import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Brackets, In, LessThanOrEqual, Repository } from 'typeorm';
import { DriverProfile, Zone } from '../database/entities';
import { ActorType, DriverStatus, UserStatus, VerificationAudience, VerificationMethod, VerificationStatus } from '../common/enums';
import { ActorRef } from '../common/contracts';
import { AuthUser } from '../common/auth.types';
import { like, paginateQb } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { DriverCoreService, PRE_ACTIVE } from '../drivers/driver-core.service';
import { DriversAdminService } from '../drivers/drivers-admin.service';
import { BackgroundCheckResult, CertnAdapter } from '../drivers/adapters/certn.adapter';
import {
  VerificationChoice,
  VerificationPolicy,
  assertOverrideAllowed,
  certnStatus,
  deadlineText,
  verificationSteps,
  verificationSummary,
  withoutRestore,
} from './verification-policy';
import { AudienceHandler, ForceItemResult, ForceOptions, ForceOutcome, Gate, RegistrationResult, StatusCounts, SubjectsQueryInput } from './verification.types';
import { requirementsNotMet } from './verification.errors';

const SYSTEM: ActorRef = { type: ActorType.SYSTEM };
const staff = (u: AuthUser): ActorRef => ({ type: ActorType.STAFF, id: u.id, name: u.name });
/** the states in which a subject can still be verified */
const OPEN: VerificationStatus[] = [VerificationStatus.UNVERIFIED, VerificationStatus.PENDING, VerificationStatus.NEEDS_REVIEW];
/** starting the Certn check failed this many times (network, bad key ...): hand the driver to staff */
export const MAX_CHECK_ATTEMPTS = 5;

/** Drivers: instant activation, the manual SOP-02 queue or the automatic Certn check, force verification and the checks that go with them. */
@Injectable()
export class DriverVerification implements AudienceHandler {
  readonly audience = VerificationAudience.DRIVER;
  private readonly logger = new Logger('DriverVerification');

  constructor(
    private core: DriverCoreService,
    private admin: DriversAdminService,
    private certn: CertnAdapter,
    private audit: AuditService,
    @InjectRepository(Zone) private zones: Repository<Zone>,
  ) {}

  // ------------------------------------------------------------------ helpers
  private result(p: DriverProfile, mode: VerificationMethod): RegistrationResult {
    return { mode, accountStatus: p.status, verification: verificationSummary(VerificationAudience.DRIVER, p) };
  }

  /** every active zone of the driver's city: what an unattended activation gives them (staff can narrow it later) */
  /** Zones a newly active driver starts with: the local zone they signed up from; if none was recorded, every active zone of their city (as before). */
  private async startingZones(p: DriverProfile): Promise<string[]> {
    const own = await this.core.registrationZoneId(p);
    return own ? [own] : this.cityZoneIds(p.cityId);
  }

  private async cityZoneIds(cityId: string | null): Promise<string[]> {
    if (!cityId) return [];
    return (await this.zones.find({ where: { cityId, active: true }, select: ['id'] })).map((z) => z.id);
  }

  private effective(p: DriverProfile, policy: VerificationPolicy): VerificationChoice {
    return p.verificationMethod === VerificationMethod.MANUAL || p.verificationMethod === VerificationMethod.AUTOMATIC ? p.verificationMethod : policy.method;
  }

  private assertOpen(p: DriverProfile) {
    if (!OPEN.includes(p.verificationStatus)) {
      throw new BadRequestException(p.verificationStatus === VerificationStatus.VERIFIED ? 'This driver is already verified' : `This driver's verification is ${p.verificationStatus}`);
    }
  }

  // ------------------------------------------------------------------ registration
  async onRegistered(id: string, policy: VerificationPolicy): Promise<RegistrationResult> {
    const p = await this.core.getProfile(id);
    // already handled (the event is raised once per sign-up, but staying idempotent costs nothing)
    if (p.status !== DriverStatus.APPLIED || p.verificationMethod) return this.result(p, p.verificationMethod ?? policy.mode);

    if (policy.instant) {
      await this.activateInstantly(p);
      return this.result(p, VerificationMethod.INSTANT);
    }
    if (policy.method === VerificationMethod.AUTOMATIC && certnStatus().ready) {
      p.verificationStatus = VerificationStatus.PENDING;
      p.verificationMethod = VerificationMethod.AUTOMATIC;
      await this.core.profiles.save(p);
      // a Certn outage must not break sign-up: the sweeper retries, and after a few failures staff take over
      await this.beginCheck(p, null).catch((e) => this.checkFailed(p, e));
      return this.result(await this.core.getProfile(id), VerificationMethod.AUTOMATIC);
    }
    p.verificationStatus = VerificationStatus.PENDING;
    p.verificationMethod = VerificationMethod.MANUAL;
    // the automatic method is chosen but Certn cannot be used at this moment: the sign-up waits for staff instead of failing
    if (policy.method === VerificationMethod.AUTOMATIC) p.meta = { ...p.meta, verification: { ...p.meta?.verification, fallback: 'CERTN_NOT_READY' } };
    await this.core.profiles.save(p);
    return this.result(p, VerificationMethod.MANUAL);
  }

