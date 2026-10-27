import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  City,
  CommissionTier,
  Incentive,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroup,
  ModifierGroup,
  ModifierOption,
  Order,
  Restaurant,
  TaxClass,
  Zone,
} from '../database/entities';
import { ACTIVE_ORDER_STATUSES, DropoffMethod, FulfilmentMode, OrderStatus, OrderType, RestaurantServiceMode } from '../common/enums';
import { fulfilmentAvailability } from '../common/service-mode';
import { basketOf, estimatedWeight, isRetail, profileOf, stockUse, unitPriceOf } from '../common/store-types';
import { IPricingService, IPromotionsService, PromotionEvaluation, Quote, QuoteInput, QuoteLine } from '../common/contracts';
import { haversineKm } from '../common/geo.util';
import { MapsService } from '../integrations/maps.service';
import { AvailabilityService, daypartOf, GeoService, zonedParts } from '../core/core.module';
import { SettingsService } from '../settings/settings.service';
import { WalletService } from './wallet.service';
import { computeMoney, lazyProvider, round2 } from './pricing.math';
import { commissionDefaults, methodOf, resolveCommission } from '../platform/commission';

const DEFAULT_TAX_RATE = 13;

@Injectable()
export class PricingService implements IPricingService {
  private readonly logger = new Logger(PricingService.name);

  constructor(
    private moduleRef: ModuleRef,
    private settings: SettingsService,
    private availability: AvailabilityService,
    private geo: GeoService,
    private wallet: WalletService,
    private maps: MapsService,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(MenuItem) private menuItems: Repository<MenuItem>,
    @InjectRepository(MenuCategory) private categories: Repository<MenuCategory>,
    @InjectRepository(MenuItemModifierGroup) private itemGroups: Repository<MenuItemModifierGroup>,
    @InjectRepository(ModifierGroup) private groups: Repository<ModifierGroup>,
    @InjectRepository(ModifierOption) private options: Repository<ModifierOption>,
    @InjectRepository(TaxClass) private taxClasses: Repository<TaxClass>,
    @InjectRepository(City) private cities: Repository<City>,
    @InjectRepository(Zone) private zones: Repository<Zone>,
    @InjectRepository(CommissionTier) private tiers: Repository<CommissionTier>,
    @InjectRepository(Incentive) private incentives: Repository<Incentive>,
    @InjectRepository(Order) private orders: Repository<Order>,
  ) {}

  private promotions(): IPromotionsService | null {
    return lazyProvider<IPromotionsService>(this.moduleRef, '../marketing/promotions.service', 'PromotionsService');
  }

  // ------------------------------------------------------------------ commission
  async commissionPct(restaurantId: string, fulfilment: FulfilmentMode): Promise<number> {
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    return this.commissionFor(r, fulfilment);
  }

  /** the rate for this store and method: its override -> its tier -> the tier of its kind of store -> the default tier -> the platform default (see platform/commission.ts) */
  async commissionFor(r: Restaurant | null, fulfilment: FulfilmentMode): Promise<number> {
    return (await resolveCommission(r, methodOf(fulfilment), this.tiers, commissionDefaults(this.settings))).pct;
  }

