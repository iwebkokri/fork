import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { City, DriverOffer, DriverProfile, Order, OrderItem, Restaurant } from '../database/entities';
import { DriverStatus, OfferStatus, OrderStatus, VehicleType } from '../common/enums';
import { haversineKm, haversineSql, roadEstimate } from '../common/geo.util';
import { SettingsService } from '../settings/settings.service';
import { LazyServices } from './lazy';
import { batchCompatible, DEFAULT_WEIGHTS, scoreCandidate, ScoreWeights, vehicleSpeedKmh } from './scoring';
import { RankedCandidate } from './dispatch.types';

/** No driver ever carries more than this many orders at once (owner rule). */
export const HARD_MAX_ORDERS_PER_DRIVER = 2;
/** minutes to hand over the first order before heading to the next pickup */
const STACK_HANDOVER_MIN = 2;

const ACTIVE_TRIP_STATUSES = [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY];
const DEFAULT_RADIUS_RINGS_KM = [2, 5, 10, 20, 30];
/** time the driver needs to read + accept the offer before heading out (min) */
const ACCEPT_BUFFER_MIN = 0.5;

export interface RankOptions {
  radiusKm?: number;
  excludeIds?: string[];
  /** also return drivers that failed a hard rule (offline, wrong zone, too far, ...) with their reasons */
  includeIneligible?: boolean;
  limit?: number;
  now?: Date;
  /** dispatch boost to add to the estimated pay */
  boost?: number;
}

/** Candidate selection + scoring engine (spec 5.4). */
@Injectable()
export class DispatchRankingService {
  private lazy: LazyServices;