  private async activateInstantly(p: DriverProfile) {
    const zoneIds = await this.startingZones(p);
    await this.core.changeStatus(p, DriverStatus.ACTIVE, SYSTEM, 'Instant registration (not verified)', {
      approvedAt: new Date(),
      zoneIds,
      verificationStatus: VerificationStatus.UNVERIFIED,
      verificationMethod: VerificationMethod.INSTANT,
      verifiedAt: null,
      verifiedBy: null,
      verificationDueAt: null,
    });
    await this.core.sendWelcome(p);
    await this.audit.log({ actor: null, action: 'verification.instant_activate', entity: 'driver', entityId: p.id, after: { zones: zoneIds.length } });
  }

  // ------------------------------------------------------------------ the Certn check
  /** Starts the Certn check and records it (no document precondition: the automatic method is the check itself). */
  private async beginCheck(p: DriverProfile, actor: AuthUser | null) {
    const res = await this.certn.start(
      { subjectId: p.id, kind: 'DRIVER', firstName: p.user.firstName, lastName: p.user.lastName, email: p.user.email, phone: p.user.phone },
      (r) => void this.applyResult(r).catch((e) => this.logger.error(`Certn result for driver ${p.id} failed: ${e.message}`)),
    );
    p.backgroundCheckProvider = res.provider;
    p.backgroundCheckRef = res.ref;
    p.backgroundCheckStatus = 'IN_PROGRESS';
    p.meta = {
      ...p.meta,
      backgroundCheckHistory: [...(p.meta?.backgroundCheckHistory ?? []), { at: new Date().toISOString(), event: 'STARTED', by: actor?.id ?? 'system', ref: res.ref, provider: res.provider, via: 'verification' }],
      verification: { ...p.meta?.verification, certnError: null },
    };
    if (p.verificationMethod === VerificationMethod.AUTOMATIC && [DriverStatus.APPLIED, DriverStatus.DOCS_REVIEW].includes(p.status)) {
      await this.core.changeStatus(p, DriverStatus.BACKGROUND_CHECK, actor ? staff(actor) : SYSTEM, 'Certn check started');
    } else {
      await this.core.profiles.save(p);
    }
  }

  private async checkFailed(p: DriverProfile, e: any) {
    const v = p.meta?.verification ?? {};
    const attempts = (v.certnAttempts ?? 0) + 1;
    const message = String(e?.message ?? e).slice(0, 200);
    this.logger.warn(`Certn check for driver ${p.id} could not start (attempt ${attempts}): ${message}`);
    p.meta = { ...p.meta, verification: { ...v, certnAttempts: attempts, certnError: message } };
    if (attempts >= MAX_CHECK_ATTEMPTS) {
      p.verificationStatus = VerificationStatus.NEEDS_REVIEW;
      await this.core.opsNotify('driver.background_check', 'Background check could not start', `${this.core.driverName(p)}: starting the Certn check failed ${attempts} times (${message}). Start it again or review the driver by hand.`, { driverId: p.id });
    }
    await this.core.profiles.save(p);
  }

  async startCheck(id: string, actor: AuthUser) {
    const p = await this.core.getProfile(id);
    this.assertOpen(p);
    const certn = certnStatus();
    if (!certn.ready) throw new BadRequestException(certn.reason ?? 'Certn is not configured');
    if (p.backgroundCheckStatus === 'IN_PROGRESS') throw new BadRequestException('A background check is already in progress');
    // an instantly admitted driver (or one flagged earlier) is put on the automatic method for this check; a driver in the manual queue keeps staff in charge
    if (p.verificationStatus !== VerificationStatus.PENDING) {
      p.verificationStatus = VerificationStatus.PENDING;
      p.verificationMethod = VerificationMethod.AUTOMATIC;
      p.verificationDueAt = p.verificationDueAt ?? null;
    }
    p.meta = { ...p.meta, verification: { ...p.meta?.verification, certnAttempts: 0, certnError: null } };
    await this.beginCheck(p, actor);
    await this.audit.log({ actor, action: 'verification.check_start', entity: 'driver', entityId: p.id, after: { provider: p.backgroundCheckProvider, ref: p.backgroundCheckRef } });
    return { provider: p.backgroundCheckProvider, ref: p.backgroundCheckRef, status: p.backgroundCheckStatus, verificationStatus: p.verificationStatus };
  }