  // ------------------------------------------------------------------ quote
  async quote(input: QuoteInput): Promise<Quote> {
    const warnings: string[] = [];
    const restaurant = await this.restaurants.findOne({ where: { id: input.restaurantId } });
    if (!restaurant) throw new BadRequestException('Restaurant not found');
    if (!input.items?.length) throw new BadRequestException('Your cart is empty');

    const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : null;
    const at = scheduledFor ?? new Date();
    const tz = await this.availability.timezoneFor(restaurant);

    // --- restaurant open / schedule rules
    const can = await this.availability.canOrderAt(restaurant, scheduledFor);
    if (!can.ok) throw new BadRequestException(can.reason ?? 'Restaurant is not accepting orders');
    if (scheduledFor) await this.checkSchedule(restaurant, scheduledFor);

    // --- fulfilment
    const fulfilment = this.resolveFulfilment(restaurant, input);
    const pickup = fulfilment === FulfilmentMode.PICKUP;
    const type = pickup ? OrderType.PICKUP : OrderType.DELIVERY;

    // --- items
    const lines = await this.priceLines(restaurant, input, at, tz, pickup);
    const profile = profileOf(restaurant.storeType);
    const basket = basketOf(lines);
    // age-restricted goods: the customer confirms their age, and they are never left at the door (ID is checked at hand-over)
    const minAge = lines.reduce((m, l) => Math.max(m, l.minAge ?? 0), 0);
    const ageConfirmationRequired = minAge > 0 && !input.ageConfirmed;
    if (minAge > 0) {
      const names = lines.filter((l) => (l.minAge ?? 0) > 0).map((l) => l.name);
      if (ageConfirmationRequired && input.requireAgeConfirmation !== false) {
        throw new BadRequestException({ message: `You must be at least ${minAge} to order ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and more' : ''}. Confirm your age to continue.`, code: 'AGE_CONFIRMATION_REQUIRED', details: { minAge, items: names } });
      }
      // only a hand-over the customer chose in this very request is refused: a saved "leave at the door" of the address is simply replaced by an in-person hand-over
      if (type === OrderType.DELIVERY && input.dropoffExplicit && input.dropoffMethod === DropoffMethod.LEAVE_AT_DOOR) {
        throw new BadRequestException({ message: 'Orders with age-restricted products are handed over in person (the driver checks ID). Choose "Hand it to me" or "Meet outside".', code: 'ID_CHECK_NO_LEAVE_AT_DOOR', details: { minAge } });
      }
    }
    const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const foodTax = round2(lines.reduce((s, l) => s + l.taxAmount, 0));

    // --- geo / zone / city
    let distanceKm: number | null = null;
    let driveMinutes = 0;
    let deliveryZone: Zone | null = null;
    if (!pickup) {
      const a = input.deliveryAddress;
      if (!a || typeof a.lat !== 'number' || typeof a.lng !== 'number') throw new BadRequestException('A delivery address is required');
      deliveryZone = await this.geo.resolveZone(a.lat, a.lng);
      // Zones and radii exist for driver dispatch. Customers are only held to them when the platform asks for it.
      const limitCustomers = this.settings.get<boolean>('orders.limitCustomersToZones', false);
      if (!deliveryZone && limitCustomers) throw new BadRequestException('Sorry, this address is outside our delivery area');
      if (restaurant.lat != null && restaurant.lng != null) {
        const straight = haversineKm(restaurant.lat, restaurant.lng, a.lat, a.lng);
        // the road distance and drive time: the maps provider when "real road distances" is on (remembered, so the quote, the payment and the order agree), else the built-in estimate
        const est = await this.maps.route({ lat: restaurant.lat, lng: restaurant.lng }, { lat: a.lat, lng: a.lng });
        distanceKm = Math.round(est.km * 1000) / 1000;
        driveMinutes = est.minutes;
        if (limitCustomers) {
          // radius: restaurant's own limit, capped by the zone rules (busy mode may shrink it)
          const zoneForRules = (restaurant.zoneId && (await this.zones.findOne({ where: { id: restaurant.zoneId } }))) || deliveryZone;
          const cityForRules = await this.cityOf(zoneForRules?.cityId ?? restaurant.cityId);
          const eff = this.geo.effective(zoneForRules, cityForRules);
          const cap = zoneForRules?.busyMode && zoneForRules.busyRadiusKm ? zoneForRules.busyRadiusKm : eff.maxRadiusKm;
          const radius = Math.min(restaurant.deliveryRadiusKm || cap, cap);
          if (straight > radius) throw new BadRequestException(`This restaurant delivers within ${radius} km of its location`);
        } else {
          // no zone/radius limit: the customer pays by distance (base fee + per-km fee below); only an absurd distance is refused
          const maxKm = Number(this.settings.get<number>('orders.maxDeliveryDistanceKm', 100));
          if (maxKm > 0 && straight > maxKm) throw new BadRequestException(`This store is too far from that address to deliver (more than ${maxKm} km)`);
        }
      }
    }
    const restaurantZone =
      (restaurant.zoneId && (await this.zones.findOne({ where: { id: restaurant.zoneId } }))) ||
      (restaurant.lat != null && restaurant.lng != null ? await this.geo.resolveZone(restaurant.lat, restaurant.lng) : null);
    const feeZone = restaurantZone ?? deliveryZone;
    const city = await this.cityOf(feeZone?.cityId ?? restaurant.cityId);
    const eff = this.geo.effective(feeZone, city);

    // --- minimum order (delivery)
    if (!pickup) {
      const min = Math.max(restaurant.minimumOrder ?? 0, eff.minimumOrder ?? 0);
      if (subtotal < min) throw new BadRequestException(`Minimum order for delivery is $${min.toFixed(2)} (your subtotal is $${subtotal.toFixed(2)})`);
    }

    // --- fees
    let deliveryFee = 0;
    if (fulfilment === FulfilmentMode.PLATFORM_DRIVER) {
      const raw = eff.baseFee + eff.perKmFee * (distanceKm ?? 0);
      deliveryFee = round2(raw * (eff.busyMultiplier || 1));
      if ((eff.busyMultiplier || 1) > 1) warnings.push('BUSY_PRICING');
    } else if (fulfilment === FulfilmentMode.OWN_DRIVER) {
      deliveryFee = round2(restaurant.ownDeliveryFee ?? 0);
    }
    const serviceFee = round2(Math.min(((city?.serviceFeePct ?? 10) * subtotal) / 100, city?.serviceFeeCap ?? 5));
    const smallThreshold = city?.smallOrderThreshold ?? 15;
    const smallOrderFee = subtotal < smallThreshold ? round2(city?.smallOrderFee ?? 2) : 0;

    // --- promotion
    let evaluation: PromotionEvaluation | null = null;
    const promoSvc = this.promotions();
    if (promoSvc) {
      try {
        evaluation = await promoSvc.evaluate({
          code: input.promoCode?.trim() || undefined,
          customerId: input.customerId,
          restaurantId: restaurant.id,
          cityId: city?.id ?? restaurant.cityId,
          zoneId: feeZone?.id ?? null,
          orderType: type,
          subtotal,
          deliveryFee,
          items: lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, unitPrice: l.unitPrice })),
        });
      } catch (e) {
        if (input.promoCode) throw e; // explicit bad code -> tell the customer
        this.logger.debug(`auto promo skipped: ${(e as Error).message}`);
      }
    } else if (input.promoCode) {
      throw new BadRequestException('Promo codes are not available right now');
    }
    let discountTotal = 0;
    let platformPromoAmount = 0;
    let restaurantPromoAmount = 0;
    if (evaluation) {
      const cap = round2(subtotal + deliveryFee);
      discountTotal = Math.min(round2(evaluation.discountTotal), cap);
      const ratio = evaluation.discountTotal > 0 ? discountTotal / evaluation.discountTotal : 0;
      platformPromoAmount = round2(evaluation.platformAmount * ratio);
      restaurantPromoAmount = round2(discountTotal - platformPromoAmount);
      if (evaluation.restaurantAmount === 0) restaurantPromoAmount = 0;
      if (restaurantPromoAmount === 0) platformPromoAmount = discountTotal;
    }

    // --- tax, commission, total
    const taxClass = await this.defaultTaxRate();
    const tip = Math.min(Math.max(round2(input.tip ?? 0), 0), this.settings.get<number>('orders.maxTip', 200));
    const commissionPct = await this.commissionFor(restaurant, fulfilment);
    const money = computeMoney({
      subtotal,
      foodTax,
      deliveryFee,
      serviceFee,
      smallOrderFee,
      tip,
      discountTotal,
      platformPromoAmount,
      restaurantPromoAmount,
      fulfilment,
      feeTaxRatePct: taxClass,
      taxOnDeliveryFee: this.settings.get<boolean>('taxes.taxOnDeliveryFee', true),
      taxOnFees: this.settings.get<boolean>('taxes.taxOnFees', true),
      commissionPct,
    });

    // --- wallet
    let walletUsed = 0;
    if (input.useWallet && input.customerId && this.settings.get<boolean>('payments.walletEnabled', true)) {
      walletUsed = Math.min(await this.wallet.balance(input.customerId), money.total);
      walletUsed = round2(walletUsed);
    }

    // --- ETA (prep incl. busy mode + kitchen load, drive time, buffer)
    let prepBase = this.availability.prepTime(restaurant, pickup);
    if (profile.retail) {
      // picking a basket takes longer the more is in it: a base time plus seconds per unit (never below the store's own prep time, capped)
      const base = Number(this.settings.get<number>('orders.retail.prepBaseMinutes', 10));
      const perUnit = Number(this.settings.get<number>('orders.retail.prepSecondsPerUnit', 20));
      const cap = Number(this.settings.get<number>('orders.retail.prepMaxMinutes', 90));
      const picking = Math.min(cap, Math.round(base + (basket.units * perUnit) / 60)) + (restaurant.busyExtraPrepMin ?? 0);
      prepBase = Math.max(prepBase, picking);
    }
    const load = await this.orders.count({
      where: { restaurantId: restaurant.id, status: In([OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.DRIVER_ASSIGNED]) },
    });
    const loadExtra = Math.min(15, Math.floor(load / 3) * 2);
    if (loadExtra > 0) warnings.push('KITCHEN_BUSY');
    if (restaurant.busyExtraPrepMin > 0) warnings.push('BUSY_MODE');
    const prepTimeMin = prepBase + loadExtra;
    const buffer = this.settings.get<number>('orders.quotedEtaBufferMin', 5);
    const etaMinutes = pickup ? prepTimeMin : prepTimeMin + driveMinutes + buffer;

    return {
      restaurantId: restaurant.id,
      type,
      fulfilment,
      storeType: restaurant.storeType,
      requiresIdCheck: minAge > 0,
      minAge,
      ageConfirmationRequired,
      dropoffMethod: type === OrderType.DELIVERY ? (minAge > 0 && input.dropoffMethod === DropoffMethod.LEAVE_AT_DOOR ? DropoffMethod.HAND_TO_ME : input.dropoffMethod ?? null) : null,
      basket,
      lines,
      subtotal,
      deliveryFee,
      serviceFee,
      smallOrderFee,
      taxAmount: money.taxAmount,
      tip,
      discountTotal,
      platformPromoAmount,
      restaurantPromoAmount,
      promotion: evaluation ? { id: evaluation.promotion.id, code: evaluation.promotion.code, name: evaluation.promotion.name } : null,
      walletUsed,
      total: money.total,
      distanceKm,
      prepTimeMin,
      etaMinutes,
      zoneId: restaurantZone?.id ?? deliveryZone?.id ?? null,
      cityId: city?.id ?? restaurant.cityId ?? null,
      commissionPct,
      commissionAmount: money.commissionAmount,
      restaurantPayout: money.restaurantPayout,
      warnings,
      availableFulfilment: this.availableFulfilment(restaurant),
    };
  }

  /** What the customer can pick at checkout for this restaurant right now (mode + capability flags). */
  availableFulfilment(r: Restaurant) {
    const av = fulfilmentAvailability(r);
    return { serviceMode: av.serviceMode, serviceModeLabel: av.serviceModeLabel, pickup: av.pickupAvailable, delivery: av.deliveryAvailable, platformDelivery: av.platformDeliveryAvailable, ownDelivery: av.ownDeliveryAvailable };
  }

  private resolveFulfilment(r: Restaurant, input: QuoteInput): FulfilmentMode {
    const av = fulfilmentAvailability(r);
    if (av.serviceMode === RestaurantServiceMode.CLOSED) throw new BadRequestException('This store is closed right now and is not taking orders');
    if (input.type === OrderType.PICKUP) {
      if (!av.pickupAvailable) throw new BadRequestException('This restaurant does not offer pickup');
      return FulfilmentMode.PICKUP;
    }
    if (av.serviceMode === RestaurantServiceMode.PICKUP_ONLY) {
      throw new BadRequestException(
        av.pickupAvailable ? 'This store is pickup only right now. Delivery is unavailable, but you can still order for pickup.' : 'This store is pickup only right now and does not offer pickup',
      );
    }
    const wantsOwn = input.fulfilment === FulfilmentMode.OWN_DRIVER;
    if (input.fulfilment === FulfilmentMode.PICKUP) throw new BadRequestException('Delivery orders cannot use PICKUP fulfilment');
    if (wantsOwn) {
      if (!r.ownDeliveryEnabled) throw new BadRequestException('This restaurant does not deliver with its own drivers');
      return FulfilmentMode.OWN_DRIVER;
    }
    if (r.deliveryEnabled) return FulfilmentMode.PLATFORM_DRIVER;
    if (r.ownDeliveryEnabled) return FulfilmentMode.OWN_DRIVER;
    throw new BadRequestException('This restaurant does not offer delivery');
  }

  private async checkSchedule(r: Restaurant, when: Date) {
    const now = Date.now();
    const lead = (r.scheduleLeadMin ?? 45) * 60_000;
    if (when.getTime() < now + lead) throw new BadRequestException(`Scheduled orders need at least ${r.scheduleLeadMin ?? 45} minutes lead time`);
    const maxDays = this.settings.get<number>('orders.maxScheduleDays', 3);
    if (when.getTime() > now + maxDays * 86_400_000) throw new BadRequestException(`Orders can be scheduled up to ${maxDays} days ahead`);
    const slot = (r.slotMinutes || 15) * 60_000;
    const start = new Date(Math.floor(when.getTime() / slot) * slot);
    const taken = await this.orders
      .createQueryBuilder('o')
      .where('o.restaurantId = :id AND o.isScheduled = true AND o.scheduledFor >= :s AND o.scheduledFor < :e', {
        id: r.id,
        s: start,
        e: new Date(start.getTime() + slot),
      })
      .andWhere('o.status NOT IN (:...gone)', { gone: [OrderStatus.CANCELLED, OrderStatus.REJECTED] })
      .getCount();
    if (taken >= (r.maxOrdersPerSlot ?? 5)) throw new BadRequestException('That time slot is full, please pick another');
  }

  private async cityOf(id?: string | null) {
    if (id) {
      const c = await this.cities.findOne({ where: { id } });
      if (c) return c;
    }
    return null;
  }

  private taxCache: { at: number; rows: TaxClass[] } = { at: 0, rows: [] };
  private async taxRows() {
    if (Date.now() - this.taxCache.at > 30_000) this.taxCache = { at: Date.now(), rows: await this.taxClasses.find({ where: { active: true } }) };
    return this.taxCache.rows;
  }
  private async defaultTaxRate(): Promise<number> {
    const rows = await this.taxRows();
    const code = this.settings.get<string>('taxes.defaultTaxClass', 'HST_ON');
    return (rows.find((t) => t.code === code) ?? rows.find((t) => t.isDefault))?.ratePct ?? DEFAULT_TAX_RATE;
  }

  private async priceLines(r: Restaurant, input: QuoteInput, at: Date, tz: string, pickup: boolean): Promise<QuoteLine[]> {
    const ids = [...new Set(input.items.map((i) => i.menuItemId))];
    const items = await this.menuItems.find({ where: { id: In(ids), restaurantId: r.id } });
    const byId = new Map(items.map((i) => [i.id, i]));
    const catIds = [...new Set(items.map((i) => i.categoryId).filter(Boolean))] as string[];
    const cats = catIds.length ? await this.categories.find({ where: { id: In(catIds) } }) : [];
    const catById = new Map(cats.map((c) => [c.id, c]));
    const links = await this.itemGroups.find({ where: { menuItemId: In(ids) } });
    const groupIds = [...new Set(links.map((l) => l.groupId))];
    const groups = groupIds.length ? await this.groups.find({ where: { id: In(groupIds) } }) : [];
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const opts = groupIds.length ? await this.options.find({ where: { groupId: In(groupIds) } }) : [];
    const optById = new Map(opts.map((o) => [o.id, o]));
    const rows = await this.taxRows();
    const defaultCode = this.settings.get<string>('taxes.defaultTaxClass', 'HST_ON');
    const defaultRate = await this.defaultTaxRate();
    const minutes = zonedParts(at, tz).minutes;
    const profile = profileOf(r.storeType);
    if (input.items.length > profile.limits.maxLines) throw new BadRequestException(`A ${profile.label.toLowerCase()} order can have at most ${profile.limits.maxLines} different ${profile.itemLabelPlural}`);

    const out: QuoteLine[] = [];
    for (const it of input.items) {
      const qty = Math.floor(Number(it.quantity));
      if (!qty || qty < 1 || qty > profile.limits.maxQtyPerLine) throw new BadRequestException(`Item quantity must be between 1 and ${profile.limits.maxQtyPerLine}`);
      const item = byId.get(it.menuItemId);
      if (!item) throw new BadRequestException('An item in your cart is no longer on this restaurant\'s menu');
      if (!this.availability.itemSellable(item, at, tz)) throw new BadRequestException(`"${item.name}" is not available right now`);
      if ((item.minAge ?? 0) > 0 && !this.settings.get<boolean>('restaurant.ageRestricted.enabled', true)) {
        throw new BadRequestException({ message: `"${item.name}" cannot be sold right now`, code: 'AGE_RESTRICTED_DISABLED' });
      }
      const cat = item.categoryId ? catById.get(item.categoryId) : null;
      if (cat && (!cat.active || (cat.dayparts?.length && !cat.dayparts.includes(daypartOf(minutes))))) {
        throw new BadRequestException(`"${item.name}" is not available at this time of day`);
      }
      // modifiers
      const chosen = [...new Set(it.modifierOptionIds ?? [])];
      const itemLinks = links.filter((l) => l.menuItemId === item.id);
      const allowedGroups = new Set(itemLinks.map((l) => l.groupId));
      const mods: QuoteLine['modifiers'] = [];
      const perGroup = new Map<string, number>();
      for (const oid of chosen) {
        const o = optById.get(oid);
        if (!o || !allowedGroups.has(o.groupId)) throw new BadRequestException(`Invalid option selected for "${item.name}"`);
        if (!o.available) throw new BadRequestException(`Option "${o.name}" is unavailable`);
        const g = groupById.get(o.groupId)!;
        perGroup.set(g.id, (perGroup.get(g.id) ?? 0) + 1);
        mods.push({ groupName: g.name, optionId: o.id, name: o.name, priceDelta: o.priceDelta });
      }
      for (const gid of allowedGroups) {
        const g = groupById.get(gid);
        if (!g) continue;
        const n = perGroup.get(gid) ?? 0;
        const min = g.required ? Math.max(1, g.minSelect) : g.minSelect;
        const max = g.maxSelect > 0 ? g.maxSelect : Number.MAX_SAFE_INTEGER;
        if (n < min) throw new BadRequestException(`Please choose ${min > 1 ? `at least ${min}` : 'an option'} for "${g.name}" on "${item.name}"`);
        if (n > max) throw new BadRequestException(`You can choose at most ${max} for "${g.name}" on "${item.name}"`);
      }
      const base = pickup && item.pickupPrice != null ? item.pickupPrice : item.price;
      // weighed products: `price` is per kg / lb and the customer orders steps, so one unit is one step (price x step weight); pieces cost `price` each
      const unitPrice = round2(unitPriceOf(item, base) + mods.reduce((s, m) => s + m.priceDelta, 0));
      const lineTotal = round2(unitPrice * qty);
      const code = item.taxClassCode ?? defaultCode;
      const tc = rows.find((t) => t.code === code);
      const rate = tc ? tc.ratePct : defaultRate;
      out.push({
        menuItemId: item.id,
        name: item.name,
        quantity: qty,
        unitPrice,
        lineTotal,
        taxAmount: round2((lineTotal * rate) / 100),
        taxClassCode: tc?.code ?? code,
        modifiers: mods,
        notes: it.notes?.slice(0, 300),
        stationId: item.stationId,
        allergens: item.allergens ?? [],
        sku: item.sku ?? null,
        barcode: item.barcode ?? null,
        packSize: item.packSize ?? null,
        sellBy: item.sellBy === 'WEIGHT' ? 'WEIGHT' : 'UNIT',
        weightUnit: item.weightUnit ?? 'KG',
        stepSize: item.sellBy === 'WEIGHT' ? Number(item.stepSize) : 1,
        estimatedWeight: item.sellBy === 'WEIGHT' ? estimatedWeight(item, qty) : null,
        minAge: item.minAge ?? 0,
        temperature: item.temperature ?? 'AMBIENT',
        substitution: it.substitution === 'REFUND' ? 'REFUND' : 'ALLOW',
      });
    }

    // what the whole basket takes from the shelves, and the per-order limit, per product (the same product may sit on several lines)
    const used = new Map<string, { use: number; qty: number }>();
    for (const l of out) {
      const item = byId.get(l.menuItemId)!;
      const cur = used.get(item.id) ?? { use: 0, qty: 0 };
      used.set(item.id, { use: cur.use + stockUse(item, l.quantity), qty: cur.qty + l.quantity });
    }
    for (const [id, u] of used) {
      const item = byId.get(id)!;
      if (item.trackStock && u.use > Number(item.stockQty ?? 0) + 1e-9) {
        const left = Number(item.stockQty ?? 0);
        const label = item.sellBy === 'WEIGHT' ? `${left} ${String(item.weightUnit).toLowerCase()}` : String(left);
        throw new BadRequestException({ message: `Only ${label} of "${item.name}" left`, code: 'INSUFFICIENT_STOCK', details: { menuItemId: item.id, name: item.name, available: left } });
      }
      if (item.maxPerOrder && u.qty > item.maxPerOrder) {
        throw new BadRequestException({ message: `You can order at most ${item.maxPerOrder} of "${item.name}"`, code: 'MAX_PER_ORDER', details: { menuItemId: item.id, name: item.name, max: item.maxPerOrder } });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ driver pay
  async driverPay(input: { cityId?: string | null; zoneId?: string | null; pickupKm: number; dropKm: number; waitMin?: number; tip?: number; at?: Date }) {
    const city = input.cityId ? await this.cities.findOne({ where: { id: input.cityId } }) : await this.cities.findOne({ where: { active: true } });
    const at = input.at ?? new Date();
    const km = Math.max(0, input.pickupKm) + Math.max(0, input.dropKm);
    const wait = Math.max(0, (input.waitMin ?? 0) - (city?.driverFreeWaitMin ?? 5)) * (city?.driverPerWaitMin ?? 0.25);
    const raw = (city?.driverBaseFare ?? 3) + (city?.driverPerKm ?? 0.6) * km + wait;
    const base = round2(Math.max(raw, city?.driverMinPerTrip ?? 4.5));

    // active incentives (peak / weather / supply / first-week) - quests are paid separately
    const tz = city?.timezone ?? 'America/Toronto';
    const { dow, minutes } = zonedParts(at, tz);
    const rows = await this.incentives
      .createQueryBuilder('i')
      .where('i.active = true AND i.startsAt <= :at AND i.endsAt >= :at', { at })
      .andWhere("i.type <> 'QUEST'")
      .getMany();
    let boost = 0;
    const toMin = (s: string | null) => (s ? +s.split(':')[0] * 60 + +(s.split(':')[1] || 0) : null);
    for (const inc of rows) {
      if (inc.zoneId && inc.zoneId !== input.zoneId) continue;
      if (inc.cityId && city && inc.cityId !== city.id) continue;
      if (inc.daysOfWeek?.length && !inc.daysOfWeek.includes(dow)) continue;
      const s = toMin(inc.startTime);
      const e = toMin(inc.endTime);
      if (s != null && e != null && !(e > s ? minutes >= s && minutes < e : minutes >= s || minutes < e)) continue;
      boost += inc.amountPerTrip + (base * (inc.percentBoost || 0)) / 100;
    }
    boost = round2(boost);
    return { base, boost, total: round2(base + boost) };
  }
}
