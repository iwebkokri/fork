import { ratingDisplay } from '../ratings/ratings.constants';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Brackets, DataSource, In } from 'typeorm';
import {
  Banner,
  City,
  Cuisine,
  CustomerProfile,
  Favorite,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroup,
  ModifierGroup,
  ModifierOption,
  Order,
  Promotion,
  Restaurant,
  RestaurantHours,
  Review,
  User,
  Zone,
} from '../database/entities';
import { OrderStatus, RestaurantServiceMode, RestaurantStatus, StoreType } from '../common/enums';
import { fulfilmentAvailability } from '../common/service-mode';
import { STORE_PROFILES, STORE_TYPES, estimatedWeight, parseStoreTypeFilter, profileOf, stepOf, unitPriceOf, weightLabel } from '../common/store-types';
import { itemDetailsView } from '../common/menu-details';
import { haversineKm, haversineSql, roadEstimate } from '../common/geo.util';
import { AvailabilityService, daypartOf, GeoService, zonedParts } from '../core/core.module';
import { SettingsService } from '../settings/settings.service';
import { assertLatLng, csv, isUuid, maskName, num, parseBool, round2 } from './util';

export interface Loc {
  lat: number;
  lng: number;
  /** false = no coordinates were supplied, city centre was used */
  located: boolean;
  zone: Zone | null;
  city: City | null;
  eff: ReturnType<GeoService['effective']>;
}

/** Numeric score used for sorting/filtering (kept out of the public card so "New" restaurants do not leak a number). */
const RATING_SCORE = new WeakMap<object, number>();
const ratingScore = (c: RestaurantCard) => RATING_SCORE.get(c) ?? c.rating ?? 0;

export interface RestaurantCard {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  coverUrl: string | null;
  /** what kind of business this is: RESTAURANT, CAFE, BAKERY, GROCERY, CONVENIENCE, SPECIALTY (docs/store-types.md) */
  storeType: StoreType;
  storeTypeLabel: string;
  /** FOOD (restaurant, cafe, bakery) or RETAIL (grocery, convenience, specialty) */
  vertical: 'FOOD' | 'RETAIL';
  /** true: the store sells products picked from shelves (catalog, weights, substitutions) instead of cooked dishes */
  retail: boolean;
  cuisines: string[];
  /** null (with ratingLabel "New") until the restaurant has ratings.minCountToShow reviews */
  rating: number | null;
  ratingLabel?: string | null;
  ratingCount: number;
  priceLevel: number;
  distanceKm: number | null;
  etaMinutes: number | null;
  etaRange: { min: number; max: number } | null;
  deliveryFee: number | null;
  minimumOrder: number;
  isOpen: boolean;
  status: { open: boolean; reason: string | null; opensAt: Date | null; closesAt: Date | null };
  nextOpening: Date | null;
  canSchedule: boolean;
  /** service mode right now + what the customer can order (mode-aware; delivery also needs the customer inside the delivery radius) */
  serviceMode: RestaurantServiceMode;
  serviceModeLabel: string;
  deliveryAvailable: boolean;
  pickupAvailable: boolean;
  /** delivery capability + radius ignoring the service mode (lets clients show "closed" stores that normally deliver here) */
  inDeliveryRange: boolean;
  isNew: boolean;
  isFeatured: boolean;
  isFavorite: boolean;
  promo: { label: string; code: string | null } | null;
}

const promoLabel = (p: Promotion) => {
  switch (p.type) {
    case 'PERCENT':
      return `${p.value}% off`;
    case 'FIXED':
      return `$${p.value} off`;
    case 'FREE_DELIVERY':
      return 'Free delivery';
    case 'BOGO':
      return 'Buy one, get one';
    default:
      return 'Free item';
  }
};

const DEFAULT_CENTER = { lat: 43.589, lng: -79.6441 };
const MAX_DISCOVERY_KM = 30;
/** Discovery looks this far when customers are not limited to zones (the safety cap, never less than the default 30 km). */
const discoveryKm = (settings: SettingsService) => (settings.get<boolean>('orders.limitCustomersToZones', false) ? MAX_DISCOVERY_KM : Math.max(MAX_DISCOVERY_KM, Number(settings.get<number>('orders.maxDeliveryDistanceKm', 100)) || MAX_DISCOVERY_KM));

