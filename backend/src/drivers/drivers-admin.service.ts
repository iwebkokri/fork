import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { csvCell } from '../common/csv';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { Brackets, In, Repository } from 'typeorm';
import {
  DriverDocument,
  DriverOffer,
  DriverProfile,
  Incentive,
  LedgerEntry,
  Order,
  ReviewCase,
  SosAlert,
  TrainingAttempt,
  User,
  Zone,
  City,
} from '../database/entities';
import { ActorRef } from '../common/contracts';
import { ActorType, DocStatus, DriverDocType, DriverStatus, PartyType, UserStatus, UserType, OrderStatus, VerificationMethod, VerificationStatus } from '../common/enums';
import { withoutRestore } from '../verification/verification-policy';
import { paginateQb, like } from '../common/pagination';
import { AuthUser } from '../common/auth.types';
import { DriverCoreService, PRE_ACTIVE } from './driver-core.service';
import { AcceptanceService } from '../dispatch/acceptance.service';
import { CertnAdapter, BackgroundCheckResult } from './adapters/certn.adapter';
import { maskAccount, round2, todayStr } from './drivers.util';
import {
  ActivateDto,
  ApproveDto,
  BackgroundOverrideDto,
  CreateDriverDto,
  DriverListQuery,
  InsuranceDto,
  ReasonDto,
  ReviewDocumentDto,
  UpdateDriverDto,
} from './drivers.dto';

const NEEDS_EXPIRY = [DriverDocType.LICENCE, DriverDocType.INSURANCE, DriverDocType.VEHICLE_REGISTRATION];

@Injectable()
export class DriversAdminService {
  private readonly logger = new Logger('DriversAdmin');

  constructor(
    private core: DriverCoreService,
    private certn: CertnAdapter,
    private acceptance: AcceptanceService,
    @InjectRepository(DriverOffer) private offers: Repository<DriverOffer>,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(LedgerEntry) private ledger: Repository<LedgerEntry>,
    @InjectRepository(ReviewCase) private cases: Repository<ReviewCase>,
    @InjectRepository(SosAlert) private sos: Repository<SosAlert>,
    @InjectRepository(TrainingAttempt) private attempts: Repository<TrainingAttempt>,
    @InjectRepository(Zone) private zones: Repository<Zone>,
    @InjectRepository(City) private cities: Repository<City>,
  ) {}

  private actor(u: AuthUser): ActorRef {
    return { type: ActorType.STAFF, id: u.id, name: u.name };
  }