  /** The Certn result (webhook or mock). Null when no driver has this reference. */
  async applyResult(r: BackgroundCheckResult): Promise<boolean | null> {
    const p = await this.core.profiles.findOne({ where: { backgroundCheckRef: r.ref }, relations: ['user'] });
    if (!p) return null;
    const automatic = p.verificationMethod === VerificationMethod.AUTOMATIC && [VerificationStatus.PENDING, VerificationStatus.NEEDS_REVIEW].includes(p.verificationStatus);
    // the manual SOP-02 pipeline (staff started the check, CLEAR moves the driver on to training) is unchanged
    if (!automatic) return this.admin.applyBackgroundResult(r);
    if (r.status === 'IN_PROGRESS' || p.backgroundCheckStatus === r.status) return true;
    await this.admin.applyBackgroundResult(r, { advance: false, quietWhenClear: true });
    const fresh = await this.core.getProfile(p.id);
    if (r.status === 'CLEAR') {
      await this.complete(fresh, VerificationMethod.AUTOMATIC, null, 'Certn check clear');
    } else {
      // flagged or failed: a person decides. Nobody is rejected automatically.
      fresh.verificationStatus = VerificationStatus.NEEDS_REVIEW;
      await this.core.profiles.save(fresh);
      await this.audit.log({ actor: null, action: 'verification.needs_review', entity: 'driver', entityId: fresh.id, after: { check: r.status } });
    }
    return true;
  }

  // ------------------------------------------------------------------ verify / reject
  /** The checklist the driver has to satisfy for the given method. */
  async gates(p: DriverProfile, method: VerificationChoice): Promise<Gate[]> {
    const background: Gate = { key: 'background_check', label: 'Background check clear', done: p.backgroundCheckStatus === 'CLEAR', detail: p.backgroundCheckStatus };
    if (method === VerificationMethod.AUTOMATIC) return [background];
    const docs = await this.core.requiredDocState(p.id);
    const insurance = p.meta?.insurance as { coversDelivery?: boolean; expiresAt?: string } | undefined;
    return [
      { key: 'documents_approved', label: 'Required documents approved', done: docs.every((d) => d.valid), detail: docs.filter((d) => !d.valid).map((d) => `${d.type}: ${d.status ?? 'missing'}`).join(', ') || undefined },
      { key: 'insurance_confirmed', label: 'Insurance covers delivery use (expiry recorded)', done: !!insurance?.coversDelivery && !!insurance?.expiresAt },
      background,
    ];
  }

  /**
   * Verified: the verification fields are set and a driver who is not working yet is activated (zones: all active zones of the city unless
   * staff already chose some). A driver who was taken off the road by Force verification goes back to ACTIVE. Suspended / deactivated
   * drivers are marked verified but stay as they are: reinstating them is a separate decision (SOP-08).
   */
  private async complete(p: DriverProfile, method: VerificationMethod, by: string | null, note: string) {
    const now = new Date();
    const fields: Partial<DriverProfile> = { verificationStatus: VerificationStatus.VERIFIED, verificationMethod: method, verifiedAt: now, verifiedBy: by, verificationDueAt: null, meta: withoutRestore(p.meta) };
    if (p.status === DriverStatus.ACTIVE || !PRE_ACTIVE.includes(p.status)) {
      Object.assign(p, fields);
      await this.core.profiles.save(p);
    } else {
      const zoneIds = p.zoneIds?.length ? p.zoneIds : await this.startingZones(p);
      await this.core.changeStatus(p, DriverStatus.ACTIVE, by ? { type: ActorType.STAFF, id: by } : SYSTEM, note, { ...fields, approvedAt: p.approvedAt ?? now, zoneIds });
      await this.core.sendWelcome(p);
    }
    await this.core.notifyDriver(p, 'verification.verified', { name: p.user?.firstName ?? '' }, {}).catch(() => undefined);
    await this.audit.log({ actor: null, action: 'verification.verified', entity: 'driver', entityId: p.id, after: { method, by, note } });
  }

