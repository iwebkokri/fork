import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { ActorType, FulfilmentMode, OfferStatus, OrderStatus } from '../common/enums';
import { haversineKm, roadEstimate } from '../common/geo.util';
import { DriverOffer, Order } from '../database/entities';
import { OrdersService } from '../orders/orders.service';
import { DriverCoreService } from './driver-core.service';

/** What is stored on `orders.meta.presence` while a driver is on the way to the restaurant. */
export interface PresenceState {
  /** minutes the pickup run should take, worked out when the check first sees the order (from the accepted offer's pickup distance) */
  expectedMin: number;
  /** when to ask next, ISO; before the first question this is assignment time + multiplier x expectedMin */
  dueAt: string;
  /** the open question, if any */
  check?: { askedAt: string; deadlineAt: string } | null;
}

const BEFORE_PICKUP = [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY];
const SPEED_KMH = 28; // same average the ETA engine assumes (driver-location.service.ts)
const NEAR_KM = 0.15; // already at the restaurant: arrival detection will take care of it

/**
 * "Are you still on your way?" watchdog.
 *
 * A driver who accepts an order and is, say, 3 minutes from the restaurant is expected there in about 3 minutes. If the
 * driver has not arrived after `driver.presence.multiplier` x that time (default 2x), the driver app is asked to confirm
 * over the socket (`driver.presence_check`) and by push. The driver has `driver.presence.confirmSeconds` (default 90) to
 * answer with `POST /driver/trip/:orderId/still-here`. No answer: the order is unassigned and goes back to dispatch to be
 * offered to someone else (the existing redispatch path, previous decliners excluded). A driver who confirms is asked
 * again after another expected-pickup interval if still not there.
 *
 * Settings (all optional): driver.presence.enabled (true), .multiplier (2), .minMinutes (2), .confirmSeconds (90).
 */
@Injectable()
export class DriverPresenceService {
  private readonly logger = new Logger('DriverPresence');
  private running = false;

  constructor(
    private core: DriverCoreService,
    private ordersService: OrdersService,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(DriverOffer) private offers: Repository<DriverOffer>,
  ) {}

  private cfg() {
    const s = this.core.settings;
    return {
      enabled: s.get<boolean>('driver.presence.enabled', true) !== false,
      multiplier: Math.max(1.2, Number(s.get<number>('driver.presence.multiplier', 2))),
      minMinutes: Math.max(1, Number(s.get<number>('driver.presence.minMinutes', 2))),
      confirmMs: Math.max(20, Number(s.get<number>('driver.presence.confirmSeconds', 90))) * 1000,
    };
  }

