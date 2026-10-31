import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ModuleRef } from '@nestjs/core';
import { In, Repository } from 'typeorm';
import {
  DriverLocationLog,
  DriverProfile,
  DriverShift,
  Order,
  Review,
  SosAlert,
  User,
  Zone,
} from '../database/entities';
import { ActorRef, IDispatchService, IPayoutsService } from '../common/contracts';
import { ActorType, DriverStatus, OrderStatus, OrderType, PartyType, VerificationAudience } from '../common/enums';
import { verificationSummary } from '../verification/verification-policy';
import * as bcrypt from 'bcryptjs';
import { haversineKm } from '../common/geo.util';
import { OrdersService } from '../orders/orders.service';
import { ProofService } from '../orders/proof.service';
import { LedgerService } from '../orders/ledger.service';
import { DriverCoreService } from './driver-core.service';
import { DriverPresenceService } from './driver-presence.service';
import { AcceptanceService } from '../dispatch/acceptance.service';
import { MaskedCallAdapter } from './adapters/masked-call.adapter';
import { lazyService, maskAccount, round2, tzStart } from './drivers.util';
import {
  AvailableShiftsQuery,
  BankDto,
  CallDto,
  DeclineOfferDto,
  DeliverDto,
  GoOnlineDto,
  LocationDto,
  PickupDto,
  QuizSubmitDto,
  ReplaceDocumentDto,
  SosDto,
  StepDto,
  TaxInfoDto,
  TripQuery,
  UpdateProfileDto,
  UploadDocumentDto,
} from './drivers.dto';

const ON_TRIP_STATUSES = [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY];