  async verify(id: string, actor: AuthUser, dto: { note?: string; override?: boolean }, policy: VerificationPolicy) {
    const p = await this.core.getProfile(id);
    this.assertOpen(p);
    const method = this.effective(p, policy);
    const gates = await this.gates(p, method);
    const missing = gates.filter((g) => !g.done);
    let overridden = false;
    if (missing.length) {
      if (!dto.override) throw requirementsNotMet(gates);
      assertOverrideAllowed(actor, dto.note);
      overridden = true;
      // "verify anyway" must leave the driver able to work: the documents are not required to go online either (recorded, and audited below)
      if (missing.some((g) => g.key === 'documents_approved')) p.meta = { ...p.meta, verification: { ...p.meta?.verification, docsWaived: true } };
    }
    await this.complete(p, method, actor.id, dto.note?.trim() || (overridden ? 'Verified by Super Admin override' : 'Verified by staff'));
    await this.audit.log({ actor, action: 'verification.verify', entity: 'driver', entityId: p.id, after: { method, overridden, missing: missing.map((g) => g.key), note: dto.note ?? null } });
    return this.details(id, policy);
  }

  async reject(id: string, actor: AuthUser, reason: string) {
    const p = await this.core.getProfile(id);
    this.assertOpen(p);
    if (!PRE_ACTIVE.includes(p.status)) {
      throw new BadRequestException(`This driver is ${p.status}: reject only applies to drivers who are not working yet. Use suspend or deactivate for the rest (SOP-08)`);
    }
    await this.core.changeStatus(p, DriverStatus.REJECTED, staff(actor), reason, { verificationStatus: VerificationStatus.REJECTED, verificationDueAt: null, meta: withoutRestore(p.meta) });
    await this.core.notifyDriver(p, 'account.rejected', { reason });
    await this.audit.log({ actor, action: 'verification.reject', entity: 'driver', entityId: p.id, after: { reason } });
    return { status: p.status, verificationStatus: p.verificationStatus };
  }

  async details(id: string, policy: VerificationPolicy) {
    const p = await this.core.getProfile(id);
    const method = this.effective(p, policy);
    const v = p.meta?.verification ?? {};
    return {
      audience: VerificationAudience.DRIVER,
      id: p.id,
      name: this.core.driverName(p),
      email: p.user.email,
      phone: p.user.phone,
      accountStatus: p.status,
      isOnline: p.isOnline,
      onTrip: p.onTrip,
      verification: {
        ...verificationSummary(VerificationAudience.DRIVER, p),
        effectiveMethod: method,
        verifiedBy: p.verifiedBy,
        forcedAt: p.verificationForcedAt,
        fallback: v.fallback ?? null,
        certnError: v.certnError ?? null,
        certnAttempts: v.certnAttempts ?? 0,
      },
      backgroundCheck: { provider: p.backgroundCheckProvider, status: p.backgroundCheckStatus, ref: p.backgroundCheckRef, history: p.meta?.backgroundCheckHistory ?? [] },
      gates: await this.gates(p, method),
      canVerify: OPEN.includes(p.verificationStatus),
      canStartCheck: OPEN.includes(p.verificationStatus) && p.backgroundCheckStatus !== 'IN_PROGRESS',
      canReject: OPEN.includes(p.verificationStatus) && PRE_ACTIVE.includes(p.status),
    };
  }

  // ------------------------------------------------------------------ force verification
  async forceTargets(ids?: string[]) {
    const skipped: ForceItemResult[] = [];
    if (ids?.length) {
      const rows = await this.core.profiles.find({ where: { id: In(ids) }, relations: ['user'] });
      const byId = new Map(rows.map((p) => [p.id, p]));
      const targets: string[] = [];
      for (const id of ids) {
        const p = byId.get(id);
        if (!p) skipped.push({ id, name: '', outcome: 'SKIPPED', note: 'driver not found' });
        else if (p.verificationStatus !== VerificationStatus.UNVERIFIED) skipped.push({ id, name: this.core.driverName(p), outcome: 'SKIPPED', note: `already ${p.verificationStatus}` });
        else targets.push(id);
      }
      return { targets, skipped };
    }
    const rows = await this.core.profiles.find({ where: { verificationStatus: VerificationStatus.UNVERIFIED }, select: ['id'], order: { createdAt: 'ASC' }, take: 5000 });
    return { targets: rows.map((r) => r.id), skipped };
  }