@Injectable()
export class DiscoveryService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private availability: AvailabilityService,
    private geo: GeoService,
    private settings: SettingsService,
  ) {}

  // ------------------------------------------------------------------ location
  async resolveLocation(latIn?: number, lngIn?: number): Promise<Loc> {
    assertLatLng(latIn, lngIn);
    const located = latIn !== undefined && lngIn !== undefined;
    let lat = latIn ?? DEFAULT_CENTER.lat;
    let lng = lngIn ?? DEFAULT_CENTER.lng;
    let zone: Zone | null = null;
    let city: City | null = null;
    if (located) {
      zone = await this.geo.resolveZone(lat, lng);
      city = await this.geo.cityFor(zone);
    }
    if (!city) {
      const cities = await this.ds.getRepository(City).find({ where: { active: true }, order: { createdAt: 'ASC' } });
      if (located) {
        city = cities.filter((c) => haversineKm(lat, lng, c.centerLat, c.centerLng) <= 40).sort((a, b) => haversineKm(lat, lng, a.centerLat, a.centerLng) - haversineKm(lat, lng, b.centerLat, b.centerLng))[0] ?? null;
      } else {
        city = cities[0] ?? null;
        if (city) {
          lat = city.centerLat;
          lng = city.centerLng;
        }
      }
    }
    return { lat, lng, located, zone, city, eff: this.geo.effective(zone, city) };
  }

  // ------------------------------------------------------------------ shared building blocks
  private async activePromos(restaurantIds: string[], cityId: string | null) {
    const now = new Date();
    const qb = this.ds
      .getRepository(Promotion)
      .createQueryBuilder('p')
      .where('p.active = true AND p.pendingApproval = false')
      .andWhere('(p.startsAt IS NULL OR p.startsAt <= :now) AND (p.endsAt IS NULL OR p.endsAt >= :now)', { now })
      .andWhere('(p.usageLimit IS NULL OR p.usedCount < p.usageLimit)');
    if (restaurantIds.length) {
      qb.andWhere(new Brackets((b) => b.where('p.restaurantId IN (:...ids)', { ids: restaurantIds }).orWhere('p.restaurantId IS NULL')));
    } else qb.andWhere('p.restaurantId IS NULL');
    const all = await qb.orderBy('p.createdAt', 'DESC').limit(300).getMany();
    return all.filter((p) => !p.cityId || !cityId || p.cityId === cityId);
  }

  private pickPromo(r: Restaurant, promos: Promotion[]) {
    const own = promos.find((p) => p.restaurantId === r.id);
    const platform = promos.find((p) => !p.restaurantId && p.autoApply);
    const p = own ?? platform;
    return p ? { label: promoLabel(p), code: p.code } : null;
  }

  /** Nearby LIVE restaurants (SQL prefilter) with cuisines loaded, nearest first. */
  private async nearby(loc: Loc, limit = 150, types: StoreType[] | null = null): Promise<Restaurant[]> {
    const qb = this.ds
      .getRepository(Restaurant)
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.cuisines', 'c')
      .where('r.status = :live', { live: RestaurantStatus.LIVE })
      .andWhere('r.lat IS NOT NULL AND r.lng IS NOT NULL')
      .andWhere(`${haversineSql('r.lat', 'r.lng')} <= :maxKm`, { lat: loc.lat, lng: loc.lng, maxKm: discoveryKm(this.settings) });
    if (types) qb.andWhere('r.storeType IN (:...types)', { types: types.length ? types : ['__none__'] });
    const rows = await qb.getMany();
    const d = (r: Restaurant) => haversineKm(loc.lat, loc.lng, r.lat!, r.lng!);
    return rows.sort((a, b) => d(a) - d(b)).slice(0, limit);
  }

  private feeFor(loc: Loc, distanceKm: number) {
    const raw = (loc.eff.baseFee + loc.eff.perKmFee * distanceKm) * (loc.eff.busyMultiplier || 1);
    return round2(raw);
  }

  private async buildCards(list: Restaurant[], loc: Loc, opts: { favorites?: Set<string>; promos?: Promotion[] } = {}): Promise<RestaurantCard[]> {
    const promos = opts.promos ?? (await this.activePromos(list.map((r) => r.id), loc.city?.id ?? null));
    const buffer = this.settings.get<number>('orders.quotedEtaBufferMin', 5);
    const now = new Date();
    return Promise.all(
      list.map(async (r) => {
        const st = await this.availability.status(r, now);
        const nextOpening = st.open ? null : st.opensAt ?? (await this.availability.nextOpening(r, now));
        const km = r.lat != null && r.lng != null ? haversineKm(loc.lat, loc.lng, r.lat, r.lng) : null;
        const radius = Math.min(r.deliveryRadiusKm ?? 5, loc.eff.maxRadiusKm || 12);
        const av = fulfilmentAvailability(r);
        // customers are limited to the store's radius only when the platform enforces it; otherwise any distance up to the safety cap
        const limitCustomers = this.settings.get<boolean>('orders.limitCustomersToZones', false);
        const maxKm = Number(this.settings.get<number>('orders.maxDeliveryDistanceKm', 100));
        const reachKm = limitCustomers ? radius : maxKm > 0 ? maxKm : Infinity;
        const inDeliveryRange = (r.deliveryEnabled || r.ownDeliveryEnabled) && km !== null && km <= reachKm;
        const deliveryAvailable = av.deliveryAvailable && inDeliveryRange;
        const pickupAvailable = av.pickupAvailable;
        let eta: number | null = null;
        if (km !== null) {
          const road = roadEstimate(loc.lat, loc.lng, r.lat!, r.lng!);
          eta = deliveryAvailable ? this.availability.prepTime(r) + road.minutes + buffer : this.availability.prepTime(r, true);
        }
        const penalty = this.settings.get<number>('ratings.restaurant.discoveryPenalty', 0);
        const score = (r.rating ?? 0) * (penalty > 0 && penalty < 1 && r.ratingAlert === 'WARN' ? penalty : 1);
        const card = {
          id: r.id,
          slug: r.slug,
          name: r.name,
          logoUrl: r.logoUrl,
          coverUrl: r.coverUrl,
          storeType: r.storeType ?? StoreType.RESTAURANT,
          storeTypeLabel: profileOf(r.storeType).label,
          vertical: profileOf(r.storeType).vertical,
          retail: profileOf(r.storeType).retail,
          cuisines: (r.cuisines ?? []).map((c) => c.name),
          ...ratingDisplay(r.rating, r.ratingCount, this.settings.get<number>('ratings.minCountToShow', 5)),
          priceLevel: r.priceLevel,
          distanceKm: km === null ? null : round2(km),
          etaMinutes: eta,
          etaRange: eta === null ? null : { min: eta, max: eta + 10 },
          deliveryFee: km === null ? null : deliveryAvailable ? (r.ownDeliveryEnabled && !r.deliveryEnabled ? r.ownDeliveryFee : this.feeFor(loc, km)) : 0,
          minimumOrder: Math.max(r.minimumOrder ?? 0, deliveryAvailable ? loc.eff.minimumOrder ?? 0 : 0),
          isOpen: st.open,
          status: { open: st.open, reason: st.reason ?? null, opensAt: st.opensAt ?? null, closesAt: st.closesAt ?? null },
          nextOpening,
          canSchedule: r.scheduledEnabled && !st.open && av.serviceMode !== RestaurantServiceMode.CLOSED,
          serviceMode: av.serviceMode,
          serviceModeLabel: av.serviceModeLabel,
          deliveryAvailable,
          pickupAvailable,
          inDeliveryRange,
          isNew: r.isNew || (!!r.wentLiveAt && now.getTime() - r.wentLiveAt.getTime() < 30 * 86400_000),
          isFeatured: r.isFeatured,
          isFavorite: opts.favorites?.has(r.id) ?? false,
          promo: this.pickPromo(r, promos),
        } satisfies RestaurantCard;
        RATING_SCORE.set(card, score);
        return card;
      }),
    );
  }

  private async favoritesOf(customerId?: string) {
    if (!customerId) return new Set<string>();
    const rows = await this.ds.getRepository(Favorite).find({ where: { customerId } });
    return new Set(rows.map((f) => f.restaurantId));
  }

  // ------------------------------------------------------------------ home feed
  async home(latIn?: number, lngIn?: number, customerId?: string, filter: { storeType?: string; vertical?: string } = {}) {
    const loc = await this.resolveLocation(latIn, lngIn);
    const types = parseStoreTypeFilter(filter.storeType, filter.vertical);
    const [allNearby, favorites] = await Promise.all([this.nearby(loc), this.favoritesOf(customerId)]);
    // the type tiles always count every kind of store around the customer; the feed below follows the chosen types
    const list = types ? allNearby.filter((r) => types.includes(r.storeType)) : allNearby;
    const promos = await this.activePromos(list.map((r) => r.id), loc.city?.id ?? null);
    const reach = (c: RestaurantCard) => c.deliveryAvailable || (c.pickupAvailable && (c.distanceKm ?? 99) <= 10) || (c.serviceMode === RestaurantServiceMode.CLOSED && c.inDeliveryRange);
    const cards = (await this.buildCards(list, loc, { favorites, promos })).filter(reach);
    // CLOSED stores that normally deliver here stay in the lists (shown as closed, sorted after open ones)
    const deliverable = cards.filter((c) => c.deliveryAvailable || (c.serviceMode === RestaurantServiceMode.CLOSED && c.inDeliveryRange));
    const pickupOnlyStores = cards.filter((c) => c.serviceMode === RestaurantServiceMode.PICKUP_ONLY && c.pickupAvailable);
    const byDistance = (a: RestaurantCard, b: RestaurantCard) => (a.distanceKm ?? 99) - (b.distanceKm ?? 99);
    const openFirst = (a: RestaurantCard, b: RestaurantCard) => Number(b.isOpen) - Number(a.isOpen);
    const score = (c: RestaurantCard) => ratingScore(c) * Math.log(c.ratingCount + 2) + (c.isFeatured ? 3 : 0);

    // popular = rating x volume, boosted by real order volume in the last 30 days
    const orderCounts = await this.ds
      .getRepository(Order)
      .createQueryBuilder('o')
      .select('o.restaurantId', 'id')
      .addSelect('COUNT(*)', 'n')
      .where('o.restaurantId IN (:...ids)', { ids: deliverable.map((c) => c.id).concat('00000000-0000-0000-0000-000000000000') })
      .andWhere('o.createdAt > :d', { d: new Date(Date.now() - 30 * 86400_000) })
      .andWhere('o.status IN (:...s)', { s: [OrderStatus.DELIVERED, OrderStatus.COLLECTED] })
      .groupBy('o.restaurantId')
      .getRawMany<{ id: string; n: string }>();
    const volume = new Map(orderCounts.map((r) => [r.id, +r.n]));

    const nearby = [...deliverable].sort((a, b) => openFirst(a, b) || byDistance(a, b));
    const popular = [...deliverable].sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || score(b) + Math.log((volume.get(b.id) ?? 0) + 1) * 2 - (score(a) + Math.log((volume.get(a.id) ?? 0) + 1) * 2));
    const fresh = deliverable.filter((c) => c.isNew).sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || byDistance(a, b));
    const fastest = deliverable.filter((c) => c.isOpen && c.etaMinutes !== null).sort((a, b) => a.etaMinutes! - b.etaMinutes!);
    const deals = deliverable.filter((c) => c.promo).sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || byDistance(a, b));

    // cuisine tiles: active cuisines with count of nearby restaurants
    const cuisineCount = new Map<string, number>();
    for (const r of list) for (const c of r.cuisines ?? []) if (deliverable.some((d) => d.id === r.id)) cuisineCount.set(c.id, (cuisineCount.get(c.id) ?? 0) + 1);
    const cuisines = (await this.ds.getRepository(Cuisine).find({ where: { active: true }, order: { sortOrder: 'ASC', name: 'ASC' } }))
      .map((c) => ({ id: c.id, slug: c.slug, name: c.name, iconUrl: c.iconUrl, restaurantCount: cuisineCount.get(c.id) ?? 0 }))
      .filter((c) => c.restaurantCount > 0);

    const banners = await this.banners(loc.city?.id ?? null, 'HOME');
    const tileSource = types ? (await this.buildCards(allNearby, loc, { favorites })).filter(reach) : cards;
    const storeTypes = STORE_TYPES.map((type) => {
      const p = STORE_PROFILES[type];
      const mine = tileSource.filter((c) => c.storeType === type);
      return { type, label: p.label, pluralLabel: p.pluralLabel, vertical: p.vertical, retail: p.retail, count: mine.length, openCount: mine.filter((c) => c.isOpen).length };
    });
    const platformPromos = promos.filter((p) => !p.restaurantId && p.code && p.autoApply === false).slice(0, 5).map((p) => ({ id: p.id, code: p.code, name: p.name, description: p.description, label: promoLabel(p), minSubtotal: p.minSubtotal, endsAt: p.endsAt }));

    return {
      location: {
        lat: loc.lat,
        lng: loc.lng,
        located: loc.located,
        serviceable: loc.located ? deliverable.length > 0 || !!loc.zone : true,
        zone: loc.zone ? { id: loc.zone.id, name: loc.zone.name, busy: loc.zone.busyMode } : null,
        city: loc.city ? { id: loc.city.id, name: loc.city.name, timezone: loc.city.timezone } : null,
      },
      banners,
      /** every kind of store around the customer (always unfiltered): tiles for "Restaurants", "Grocery", "Convenience"... */
      storeTypes,
      filter: { storeTypes: types, applied: !!types },
      /** nearby stores split by what they are: made-to-order food vs. grocery / retail (each already sorted open first, nearest first) */
      sections: { food: nearby.filter((c) => c.vertical === 'FOOD').slice(0, 20), retail: nearby.filter((c) => c.vertical === 'RETAIL').slice(0, 20) },
      cuisines,
      nearby: nearby.slice(0, 20),
      pickupOnly: [...pickupOnlyStores].sort(byDistance).slice(0, 20),
      popular: popular.slice(0, 12),
      new: fresh.slice(0, 12),
      deals: deals.slice(0, 12),
      fastest: fastest.slice(0, 12),
      favorites: customerId ? cards.filter((c) => c.isFavorite).slice(0, 12) : [],
      promotions: platformPromos,
      counts: {
        restaurants: deliverable.length,
        stores: deliverable.length,
        open: deliverable.filter((c) => c.isOpen).length,
        pickupOnly: pickupOnlyStores.length,
        food: deliverable.filter((c) => c.vertical === 'FOOD').length,
        retail: deliverable.filter((c) => c.vertical === 'RETAIL').length,
      },
    };
  }

  async banners(cityId: string | null, placement: Banner['placement'] = 'HOME') {
    const now = new Date();
    const rows = await this.ds
      .getRepository(Banner)
      .createQueryBuilder('b')
      .where('b.active = true AND b.placement = :pl', { pl: placement })
      .andWhere('(b.cityId IS NULL OR b.cityId = :city)', { city: cityId ?? '00000000-0000-0000-0000-000000000000' })
      .andWhere('(b.startsAt IS NULL OR b.startsAt <= :now) AND (b.endsAt IS NULL OR b.endsAt >= :now)', { now })
      .orderBy('b.sortOrder', 'ASC')
      .addOrderBy('b.createdAt', 'DESC')
      .getMany();
    return rows.map((b) => ({ id: b.id, title: b.title, subtitle: b.subtitle, imageUrl: b.imageUrl, link: b.link, placement: b.placement }));
  }

  // ------------------------------------------------------------------ search
  async search(
    q: {
      q?: string;
      lat?: string;
      lng?: string;
      type?: string;
      priceLevel?: string;
      minRating?: string;
      maxFee?: string;
      maxEta?: string;
      dietary?: string;
      excludeAllergens?: string;
      cuisine?: string;
      /** one or more store types, comma separated (GROCERY,BAKERY) */
      storeType?: string;
      /** FOOD (restaurant, cafe, bakery) or RETAIL (grocery, convenience, specialty) */
      vertical?: string;
      /** exact barcode / SKU lookup (also tried when q is 6 to 14 digits) */
      barcode?: string;
      pickupOnly?: string;
      /** pickup | delivery: only stores where that fulfilment is available right now */
      fulfilment?: string;
      openNow?: string;
      sort?: string;
      page?: string;
      limit?: string;
    },
    customerId?: string,
  ) {
    const loc = await this.resolveLocation(num(q.lat), num(q.lng));
    const text = (q.q ?? '').trim();
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    const type = ['restaurants', 'dishes', 'cuisines'].includes(q.type ?? '') ? q.type! : 'all';
    const page = Math.max(1, num(q.page) ?? 1);
    const limit = Math.min(50, Math.max(1, num(q.limit) ?? 20));
    const fulfilmentFilter = ['pickup', 'delivery'].includes((q.fulfilment ?? '').toLowerCase()) ? (q.fulfilment as string).toLowerCase() : null;
    const pickupOnly = (parseBool(q.pickupOnly) ?? false) || fulfilmentFilter === 'pickup';
    const openNow = parseBool(q.openNow) ?? false;
    const prices = csv(q.priceLevel).map(Number).filter((n) => n >= 1 && n <= 4);
    const minRating = num(q.minRating);
    const maxFee = num(q.maxFee);
    const maxEta = num(q.maxEta);
    const dietary = csv(q.dietary).map((d) => d.toLowerCase());
    const exclude = csv(q.excludeAllergens).map((d) => d.toLowerCase());
    const cuisineSlugs = csv(q.cuisine).map((s) => s.toLowerCase());
    const types = parseStoreTypeFilter(q.storeType, q.vertical);
    const barcode = /^\d{6,14}$/.test(text) ? text : /^\d{6,14}$/.test((q.barcode ?? '').trim()) ? (q.barcode ?? '').trim() : null;

    const list = await this.nearby(loc, 150, types);
    const favorites = await this.favoritesOf(customerId);
    let cards = await this.buildCards(list, loc, { favorites });
    const byId = new Map(list.map((r) => [r.id, r]));

    // reachability: delivery within radius, or pickup within 25 km (pickupOnly shows everything pickup-capable)
    cards = cards.filter((c) =>
      fulfilmentFilter === 'delivery'
        ? c.deliveryAvailable
        : pickupOnly
          ? c.pickupAvailable
          : c.deliveryAvailable || (c.pickupAvailable && (c.distanceKm ?? 99) <= 25) || (c.serviceMode === RestaurantServiceMode.CLOSED && (c.inDeliveryRange || (c.distanceKm ?? 99) <= 25)),
    );
    if (openNow) cards = cards.filter((c) => c.isOpen);
    if (prices.length) cards = cards.filter((c) => prices.includes(c.priceLevel));
    if (minRating !== undefined) cards = cards.filter((c) => ratingScore(c) >= minRating);
    if (maxFee !== undefined) cards = cards.filter((c) => pickupOnly || (c.deliveryFee ?? 0) <= maxFee);
    if (maxEta !== undefined) cards = cards.filter((c) => c.etaMinutes !== null && c.etaMinutes <= maxEta);
    if (cuisineSlugs.length) cards = cards.filter((c) => byId.get(c.id)!.cuisines.some((cu) => cuisineSlugs.includes(cu.slug)));

    const ids = cards.map((c) => c.id);
    // dietary: restaurant must offer at least one sellable item for every requested tag
    if (dietary.length && ids.length) {
      let allowed = new Set(ids);
      for (const tag of dietary) {
        const rows = await this.ds
          .getRepository(MenuItem)
          .createQueryBuilder('i')
          .select('DISTINCT i.restaurantId', 'id')
          .where('i.restaurantId IN (:...ids)', { ids })
          .andWhere('i.active = true AND i.available = true')
          .andWhere(`i.dietaryTags @> :tag::jsonb`, { tag: JSON.stringify([tag]) })
          .getRawMany<{ id: string }>();
        const s = new Set(rows.map((r) => r.id));
        allowed = new Set([...allowed].filter((x) => s.has(x)));
      }
      cards = cards.filter((c) => allowed.has(c.id));
    }

    // dish matches
    type DishRow = MenuItem;
    let dishes: DishRow[] = [];
    const cardIds = cards.map((c) => c.id);
    if ((type === 'all' || type === 'dishes') && cardIds.length && (tokens.length || dietary.length || barcode)) {
      const qb = this.ds
        .getRepository(MenuItem)
        .createQueryBuilder('i')
        .where('i.restaurantId IN (:...ids)', { ids: cardIds })
        .andWhere('i.active = true');
      if (barcode) qb.andWhere('(i.barcode = :bc OR i.sku = :bc)', { bc: barcode });
      else tokens.forEach((t, i) => qb.andWhere(`(i.name ILIKE :t${i} OR i.description ILIKE :t${i} OR i.brand ILIKE :t${i} OR i.sku ILIKE :t${i})`, { [`t${i}`]: `%${t.replace(/[%_\\]/g, (m) => `\\${m}`)}%` }));
      dietary.forEach((d, i) => qb.andWhere(`i.dietaryTags @> :dt${i}::jsonb`, { [`dt${i}`]: JSON.stringify([d]) }));
      dishes = await qb.orderBy('i.isPopular', 'DESC').limit(400).getMany();
      if (exclude.length) dishes = dishes.filter((d) => !d.allergens.some((a) => exclude.includes(String(a).toLowerCase())));
    }
    const dishesByRest = new Map<string, DishRow[]>();
    for (const d of dishes) dishesByRest.set(d.restaurantId, [...(dishesByRest.get(d.restaurantId) ?? []), d]);

    const textMatch = (c: RestaurantCard) => {
      if (!tokens.length) return 0;
      const r = byId.get(c.id)!;
      const hay = `${r.name} ${(r.cuisines ?? []).map((x) => x.name).join(' ')} ${r.description ?? ''}`.toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) return 0;
      const name = r.name.toLowerCase();
      if (name === text.toLowerCase()) return 100;
      if (name.startsWith(tokens[0])) return 80;
      if (name.includes(text.toLowerCase())) return 60;
      return 40;
    };

    let matched = cards
      .map((c) => ({ c, s: textMatch(c), dishCount: dishesByRest.get(c.id)?.length ?? 0 }))
      .filter((x) => (tokens.length ? x.s > 0 || x.dishCount > 0 : true));
    if (type === 'dishes' || type === 'cuisines') matched = type === 'cuisines' ? matched : [];

    const sort = q.sort ?? 'relevance';
    const cmp: Record<string, (a: (typeof matched)[number], b: (typeof matched)[number]) => number> = {
      relevance: (a, b) => Number(b.c.isOpen) - Number(a.c.isOpen) || b.s + b.dishCount * 5 - (a.s + a.dishCount * 5) || (a.c.distanceKm ?? 99) - (b.c.distanceKm ?? 99),
      distance: (a, b) => (a.c.distanceKm ?? 99) - (b.c.distanceKm ?? 99),
      rating: (a, b) => ratingScore(b.c) - ratingScore(a.c) || b.c.ratingCount - a.c.ratingCount,
      eta: (a, b) => (a.c.etaMinutes ?? 999) - (b.c.etaMinutes ?? 999),
      fee: (a, b) => (a.c.deliveryFee ?? 99) - (b.c.deliveryFee ?? 99),
      price_low: (a, b) => a.c.priceLevel - b.c.priceLevel || ratingScore(b.c) - ratingScore(a.c),
      price_high: (a, b) => b.c.priceLevel - a.c.priceLevel || ratingScore(b.c) - ratingScore(a.c),
      popular: (a, b) => b.c.ratingCount * ratingScore(b.c) - a.c.ratingCount * ratingScore(a.c),
    };
    matched.sort(cmp[sort] ?? cmp.relevance);
    // CLOSED stores always last (stable)
    matched = [...matched.filter((m) => m.c.serviceMode !== RestaurantServiceMode.CLOSED), ...matched.filter((m) => m.c.serviceMode === RestaurantServiceMode.CLOSED)];
    const total = matched.length;
    const restaurants = matched.slice((page - 1) * limit, page * limit).map(({ c }) => ({
      ...c,
      matchedDishes: (dishesByRest.get(c.id) ?? []).slice(0, 3).map((d) => ({ id: d.id, name: d.name, price: d.price, imageUrl: d.imageUrl })),
    }));

    const cardMap = new Map(cards.map((c) => [c.id, c]));
    const dishOut = (type === 'all' || type === 'dishes' ? dishes : [])
      .filter((d) => cardMap.has(d.restaurantId))
      .sort((a, b) => Number(cardMap.get(b.restaurantId)!.isOpen) - Number(cardMap.get(a.restaurantId)!.isOpen) || (cardMap.get(a.restaurantId)!.distanceKm ?? 99) - (cardMap.get(b.restaurantId)!.distanceKm ?? 99))
      .slice(0, type === 'dishes' ? limit : 20)
      .map((d) => {
        const c = cardMap.get(d.restaurantId)!;
        return {
          id: d.id,
          name: d.name,
          description: d.description,
          imageUrl: d.imageUrl,
          price: d.price,
          dietaryTags: d.dietaryTags,
          allergens: d.allergens,
          available: this.availability.itemSellable(d),
          ...this.productFacts(d),
          restaurant: { id: c.id, slug: c.slug, name: c.name, logoUrl: c.logoUrl, isOpen: c.isOpen, distanceKm: c.distanceKm, etaMinutes: c.etaMinutes, storeType: c.storeType, storeTypeLabel: c.storeTypeLabel, retail: c.retail },
        };
      });

    // cuisines: name match over active cuisines, with count of reachable restaurants
    let cuisines: { id: string; slug: string; name: string; iconUrl: string | null; restaurantCount: number }[] = [];
    if (type === 'all' || type === 'cuisines') {
      const all = await this.ds.getRepository(Cuisine).find({ where: { active: true }, order: { sortOrder: 'ASC' } });
      cuisines = all
        .filter((c) => !tokens.length || tokens.every((t) => c.name.toLowerCase().includes(t)))
        .map((c) => ({ id: c.id, slug: c.slug, name: c.name, iconUrl: c.iconUrl, restaurantCount: cards.filter((k) => byId.get(k.id)!.cuisines.some((cu) => cu.id === c.id)).length }))
        .filter((c) => c.restaurantCount > 0);
    }

    return {
      query: text,
      location: { lat: loc.lat, lng: loc.lng, located: loc.located },
      filter: { storeTypes: types, barcode },
      restaurants: type === 'dishes' ? [] : restaurants,
      /** the matching dishes / products; a grocery product also carries sku, brand, packSize, sellBy, weightUnit, minAge, inStock... */
      dishes: dishOut,
      cuisines: type === 'restaurants' || type === 'dishes' ? [] : cuisines,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  // ------------------------------------------------------------------ restaurant page
  async findRestaurant(slugOrId: string): Promise<Restaurant> {
    const repo = this.ds.getRepository(Restaurant);
    const r = await repo.findOne({ where: isUuid(slugOrId) ? { id: slugOrId } : { slug: slugOrId }, relations: { cuisines: true } });
    if (!r || ![RestaurantStatus.LIVE, RestaurantStatus.PAUSED].includes(r.status)) throw new NotFoundException('Restaurant not found');
    return r;
  }

  /** The catalog facts of a product (groceries / retail): all safe defaults for a plain restaurant dish. */
  productFacts(i: MenuItem) {
    const weighed = i.sellBy === 'WEIGHT';
    const step = stepOf(i);
    const tracked = !!i.trackStock;
    const stock = Number(i.stockQty ?? 0);
    const inStock = !tracked || stock > 0;
    const cap = Math.min(99, i.maxPerOrder ?? 99);
    // the most the customer can put in the cart: what is on the shelf (in pieces, or in steps for weighed products) and the per-order limit
    const maxQuantity = !inStock ? 0 : tracked ? Math.max(0, Math.min(cap, Math.floor(weighed ? stock / step : stock))) : cap;
    return {
      sku: i.sku ?? null,
      barcode: i.barcode ?? null,
      brand: i.brand ?? null,
      packSize: i.packSize ?? null,
      sellBy: (i.sellBy ?? 'UNIT') as 'UNIT' | 'WEIGHT',
      weightUnit: weighed ? i.weightUnit : null,
      /** weighed products: the weight of one step and the price of one step (price is per weightUnit) */
      stepSize: weighed ? step : null,
      stepPrice: weighed ? unitPriceOf(i) : null,
      stepLabel: weighed ? weightLabel(i, 1) : null,
      inStock,
      lowStock: tracked && inStock && i.lowStockThreshold != null && stock <= i.lowStockThreshold,
      maxQuantity,
      maxPerOrder: i.maxPerOrder ?? null,
      minAge: i.minAge ?? 0,
      ageRestricted: (i.minAge ?? 0) > 0,
      temperature: (i.temperature ?? 'AMBIENT') as 'AMBIENT' | 'CHILLED' | 'FROZEN',
    };
  }

  /** Turns items into customer-facing products (modifier groups, daypart / stock availability, allergen conflicts). `tz` decides which items are inside their daypart now. */
  private async shaper(r: Restaurant, opts: { customerAllergens?: string[] } = {}) {
    const cats = await this.ds.getRepository(MenuCategory).find({ where: { restaurantId: r.id, active: true }, order: { sortOrder: 'ASC', name: 'ASC' } });
    const tz = await this.availability.timezoneFor(r);
    const now = new Date();
    const part = daypartOf(zonedParts(now, tz).minutes);
    const catMap = new Map(cats.map((c) => [c.id, c]));
    const allergenSet = new Set((opts.customerAllergens ?? []).map((a) => a.toLowerCase()));
    const shapeAll = async (list: MenuItem[]) => {
      const itemIds = list.map((i) => i.id);
      const links = itemIds.length ? await this.ds.getRepository(MenuItemModifierGroup).find({ where: { menuItemId: In(itemIds) }, order: { sortOrder: 'ASC' } }) : [];
      const groupIds = [...new Set(links.map((l) => l.groupId))];
      const groups = groupIds.length ? await this.ds.getRepository(ModifierGroup).find({ where: { id: In(groupIds) } }) : [];
      const options = groupIds.length ? await this.ds.getRepository(ModifierOption).find({ where: { groupId: In(groupIds) }, order: { sortOrder: 'ASC', name: 'ASC' } }) : [];
      const groupMap = new Map(groups.map((g) => [g.id, g]));
      return list.map((i) => {
        const cat = i.categoryId ? catMap.get(i.categoryId) : undefined;
        const catBlocked = !!cat?.dayparts?.length && !cat.dayparts.includes(part);
        const sellable = this.availability.itemSellable(i, now, tz) && !catBlocked;
        const dayBlocked = catBlocked || (!!i.dayparts?.length && !i.dayparts.includes(part));
        const soldOut = !!i.trackStock && Number(i.stockQty ?? 0) <= 0;
        return {
          id: i.id,
          name: i.name,
          description: i.description,
          imageUrl: i.imageUrl,
          galleryUrls: i.galleryUrls ?? [],
          price: i.price,
          pickupPrice: i.pickupPrice,
          calories: i.calories,
          allergens: i.allergens,
          dietaryTags: i.dietaryTags,
          ...itemDetailsView(i),
          isPopular: i.isPopular,
          isCombo: i.isCombo,
          dayparts: i.dayparts,
          categoryId: i.categoryId,
          ...this.productFacts(i),
          available: sellable,
          unavailableReason: sellable ? null : !i.available || soldOut ? 'OUT_OF_STOCK' : dayBlocked ? 'NOT_SERVED_NOW' : 'UNAVAILABLE',
          allergenConflict: i.allergens.filter((a) => allergenSet.has(String(a).toLowerCase())),
          mayContainConflict: (i.mayContain ?? []).filter((a) => allergenSet.has(String(a).toLowerCase())),
          modifierGroups: links
            .filter((l) => l.menuItemId === i.id && groupMap.has(l.groupId))
            .map((l) => {
              const g = groupMap.get(l.groupId)!;
              return {
                id: g.id,
                name: g.name,
                required: g.required || g.minSelect > 0,
                minSelect: g.required ? Math.max(1, g.minSelect) : g.minSelect,
                maxSelect: g.maxSelect,
                options: options.filter((o) => o.groupId === g.id).map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta, isDefault: o.isDefault, available: o.available })),
              };
            }),
        };
      });
    };
    return { cats, shapeAll };
  }

  /**
   * The menu of a store. Restaurants get the whole menu (as before). A store with a big catalog asks for `summary`: every department with its product
   * count and only the first `summary` products of each (the rest comes from catalog(), paged).
   */
  async buildMenu(r: Restaurant, opts: { customerAllergens?: string[]; summary?: number } = {}) {
    const [sh, items] = await Promise.all([
      this.shaper(r, opts),
      this.ds.getRepository(MenuItem).find({ where: { restaurantId: r.id, active: true }, order: { sortOrder: 'ASC', name: 'ASC' } }),
    ]);
    const catMap = new Map(sh.cats.map((c) => [c.id, c]));
    const per = opts.summary && opts.summary > 0 ? opts.summary : null;
    const grouped = sh.cats.map((c) => ({ cat: c, all: items.filter((i) => i.categoryId === c.id) })).filter((g) => g.all.length);
    const loose = items.filter((i) => !i.categoryId || !catMap.has(i.categoryId));
    const picked = new Set<string>();
    const shown = grouped.map((g) => ({ ...g, show: per ? g.all.slice(0, per) : g.all }));
    shown.forEach((g) => g.show.forEach((i) => picked.add(i.id)));
    const looseShown = per ? loose.slice(0, per) : loose;
    looseShown.forEach((i) => picked.add(i.id));
    const popularItems = items.filter((i) => i.isPopular).slice(0, 8);
    popularItems.forEach((i) => picked.add(i.id));
    const shaped = new Map((await sh.shapeAll(items.filter((i) => picked.has(i.id)))).map((x) => [x.id, x]));
    const view = (list: MenuItem[]) => list.map((i) => shaped.get(i.id)!);
    const categories = shown.map((g) => ({ id: g.cat.id as string | null, name: g.cat.name, description: g.cat.description, dayparts: g.cat.dayparts, itemCount: g.all.length, items: view(g.show) }));
    if (loose.length) categories.push({ id: null, name: 'Other', description: null, dayparts: [], itemCount: loose.length, items: view(looseShown) });
    const popular = view(popularItems);
    const truncated = !!per && categories.some((c) => c.itemCount > c.items.length);
    return { mode: per ? ('CATALOG' as const) : ('MENU' as const), truncated, itemCount: items.length, categories, popular };
  }

  /**
   * Paged catalog of ONE store (groceries: thousands of products). Filters: categoryId ("none" = no department), q (name / brand / SKU / barcode),
   * dietary, inStock, minAge (age-restricted only with "restricted"), sort (popular, name, price_low, price_high).
   */
  async catalog(slugOrId: string, q: { categoryId?: string; q?: string; dietary?: string; inStock?: string; restricted?: string; sort?: string; page?: string; limit?: string }, customerId?: string) {
    const r = await this.findRestaurant(slugOrId);
    const page = Math.max(1, num(q.page) ?? 1);
    const limit = Math.min(100, Math.max(1, num(q.limit) ?? 24));
    const qb = this.ds.getRepository(MenuItem).createQueryBuilder('i').where('i.restaurantId = :rid AND i.active = true', { rid: r.id });
    const text = (q.q ?? '').trim().slice(0, 100);
    if (/^\d{6,14}$/.test(text)) qb.andWhere('(i.barcode = :bc OR i.sku = :bc OR i.name ILIKE :s)', { bc: text, s: `%${text}%` });
    else
      text
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6)
        .forEach((tok, n) => qb.andWhere(`(i.name ILIKE :t${n} OR i.brand ILIKE :t${n} OR i.description ILIKE :t${n} OR i.sku ILIKE :t${n})`, { [`t${n}`]: `%${tok.replace(/[%_\\]/g, (m) => `\\${m}`)}%` }));
    if (q.categoryId === 'none') qb.andWhere('i.categoryId IS NULL');
    else if (q.categoryId) {
      if (!isUuid(q.categoryId)) throw new BadRequestException('categoryId must be an id or "none"');
      qb.andWhere('i.categoryId = :cat', { cat: q.categoryId });
    }
    csv(q.dietary).map((d) => d.toLowerCase()).forEach((d, n) => qb.andWhere(`i.dietaryTags @> :dt${n}::jsonb`, { [`dt${n}`]: JSON.stringify([d]) }));
    if (parseBool(q.inStock)) qb.andWhere('i.available = true AND (i.trackStock = false OR COALESCE(i.stockQty, 0) > 0)');
    if (parseBool(q.restricted) === true) qb.andWhere('i.minAge > 0');
    switch (q.sort) {
      case 'name':
        qb.orderBy('i.name', 'ASC');
        break;
      case 'price_low':
        qb.orderBy('i.price', 'ASC').addOrderBy('i.name', 'ASC');
        break;
      case 'price_high':
        qb.orderBy('i.price', 'DESC').addOrderBy('i.name', 'ASC');
        break;
      default:
        qb.orderBy('i.isPopular', 'DESC').addOrderBy('i.sortOrder', 'ASC').addOrderBy('i.name', 'ASC');
    }
    const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    let profile: CustomerProfile | null = null;
    if (customerId) profile = await this.ds.getRepository(CustomerProfile).findOne({ where: { userId: customerId } });
    const sh = await this.shaper(r, { customerAllergens: profile?.allergens });
    const counts = await this.ds
      .getRepository(MenuItem)
      .createQueryBuilder('i')
      .select('i.categoryId', 'id')
      .addSelect('COUNT(*)', 'n')
      .where('i.restaurantId = :rid AND i.active = true', { rid: r.id })
      .groupBy('i.categoryId')
      .getRawMany<{ id: string | null; n: string }>();
    const n = new Map(counts.map((c) => [c.id, +c.n]));
    const categories = sh.cats.filter((c) => n.get(c.id)).map((c) => ({ id: c.id as string | null, name: c.name, description: c.description, itemCount: n.get(c.id) ?? 0 }));
    if (n.get(null)) categories.push({ id: null, name: 'Other', description: null, itemCount: n.get(null) ?? 0 });
    return {
      store: { id: r.id, slug: r.slug, name: r.name, storeType: r.storeType, storeTypeLabel: profileOf(r.storeType).label, retail: profileOf(r.storeType).retail },
      data: await sh.shapeAll(rows),
      categories,
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** One product of a store with its options (a grocery product page, or a dish dialog). */
  async product(slugOrId: string, itemId: string, customerId?: string) {
    const r = await this.findRestaurant(slugOrId);
    if (!isUuid(itemId)) throw new NotFoundException('Product not found');
    const item = await this.ds.getRepository(MenuItem).findOne({ where: { id: itemId, restaurantId: r.id, active: true } });
    if (!item) throw new NotFoundException('Product not found');
    let profile: CustomerProfile | null = null;
    if (customerId) profile = await this.ds.getRepository(CustomerProfile).findOne({ where: { userId: customerId } });
    const sh = await this.shaper(r, { customerAllergens: profile?.allergens });
    const [shaped] = await sh.shapeAll([item]);
    const cat = sh.cats.find((c) => c.id === item.categoryId);
    return { store: { id: r.id, slug: r.slug, name: r.name, storeType: r.storeType, retail: profileOf(r.storeType).retail }, category: cat ? { id: cat.id, name: cat.name } : null, product: shaped };
  }

  /** The kinds of store on the platform with how many are around the customer: the tiles of a "what are you looking for" screen. */
  async storeTypes(latIn?: number, lngIn?: number) {
    const loc = await this.resolveLocation(latIn, lngIn);
    const cards = (await this.buildCards(await this.nearby(loc), loc)).filter((c) => c.deliveryAvailable || (c.pickupAvailable && (c.distanceKm ?? 99) <= 10) || (c.serviceMode === RestaurantServiceMode.CLOSED && c.inDeliveryRange));
    const data = STORE_TYPES.map((type) => {
      const p = STORE_PROFILES[type];
      const mine = cards.filter((c) => c.storeType === type);
      return { type, label: p.label, pluralLabel: p.pluralLabel, vertical: p.vertical, retail: p.retail, itemLabel: p.itemLabel, itemLabelPlural: p.itemLabelPlural, categoryLabel: p.categoryLabel, count: mine.length, openCount: mine.filter((c) => c.isOpen).length };
    });
    return {
      location: { lat: loc.lat, lng: loc.lng, located: loc.located },
      data,
      verticals: (['FOOD', 'RETAIL'] as const).map((v) => ({ vertical: v, label: v === 'FOOD' ? 'Restaurants & food' : 'Grocery & shops', count: data.filter((d) => d.vertical === v).reduce((s, d) => s + d.count, 0) })),
    };
  }

  /** Browse stores (the "all grocery stores near me" list): same cards and filters as search, without the dish / cuisine parts. */
  async stores(q: Parameters<DiscoveryService['search']>[0], customerId?: string) {
    const r = await this.search({ ...q, type: 'restaurants' }, customerId);
    return { query: r.query, location: r.location, filter: r.filter, data: r.restaurants, meta: r.meta };
  }

  /**
   * The store page. `menu`: "full" = every product (even for a grocery store), "summary" = a few products per department (the default for retail stores;
   * `perCategory` sets how many, 1 to 50). Restaurants get the full menu unless a summary is asked for.
   */
  async restaurantPage(slugOrId: string, latIn?: number, lngIn?: number, customerId?: string, view: { menu?: string; perCategory?: string } = {}) {
    const r = await this.findRestaurant(slugOrId);
    const loc = await this.resolveLocation(latIn, lngIn);
    let profile: CustomerProfile | null = null;
    if (customerId) profile = await this.ds.getRepository(CustomerProfile).findOne({ where: { userId: customerId } });
    const favorites = await this.favoritesOf(customerId);
    const [card] = await this.buildCards([r], loc, { favorites });
    const [menu, hours, reviews, promos] = await Promise.all([
      this.buildMenu(r, { customerAllergens: profile?.allergens, summary: this.summaryOf(r, view) }),
      this.ds.getRepository(RestaurantHours).find({ where: { restaurantId: r.id }, order: { dayOfWeek: 'ASC', openTime: 'ASC' } }),
      this.recentReviews(r.id, 5),
      this.activePromos([r.id], r.cityId),
    ]);
    const relevant = promos.filter((p) => p.restaurantId === r.id || (!p.restaurantId && (p.autoApply || p.code)));
    const tz = await this.availability.timezoneFor(r);
    const sp = profileOf(r.storeType);
    return {
      restaurant: {
        ...card,
        /** how this kind of store works: labels to show and what the checkout / picking will do (docs/store-types.md) */
        store: { type: sp.type, label: sp.label, vertical: sp.vertical, retail: sp.retail, itemLabel: sp.itemLabel, itemLabelPlural: sp.itemLabelPlural, categoryLabel: sp.categoryLabel, limits: sp.limits },
        description: r.description,
        photos: r.photos,
        phone: r.phone,
        website: r.website,
        address: { line1: r.addressLine1, line2: r.addressLine2, city: r.city, province: r.province, postalCode: r.postalCode, lat: r.lat, lng: r.lng },
        timezone: tz,
        deliveryRadiusKm: r.deliveryRadiusKm,
        prepTimeMin: this.availability.prepTime(r),
        pickupPrepTimeMin: this.availability.prepTime(r, true),
        fulfilment: { delivery: r.deliveryEnabled, ownDelivery: r.ownDeliveryEnabled, pickup: r.pickupEnabled, scheduled: r.scheduledEnabled },
        serviceModeUpdatedAt: r.serviceModeUpdatedAt,
        serviceModeResumeAt: r.serviceModeResumeAt,
        pickupInstructions: r.pickupInstructions,
        parkingNotes: r.parkingNotes,
        schedule: { slotMinutes: r.slotMinutes, leadMinutes: r.scheduleLeadMin, maxDaysAhead: this.settings.get<number>('orders.maxScheduleDays', 3) },
        hours: hours.map((h) => ({ dayOfWeek: h.dayOfWeek, openTime: h.openTime, closeTime: h.closeTime, closed: h.closed })),
      },
      promos: relevant.slice(0, 6).map((p) => ({ id: p.id, code: p.code, name: p.name, description: p.description, label: promoLabel(p), minSubtotal: p.minSubtotal, restaurantFunded: !!p.restaurantId, autoApply: p.autoApply, endsAt: p.endsAt })),
      menu,
      reviews,
      ratings: this.ratingSummary(r),
    };
  }

  private summaryOf(r: Restaurant, view: { menu?: string; perCategory?: string }) {
    if (view.menu === 'full') return 0;
    const asked = Math.min(50, Math.max(0, Math.trunc(Number(view.perCategory)) || 0));
    if (asked) return asked;
    return view.menu === 'summary' || profileOf(r.storeType).retail ? 8 : 0;
  }

  /** Public rating block: numeric rating only once ratings.minCountToShow reviews exist (else null + "New"). */
  private ratingSummary(r: Restaurant) {
    const d = ratingDisplay(r.rating, r.ratingCount, this.settings.get<number>('ratings.minCountToShow', 5));
    const shown = d.rating != null;
    return { ...d, distribution: shown ? r.ratingStats?.distribution ?? null : null, topTags: shown ? (r.ratingStats?.positiveTags ?? []).slice(0, 3) : [] };
  }

  async recentReviews(restaurantId: string, limit = 10) {
    const rows = await this.ds
      .getRepository(Review)
      .createQueryBuilder('v')
      .where('v.restaurantId = :id AND v.status = :s AND v.restaurantRating IS NOT NULL', { id: restaurantId, s: 'VISIBLE' })
      .orderBy('v.createdAt', 'DESC')
      .limit(limit)
      .getMany();
    const users = rows.length ? await this.ds.getRepository(User).find({ where: { id: In(rows.map((v) => v.customerId)) } }) : [];
    const um = new Map(users.map((u) => [u.id, u]));
    return rows.map((v) => ({
      id: v.id,
      rating: v.restaurantRating,
      tags: v.restaurantTags,
      comment: v.comment,
      reply: v.reply,
      repliedAt: v.repliedAt,
      author: maskName(um.get(v.customerId)?.firstName, um.get(v.customerId)?.lastName),
      createdAt: v.createdAt,
    }));
  }

  async reviewsPage(slugOrId: string, page = 1, limit = 20) {
    const r = await this.findRestaurant(slugOrId);
    const [rows, total] = await this.ds
      .getRepository(Review)
      .createQueryBuilder('v')
      .where('v.restaurantId = :id AND v.status = :s AND v.restaurantRating IS NOT NULL', { id: r.id, s: 'VISIBLE' })
      .orderBy('v.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const users = rows.length ? await this.ds.getRepository(User).find({ where: { id: In(rows.map((v) => v.customerId)) } }) : [];
    const um = new Map(users.map((u) => [u.id, u]));
    return {
      summary: this.ratingSummary(r),
      data: rows.map((v) => ({ id: v.id, rating: v.restaurantRating, tags: v.restaurantTags, comment: v.comment, reply: v.reply, repliedAt: v.repliedAt, author: maskName(um.get(v.customerId)?.firstName, um.get(v.customerId)?.lastName), createdAt: v.createdAt })),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  // ------------------------------------------------------------------ scheduled-order slots
  async slots(slugOrId: string, dateStr: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? '')) throw new BadRequestException('date must be YYYY-MM-DD');
    const r = await this.findRestaurant(slugOrId);
    if (!r.scheduledEnabled || r.serviceMode === RestaurantServiceMode.CLOSED) return { date: dateStr, enabled: false, slotMinutes: r.slotMinutes, timezone: await this.availability.timezoneFor(r), slots: [] };
    const maxDays = this.settings.get<number>('orders.maxScheduleDays', 3);
    const tz = await this.availability.timezoneFor(r);
    const today = zonedParts(new Date(), tz).date;
    const diffDays = Math.round((Date.parse(`${dateStr}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000);
    if (diffDays < 0 || diffDays > maxDays) throw new BadRequestException(`Scheduled orders can be placed up to ${maxDays} days ahead`);
    const starts = await this.availability.slots(r, dateStr);
    if (!starts.length) return { date: dateStr, enabled: true, slotMinutes: r.slotMinutes, timezone: tz, slots: [] };
    const step = (r.slotMinutes || 15) * 60_000;
    const booked = await this.ds
      .getRepository(Order)
      .createQueryBuilder('o')
      .select('o.scheduledFor', 'at')
      .addSelect('COUNT(*)', 'n')
      .where('o.restaurantId = :id AND o.isScheduled = true', { id: r.id })
      .andWhere('o.scheduledFor >= :from AND o.scheduledFor < :to', { from: starts[0], to: new Date(starts[starts.length - 1].getTime() + step) })
      .andWhere('o.status NOT IN (:...x)', { x: [OrderStatus.CANCELLED, OrderStatus.REJECTED] })
      .groupBy('o.scheduledFor')
      .getRawMany<{ at: Date; n: string }>();
    const label = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
    const cap = r.maxOrdersPerSlot;
    return {
      date: dateStr,
      enabled: true,
      slotMinutes: r.slotMinutes,
      timezone: tz,
      slots: starts.map((s) => {
        const n = booked.filter((b) => Math.abs(new Date(b.at).getTime() - s.getTime()) < step / 2).reduce((a, b) => a + +b.n, 0);
        return { startsAt: s, label: label.format(s), capacity: cap, booked: n, available: n < cap };
      }),
    };
  }
}
