import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { City, DriverLocationLog, DriverOffer, DriverProfile, Order } from '../database/entities';
import { ActorType, FulfilmentMode, OfferStatus, OrderStatus } from '../common/enums';
import { ActorRef, Events, IDispatchService, OrderStatusEvent } from '../common/contracts';
import { haversineKm } from '../common/geo.util';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.module';
import { OrdersService } from '../orders/orders.service';
import { DispatchRankingService } from './dispatch-ranking.service';
import { AcceptanceService } from './acceptance.service';
import { DispatchMeta, RankedCandidate } from './dispatch.types';

const ACTIVE_DISPATCH_STATUSES = [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY];
const ON_TRIP_STATUSES = [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY];
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Offer loop engine (spec 5.4): one driver at a time, 30 s window (per-city `offerTimeoutSec`), scoring via
 * DispatchRankingService, radius widening ring by ring (2/5/10/20/30 km) after `offersBeforeWiden` offers (+ extra pay per km for far drivers), escalation to the
 * dispatcher after the widest ring (`dispatch.radiusRingsKm`) (the search keeps retrying slowly even once escalated).
 * State is persisted at `orders.meta.dispatch` (DispatchMeta) so the loop survives process restarts; `tick()`
 * (every 5 s) drives WAITING -> ACTIVE transitions, offer expiry and retries; accept/decline advance immediately.
 */
@Injectable()
export class DispatchService implements IDispatchService {
  private readonly logger = new Logger('Dispatch');
  private processing = new Set<string>();
  private stationaryAlerted = new Map<string, number>();

  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(DriverOffer) private offers: Repository<DriverOffer>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(DriverLocationLog) private locationLogs: Repository<DriverLocationLog>,
    private ranking: DispatchRankingService,
    private acceptance: AcceptanceService,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private rt: RealtimeService,
    private ordersSvc: OrdersService,
    private events: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------- helpers

  private metaOf(order: Order): DispatchMeta | null {
    return (order.meta?.dispatch as DispatchMeta) ?? null;
  }

  private blankMeta(): DispatchMeta {
    return {
      state: 'STOPPED',
      cycle: 0,
      sequence: 0,
      offersInRound: 0,
      widenings: 0,
      radiusKm: this.ranking.initialRadiusKm(),
      boost: 0,
      manualBoost: 0,
      declinedIds: [],
      offeredIds: [],
      startAt: null,
      nextAttemptAt: null,
      emptyAttempts: 0,
    };
  }

  private async saveMeta(order: Order, d: DispatchMeta) {
    d.updatedAt = new Date().toISOString();
    await this.orders.update(order.id, { meta: { ...(order.meta ?? {}), dispatch: d } as Record<string, any> });
  }

  /** widen the search to the next ring (2, 5, 10, 20, 30 km); returns false when already in the widest one. The extra pay for far drivers is added per offer. */
  private widen(d: DispatchMeta): boolean {
    const next = this.ranking.nextRadiusKm(d.radiusKm);
    if (next === null) return false;
    d.widenings++;
    d.radiusKm = next;
    d.offersInRound = 0;
    d.lastEvent = `WIDENED_R${d.widenings}`;
    return true;
  }

  private async escalateOnce(order: Order, d: DispatchMeta) {
    if (d.escalatedAt) {
      d.state = 'ESCALATED';
      return;
    }
    d.escalatedAt = new Date().toISOString();
    d.state = 'ESCALATED';
    d.lastEvent = 'ESCALATED';
    await this.orders.update(order.id, { unassignedFlag: true }).catch(() => undefined);
    this.rt.emitToOps('dispatch.escalated', { orderId: order.id, code: order.code, radiusKm: d.radiusKm, widenings: d.widenings });
    await this.notifications.notifyOps('order.no_driver', { code: order.code }).catch(() => undefined);
  }

  // ---------------------------------------------------------------------- IDispatchService

  /** minutes before the food is due that the driver search starts (0 = only when the kitchen marks the order ready) */
  private preReadyMinutes(): number {
    return Math.max(0, Number(this.settings.get<number>('dispatch.preReadyMinutes', 5)));
  }