  @Cron('*/20 * * * * *')
  async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.cfg().enabled) return;
      const rows = await this.orders.find({
        where: { status: In(BEFORE_PICKUP), driverId: Not(IsNull()), fulfilment: FulfilmentMode.PLATFORM_DRIVER, driverArrivedRestaurantAt: IsNull() },
        relations: ['restaurant'],
        take: 300,
      });
      for (const o of rows) await this.check(o).catch((e) => this.logger.warn(`order ${o.code}: ${e.message}`));
    } finally {
      this.running = false;
    }
  }

  private async save(orderId: string, presence: PresenceState | null) {
    // re-read just before writing so other writers of `meta` (dispatch state, handoff) are not overwritten
    const fresh = await this.orders.findOne({ where: { id: orderId }, select: ['id', 'meta'] });
    if (!fresh) return;
    const meta = { ...(fresh.meta ?? {}) };
    if (presence) meta.presence = presence;
    else delete meta.presence;
    await this.orders.update({ id: orderId }, { meta });
  }

  /** Minutes the pickup run should take: from the accepted offer's pickup distance, else from the driver's current position. */
  private async expectedMinutes(o: Order, minMinutes: number): Promise<number> {
    const offer = await this.offers.findOne({ where: { orderId: o.id, driverId: o.driverId!, status: OfferStatus.ACCEPTED }, order: { respondedAt: 'DESC' } });
    let minutes: number | null = offer?.pickupDistanceKm != null ? Math.ceil((Number(offer.pickupDistanceKm) / SPEED_KMH) * 60) : null;
    if (minutes == null) {
      const d = await this.core.profiles.findOne({ where: { id: o.driverId! }, select: ['id', 'lat', 'lng'] });
      const r = o.restaurant;
      if (d?.lat != null && d.lng != null && r?.lat != null && r.lng != null) minutes = roadEstimate(d.lat, d.lng, r.lat, r.lng, SPEED_KMH).minutes;
    }
    return Math.max(minMinutes, minutes ?? minMinutes);
  }

  private async check(o: Order) {
    if (!o.driverAssignedAt || !o.driverId) return;
    const cfg = this.cfg();
    const now = Date.now();
    let st = (o.meta?.presence ?? null) as PresenceState | null;

    if (!st) {
      const expectedMin = await this.expectedMinutes(o, cfg.minMinutes);
      st = { expectedMin, dueAt: new Date(new Date(o.driverAssignedAt).getTime() + cfg.multiplier * expectedMin * 60_000).toISOString(), check: null };
      await this.save(o.id, st);
    }

    // an open question: wait for the answer, or take the order away when the time is up
    if (st.check) {
      if (now < new Date(st.check.deadlineAt).getTime()) return;
      await this.release(o);
      return;
    }

    if (now < new Date(st.dueAt).getTime()) return;

    // already (almost) at the restaurant: nothing to ask, automatic arrival detection will mark it
    const d = await this.core.profiles.findOne({ where: { id: o.driverId }, relations: ['user'] });
    if (!d) return;
    const r = o.restaurant;
    if (d.lat != null && d.lng != null && r?.lat != null && r.lng != null && haversineKm(d.lat, d.lng, r.lat, r.lng) < NEAR_KM) {
      await this.save(o.id, { ...st, dueAt: new Date(now + st.expectedMin * 60_000).toISOString() });
      return;
    }

    const askedAt = new Date(now);
    const deadlineAt = new Date(now + cfg.confirmMs);
    await this.save(o.id, { ...st, check: { askedAt: askedAt.toISOString(), deadlineAt: deadlineAt.toISOString() } });
    const payload = { orderId: o.id, code: o.code, restaurant: r?.name ?? null, deadlineAt: deadlineAt.toISOString(), seconds: Math.round(cfg.confirmMs / 1000) };
    this.core.rt.emitToDriver(o.driverId, 'driver.presence_check', payload);
    await this.core
      .notifyDriver(d, 'order.presence_check', { code: o.code }, { orderId: o.id, presenceCheck: true }, {
        title: 'Are you still on your way?',
        body: `Order ${o.code} is taking longer than expected. Open Forky Driver and confirm within ${Math.round(cfg.confirmMs / 1000)} seconds or it will be given to another courier.`,
      })
      .catch(() => undefined);
    this.logger.log(`presence check sent for ${o.code} (expected ${st.expectedMin} min)`);
  }

  /** No answer in time: the order leaves this driver and is offered to someone else. */
  private async release(o: Order) {
    const driverId = o.driverId!;
    await this.save(o.id, null);
    await this.ordersService.unassignDriver(o.id, { type: ActorType.SYSTEM, name: 'Presence check' }, 'Driver did not confirm they were still on the way', { redispatch: true });
    this.core.rt.emitToDriver(driverId, 'driver.presence_timeout', { orderId: o.id, code: o.code });
    const d = await this.core.profiles.findOne({ where: { id: driverId }, relations: ['user'] });
    if (d) {
      await this.core
        .notifyDriver(d, 'order.presence_timeout', { code: o.code }, { orderId: o.id }, {
          title: 'Order reassigned',
          body: `You did not confirm you were still on the way, so order ${o.code} was given to another courier.`,
        })
        .catch(() => undefined);
    }
    this.logger.warn(`order ${o.code} unassigned from driver ${driverId}: no presence confirmation`);
  }

  /** `POST /driver/trip/:orderId/still-here`: the driver answers the question. */
  async confirm(driverId: string, orderId: string) {
    const o = await this.orders.findOne({ where: { id: orderId } });
    if (!o || o.driverId !== driverId) throw new ForbiddenException('Not your order');
    const st = (o.meta?.presence ?? null) as PresenceState | null;
    if (!st?.check) return { ok: true, pending: false };
    if (Date.now() > new Date(st.check.deadlineAt).getTime() + 3000) return { ok: false, pending: false, expired: true }; // a few seconds of grace for slow networks
    const cfg = this.cfg();
    const dueAt = new Date(Date.now() + Math.max(3, st.expectedMin) * 60_000).toISOString(); // ask again later if still not there
    await this.save(o.id, { ...st, check: null, dueAt });
    return { ok: true, pending: false, nextCheckAt: dueAt, minutes: Math.round(cfg.confirmMs / 60000) };
  }

  /** What the app needs to re-open the question after a restart: the open check for an order, or null. */
  openCheck(o: Order): { deadlineAt: string; seconds: number } | null {
    const c = (o.meta?.presence as PresenceState | undefined)?.check;
    if (!c) return null;
    const left = Math.round((new Date(c.deadlineAt).getTime() - Date.now()) / 1000);
    return left > 0 ? { deadlineAt: c.deadlineAt, seconds: left } : null;
  }
}