  constructor(
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(DriverOffer) private offers: Repository<DriverOffer>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderItem) private items: Repository<OrderItem>,
    @InjectRepository(City) private cities: Repository<City>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    private settings: SettingsService,
    moduleRef: ModuleRef,
  ) {
    this.lazy = new LazyServices(moduleRef);
  }

  get weights(): ScoreWeights {
    return { ...DEFAULT_WEIGHTS, ...(this.settings.get<Partial<ScoreWeights>>('dispatch.weights', {}) ?? {}) };
  }

  async city(cityId: string | null): Promise<City> {
    const c = cityId ? await this.cities.findOne({ where: { id: cityId } }) : null;
    return c ?? this.cities.create({ offerTimeoutSec: 30, offersBeforeWiden: 3, maxRadiusWidenings: 2, radiusWidenStepKm: 2, widenBoostAmount: 2, batchMaxOrders: 2, batchMaxDropDistanceKm: 1.5, batchMaxExtraMinutes: 10, driverBaseFare: 3, driverPerKm: 0.6, driverMinPerTrip: 4.5 });
  }

  /** The search rings, nearest first (default 2, 5, 10, 20, 30 km): the search starts in the first and widens to the next when nobody nearer takes the order. */
  radiusRings(): number[] {
    const raw = this.settings.get<unknown>('dispatch.radiusRingsKm', DEFAULT_RADIUS_RINGS_KM);
    const rings = (Array.isArray(raw) ? raw : []).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 200);
    const clean = [...new Set(rings)].sort((x, y) => x - y);
    return clean.length ? clean : DEFAULT_RADIUS_RINGS_KM;
  }

  initialRadiusKm(): number {
    return this.radiusRings()[0];
  }

  /** The next ring wider than `radiusKm`, or null when the search is already in the widest one. */
  nextRadiusKm(radiusKm: number): number | null {
    return this.radiusRings().find((r) => r > radiusKm + 1e-9) ?? null;
  }

  /**
   * Extra pay for a driver who is not nearby: `dispatch.extraPerKm` ($) for every km of the pickup distance beyond `dispatch.extraFreeKm`
   * (default: the first ring). It is part of the offer, shown to the driver, and paid on top of the normal driver fee.
   */
  distanceExtra(pickupKm: number): number {
    const perKm = Math.max(0, Number(this.settings.get('dispatch.extraPerKm', 0.18)) || 0);
    const free = Math.max(0, Number(this.settings.get('dispatch.extraFreeKm', this.initialRadiusKm())));
    return Math.round(Math.max(0, pickupKm - free) * perKm * 100) / 100;
  }

  /** When the food is (expected to be) ready. */
  expectedReadyAt(order: Order, restaurant: Restaurant | null, now = new Date()): Date {
    if (order.status === OrderStatus.READY) return order.readyAt ? new Date(order.readyAt) : now;
    if (order.estimatedReadyAt) return new Date(order.estimatedReadyAt);
    const prep = order.prepTimeMin ?? restaurant?.prepTimeMin ?? 15;
    const base = order.acceptedAt ? new Date(order.acceptedAt) : now;
    return new Date(base.getTime() + prep * 60_000);
  }

  async estimatePay(order: Order, city: City, pickupKm: number, dropKm: number, dispatchBoost = 0) {
    let base = Math.max(Number(city.driverMinPerTrip ?? 0), Number(city.driverBaseFare ?? 0) + Number(city.driverPerKm ?? 0) * (pickupKm + dropKm));
    let boost = 0;
    const pricing = this.lazy.pricing;
    if (pricing) {
      try {
        const r = await pricing.driverPay({ cityId: order.cityId, zoneId: order.zoneId, pickupKm, dropKm, waitMin: 0, at: new Date() });
        base = r.base;
        boost = r.boost;
      } catch {
        /* fall back to local computation */
      }
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return { base: r2(base), boost: r2(boost + dispatchBoost), total: r2(base + boost + dispatchBoost) };
  }

  /** Ranked drivers for an order. Eligible drivers first (by score), ineligible ones (if requested) after. */
  async rank(order: Order, opts: RankOptions = {}): Promise<RankedCandidate[]> {
    const now = opts.now ?? new Date();
    const restaurant = order.restaurant ?? (await this.restaurants.findOne({ where: { id: order.restaurantId } }));
    if (!restaurant || restaurant.lat == null || restaurant.lng == null) return [];
    const city = await this.city(order.cityId ?? restaurant.cityId);
    const radiusKm = opts.radiusKm ?? this.initialRadiusKm();
    const drop = order.deliveryAddress;
    const dropRoad = order.distanceKm != null
      ? Number(order.distanceKm)
      : drop?.lat != null
        ? roadEstimate(restaurant.lat, restaurant.lng, drop.lat, drop.lng).km
        : 3;
    const readyAt = this.expectedReadyAt(order, restaurant, now);
    const w = this.weights;
    const readyWindow = Number(this.settings.get('dispatch.readyMatchWindowMin', 2));
    const bike = { maxKm: Number(this.settings.get('dispatch.bikeMaxDistanceKm', 4)), maxSubtotal: Number(this.settings.get('dispatch.bikeMaxSubtotal', 80)) };
    const freshSec = Number(this.settings.get('dispatch.locationFreshSec', 120));
    const batching = await this.batchingEnabled(order.cityId);
    const stack = this.stackingConfig();
    const itemCount = Number((await this.items.sum('quantity', { orderId: order.id, removed: false })) ?? 0) || 1;

    const qb = this.drivers
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.user', 'u')
      .where('d.status = :st', { st: DriverStatus.ACTIVE })
      .andWhere('d.lat IS NOT NULL AND d.lng IS NOT NULL')
      .setParameters({ lat: restaurant.lat, lng: restaurant.lng });
    if (opts.excludeIds?.length) qb.andWhere('d.id NOT IN (:...ex)', { ex: opts.excludeIds });
    if (opts.includeIneligible) {
      qb.orderBy(haversineSql('d.lat', 'd.lng'), 'ASC').limit(80);
    } else {
      qb.andWhere('d.isOnline = true')
        .andWhere('d.lastLocationAt >= :fresh', { fresh: new Date(now.getTime() - freshSec * 1000) })
        .andWhere(`${haversineSql('d.lat', 'd.lng')} <= :maxKm`, { maxKm: radiusKm });
    }
    const drivers = await qb.getMany();
    if (!drivers.length) return [];
    const ids = drivers.map((d) => d.id);

    const [active, pending] = await Promise.all([
      this.orders.find({ where: { driverId: In(ids), status: In(ACTIVE_TRIP_STATUSES) }, relations: ['restaurant'] }),
      this.offers
        .createQueryBuilder('o')
        .where('o.driverId IN (:...ids)', { ids })
        .andWhere('o.status = :p AND o.expiresAt > :now AND o.orderId != :oid', { p: OfferStatus.PENDING, now, oid: order.id })
        .getMany(),
    ]);
    const activeBy = new Map<string, Order[]>();
    active.forEach((o) => activeBy.set(o.driverId, [...(activeBy.get(o.driverId) ?? []), o]));
    const busy = new Set(pending.map((p) => p.driverId));

    const out: RankedCandidate[] = [];
    for (const d of drivers) {
      const reasons: string[] = [];
      const straight = haversineKm(d.lat, d.lng, restaurant.lat, restaurant.lng);
      let est = roadEstimate(d.lat, d.lng, restaurant.lat, restaurant.lng, vehicleSpeedKmh(d.vehicleType));
      if (!d.isOnline) reasons.push('OFFLINE');
      if (!d.lastLocationAt || now.getTime() - new Date(d.lastLocationAt).getTime() > freshSec * 1000) reasons.push('STALE_LOCATION');
      if (order.zoneId ? !(d.zoneIds ?? []).includes(order.zoneId) : !!order.cityId && !!d.cityId && d.cityId !== order.cityId) reasons.push('NOT_APPROVED_FOR_ZONE');
      if (straight > radiusKm) reasons.push('OUT_OF_RADIUS');
      if (busy.has(d.id)) reasons.push('HAS_PENDING_OFFER');

      const mine = activeBy.get(d.id) ?? [];
      let compatible = false;
      if (mine.length && batching && mine.length < city.batchMaxOrders) {
        const e = mine[0];
        if (e.restaurant?.lat != null && e.deliveryAddress?.lat != null && drop?.lat != null) {
          compatible = batchCompatible(
            { restaurantLat: e.restaurant.lat, restaurantLng: e.restaurant.lng, dropLat: e.deliveryAddress.lat, dropLng: e.deliveryAddress.lng, pickedUp: [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(e.status) },
            { restaurantLat: restaurant.lat, restaurantLng: restaurant.lng, dropLat: drop.lat, dropLng: drop.lng, pickedUp: false },
            { maxDropKm: Number(city.batchMaxDropDistanceKm), maxExtraMin: city.batchMaxExtraMinutes },
          ).ok;
        }
      }
      // EN-ROUTE STACKING: a driver who already has the first order in the car (heading to its drop-off B) can take a second order whose pickup is
      // near B, to be collected right after that delivery. Never more than stack.max (hard cap 2) orders per driver; the first order is never delayed.
      let stackOk = false;
      if (mine.length >= HARD_MAX_ORDERS_PER_DRIVER) reasons.push('MAX_ORDERS_REACHED');
      else if (mine.length === 1 && stack.enabled && mine.length < stack.max) {
        const e = mine[0];
        const first = e.deliveryAddress;
        if ([OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(e.status) && first?.lat != null && first?.lng != null) {
          const speed = vehicleSpeedKmh(d.vehicleType);
          const leg1 = roadEstimate(d.lat, d.lng, Number(first.lat), Number(first.lng), speed); // to the first customer
          const leg2 = roadEstimate(Number(first.lat), Number(first.lng), restaurant.lat, restaurant.lng, speed); // from there to the new restaurant
          const lateMin = (now.getTime() + (ACCEPT_BUFFER_MIN + leg1.minutes + STACK_HANDOVER_MIN + leg2.minutes) * 60_000 - readyAt.getTime()) / 60_000;
          if (leg2.km <= stack.maxPickupFromDropKm && lateMin <= stack.maxLateMin) {
            stackOk = true;
            est = { km: leg1.km + leg2.km, minutes: leg1.minutes + STACK_HANDOVER_MIN + leg2.minutes };

          } else {
            reasons.push(leg2.km > stack.maxPickupFromDropKm ? 'STACK_PICKUP_TOO_FAR_FROM_DROP' : 'STACK_WOULD_ARRIVE_LATE');
          }
        }
      }
      const arrivalMs = now.getTime() + (ACCEPT_BUFFER_MIN + est.minutes) * 60_000;
      const slackMin = (readyAt.getTime() - arrivalMs) / 60_000;
      const lastOffer = d.lastOfferAt ? (now.getTime() - new Date(d.lastOfferAt).getTime()) / 60_000 : null;
      const s = scoreCandidate(
        {
          radiusKm: Math.max(radiusKm, 1),
          pickupRoadKm: est.km,
          pickupEtaMin: est.minutes,
          dropRoadKm: dropRoad,
          slackMin,
          readyWindowMin: readyWindow,
          vehicleType: d.vehicleType ?? VehicleType.CAR,
          orderSubtotal: Number(order.subtotal ?? 0),
          itemCount,
          bike,
          activeOrders: mine.length,
          batchingEnabled: batching || stackOk,
          batchMaxOrders: stackOk ? stack.max : city.batchMaxOrders,
          batchCompatible: compatible || stackOk,
          acceptanceRate: Number(d.acceptanceRate ?? this.settings.get('dispatch.acceptance.priorRate', 90)),
          acceptanceLowThreshold: Number(this.settings.get('dispatch.acceptance.lowThreshold', 50)),
          onTimeRate: Number(d.onTimeRate ?? 100),
          rating: Number(d.rating ?? 5),
          minutesSinceLastOffer: lastOffer,
        },
        w,
      );
      const all = [...reasons, ...s.reasons];
      const distanceExtra = this.distanceExtra(est.km);
      const pay = await this.estimatePay(order, city, est.km, dropRoad, (opts.boost ?? 0) + distanceExtra);
      out.push({
        driverId: d.id,
        userId: d.userId,
        name: `${d.user?.firstName ?? ''} ${d.user?.lastName ?? ''}`.trim() || 'Driver',
        phone: d.user?.phone ?? null,
        vehicleType: d.vehicleType,
        lat: d.lat,
        lng: d.lng,
        distanceKm: Math.round(est.km * 100) / 100,
        etaMin: est.minutes,
        dropKm: Math.round(dropRoad * 100) / 100,
        estimatedPay: pay.total,
        distanceExtra,
        score: s.score,
        breakdown: s.breakdown,
        factors: s.factors,
        eligible: all.length === 0,
        reasons: all,
        activeOrders: mine.length,
        onTrip: d.onTrip || mine.length > 0,
        lastOfferAt: d.lastOfferAt,
        lastLocationAt: d.lastLocationAt,
      });
    }
    let res = opts.includeIneligible ? out : out.filter((c) => c.eligible);
    res.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.distanceKm - b.distanceKm);
    if (opts.limit) res = res.slice(0, opts.limit);
    return res;
  }

  /** En-route stacking settings (System > Platform Settings > dispatch). The per-driver cap can be lowered but never raised above 2. */
  stackingConfig() {
    return {
      enabled: this.settings.get<boolean>('dispatch.stacking.enabled', true),
      max: Math.min(HARD_MAX_ORDERS_PER_DRIVER, Math.max(1, Number(this.settings.get<number>('dispatch.stacking.maxOrdersPerDriver', 2)))),
      maxPickupFromDropKm: Number(this.settings.get<number>('dispatch.stacking.maxPickupFromDropKm', 3)),
      maxLateMin: Number(this.settings.get<number>('dispatch.stacking.maxLateMin', 10)),
    };
  }

  async batchingEnabled(cityId?: string | null): Promise<boolean> {
    try {
      return (await this.settings.isFeatureEnabled('order_batching', cityId ?? undefined)) || this.settings.get<boolean>('dispatch.batching.enabled', false) === true;
    } catch {
      return false;
    }
  }
}