  async startDispatch(orderId: string): Promise<void> {
    const order = await this.orders.findOne({ where: { id: orderId }, relations: ['restaurant'] });
    if (!order) return;
    if (order.fulfilment !== FulfilmentMode.PLATFORM_DRIVER) return;
    if (order.driverId) return;
    if (!ACTIVE_DISPATCH_STATUSES.includes(order.status)) return;

    const existing = this.metaOf(order);
    if (existing && existing.state === 'MANUAL_HOLD') return;

    const autoAssign = this.settings.get<boolean>('dispatch.autoAssign', true);
    const now = new Date();
    const d: DispatchMeta = {
      ...this.blankMeta(),
      state: autoAssign ? 'ACTIVE' : 'MANUAL',
      cycle: (existing?.cycle ?? 0) + 1,
      manualBoost: existing?.manualBoost ?? 0,
      // a driver who declined this order is never re-offered it, even after a restart / re-dispatch
      declinedIds: [...(existing?.declinedIds ?? [])],
      offeredIds: [...(existing?.declinedIds ?? [])],
      startAt: now.toISOString(),
      startedAt: now.toISOString(),
      lastEvent: 'STARTED',
    };
    if (!autoAssign) {
      await this.saveMeta(order, d);
      return;
    }

    // Ready-time matching (spec 5.4): delay the loop so the driver arrives at the restaurant no more than
    // `readyMatchWindowMin` before the food is ready. We peek the nearest current candidate's ETA as a
    // best-effort estimate of "time to find + drive a driver here"; if none are online yet, fall back to a
    // configured assumption rather than blocking dispatch indefinitely.
    // Kitchen already confirmed READY (dispatch.startOn = READY): no artificial wait, the first offer goes out right now.
    if (order.status === OrderStatus.READY) {
      d.lastEvent = 'STARTED_READY';
      await this.saveMeta(order, d);
      await this.advance(order.id);
      return;
    }

    // Owner rule: the driver search starts dispatch.preReadyMinutes (default 5) before the food is due, e.g. ready at 3:20 pm => search from 3:15 pm.
    const readyAt = this.ranking.expectedReadyAt(order, order.restaurant ?? null, now);
    const idealStart = new Date(readyAt.getTime() - this.preReadyMinutes() * 60_000);

    if (idealStart.getTime() > now.getTime() + 15_000) {
      d.state = 'WAITING';
      d.nextAttemptAt = idealStart.toISOString();
      await this.saveMeta(order, d);
      return;
    }
    await this.saveMeta(order, d);
    await this.advance(order.id);
  }