  async force(id: string, o: ForceOptions): Promise<ForceItemResult> {
    const p = await this.core.getProfile(id);
    const name = this.core.driverName(p);
    if (p.verificationStatus !== VerificationStatus.UNVERIFIED) return { id, name, outcome: 'SKIPPED', note: `already ${p.verificationStatus}` };
    p.verificationStatus = VerificationStatus.PENDING;
    p.verificationMethod = o.method;
    p.verificationForcedAt = new Date();
    p.verificationDueAt = o.dueAt;
    p.verifiedAt = null;
    p.verifiedBy = null;
    p.meta = { ...p.meta, verification: { ...(p.meta?.verification ?? {}), forcedBy: o.actor.id, certnAttempts: 0, certnError: null, reminderSentAt: null, fallback: null } };
    await this.core.profiles.save(p);
    // a clear Certn result is already on file (staff ran the check earlier): nothing left to wait for
    if (o.method === VerificationMethod.AUTOMATIC && p.backgroundCheckStatus === 'CLEAR') {
      await this.complete(p, VerificationMethod.AUTOMATIC, null, 'Certn check was already clear');
      return { id, name, outcome: 'VERIFIED', note: 'a clear Certn result was already on file' };
    }
    if (o.method === VerificationMethod.AUTOMATIC && o.startCheckNow) await this.beginCheck(p, o.actor).catch((e) => this.checkFailed(p, e));
    void this.notifyRequired(p, o.method, o.dueAt);
    if (o.dueAt.getTime() > Date.now()) return { id, name, outcome: 'GRACE', note: `working until ${o.dueAt.toISOString().slice(0, 10)}` };
    if (!o.blockNow) return { id, name, outcome: 'DEFERRED', note: 'will be taken off the road by the next sweep' };
    const outcome = await this.block(p);
    const notes: Partial<Record<ForceOutcome, string>> = { DEFERRED: 'on a trip: taken off the road when it ends', SKIPPED: 'was not working: marked pending, nothing to take off the road' };
    return { id, name, outcome, note: notes[outcome] };
  }

  private async notifyRequired(p: DriverProfile, method: VerificationMethod, dueAt: Date | null) {
    await this.core
      .notifyDriver(p, 'verification.required', { deadline: deadlineText(dueAt), steps: verificationSteps(VerificationAudience.DRIVER, method) }, { audience: 'DRIVER' })
      .catch((e) => this.logger.warn(`could not notify driver ${p.id}: ${e.message}`));
  }

  /** Takes a working driver off the road until verified (remembers ACTIVE so the driver comes back by itself). */
  private async block(p: DriverProfile): Promise<ForceOutcome> {
    if (p.status !== DriverStatus.ACTIVE) return 'SKIPPED';
    if (p.onTrip) return 'DEFERRED';
    const automatic = p.verificationMethod === VerificationMethod.AUTOMATIC;
    p.meta = { ...p.meta, verification: { ...p.meta?.verification, restoreStatus: DriverStatus.ACTIVE, blockedAt: new Date().toISOString() } };
    await this.core.changeStatus(p, automatic ? DriverStatus.BACKGROUND_CHECK : DriverStatus.DOCS_REVIEW, SYSTEM, 'Verification required: finish your verification to go online again');
    await this.audit.log({ actor: null, action: 'verification.block', entity: 'driver', entityId: p.id, after: { to: p.status, dueAt: p.verificationDueAt } });
    return 'BLOCKED';
  }

  // ------------------------------------------------------------------ sweeper steps
  async enforceDue(): Promise<number> {
    const due = await this.core.profiles.find({
      where: { verificationStatus: In([VerificationStatus.PENDING, VerificationStatus.NEEDS_REVIEW, VerificationStatus.REJECTED]), status: DriverStatus.ACTIVE, verificationDueAt: LessThanOrEqual(new Date()) },
      relations: ['user'],
      order: { verificationDueAt: 'ASC' },
      take: 200,
    });
    let n = 0;
    for (const p of due) {
      try {
        if ((await this.block(p)) === 'BLOCKED') n++;
      } catch (e: any) {
        this.logger.error(`could not take driver ${p.id} off the road: ${e.message}`);
      }
    }
    return n;
  }