  // ------------------------------------------------------------------ list / detail
  private listQb(q: DriverListQuery) {
    const qb = this.core.profiles.createQueryBuilder('d').innerJoinAndSelect('d.user', 'u');
    if (q.status) qb.andWhere('d.status = :st', { st: q.status });
    if (q.cityId) qb.andWhere('d.cityId = :cityId', { cityId: q.cityId });
    if (q.zoneId) qb.andWhere(`d."zoneIds" @> :z::jsonb`, { z: JSON.stringify([q.zoneId]) });
    if (q.vehicleType) qb.andWhere('d.vehicleType = :vt', { vt: q.vehicleType });
    if (q.online === 'true') qb.andWhere('d.isOnline = true');
    if (q.online === 'false') qb.andWhere('d.isOnline = false');
    if (q.ratingMin !== undefined) qb.andWhere('d.rating >= :rmin', { rmin: q.ratingMin });
    if (q.ratingMax !== undefined) qb.andWhere('d.rating <= :rmax', { rmax: q.ratingMax });
    if (q.backgroundCheck) qb.andWhere('d.backgroundCheckStatus = :bg', { bg: q.backgroundCheck });
    if (q.verification) qb.andWhere('d.verificationStatus = :vs', { vs: q.verification });
    if (q.expiringDays !== undefined) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM driver_documents dd WHERE dd."driverId" = d.id AND dd.status IN ('APPROVED','EXPIRED') AND dd."expiresAt" IS NOT NULL AND dd."expiresAt" <= (CURRENT_DATE + :ed::int))`,
        { ed: q.expiringDays },
      );
    }
    if (q.search) {
      qb.andWhere(
        new Brackets((b) =>
          b
            .where('u.firstName ILIKE :s', { s: like(q.search!) })
            .orWhere('u.lastName ILIKE :s', { s: like(q.search!) })
            .orWhere(`(u.firstName || ' ' || u.lastName) ILIKE :s`, { s: like(q.search!) })
            .orWhere('u.email ILIKE :s', { s: like(q.search!) })
            .orWhere('u.phone ILIKE :s', { s: like(q.search!) })
            .orWhere('d.licensePlate ILIKE :s', { s: like(q.search!) }),
        ),
      );
    }
    return qb;
  }

  private row(d: DriverProfile, extra: Record<string, any> = {}) {
    return {
      id: d.id,
      userId: d.userId,
      name: this.core.driverName(d),
      email: d.user?.email ?? null,
      phone: d.user?.phone ?? null,
      status: d.status,
      statusReason: d.statusReason,
      cityId: d.cityId,
      zoneIds: d.zoneIds,
      vehicleType: d.vehicleType,
      licensePlate: d.licensePlate,
      isOnline: d.isOnline,
      onTrip: d.onTrip,
      activeZoneId: d.activeZoneId,
      lat: d.lat,
      lng: d.lng,
      lastLocationAt: d.lastLocationAt,
      rating: d.rating,
      ratingCount: d.ratingCount,
      acceptanceRate: d.acceptanceRate,
      acceptance: this.acceptance.summary(d),
      completionRate: d.completionRate,
      onTimeRate: d.onTimeRate,
      totalTrips: d.totalTrips,
      cancellations: d.cancellations,
      backgroundCheckStatus: d.backgroundCheckStatus,
      trainingCompleted: d.trainingCompleted,
      insulatedBagConfirmed: d.insulatedBagConfirmed,
      pendingBalance: d.pendingBalance,
      lifetimeEarnings: d.lifetimeEarnings,
      approvedAt: d.approvedAt,
      verificationStatus: d.verificationStatus,
      verificationMethod: d.verificationMethod,
      verifiedAt: d.verifiedAt,
      verificationDueAt: d.verificationDueAt,
      createdAt: d.createdAt,
      ...extra,
    };
  }

  async list(q: DriverListQuery) {
    const res = await paginateQb(this.listQb(q), q, {
      sortable: {
        createdAt: 'd.createdAt',
        rating: 'd.rating',
        totalTrips: 'd.totalTrips',
        status: 'd.status',
        name: 'u.firstName',
        acceptanceRate: 'd.acceptanceRate',
        pendingBalance: 'd.pendingBalance',
      },
      defaultSort: ['d.createdAt', 'DESC'],
    });
    const ids = res.data.map((d) => d.id);
    const expiring = new Map<string, string>();
    if (ids.length) {
      const rows: { driverId: string; next: string }[] = await this.core.docs.manager.query(
        `SELECT "driverId", MIN("expiresAt")::text AS next FROM driver_documents WHERE "driverId" = ANY($1) AND "expiresAt" IS NOT NULL AND status IN ('APPROVED','EXPIRED') GROUP BY "driverId"`,
        [ids],
      );
      rows.forEach((r) => expiring.set(r.driverId, r.next));
    }
    return { data: res.data.map((d) => this.row(d, { nextDocExpiry: expiring.get(d.id) ?? null })), meta: res.meta };
  }

  async summary(cityId?: string) {
    const qb = this.core.profiles.createQueryBuilder('d').select('d.status', 'status').addSelect('COUNT(*)::int', 'count').groupBy('d.status');
    if (cityId) qb.where('d.cityId = :cityId', { cityId });
    const rows = await qb.getRawMany<{ status: DriverStatus; count: number }>();
    const byStatus = Object.fromEntries(Object.values(DriverStatus).map((s) => [s, rows.find((r) => r.status === s)?.count ?? 0]));
    const on = this.core.profiles.createQueryBuilder('d').where('d.isOnline = true');
    if (cityId) on.andWhere('d.cityId = :cityId', { cityId });
    const online = await on.getCount();
    const expiringRows: { c: number }[] = await this.core.docs.manager.query(
      `SELECT COUNT(DISTINCT "driverId")::int AS c FROM driver_documents WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= CURRENT_DATE + 30 AND status IN ('APPROVED','EXPIRED')`,
    );
    const sosOpen = await this.sos.count({ where: { status: 'OPEN' } });
    return { byStatus, online, onTrip: await this.core.profiles.count({ where: { onTrip: true } }), docsExpiring30d: expiringRows[0]?.c ?? 0, openSos: sosOpen };
  }

  async detail(id: string) {
    const d = await this.core.getProfile(id);
    const docs = await this.core.docs.find({ where: { driverId: id }, order: { createdAt: 'DESC' } });
    const docState = await this.core.requiredDocState(id);
    const training = await this.core.trainingProgress(id);
    const checklist = await this.core.checklist(d);
    const zoneRows = d.zoneIds?.length ? await this.zones.find({ where: { id: In(d.zoneIds) } }) : [];
    const city = d.cityId ? await this.cities.findOne({ where: { id: d.cityId } }) : null;
    const trips = await this.orders.find({ where: { driverId: id }, order: { createdAt: 'DESC' }, take: 15, relations: ['restaurant'] });
    const offers = await this.offers.find({ where: { driverId: id }, order: { sentAt: 'DESC' }, take: 30 });
    const cases = await this.cases.find({ where: { subjectType: 'DRIVER', subjectId: id }, order: { createdAt: 'DESC' } });
    const sos = await this.sos.find({ where: { driverId: id }, order: { createdAt: 'DESC' }, take: 10 });
    const balance = await this.balance(id);
    const since = new Date(Date.now() - 30 * 86400000);
    const perf: { trips: number; pay: number; tips: number; boost: number }[] = await this.orders.manager.query(
      `SELECT COUNT(*)::int AS trips, COALESCE(SUM("driverPay"),0)::float AS pay, COALESCE(SUM(tip),0)::float AS tips, COALESCE(SUM("driverBoost"),0)::float AS boost
       FROM orders WHERE "driverId" = $1 AND status IN ('DELIVERED','COLLECTED') AND "deliveredAt" >= $2`,
      [id, since],
    );
    const first = d.meta?.insurance ?? null;
    return {
      ...this.row(d),
      user: { id: d.user.id, firstName: d.user.firstName, lastName: d.user.lastName, email: d.user.email, phone: d.user.phone, status: d.user.status, lastLoginAt: d.user.lastLoginAt },
      city: city ? { id: city.id, name: city.name } : null,
      vehicle: { type: d.vehicleType, make: d.vehicleMake, model: d.vehicleModel, color: d.vehicleColor, licensePlate: d.licensePlate },
      documents: docs,
      requiredDocuments: docState,
      insurance: first,
      backgroundCheck: {
        provider: d.backgroundCheckProvider,
        status: d.backgroundCheckStatus,
        ref: d.backgroundCheckRef,
        history: d.meta?.backgroundCheckHistory ?? [],
      },
      training: { ...training, completed: d.trainingCompleted, score: d.trainingScore },
      onboarding: checklist,
      zones: zoneRows.map((z) => ({ id: z.id, name: z.name })),
      bank: d.bank ? { institution: d.bank.institution, transit: d.bank.transit, account: maskAccount(d.bank.accountLast4), holder: d.bank.holder, debitCardLast4: d.bank.debitCardLast4 } : null,
      taxInfo: d.taxInfo ? { legalName: d.taxInfo.legalName, sin: d.taxInfo.sinLast3 ? `***-***-${d.taxInfo.sinLast3}` : null, collectedAt: d.taxInfo.collectedAt } : null,
      ontarioNoticeAcked: d.ontarioPlatformWorkerNoticeAcked,
      payoutSchedule: d.payoutSchedule,
      notices: d.meta?.notices ?? [],
      notes: d.meta?.notes ?? null,
      performance: {
        rating: d.rating,
        ratingCount: d.ratingCount,
        acceptanceRate: d.acceptanceRate,
        acceptance: this.acceptance.summary(d),
        completionRate: d.completionRate,
        onTimeRate: d.onTimeRate,
        totalTrips: d.totalTrips,
        cancellations: d.cancellations,
      },
      earnings: {
        unpaidBalance: balance,
        lifetime: d.lifetimeEarnings,
        last30d: { trips: perf[0]?.trips ?? 0, basePay: perf[0]?.pay ?? 0, tips: perf[0]?.tips ?? 0, boosts: perf[0]?.boost ?? 0 },
      },
      recentTrips: trips.map((o) => ({
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
      offers: offers.map((o) => ({
        id: o.id,
        orderId: o.orderId,
        status: o.status,
        sequence: o.sequence,
        sentAt: o.sentAt,
        respondedAt: o.respondedAt,
        estimatedPay: o.estimatedPay,
        boostAmount: o.boostAmount,
        declineReason: o.declineReason,
      })),
      cases,
      sosAlerts: sos,
    };
  }

  recomputeAcceptance() {
    return this.acceptance.recompute();
  }

  /** Offer history inside the rolling acceptance window (GET /admin/drivers/:id/offers?days=14). */
  async offerHistory(id: string, days?: number) {
    const d = await this.core.getProfile(id);
    return { acceptance: this.acceptance.summary(d), offers: await this.acceptance.history(id, days) };
  }

  async balance(driverId: string): Promise<number> {
    const r = await this.ledger
      .createQueryBuilder('l')
      .select('COALESCE(SUM(l.amount),0)', 'sum')
      .where('l.partyType = :t AND l.partyId = :id AND l.payoutId IS NULL', { t: PartyType.DRIVER, id: driverId })
      .getRawOne<{ sum: string }>();
    return round2(parseFloat(r?.sum ?? '0'));
  }

  // ------------------------------------------------------------------ CRUD
  async create(dto: CreateDriverDto, admin: AuthUser) {
    const email = dto.email.toLowerCase();
    if (await this.core.users.findOne({ where: { email } })) throw new ConflictException('Email already registered');
    const phone = dto.phone.replace(/[^\d+]/g, '').replace(/^(\d{10})$/, '+1$1').replace(/^1(\d{10})$/, '+1$1');
    if (await this.core.users.findOne({ where: { phone } })) throw new ConflictException('Phone already registered');
    if (!(await this.cities.findOne({ where: { id: dto.cityId } }))) throw new BadRequestException('Unknown city');
    const tempPassword = dto.password ?? randomBytes(6).toString('base64url');
    const profile = await this.core.users.manager.transaction(async (em) => {
      const u = await em.save(
        em.create(User, {
          type: UserType.DRIVER,
          status: UserStatus.ACTIVE,
          email,
          phone,
          phoneVerified: true,
          firstName: dto.firstName,
          lastName: dto.lastName,
          passwordHash: await bcrypt.hash(tempPassword, 10),
        }),
      );
      return em.save(
        em.create(DriverProfile, {
          userId: u.id,
          cityId: dto.cityId,
          status: DriverStatus.APPLIED,
          vehicleType: dto.vehicleType ?? undefined,
          vehicleMake: dto.vehicleMake ?? null,
          vehicleModel: dto.vehicleModel ?? null,
          vehicleColor: dto.vehicleColor ?? null,
          licensePlate: dto.licensePlate ?? null,
          meta: { createdBy: admin.id },
        }),
      );
    });
    return { id: profile.id, temporaryPassword: dto.password ? undefined : tempPassword };
  }

  async update(id: string, dto: UpdateDriverDto) {
    const d = await this.core.getProfile(id);
    const before = this.row(d);
    const u = d.user;
    if (dto.firstName !== undefined) u.firstName = dto.firstName;
    if (dto.lastName !== undefined) u.lastName = dto.lastName;
    if (dto.phone !== undefined && dto.phone !== u.phone) {
      const other = await this.core.users.findOne({ where: { phone: dto.phone } });
      if (other && other.id !== u.id) throw new ConflictException('Phone already registered');
      u.phone = dto.phone;
    }
    await this.core.users.save(u);
    for (const k of ['cityId', 'vehicleType', 'vehicleMake', 'vehicleModel', 'vehicleColor', 'licensePlate', 'payoutSchedule', 'insulatedBagConfirmed'] as const) {
      if ((dto as any)[k] !== undefined) (d as any)[k] = (dto as any)[k];
    }
    if (dto.notes !== undefined) d.meta = { ...d.meta, notes: dto.notes };
    await this.core.profiles.save(d);
    return { before, after: this.row(d) };
  }

  /** Soft delete: only drivers without trips may be removed; others must be deactivated. */
  async remove(id: string) {
    const d = await this.core.getProfile(id);
    const trips = await this.orders.count({ where: { driverId: id } });
    if (trips > 0) throw new BadRequestException('Driver has trip history - deactivate instead of deleting');
    d.user.status = UserStatus.DELETED;
    d.user.deletedAt = new Date();
    await this.core.users.save(d.user);
    await this.core.changeStatus(d, DriverStatus.DEACTIVATED, { type: ActorType.SYSTEM }, 'Deleted by admin');
    return { ok: true };
  }

  // ------------------------------------------------------------------ SOP-02 step 1: documents
  async startReview(id: string, admin: AuthUser) {
    const d = await this.core.getProfile(id);
    if (d.status !== DriverStatus.APPLIED) throw new BadRequestException(`Driver is ${d.status}, not APPLIED`);
    await this.core.changeStatus(d, DriverStatus.DOCS_REVIEW, this.actor(admin));
    return this.core.checklist(d);
  }

  async reviewDocument(id: string, docId: string, dto: ReviewDocumentDto, admin: AuthUser) {
    const d = await this.core.getProfile(id);
    const doc = await this.core.docs.findOne({ where: { id: docId, driverId: id } });
    if (!doc) throw new NotFoundException('Document not found');
    const before = { status: doc.status, expiresAt: doc.expiresAt, rejectReason: doc.rejectReason };
    if (dto.status === DocStatus.REJECTED) {
      const reason = this.core.requireReason(dto.rejectReason);
      doc.status = DocStatus.REJECTED;
      doc.rejectReason = reason;
    } else {
      const expiresAt = dto.expiresAt ?? doc.expiresAt;
      if (NEEDS_EXPIRY.includes(doc.type) && !expiresAt) throw new BadRequestException(`An expiry date is required to approve a ${doc.type}`);
      if (expiresAt && expiresAt < todayStr()) throw new BadRequestException('Document is already expired - reject it with reason "Document expired"');
      doc.status = DocStatus.APPROVED;
      doc.rejectReason = null;
      doc.expiresAt = expiresAt ?? null;
      doc.expiryReminderSentAt = null;
    }
    doc.reviewedById = admin.id;
    doc.reviewedAt = new Date();
    await this.core.docs.save(doc);
    if (d.status === DriverStatus.APPLIED) await this.core.changeStatus(d, DriverStatus.DOCS_REVIEW, this.actor(admin));
    if (doc.type === DriverDocType.INSURANCE && doc.status === DocStatus.APPROVED && d.meta?.insurance) {
      d.meta = { ...d.meta, insurance: { ...d.meta.insurance, expiresAt: doc.expiresAt } };
      await this.core.profiles.save(d);
    }
    if (dto.status === DocStatus.REJECTED) {
      await this.core.notifyDriver(d, 'document.rejected', { docType: doc.type, reason: doc.rejectReason }, { documentId: doc.id }, {
        title: 'Document rejected',
        body: `Your ${doc.type} was rejected: ${doc.rejectReason}. Please upload a new copy.`,
      });
    }
    return { before, after: doc };
  }

  async setInsurance(id: string, dto: InsuranceDto) {
    const d = await this.core.getProfile(id);
    d.meta = { ...d.meta, insurance: { coversDelivery: dto.coversDelivery, expiresAt: dto.expiresAt, provider: dto.provider ?? null, policyNumber: dto.policyNumber ?? null, confirmedAt: new Date().toISOString() } };
    await this.core.profiles.save(d);
    const ins = await this.core.docs.findOne({ where: { driverId: id, type: DriverDocType.INSURANCE }, order: { createdAt: 'DESC' } });
    if (ins) {
      ins.expiresAt = dto.expiresAt;
      ins.expiryReminderSentAt = null;
      await this.core.docs.save(ins);
    }
    return d.meta.insurance;
  }

  // ------------------------------------------------------------------ SOP-02 step 2: background check (Certn)
  async startBackgroundCheck(id: string, admin: AuthUser) {
    const d = await this.core.getProfile(id);
    if (![DriverStatus.DOCS_REVIEW, DriverStatus.BACKGROUND_CHECK, DriverStatus.APPLIED].includes(d.status)) {
      throw new BadRequestException(`Cannot start a background check while driver is ${d.status}`);
    }
    if (d.backgroundCheckStatus === 'IN_PROGRESS') throw new BadRequestException('A background check is already in progress');
    this.assertNotAutomatic(d);
    const docs = await this.core.requiredDocState(id);
    const unapproved = docs.filter((x) => !x.valid).map((x) => x.type);
    if (unapproved.length) throw new BadRequestException(`Documents must be approved first: ${unapproved.join(', ')}`);
    const res = await this.certn.start(
      { subjectId: d.id, kind: 'DRIVER', firstName: d.user.firstName, lastName: d.user.lastName, email: d.user.email, phone: d.user.phone },
      (r) => void this.applyBackgroundResult(r).catch((e) => this.logger.error(e.message)),
    );
    d.backgroundCheckProvider = res.provider;
    d.backgroundCheckRef = res.ref;
    d.backgroundCheckStatus = 'IN_PROGRESS';
    d.meta = { ...d.meta, backgroundCheckHistory: [...(d.meta?.backgroundCheckHistory ?? []), { at: new Date().toISOString(), event: 'STARTED', by: admin.id, ref: res.ref, provider: res.provider }] };
    if (d.status !== DriverStatus.BACKGROUND_CHECK) await this.core.changeStatus(d, DriverStatus.BACKGROUND_CHECK, this.actor(admin));
    else await this.core.profiles.save(d);
    return { provider: res.provider, ref: res.ref, status: d.backgroundCheckStatus };
  }

  /** A driver whose verification is run by the automatic (Certn) method is handled by the Verification service, not by the manual SOP-02 buttons. */
  private assertNotAutomatic(d: DriverProfile) {
    if (d.verificationMethod === VerificationMethod.AUTOMATIC && [VerificationStatus.PENDING, VerificationStatus.NEEDS_REVIEW].includes(d.verificationStatus)) {
      throw new BadRequestException('This driver is verified automatically (Certn): use the Verification card (start check, verify or reject) instead');
    }
  }

  /**
   * Called by the Certn webhook and by the mock provider. Idempotent.
   * `advance: false` records the result without moving the driver on to TRAINING (the automatic method decides what happens next);
   * `quietWhenClear` does not tell staff about a clear result (automatic verification activates the driver by itself: only flagged or failed results need a person).
   */
  async applyBackgroundResult(r: BackgroundCheckResult, opts: { advance?: boolean; quietWhenClear?: boolean } = {}): Promise<boolean> {
    const d = await this.core.profiles.findOne({ where: { backgroundCheckRef: r.ref }, relations: ['user'] });
    if (!d) return false;
    if (r.status === 'IN_PROGRESS' || d.backgroundCheckStatus === r.status) return true;
    d.backgroundCheckStatus = r.status;
    d.meta = { ...d.meta, backgroundCheckHistory: [...(d.meta?.backgroundCheckHistory ?? []), { at: new Date().toISOString(), event: 'RESULT', status: r.status, ref: r.ref, reportUrl: r.reportUrl ?? null }] };
    if (r.status === 'CLEAR' && d.status === DriverStatus.BACKGROUND_CHECK && opts.advance !== false) {
      await this.core.changeStatus(d, DriverStatus.TRAINING, { type: ActorType.SYSTEM }, 'Background check clear');
    } else {
      await this.core.profiles.save(d);
    }
    if (!(opts.quietWhenClear && r.status === 'CLEAR')) {
      await this.core.opsNotify('driver.background_check', `Background check ${r.status}`, `${this.core.driverName(d)}: background check result is ${r.status}.`, { driverId: d.id, status: r.status });
    }
    return true;
  }

  async overrideBackground(id: string, dto: BackgroundOverrideDto, admin: AuthUser) {
    const d = await this.core.getProfile(id);
    this.assertNotAutomatic(d);
    d.backgroundCheckStatus = dto.status;
    d.meta = { ...d.meta, backgroundCheckHistory: [...(d.meta?.backgroundCheckHistory ?? []), { at: new Date().toISOString(), event: 'OVERRIDE', status: dto.status, by: admin.id, note: dto.note }] };
    if (dto.status === 'CLEAR' && d.status === DriverStatus.BACKGROUND_CHECK) await this.core.changeStatus(d, DriverStatus.TRAINING, this.actor(admin), 'Background check cleared manually');
    else await this.core.profiles.save(d);
    return { status: d.backgroundCheckStatus, driverStatus: d.status };
  }

  // ------------------------------------------------------------------ approval / activation
  async approve(id: string, dto: ApproveDto, admin: AuthUser) {
    const d = await this.core.getProfile(id);
    if (!PRE_ACTIVE.includes(d.status) || d.status === DriverStatus.APPROVED) {
      if (d.status === DriverStatus.APPROVED && dto.zoneIds?.length) return this.activate(id, { zoneIds: dto.zoneIds, insulatedBagConfirmed: dto.insulatedBagConfirmed ?? d.insulatedBagConfirmed }, admin);
      throw new BadRequestException(`Driver is ${d.status}`);
    }
    if (!dto.override) {
      const cl = await this.core.checklist(d);
      const gates = ['documents_approved', 'insurance_confirmed', 'background_check', 'training'];
      const missing = cl.steps.filter((s) => gates.includes(s.key) && !s.done).map((s) => s.key);
      if (missing.length) throw new BadRequestException({ message: 'Onboarding checklist incomplete', missing } as any);
    }
    // approving a driver by hand IS the manual verification (docs/verification.md)
    const now = new Date();
    await this.core.changeStatus(d, DriverStatus.APPROVED, this.actor(admin), dto.note ?? null, {
      approvedAt: now,
      verificationStatus: VerificationStatus.VERIFIED,
      verificationMethod: VerificationMethod.MANUAL,
      verifiedAt: now,
      verifiedBy: admin.id,
      verificationDueAt: null,
      meta: withoutRestore(d.meta),
    });
    await this.core.notifyDriver(d, 'account.approved', { name: d.user.firstName });
    if (dto.zoneIds?.length) return this.activate(id, { zoneIds: dto.zoneIds, insulatedBagConfirmed: dto.insulatedBagConfirmed ?? d.insulatedBagConfirmed }, admin);
    return { status: d.status };
  }

  async activate(id: string, dto: ActivateDto, admin: AuthUser) {
    const d = await this.core.getProfile(id);
    if (d.status !== DriverStatus.APPROVED) throw new BadRequestException(`Driver must be APPROVED first (currently ${d.status})`);
    // staff may choose zones; otherwise the courier keeps the one switched on at approval (the local zone they signed up from)
    const zoneIds = dto.zoneIds?.length ? dto.zoneIds : (d.zoneIds ?? []);
    if (!zoneIds.length) throw new BadRequestException('Choose at least one zone');
    if (!dto.insulatedBagConfirmed) throw new BadRequestException('Insulated bag must be confirmed');
    await this.assertZones(zoneIds);
    await this.core.changeStatus(d, DriverStatus.ACTIVE, this.actor(admin), null, { zoneIds, insulatedBagConfirmed: true });
    await this.core.sendWelcome(d);
    return { status: d.status, zoneIds: d.zoneIds };
  }

  async reject(id: string, dto: ReasonDto, admin: AuthUser) {
    const d = await this.core.getProfile(id);
    if (!PRE_ACTIVE.includes(d.status)) throw new BadRequestException(`Driver is ${d.status}; use deactivate`);
    const reason = this.core.requireReason(dto.reason);
    await this.core.changeStatus(d, DriverStatus.REJECTED, this.actor(admin), reason, { verificationStatus: VerificationStatus.REJECTED, verificationDueAt: null, meta: withoutRestore(d.meta) });
    await this.core.notifyDriver(d, 'account.rejected', { reason });
    return { status: d.status };
  }

  // ------------------------------------------------------------------ SOP-08: suspend / deactivate / reinstate
  private async notice(d: DriverProfile, kind: 'SUSPENDED' | 'DEACTIVATED', dto: ReasonDto, admin: AuthUser) {
    const reason = this.core.requireReason(dto.reason);
    const days = dto.respondWithinDays ?? this.core.settings.get<number>('driver.deactivationResponseDays', 7);
    const respondBy = new Date(Date.now() + days * 86400000);
    const notice = { at: new Date().toISOString(), kind, reason, respondBy: respondBy.toISOString(), by: admin.id, evidence: dto.evidence ?? null };
    d.meta = { ...d.meta, notices: [...(d.meta?.notices ?? []), notice] };
    return { reason, respondBy, notice };
  }

  async suspend(id: string, dto: ReasonDto, admin: AuthUser) {
    const d = await this.core.getProfile(id);
    if (d.status !== DriverStatus.ACTIVE) throw new BadRequestException(`Only ACTIVE drivers can be suspended (currently ${d.status})`);
    const n = await this.notice(d, 'SUSPENDED', dto, admin);
    await this.core.changeStatus(d, DriverStatus.SUSPENDED, this.actor(admin), n.reason);
    await this.core.notifyDriver(d, 'account.deactivation_notice', { reason: n.reason, respondBy: n.respondBy.toDateString() }, { kind: 'SUSPENDED', respondBy: n.respondBy });
    return { status: d.status, respondBy: n.respondBy };
  }

  async deactivate(id: string, dto: ReasonDto, admin: AuthUser) {
    const d = await this.core.getProfile(id);
    if (![DriverStatus.ACTIVE, DriverStatus.SUSPENDED, DriverStatus.APPROVED].includes(d.status)) throw new BadRequestException(`Cannot deactivate a driver in ${d.status}`);
    if (d.onTrip) throw new BadRequestException('Driver is on a trip - reassign or wait until the trip ends');
    const n = await this.notice(d, 'DEACTIVATED', dto, admin);
    await this.core.changeStatus(d, DriverStatus.DEACTIVATED, this.actor(admin), n.reason);
    await this.core.notifyDriver(d, 'account.deactivation_notice', { reason: n.reason, respondBy: n.respondBy.toDateString() }, { kind: 'DEACTIVATED', respondBy: n.respondBy });
    return { status: d.status, respondBy: n.respondBy, unpaidBalance: await this.balance(id), note: 'Finalise any unpaid balance via Finance (SOP-08 step 4)' };
  }

  async reinstate(id: string, reason: string | undefined, admin: AuthUser) {
    const d = await this.core.getProfile(id);
    if (![DriverStatus.SUSPENDED, DriverStatus.DEACTIVATED].includes(d.status)) throw new BadRequestException(`Driver is ${d.status}`);
    if (this.core.docsRequired(d)) {
      const docs = await this.core.requiredDocState(id);
      const bad = docs.filter((x) => !x.valid).map((x) => x.type);
      if (bad.length) throw new BadRequestException(`Required documents not valid: ${bad.join(', ')}`);
    }
    if (!d.zoneIds.length) throw new BadRequestException('No zones assigned - assign zones first');
    await this.core.changeStatus(d, DriverStatus.ACTIVE, this.actor(admin), reason ?? null);
    d.meta = { ...d.meta, notices: [...(d.meta?.notices ?? []), { at: new Date().toISOString(), kind: 'REINSTATED', reason: reason ?? null, by: admin.id }] };
    await this.core.profiles.save(d);
    await this.core.notifyDriver(d, 'account.approved', { name: d.user.firstName }, { reinstated: true });
    return { status: d.status };
  }

  private async assertZones(zoneIds: string[]) {
    const found = await this.zones.count({ where: { id: In(zoneIds) } });
    if (found !== new Set(zoneIds).size) throw new BadRequestException('One or more zones do not exist');
  }

  async setZones(id: string, zoneIds: string[]) {
    const d = await this.core.getProfile(id);
    await this.assertZones(zoneIds);
    const before = d.zoneIds;
    d.zoneIds = zoneIds;
    if (d.activeZoneId && !zoneIds.includes(d.activeZoneId)) this.core.applyOffline(d);
    await this.core.profiles.save(d);
    return { before, after: d.zoneIds };
  }

  // ------------------------------------------------------------------ export
  async exportCsv(q: DriverListQuery): Promise<string> {
    const rows = await this.listQb(q).orderBy('d.createdAt', 'DESC').limit(5000).getMany();
    const esc = csvCell;
    const head = ['id', 'name', 'email', 'phone', 'status', 'vehicle', 'online', 'rating', 'acceptance', 'completion', 'onTime', 'trips', 'cancellations', 'backgroundCheck', 'unpaidBalance', 'lifetimeEarnings', 'createdAt'];
    const lines = rows.map((d) =>
      [d.id, this.core.driverName(d), d.user?.email, d.user?.phone, d.status, d.vehicleType, d.isOnline, d.rating, d.acceptanceRate, d.completionRate, d.onTimeRate, d.totalTrips, d.cancellations, d.backgroundCheckStatus, d.pendingBalance, d.lifetimeEarnings, d.createdAt?.toISOString()].map(esc).join(','),
    );
    return [head.join(','), ...lines].join('\n');
  }

  async incentiveCount(id: string) {
    return this.core.incentives.count({ where: { driverId: id } });
  }
}