  async cancelDispatch(orderId: string, reason?: string): Promise<void> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) return;
    const d = this.metaOf(order);
    if (!d) return;
    if (d.pendingOfferId) {
      const offer = await this.offers.findOne({ where: { id: d.pendingOfferId } });
      if (offer && offer.status === OfferStatus.PENDING) {
        offer.status = OfferStatus.CANCELLED;
        offer.respondedAt = new Date();
        offer.declineReason = reason ?? 'dispatch_cancelled';
        await this.offers.save(offer);
        this.rt.emitToDriver(offer.driverId, 'driver.offer.cancelled', { offerId: offer.id, orderId, reason: reason ?? 'cancelled' });
        // replaces the ringing push of the offer (same collapse tag) so a closed phone does not keep an obsolete offer
        this.drivers.findOne({ where: { id: offer.driverId }, select: ['id', 'userId'] }).then((dp) => dp?.userId && this.notifications.notify({ userId: dp.userId, audience: 'DRIVER', event: 'driver.offer_cancelled', vars: { restaurant: order.restaurant?.name ?? '' }, data: { offerId: offer.id, orderId } })).catch(() => undefined);
      }
    }
    d.state = 'STOPPED';
    d.pendingOfferId = null;
    d.lastEvent = reason ? `STOPPED:${reason}` : 'STOPPED';
    await this.saveMeta(order, d);
  }

  async acceptOffer(offerId: string, driverId: string): Promise<Order> {
    const offer = await this.offers.findOne({ where: { id: offerId } });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.driverId !== driverId) throw new ForbiddenException('This offer is not yours');
    if (offer.status !== OfferStatus.PENDING) throw new BadRequestException(`Offer already ${offer.status.toLowerCase()}`);
    if (offer.expiresAt.getTime() < Date.now()) {
      offer.status = OfferStatus.EXPIRED;
      offer.respondedAt = new Date();
      await this.offers.save(offer);
      await this.acceptance.recomputeSafe(driverId);
      this.events.emit(Events.OFFER_RESPONDED, { orderId: offer.orderId, driverId, offerId: offer.id, status: 'EXPIRED' });
      this.advance(offer.orderId).catch((e) => this.logger.warn(`advance failed: ${e.message}`));
      throw new BadRequestException('This offer has expired');
    }

    const order = await this.orders.findOne({ where: { id: offer.orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.driverId) throw new BadRequestException('This order already has a driver');

    // atomic claim: a double-tap / parallel accept can only succeed once
    const claim = await this.offers.createQueryBuilder().update(DriverOffer).set({ status: OfferStatus.ACCEPTED, respondedAt: new Date() }).where('id = :id AND status = :p', { id: offerId, p: OfferStatus.PENDING }).execute();
    if (!claim.affected) throw new BadRequestException('Offer already responded to');
    offer.status = OfferStatus.ACCEPTED;
    offer.respondedAt = new Date();

    await this.drivers.increment({ id: driverId }, 'offersAccepted', 1).catch(() => undefined);
    await this.acceptance.recomputeSafe(driverId);
    const driver = await this.drivers.findOne({ where: { id: driverId }, relations: ['user'] });

    const d = this.metaOf(order) ?? this.blankMeta();
    d.state = 'ASSIGNED';
    d.assignedDriverId = driverId;
    d.pendingOfferId = null;
    d.lastEvent = 'ACCEPTED';
    await this.saveMeta(order, d);

    const actor: ActorRef = {
      type: ActorType.DRIVER,
      id: driver?.userId ?? null,
      name: driver ? `${driver.user?.firstName ?? ''} ${driver.user?.lastName ?? ''}`.trim() : undefined,
    };
    const updated = await this.ordersSvc.assignDriver(order.id, driverId, actor, { boost: Number(offer.boostAmount ?? 0) });
    this.events.emit(Events.OFFER_RESPONDED, { orderId: order.id, driverId, offerId: offer.id, status: 'ACCEPTED' });
    return updated;
  }

  async declineOffer(offerId: string, driverId: string, reason?: string): Promise<void> {
    const offer = await this.offers.findOne({ where: { id: offerId } });
    if (!offer) throw new NotFoundException('Offer not found');
    if (offer.driverId !== driverId) throw new ForbiddenException('This offer is not yours');
    if (offer.status !== OfferStatus.PENDING) return;

    offer.status = OfferStatus.DECLINED;
    offer.respondedAt = new Date();
    offer.declineReason = reason ?? null;
    await this.offers.save(offer);

    await this.acceptance.recomputeSafe(driverId);

    const order = await this.orders.findOne({ where: { id: offer.orderId } });
    if (order) {
      const d = this.metaOf(order);
      if (d && d.pendingOfferId === offer.id) {
        d.pendingOfferId = null;
        d.declinedIds = [...d.declinedIds, driverId];
        d.lastEvent = 'DECLINED';
        await this.saveMeta(order, d);
      }
    }

    this.events.emit(Events.OFFER_RESPONDED, { orderId: offer.orderId, driverId, offerId: offer.id, status: 'DECLINED' });
    this.advance(offer.orderId).catch((e) => this.logger.warn(`advance after decline failed: ${e.message}`));
  }

  async currentOffer(driverId: string): Promise<any | null> {
    const offer = await this.offers.findOne({ where: { driverId, status: OfferStatus.PENDING }, order: { sentAt: 'DESC' } });
    if (!offer || offer.expiresAt.getTime() < Date.now()) return null;
    const order = await this.orders.findOne({ where: { id: offer.orderId }, relations: ['restaurant', 'items'] });
    if (!order) return null;
    const carrying = await this.orders.count({ where: { driverId, status: In([OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY]) } });
    return {
      id: offer.id,
      orderId: order.id,
      code: order.code,
      // en-route stacking: the driver is already delivering an order; this one is picked up right after it
      stacked: carrying > 0,
      stackedNote: carrying > 0 ? 'Pick this up after you finish your current delivery' : undefined,
      restaurant: order.restaurant
        ? { id: order.restaurant.id, name: order.restaurant.name, address: order.restaurant.addressLine1, lat: order.restaurant.lat, lng: order.restaurant.lng }
        : null,
      deliveryAddress: order.deliveryAddress,
      itemCount: order.items?.reduce((s, i) => s + i.quantity, 0) ?? 0,
      subtotal: order.subtotal,
      pickupKm: offer.pickupDistanceKm,
      dropKm: offer.dropoffDistanceKm,
      estimatedPay: offer.estimatedPay,
      boostAmount: offer.boostAmount,
      sentAt: offer.sentAt,
      expiresAt: offer.expiresAt,
      secondsLeft: Math.max(0, Math.round((offer.expiresAt.getTime() - Date.now()) / 1000)),
    };
  }

  async candidates(orderId: string, limit = 10): Promise<RankedCandidate[]> {
    const order = await this.orders.findOne({ where: { id: orderId }, relations: ['restaurant'] });
    if (!order) throw new NotFoundException('Order not found');
    return this.ranking.rank(order, { includeIneligible: true, limit });
  }

  /** Dispatcher (admin live map) manual assign / reassign - stops any running offer loop first. */
  async assignManually(orderId: string, driverId: string, actor: ActorRef, opts: { boost?: number } = {}): Promise<Order> {
    await this.cancelDispatch(orderId, 'manual_assign');
    const updated = await this.ordersSvc.assignDriver(orderId, driverId, actor, opts);
    const d = this.metaOf(updated) ?? this.blankMeta();
    d.state = 'ASSIGNED';
    d.assignedDriverId = driverId;
    d.pendingOfferId = null;
    d.lastEvent = 'MANUAL_ASSIGN';
    await this.saveMeta(updated, d);
    return updated;
  }

  // ---------------------------------------------------------------------- the loop itself

  /** One step of the offer loop for an order: expire a stale pending offer, widen/escalate as needed, send the next offer. */
  private async advance(orderId: string): Promise<void> {
    if (this.processing.has(orderId)) return;
    this.processing.add(orderId);
    try {
      const order = await this.orders.findOne({ where: { id: orderId }, relations: ['restaurant'] });
      if (!order) return;
      if (order.driverId) return; // assigned through some other path already
      if (!ACTIVE_DISPATCH_STATUSES.includes(order.status)) return;

      const d = this.metaOf(order);
      if (!d || d.state === 'STOPPED' || d.state === 'MANUAL' || d.state === 'MANUAL_HOLD' || d.state === 'ASSIGNED') return;

      // expire the current pending offer (if any and due)
      if (d.pendingOfferId) {
        const offer = await this.offers.findOne({ where: { id: d.pendingOfferId } });
        if (offer && offer.status === OfferStatus.PENDING) {
          if (offer.expiresAt.getTime() > Date.now()) return; // still within its window, nothing to do this tick
          offer.status = OfferStatus.EXPIRED;
          offer.respondedAt = new Date();
          await this.offers.save(offer);
          await this.acceptance.recomputeSafe(offer.driverId);
          this.events.emit(Events.OFFER_RESPONDED, { orderId: order.id, driverId: offer.driverId, offerId: offer.id, status: 'EXPIRED' });
          this.rt.emitToDriver(offer.driverId, 'driver.offer.cancelled', { offerId: offer.id, orderId: order.id, reason: 'expired' });
        }
        d.pendingOfferId = null;
      }

      const city = await this.ranking.city(order.cityId ?? order.restaurant?.cityId ?? null);

      // ready-time WAITING gate
      if (d.state === 'WAITING') {
        const idealStart = new Date(this.ranking.expectedReadyAt(order, order.restaurant ?? null).getTime() - this.preReadyMinutes() * 60_000);
        d.nextAttemptAt = idealStart.toISOString();
        if (idealStart.getTime() > Date.now() + 1000) {
          await this.saveMeta(order, d);
          return;
        }
        d.state = 'ACTIVE';
      }

      // escalated slow-retry pacing
      if (d.state === 'ESCALATED' && d.nextAttemptAt && new Date(d.nextAttemptAt).getTime() > Date.now()) {
        await this.saveMeta(order, d);
        return;
      }

      let candidate: RankedCandidate | null = null;
      const maxLoops = this.ranking.radiusRings().length + 1;
      for (let i = 0; i < maxLoops; i++) {
        if (d.offersInRound >= city.offersBeforeWiden) {
          if (!this.widen(d)) {
            await this.escalateOnce(order, d);
            break;
          }
        }
        const ranked = await this.ranking.rank(order, { radiusKm: d.radiusKm, excludeIds: d.offeredIds, limit: 1, boost: d.boost });
        if (ranked.length) {
          candidate = ranked[0];
          break;
        }
        d.emptyAttempts++;
        if (!this.widen(d)) {
          await this.escalateOnce(order, d);
          break;
        }
      }

      if (!candidate) {
        d.nextAttemptAt = new Date(Date.now() + Number(this.settings.get('dispatch.escalatedRetrySec', 45)) * 1000).toISOString();
        await this.saveMeta(order, d);
        return;
      }

      d.sequence++;
      d.offersInRound++;
      const timeoutSec = Number(city.offerTimeoutSec) || 30;
      const expiresAt = new Date(Date.now() + timeoutSec * 1000);
      const offer = await this.offers.save(
        this.offers.create({
          orderId: order.id,
          driverId: candidate.driverId,
          status: OfferStatus.PENDING,
          sequence: d.sequence,
          round: d.widenings,
          sentAt: new Date(),
          expiresAt,
          pickupDistanceKm: candidate.distanceKm,
          dropoffDistanceKm: candidate.dropKm,
          estimatedPay: candidate.estimatedPay,
          boostAmount: round2(d.boost + d.manualBoost + candidate.distanceExtra),
          score: candidate.score,
          scoreBreakdown: candidate.breakdown,
        }),
      );
      d.pendingOfferId = offer.id;
      d.offeredIds = [...d.offeredIds, candidate.driverId];
      d.nextAttemptAt = null;
      d.lastEvent = 'OFFER_SENT';
      await this.saveMeta(order, d);

      await this.drivers.update(candidate.driverId, { lastOfferAt: new Date() }).catch(() => undefined);
      await this.drivers.increment({ id: candidate.driverId }, 'offersReceived', 1).catch(() => undefined);

      const restaurantName = order.restaurant?.name ?? '';
      this.rt.emitToDriver(candidate.driverId, 'driver.offer', {
        offerId: offer.id,
        orderId: order.id,
        code: order.code,
        restaurant: restaurantName,
        pickupKm: candidate.distanceKm,
        dropKm: candidate.dropKm,
        estimatedPay: candidate.estimatedPay,
        expiresAt: expiresAt.toISOString(),
        seconds: timeoutSec,
        // what the driver is picking up (groceries: many bags, cold chain, ID check at the door)
        storeType: order.restaurant?.storeType ?? null,
        basket: order.basket ?? null,
        requiresIdCheck: !!order.requiresIdCheck,
        minAge: order.minAge ?? 0,
      });
      this.rt.emitToOps('dispatch.offer_sent', {
        orderId: order.id,
        code: order.code,
        driverId: candidate.driverId,
        sequence: d.sequence,
        radiusKm: d.radiusKm,
        widenings: d.widenings,
        escalated: d.state === 'ESCALATED',
      });

      const driver = await this.drivers.findOne({ where: { id: candidate.driverId }, relations: ['user'] });
      if (driver?.userId) {
        await this.notifications
          .notify({
            userId: driver.userId,
            audience: 'DRIVER',
            event: 'driver.offer',
            vars: { restaurant: restaurantName, pickupKm: candidate.distanceKm, dropKm: candidate.dropKm, pay: `$${candidate.estimatedPay.toFixed(2)}`, seconds: timeoutSec },
            data: { offerId: offer.id, orderId: order.id, seconds: timeoutSec, expiresAt: expiresAt.toISOString() },
          })
          .catch(() => undefined);
      }
    } catch (e: any) {
      this.logger.warn(`advance(${orderId}) failed: ${e.message}`);
    } finally {
      this.processing.delete(orderId);
    }
  }

  /** Drives WAITING -> ACTIVE starts, offer expiry, widening/escalation retries. Accept/decline advance immediately on their own. */
  @Interval(5000)
  async tick() {
    try {
      const rows = await this.orders
        .createQueryBuilder('o')
        .select(['o.id'])
        .where('o.fulfilment = :f', { f: FulfilmentMode.PLATFORM_DRIVER })
        .andWhere('o.driverId IS NULL')
        .andWhere('o.status IN (:...st)', { st: ACTIVE_DISPATCH_STATUSES })
        .andWhere(`o.meta -> 'dispatch' ->> 'state' IN ('WAITING','ACTIVE','ESCALATED')`)
        .getMany();
      for (const r of rows) this.advance(r.id).catch((e) => this.logger.warn(`advance(${r.id}) failed: ${e.message}`));
    } catch (e: any) {
      this.logger.warn(`dispatch tick failed: ${e.message}`);
    }
  }

  /** Flags a driver who has not moved meaningfully while on a trip (spec: dispatcher acts on stalled drivers). */
  @Interval(120_000)
  async checkStationaryDrivers() {
    try {
      const thresholdMin = Number(this.settings.get('dispatch.driverMissingAlertMin', 10));
      const onTrip = await this.orders.find({ where: { status: In(ON_TRIP_STATUSES) }, select: ['id', 'driverId', 'code'] });
      const withDriver = onTrip.filter((o) => o.driverId);
      const since = new Date(Date.now() - thresholdMin * 60_000);
      for (const o of withDriver) {
        const driverId = o.driverId as string;
        const lastAlert = this.stationaryAlerted.get(driverId) ?? 0;
        if (Date.now() - lastAlert < 15 * 60_000) continue;
        const logs = await this.locationLogs.find({ where: { driverId, createdAt: MoreThan(since) }, order: { createdAt: 'ASC' } });
        if (logs.length < 2) continue;
        const spanMin = (logs[logs.length - 1].createdAt.getTime() - logs[0].createdAt.getTime()) / 60_000;
        if (spanMin < thresholdMin * 0.8) continue;
        const maxSpreadKm = Math.max(...logs.map((l) => haversineKm(logs[0].lat, logs[0].lng, l.lat, l.lng)));
        if (maxSpreadKm < 0.05) {
          this.stationaryAlerted.set(driverId, Date.now());
          this.rt.emitToOps('driver.stationary', { driverId, orderId: o.id, code: o.code, minutes: thresholdMin });
          await this.notifications.notifyOps('order.stuck', { code: o.code, reason: `Driver appears stationary for ${thresholdMin}+ minutes` }).catch(() => undefined);
        }
      }
    } catch (e: any) {
      this.logger.warn(`stationary check failed: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------------- reactions to the order lifecycle

  @OnEvent(Events.ORDER_STATUS_CHANGED)
  async onOrderStatusChanged(payload: OrderStatusEvent) {
    try {
      if (payload.order.fulfilment !== FulfilmentMode.PLATFORM_DRIVER) return;
      // dispatch.startOn: READY (default) = search starts only once the kitchen confirms the food is ready; ACCEPTED = legacy
      const legacyAccepted = String(this.settings.get('dispatch.startOn', 'READY')).toUpperCase() === 'ACCEPTED';
      if (this.preReadyMinutes() > 0 && !legacyAccepted) {
        // accepted: arm the search for (ready time - lead); ready: make sure it is running now (promote a waiting search, or start one that never started)
        if (payload.to === OrderStatus.ACCEPTED) await this.startDispatch(payload.order.id);
        else if (payload.to === OrderStatus.READY) {
          const o = await this.orders.findOne({ where: { id: payload.order.id } });
          const d = o ? this.metaOf(o) : null;
          if (!o || o.driverId) return;
          if (!d || d.state === 'STOPPED') await this.startDispatch(o.id);
          else if (d.state === 'WAITING') await this.advance(o.id); // ready time reached: the gate above lets it through
        }
        return;
      }
      const startOn = legacyAccepted ? OrderStatus.ACCEPTED : OrderStatus.READY;
      if (payload.to === startOn) await this.startDispatch(payload.order.id);
    } catch (e: any) {
      this.logger.warn(`onOrderStatusChanged failed: ${e.message}`);
    }
  }

  /** A driver was removed from an order (OrdersService.unassignDriver with redispatch) -> search again (previous decliners excluded). */
  @OnEvent(Events.DRIVER_UNASSIGNED)
  async onDriverUnassigned(payload: { orderId: string; driverId: string }) {
    try {
      const order = await this.orders.findOne({ where: { id: payload.orderId } });
      if (!order || order.driverId || order.fulfilment !== FulfilmentMode.PLATFORM_DRIVER) return;
      const d = this.metaOf(order);
      if (d) {
        d.state = 'STOPPED';
        d.assignedDriverId = null;
        d.declinedIds = [...new Set([...(d.declinedIds ?? []), payload.driverId])];
        await this.saveMeta(order, d);
      }
      // READY (or later): search right away; earlier statuses wait for the configured trigger
      const startOn = String(this.settings.get('dispatch.startOn', 'READY')).toUpperCase();
      if (order.status === OrderStatus.READY || startOn === 'ACCEPTED' || this.preReadyMinutes() > 0) await this.startDispatch(order.id);
    } catch (e: any) {
      this.logger.warn(`onDriverUnassigned failed: ${e.message}`);
    }
  }

  @OnEvent(Events.ORDER_CANCELLED)
  async onOrderCancelled(payload: OrderStatusEvent) {
    try {
      await this.cancelDispatch(payload.order.id, payload.order.cancelReason ?? payload.order.rejectReason ?? 'order_ended');
    } catch (e: any) {
      this.logger.warn(`onOrderCancelled failed: ${e.message}`);
    }
  }
}