  async retryChecks(limit: number): Promise<number> {
    const rows = await this.core.profiles.find({
      where: {
        verificationMethod: VerificationMethod.AUTOMATIC,
        verificationStatus: VerificationStatus.PENDING,
        backgroundCheckStatus: 'NOT_STARTED',
        status: In([...PRE_ACTIVE, DriverStatus.ACTIVE]),
        updatedAt: LessThanOrEqual(new Date(Date.now() - 60_000)),
      },
      relations: ['user'],
      order: { updatedAt: 'ASC' },
      take: limit,
    });
    let n = 0;
    for (const p of rows) {
      try {
        const certn = certnStatus();
        if (!certn.ready) throw new Error(certn.reason ?? 'Certn is not configured');
        await this.beginCheck(p, null);
        n++;
      } catch (e) {
        await this.checkFailed(p, e);
      }
    }
    return n;
  }

  async remind(): Promise<number> {
    const rows = await this.core.profiles.find({
      where: { verificationStatus: VerificationStatus.PENDING, status: DriverStatus.ACTIVE, verificationDueAt: Between(new Date(), new Date(Date.now() + 24 * 3600_000)) },
      relations: ['user'],
      take: 200,
    });
    let n = 0;
    for (const p of rows) {
      if (p.meta?.verification?.reminderSentAt) continue;
      p.meta = { ...p.meta, verification: { ...p.meta?.verification, reminderSentAt: new Date().toISOString() } };
      await this.core.profiles.save(p);
      await this.notifyRequired(p, p.verificationMethod ?? VerificationMethod.MANUAL, p.verificationDueAt);
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ overview
  async counts(): Promise<StatusCounts> {
    const rows: { s: VerificationStatus; n: number }[] = await this.core.profiles.createQueryBuilder('d').select('d.verificationStatus', 's').addSelect('COUNT(*)::int', 'n').groupBy('d.verificationStatus').getRawMany();
    const by = (s: VerificationStatus) => rows.find((r) => r.s === s)?.n ?? 0;
    const operatingUnverified = await this.core.profiles.count({ where: { status: DriverStatus.ACTIVE, verificationStatus: In(OPEN) } });
    const withDeadline = await this.core.profiles
      .createQueryBuilder('d')
      .where('d.verificationDueAt IS NOT NULL AND d.verificationStatus IN (:...st)', { st: [VerificationStatus.PENDING, VerificationStatus.NEEDS_REVIEW] })
      .getCount();
    const c = {
      UNVERIFIED: by(VerificationStatus.UNVERIFIED),
      PENDING: by(VerificationStatus.PENDING),
      NEEDS_REVIEW: by(VerificationStatus.NEEDS_REVIEW),
      VERIFIED: by(VerificationStatus.VERIFIED),
      REJECTED: by(VerificationStatus.REJECTED),
    };
    return { ...c, total: Object.values(c).reduce((a, b) => a + b, 0), operatingUnverified, withDeadline };
  }

  async list(q: SubjectsQueryInput) {
    const qb = this.core.profiles.createQueryBuilder('d').innerJoinAndSelect('d.user', 'u').where('u.status != :deleted', { deleted: UserStatus.DELETED });
    if (q.status) qb.andWhere('d.verificationStatus = :vs', { vs: q.status });
    if (q.search) {
      qb.andWhere(
        new Brackets((b) =>
          b
            .where(`(u.firstName || ' ' || u.lastName) ILIKE :s`, { s: like(q.search!) })
            .orWhere('u.email ILIKE :s', { s: like(q.search!) })
            .orWhere('u.phone ILIKE :s', { s: like(q.search!) }),
        ),
      );
    }
    const res = await paginateQb(qb, { page: q.page, limit: q.limit } as any, { sortable: {}, defaultSort: ['d.createdAt', 'DESC'] });
    return {
      data: res.data.map((d) => ({
        id: d.id,
        audience: VerificationAudience.DRIVER,
        name: this.core.driverName(d),
        email: d.user?.email ?? null,
        phone: d.user?.phone ?? null,
        accountStatus: d.status,
        operating: d.status === DriverStatus.ACTIVE,
        verificationStatus: d.verificationStatus,
        verificationMethod: d.verificationMethod,
        verifiedAt: d.verifiedAt,
        verificationForcedAt: d.verificationForcedAt,
        verificationDueAt: d.verificationDueAt,
        backgroundCheckStatus: d.backgroundCheckStatus,
        createdAt: d.createdAt,
      })),
      meta: res.meta,
    };
  }
}