/** Business logic behind every `/driver/*` endpoint (spec §5). Controllers stay thin. */
@Injectable()
export class DriverAppService {
  constructor(
    private core: DriverCoreService,
    private moduleRef: ModuleRef,
    private ordersService: OrdersService,
    private proofService: ProofService,
    private ledger: LedgerService,
    private acceptance: AcceptanceService,
    private maskedCallAdapter: MaskedCallAdapter,
    private presence: DriverPresenceService,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(DriverShift) private shifts: Repository<DriverShift>,
    @InjectRepository(SosAlert) private sosRepo: Repository<SosAlert>,
    @InjectRepository(Review) private reviews: Repository<Review>,
    @InjectRepository(Zone) private zones: Repository<Zone>,
    @InjectRepository(DriverLocationLog) private locationLogs: Repository<DriverLocationLog>,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  private actor(p: DriverProfile): ActorRef {
    return { type: ActorType.DRIVER, id: p.userId, name: this.core.driverName(p) };
  }

  private dispatch(): IDispatchService | null {
    return lazyService<IDispatchService>(this.moduleRef, '../dispatch/dispatch.service', 'DispatchService');
  }

  private payouts(): IPayoutsService | null {
    return lazyService<IPayoutsService>(this.moduleRef, '../finance/payouts.service', 'PayoutsService');
  }

  private locationService(): { record: (p: any) => Promise<any> } | null {
    return lazyService(this.moduleRef, '../dispatch/driver-location.service', 'DriverLocationService');
  }

  // ------------------------------------------------------------------ profile
  async profile(driverId: string) {
    const p = await this.core.getProfile(driverId);
    const checklist = await this.core.checklist(p);
    return {
      id: p.id,
      firstName: p.user.firstName,
      lastName: p.user.lastName,
      email: p.user.email,
      phone: p.user.phone,
      language: p.user.language,
      avatarUrl: p.user.avatarUrl,
      status: p.status,
      statusReason: p.statusReason,
      cityId: p.cityId,
      zoneIds: p.zoneIds,
      vehicle: { type: p.vehicleType, make: p.vehicleMake, model: p.vehicleModel, color: p.vehicleColor, licensePlate: p.licensePlate },
      isOnline: p.isOnline,
      onTrip: p.onTrip,
      activeZoneId: p.activeZoneId,
      rating: p.rating,
      ratingCount: p.ratingCount,
      acceptanceRate: p.acceptanceRate,
      acceptance: this.acceptance.summary(p),
      completionRate: p.completionRate,
      onTimeRate: p.onTimeRate,
      totalTrips: p.totalTrips,
      payoutSchedule: p.payoutSchedule,
      ontarioNoticeAcked: p.ontarioPlatformWorkerNoticeAcked,
      insulatedBagConfirmed: p.insulatedBagConfirmed,
      onboarding: checklist,
      verification: verificationSummary(VerificationAudience.DRIVER, p),
    };
  }

  async updateProfile(driverId: string, dto: UpdateProfileDto) {
    const p = await this.core.getProfile(driverId);
    if (dto.firstName !== undefined) p.user.firstName = dto.firstName;
    if (dto.lastName !== undefined) p.user.lastName = dto.lastName;
    if (dto.language !== undefined) p.user.language = dto.language;
    if (dto.avatarUrl !== undefined) p.user.avatarUrl = dto.avatarUrl;
    await this.core.users.save(p.user);
    for (const k of ['vehicleType', 'vehicleMake', 'vehicleModel', 'vehicleColor', 'licensePlate', 'payoutSchedule'] as const) {
      if ((dto as any)[k] !== undefined) (p as any)[k] = (dto as any)[k];
    }
    await this.core.profiles.save(p);
    return this.profile(driverId);
  }

  async ackNotice(driverId: string) {
    const p = await this.core.getProfile(driverId);
    p.ontarioPlatformWorkerNoticeAcked = true;
    await this.core.profiles.save(p);
    return { ok: true };
  }

  // ------------------------------------------------------------------ documents
  async listDocuments(driverId: string) {
    const required = await this.core.requiredDocState(driverId);
    const all = await this.core.docs.find({ where: { driverId }, order: { createdAt: 'DESC' } });
    return { required, history: all };
  }

  async uploadDocument(driverId: string, dto: UploadDocumentDto) {
    const doc = await this.core.docs.save(
      this.core.docs.create({ driverId, type: dto.type, fileUrl: dto.fileUrl, fileName: dto.fileName ?? null, expiresAt: dto.expiresAt ?? null }),
    );
    const p = await this.core.getProfile(driverId);
    await this.core.opsNotify('document.uploaded', 'New driver document', `${this.core.driverName(p)} uploaded a ${dto.type}.`, { driverId, documentId: doc.id });
    return doc;
  }

  async replaceDocument(driverId: string, docId: string, dto: ReplaceDocumentDto) {
    const doc = await this.core.docs.findOne({ where: { id: docId, driverId } });
    if (!doc) throw new BadRequestException('Document not found');
    doc.fileUrl = dto.fileUrl;
    doc.fileName = dto.fileName ?? doc.fileName;
    doc.expiresAt = dto.expiresAt ?? doc.expiresAt;
    doc.status = 'PENDING' as any;
    doc.rejectReason = null;
    doc.reviewedAt = null;
    doc.reviewedById = null;
    doc.expiryReminderSentAt = null;
    return this.core.docs.save(doc);
  }

  // ------------------------------------------------------------------ bank / tax
  async setBank(driverId: string, dto: BankDto) {
    const p = await this.core.getProfile(driverId);
    const u = await this.users.createQueryBuilder('u').addSelect('u.passwordHash').where('u.id = :id', { id: p.userId }).getOne();
    if (!u?.passwordHash || !(await bcrypt.compare(dto.currentPassword, u.passwordHash))) throw new ForbiddenException('Current password is required to change payout details');
    p.bank = {
      institution: dto.institution ?? p.bank?.institution,
      transit: dto.transit ?? p.bank?.transit,
      accountLast4: dto.accountNumber ? dto.accountNumber.replace(/\D/g, '').slice(-4) : p.bank?.accountLast4,
      holder: dto.holder ?? p.bank?.holder,
      debitCardLast4: dto.debitCardLast4 ?? p.bank?.debitCardLast4,
      changedAt: new Date().toISOString(), // instant cash-out is held for 24 h after any change
    } as any;
    await this.core.profiles.save(p);
    return { institution: p.bank.institution, transit: p.bank.transit, account: maskAccount(p.bank.accountLast4), holder: p.bank.holder };
  }

  async setTax(driverId: string, dto: TaxInfoDto) {
    const p = await this.core.getProfile(driverId);
    p.taxInfo = { sinLast3: dto.sin.replace(/\D/g, '').slice(-3), legalName: dto.legalName, address: dto.address, collectedAt: new Date().toISOString() };
    await this.core.profiles.save(p);
    return { legalName: p.taxInfo.legalName, sin: `***-***-${p.taxInfo.sinLast3}`, collectedAt: p.taxInfo.collectedAt };
  }

  // ------------------------------------------------------------------ training + quiz
  async training(driverId: string) {
    const progress = await this.core.trainingProgress(driverId);
    const modules = await this.core.modules.find({ where: { active: true }, order: { sortOrder: 'ASC' } });
    return {
      ...progress,
      modules: modules.map((m) => ({
        id: m.id,
        title: m.title,
        content: m.content,
        passMark: m.passMark,
        quiz: m.quiz.map((q) => ({ question: q.question, options: q.options })), // correctIndex withheld
        result: progress.modules.find((r) => r.moduleId === m.id) ?? null,
      })),
    };
  }

  async submitQuiz(driverId: string, moduleId: string, dto: QuizSubmitDto) {
    const m = await this.core.modules.findOne({ where: { id: moduleId } });
    if (!m) throw new BadRequestException('Training module not found');
    if (dto.answers.length !== m.quiz.length) throw new BadRequestException(`Expected ${m.quiz.length} answers`);
    const correct = m.quiz.filter((q, i) => q.correctIndex === dto.answers[i]).length;
    const score = m.quiz.length ? round2((correct / m.quiz.length) * 100) : 100;
    const passed = score >= (m.passMark ?? this.core.settings.get<number>('driver.trainingPassMark', 80));
    const attempt = await this.core.attempts.save(this.core.attempts.create({ driverId, moduleId, score, passed, answers: dto.answers }));
    const progress = await this.core.trainingProgress(driverId);
    if (progress.completed) {
      const p = await this.core.getProfile(driverId);
      p.trainingCompleted = true;
      p.trainingScore = progress.averageScore ?? score;
      await this.core.profiles.save(p);
      await this.core.opsNotify('driver.training_completed', 'Driver completed training', `${this.core.driverName(p)} passed all training modules.`, { driverId });
    }
    return { attempt, passed, score, progress };
  }

  // ------------------------------------------------------------------ onboarding checklist
  async checklist(driverId: string) {
    return this.core.checklist(await this.core.getProfile(driverId));
  }

  // ------------------------------------------------------------------ online / offline / zones
  async setZones(driverId: string, zoneIds: string[]) {
    const p = await this.core.getProfile(driverId);
    const found = await this.zones.count({ where: { id: In(zoneIds) } });
    if (found !== new Set(zoneIds).size) throw new BadRequestException('One or more zones do not exist');
    if (!zoneIds.every((z) => p.zoneIds.includes(z))) throw new ForbiddenException('You are only approved for your assigned zones - contact support to add a zone');
    p.zoneIds = zoneIds;
    await this.core.profiles.save(p);
    return { zoneIds: p.zoneIds };
  }

  async goOnline(driverId: string, dto: GoOnlineDto) {
    const p = await this.core.getProfile(driverId);
    const check = await this.core.goOnlineCheck(p);
    if (!check.ok) throw new BadRequestException(check.reasons.join('; '));
    const zoneId = dto.zoneId ?? p.activeZoneId ?? p.zoneIds[0];
    if (!p.zoneIds.includes(zoneId)) throw new BadRequestException('You are not approved for that zone');
    p.isOnline = true;
    p.activeZoneId = zoneId;
    p.wentOnlineAt = new Date();
    if (dto.lat !== undefined) p.lat = dto.lat;
    if (dto.lng !== undefined) p.lng = dto.lng;
    await this.core.profiles.save(p);
    this.core.rt.server?.in(`driver:${p.id}`).socketsJoin(`zone:${zoneId}`);
    this.core.rt.emitToOps('driver.status', { driverId: p.id, status: p.status, isOnline: true, zoneId });
    return { isOnline: true, activeZoneId: zoneId };
  }

  async goOffline(driverId: string) {
    const p = await this.core.getProfile(driverId);
    if (p.onTrip) throw new BadRequestException('You have an active trip - finish it before going offline');
    this.core.applyOffline(p);
    await this.core.profiles.save(p);
    this.core.rt.emitToOps('driver.status', { driverId: p.id, status: p.status, isOnline: false });
    return { isOnline: false };
  }

  // ------------------------------------------------------------------ location
  async location(driverId: string, dto: LocationDto) {
    const svc = this.locationService();
    if (svc) return svc.record({ driverId, lat: dto.lat, lng: dto.lng, heading: dto.heading, speed: dto.speed, orderId: dto.orderId, emit: true });
    // fallback while the Dispatch module isn't wired yet: persist minimally ourselves.
    const at = new Date();
    await this.core.profiles.update(driverId, { lat: dto.lat, lng: dto.lng, heading: dto.heading ?? null, lastLocationAt: at });
    await this.locationLogs.insert({ driverId, orderId: dto.orderId ?? null, lat: dto.lat, lng: dto.lng, speed: dto.speed ?? null });
    const active = await this.orders.count({ where: { driverId, status: In(ON_TRIP_STATUSES) } });
    this.core.rt.emitToOps('driver.location', { driverId, lat: dto.lat, lng: dto.lng, heading: dto.heading ?? null, orderId: dto.orderId ?? null, at: at.toISOString() });
    if (dto.orderId) this.core.rt.emitToOrder(dto.orderId, 'driver.location', { driverId, lat: dto.lat, lng: dto.lng, at: at.toISOString() });
    return { ok: true, onTrip: active > 0 };
  }

  // ------------------------------------------------------------------ offers (Dispatch)
  async currentOffer(driverId: string) {
    const svc = this.dispatch();
    return svc ? svc.currentOffer(driverId) : null;
  }

  async acceptOffer(driverId: string, offerId: string) {
    const svc = this.dispatch();
    if (!svc) throw new ServiceUnavailableException('Dispatch is temporarily unavailable - try again shortly');
    return svc.acceptOffer(offerId, driverId);
  }

  async declineOffer(driverId: string, offerId: string, dto: DeclineOfferDto) {
    const svc = this.dispatch();
    if (!svc) throw new ServiceUnavailableException('Dispatch is temporarily unavailable - try again shortly');
    await svc.declineOffer(offerId, driverId, dto.reason);
    return { ok: true };
  }

  // ------------------------------------------------------------------ active trip / status steps
  private async myOrder(driverId: string, orderId: string): Promise<Order> {
    const o = await this.ordersService.getById(orderId);
    if (o.driverId !== driverId) throw new ForbiddenException('Not your order');
    return o;
  }

  async activeTrip(driverId: string) {
    const all = await this.orders.find({ where: { driverId, status: In(ON_TRIP_STATUSES) }, relations: ['restaurant'], order: { createdAt: 'ASC' } });
    if (!all.length) return null;
    // a driver can carry up to 2 orders (en-route stacking): the one furthest along is "current" (food already in the car first), the rest wait in the queue
    const rank = (s: OrderStatus) => ([OrderStatus.ON_THE_WAY, OrderStatus.PICKED_UP].includes(s) ? 0 : s === OrderStatus.READY ? 1 : 2);
    const sorted = [...all].sort((a, b) => rank(a.status) - rank(b.status) || a.createdAt.getTime() - b.createdAt.getTime());
    const o = sorted[0];
    const view = await this.ordersService.trackingView(o.id, 'DRIVER');
    const queue = sorted.slice(1).map((q) => ({ id: q.id, code: q.code, status: q.status, restaurant: q.restaurant?.name ?? null, pickupAfterCurrentDelivery: [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(o.status) && ![OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(q.status) }));
    // masked call: the driver never sees real numbers; POST /driver/trip/:orderId/call opens a proxy session
    return { ...view, queue, stackedOrders: queue.length, presenceCheck: this.presence.openCheck(o), maskedCall: { customer: true, restaurant: true, path: `/driver/trip/${o.id}/call` } };
  }

  /** The driver says they are still on their way (answer to the "are you still here?" check). */
  async confirmPresence(driverId: string, orderId: string) {
    return this.presence.confirm(driverId, orderId);
  }

  async arrivedRestaurant(driverId: string, orderId: string, dto: StepDto) {
    const p = await this.core.getProfile(driverId);
    await this.myOrder(driverId, orderId);
    return this.ordersService.driverArrived(orderId, 'RESTAURANT', this.actor(p), { lat: dto.lat, lng: dto.lng });
  }

  async pickedUp(driverId: string, orderId: string, dto: PickupDto) {
    const p = await this.core.getProfile(driverId);
    await this.myOrder(driverId, orderId);
    return this.ordersService.transition(orderId, OrderStatus.PICKED_UP, this.actor(p), { code: dto.code, lat: dto.lat, lng: dto.lng });
  }

  async arrivedCustomer(driverId: string, orderId: string, dto: StepDto) {
    const p = await this.core.getProfile(driverId);
    await this.myOrder(driverId, orderId);
    return this.ordersService.driverArrived(orderId, 'CUSTOMER', this.actor(p), { lat: dto.lat, lng: dto.lng });
  }

  async delivered(driverId: string, orderId: string, dto: DeliverDto, ctx: { ip?: string; userAgent?: string } = {}) {
    const p = await this.core.getProfile(driverId);
    const order = await this.myOrder(driverId, orderId);
    const to = order.type === OrderType.PICKUP ? OrderStatus.COLLECTED : OrderStatus.DELIVERED;
    if (to === OrderStatus.DELIVERED) {
      // layered proof of delivery (arrival, PIN or photo by handoff method, geofence, server GPS cross-check, photo hash) - see docs/proof-of-delivery.md
      const proof = await this.proofService.prepare(order, p, dto, ctx);
      return this.ordersService.transition(orderId, to, this.actor(p), { proof, note: dto.note, lat: dto.lat, lng: dto.lng });
    }
    return this.ordersService.transition(orderId, to, this.actor(p), { code: dto.pin, note: dto.note, lat: dto.lat, lng: dto.lng });
  }

  // ------------------------------------------------------------------ earnings / trips / cash-out
  private async periodTotals(driverId: string, since: Date) {
    const rows: { trips: number; pay: number; tips: number; boost: number }[] = await this.orders.manager.query(
      `SELECT COUNT(*)::int AS trips, COALESCE(SUM("driverPay"),0)::float AS pay, COALESCE(SUM(tip),0)::float AS tips, COALESCE(SUM("driverBoost"),0)::float AS boost
       FROM orders WHERE "driverId" = $1 AND status IN ('DELIVERED','COLLECTED') AND "deliveredAt" >= $2`,
      [driverId, since],
    );
    const r = rows[0] ?? { trips: 0, pay: 0, tips: 0, boost: 0 };
    return { trips: r.trips, basePay: round2(r.pay), tips: round2(r.tips), boosts: round2(r.boost), total: round2(r.pay + r.tips + r.boost) };
  }

  async earnings(driverId: string) {
    const p = await this.core.getProfile(driverId);
    const [today, week] = await Promise.all([this.periodTotals(driverId, tzStart('day')), this.periodTotals(driverId, tzStart('week'))]);
    const unpaidBalance = await this.ledger.balance(PartyType.DRIVER, driverId);
    return { today, week, unpaidBalance, lifetimeEarnings: p.lifetimeEarnings, payoutSchedule: p.payoutSchedule };
  }

  async tripHistory(driverId: string, q: TripQuery) {
    const qb = this.orders.createQueryBuilder('o').where('o.driverId = :d', { d: driverId }).leftJoinAndSelect('o.restaurant', 'r');
    if (q.from) qb.andWhere('o.createdAt >= :f', { f: q.from });
    if (q.to) qb.andWhere('o.createdAt <= :t', { t: q.to });
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const [data, total] = await qb.orderBy('o.createdAt', 'DESC').skip((page - 1) * limit).take(limit).getManyAndCount();
    return {
      data: data.map((o) => ({
        id: o.id,
        code: o.code,
        status: o.status,
        restaurant: o.restaurant?.name ?? null,
        createdAt: o.createdAt,
        deliveredAt: o.deliveredAt,
        driverPay: o.driverPay,
        tip: o.tip,
        boost: o.driverBoost,
        distanceKm: o.distanceKm,
      })),
      meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  async cashOut(driverId: string) {
    const svc = this.payouts();
    if (!svc) throw new ServiceUnavailableException('Instant cash-out is temporarily unavailable - try again shortly');
    const p = await this.core.getProfile(driverId);
    if (p.status !== DriverStatus.ACTIVE) throw new ForbiddenException('Instant cash-out is only available to active drivers');
    const changed = (p.bank as any)?.changedAt ? new Date((p.bank as any).changedAt).getTime() : 0;
    if (changed && Date.now() - changed < 24 * 3600_000) throw new ForbiddenException('Payout details were changed recently - instant cash-out is on hold for 24 hours');
    return svc.instantCashOut(driverId, this.actor(p));
  }

  // ------------------------------------------------------------------ shifts (driver side)
  async availableShifts(driverId: string, q: AvailableShiftsQuery) {
    const p = await this.core.getProfile(driverId);
    const qb = this.shifts.createQueryBuilder('s').where('s.driverId IS NULL AND s.status = :st', { st: 'OPEN' });
    qb.andWhere('s.zoneId IN (:...z)', { z: q.zoneId ? [q.zoneId] : p.zoneIds.length ? p.zoneIds : ['00000000-0000-0000-0000-000000000000'] });
    if (q.from) qb.andWhere('s.startsAt >= :f', { f: q.from });
    if (q.to) qb.andWhere('s.endsAt <= :t', { t: q.to });
    const slots = await qb.orderBy('s.startsAt', 'ASC').limit(100).getMany();
    const withCapacity = await Promise.all(
      slots.map(async (s) => {
        const booked = await this.shifts.count({ where: { zoneId: s.zoneId, startsAt: s.startsAt, endsAt: s.endsAt, status: In(['BOOKED', 'STARTED', 'COMPLETED']) as any } });
        return { ...s, booked, full: s.slotCapacity != null && booked >= s.slotCapacity };
      }),
    );
    return withCapacity.filter((s) => !s.full);
  }

  async bookShift(driverId: string, slotId: string) {
    const slot = await this.shifts.findOne({ where: { id: slotId } });
    if (!slot || slot.driverId || slot.status !== 'OPEN') throw new BadRequestException('That shift is no longer available');
    const profile = await this.core.getProfile(driverId);
    if (profile.status !== DriverStatus.ACTIVE) throw new ForbiddenException('Only active drivers can book shifts');
    if (!profile.zoneIds.includes(slot.zoneId)) throw new ForbiddenException('You are not approved for that zone');
    if (slot.slotCapacity != null) {
      const booked = await this.shifts.count({ where: { zoneId: slot.zoneId, startsAt: slot.startsAt, endsAt: slot.endsAt, status: In(['BOOKED', 'STARTED', 'COMPLETED']) as any } });
      if (booked >= slot.slotCapacity) throw new BadRequestException('That shift is full');
    }
    const overlap = await this.shifts
      .createQueryBuilder('s')
      .where('s.driverId = :d AND s.status IN (:...st)', { d: driverId, st: ['BOOKED', 'STARTED'] })
      .andWhere('s.startsAt < :end AND s.endsAt > :start', { start: slot.startsAt, end: slot.endsAt })
      .getCount();
    if (overlap > 0) throw new BadRequestException('You already have a shift that overlaps this time');
    return this.shifts.manager.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`shift:${slot.zoneId}:${slot.startsAt.toISOString()}:${slot.endsAt.toISOString()}`]);
      if (slot.slotCapacity != null) {
        const booked = await em.getRepository(this.shifts.target as any).count({ where: { zoneId: slot.zoneId, startsAt: slot.startsAt, endsAt: slot.endsAt, status: In(['BOOKED', 'STARTED', 'COMPLETED']) as any } } as any);
        if (booked >= slot.slotCapacity) throw new BadRequestException('That shift is full');
      }
      return em.getRepository(this.shifts.target as any).save(this.shifts.create({ driverId, zoneId: slot.zoneId, startsAt: slot.startsAt, endsAt: slot.endsAt, status: 'BOOKED', slotCapacity: null }) as any);
    });
  }

  async myShifts(driverId: string) {
    return this.shifts.find({ where: { driverId }, order: { startsAt: 'DESC' }, take: 50 });
  }

  async cancelMyShift(driverId: string, shiftId: string) {
    const s = await this.shifts.findOne({ where: { id: shiftId, driverId } });
    if (!s) throw new BadRequestException('Shift not found');
    if (s.status !== 'BOOKED') throw new BadRequestException(`Cannot cancel a shift that is ${s.status}`);
    s.status = 'CANCELLED';
    return this.shifts.save(s);
  }

  // ------------------------------------------------------------------ incentives / ratings / heat-map
  async myIncentives(driverId: string) {
    const p = await this.core.getProfile(driverId);
    const now = new Date();
    const qb = this.core.incentives
      .createQueryBuilder('i')
      .where('i.active = true AND i.startsAt <= :now AND i.endsAt >= :now', { now })
      .andWhere('(i.driverId = :d OR i.driverId IS NULL)', { d: driverId })
      .andWhere('(i.zoneId IS NULL OR i.zoneId IN (:...zones))', { zones: p.zoneIds.length ? p.zoneIds : ['00000000-0000-0000-0000-000000000000'] })
      .andWhere('(i.cityId IS NULL OR i.cityId = :cityId)', { cityId: p.cityId ?? '00000000-0000-0000-0000-000000000000' });
    return qb.orderBy('i.createdAt', 'DESC').getMany();
  }

  async ratingsPerformance(driverId: string) {
    const p = await this.core.getProfile(driverId);
    const reviews = await this.reviews.find({ where: { driverId }, order: { createdAt: 'DESC' }, take: 20 });
    return {
      rating: p.rating,
      ratingCount: p.ratingCount,
      acceptanceRate: p.acceptanceRate,
      acceptance: this.acceptance.summary(p),
      completionRate: p.completionRate,
      onTimeRate: p.onTimeRate,
      totalTrips: p.totalTrips,
      cancellations: p.cancellations,
      recentReviews: reviews.filter((r) => r.driverRating != null || r.driverComment).map((r) => ({ rating: r.driverRating, comment: r.driverComment, createdAt: r.createdAt })),
    };
  }

  // ------------------------------------------------------------------ SOS
  async raiseSos(driverId: string, dto: SosDto) {
    const p = await this.core.getProfile(driverId);
    let sosOrderId: string | null = null;
    if (dto.orderId && (await this.orders.exist({ where: { id: dto.orderId, driverId } }))) sosOrderId = dto.orderId;
    const alert = await this.sosRepo.save(
      this.sosRepo.create({ driverId, orderId: sosOrderId, lat: dto.lat ?? p.lat, lng: dto.lng ?? p.lng, message: dto.message ?? null, status: 'OPEN' }),
    );
    this.core.rt.emitToOps('sos.alert', { id: alert.id, driverId, driverName: this.core.driverName(p), lat: alert.lat, lng: alert.lng, orderId: alert.orderId, message: alert.message });
    await this.core.opsNotify('sos.alert', `SOS - ${this.core.driverName(p)}`, dto.message || 'Driver pressed the SOS button.', { driverId, sosId: alert.id });
    return alert;
  }

  async mySosHistory(driverId: string) {
    return this.sosRepo.find({ where: { driverId }, order: { createdAt: 'DESC' }, take: 20 });
  }

  // ------------------------------------------------------------------ masked call
  async maskedCall(driverId: string, orderId: string, dto: CallDto) {
    const order = await this.myOrder(driverId, orderId);
    const p = await this.core.getProfile(driverId);
    let targetPhone: string | null = null;
    if (dto.party === 'CUSTOMER') {
      const customer = await this.users.findOne({ where: { id: order.customerId } });
      targetPhone = customer?.phone ?? null;
    } else {
      const restaurant = await this.orders.manager.query(`SELECT phone FROM restaurants WHERE id = $1`, [order.restaurantId]);
      targetPhone = restaurant?.[0]?.phone ?? null;
    }
    return this.maskedCallAdapter.createSession({ orderId: order.id, orderCode: order.code, driverPhone: p.user.phone, targetPhone, party: dto.party });
  }
}
