import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  DriverDocument,
  DriverProfile,
  Incentive,
  TrainingAttempt,
  TrainingModule,
  User,
  Zone,
} from '../database/entities';
import { ActorType, DocStatus, DriverDocType, DriverStatus, NotificationChannel, UserStatus, UserType, VerificationMethod } from '../common/enums';
import { ActorRef, Events, StatusChangedEvent } from '../common/contracts';
import { registrationZoneFor } from './zone-rules';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.module';
import { todayStr } from './drivers.util';

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  detail?: string;
  /** who has to act: DRIVER | OPS */
  owner: 'DRIVER' | 'OPS';
  /** not needed for this driver to work (admitted instantly, verified by Certn, or verified despite missing documents): left out of `missing`, `driverActions` and `percent` */
  optional?: boolean;
}

export const PRE_ACTIVE: DriverStatus[] = [
  DriverStatus.APPLIED,
  DriverStatus.DOCS_REVIEW,
  DriverStatus.BACKGROUND_CHECK,
  DriverStatus.TRAINING,
  DriverStatus.APPROVED,
];

/** Shared domain logic used by the admin pipeline, the driver app and the schedulers. */
@Injectable()
export class DriverCoreService {
  constructor(
    @InjectRepository(DriverProfile) readonly profiles: Repository<DriverProfile>,
    @InjectRepository(DriverDocument) readonly docs: Repository<DriverDocument>,
    @InjectRepository(TrainingModule) readonly modules: Repository<TrainingModule>,
    @InjectRepository(TrainingAttempt) readonly attempts: Repository<TrainingAttempt>,
    @InjectRepository(Incentive) readonly incentives: Repository<Incentive>,
    @InjectRepository(User) readonly users: Repository<User>,
    @InjectRepository(Zone) readonly zoneRepo: Repository<Zone>,
    readonly settings: SettingsService,
    readonly notifications: NotificationsService,
    readonly rt: RealtimeService,
    readonly events: EventEmitter2,
  ) {}

  async getProfile(id: string): Promise<DriverProfile> {
    const p = await this.profiles.findOne({ where: { id }, relations: ['user'] });
    if (!p) throw new NotFoundException('Driver not found');
    return p;
  }

  driverName(p: DriverProfile) {
    return `${p.user?.firstName ?? ''} ${p.user?.lastName ?? ''}`.trim() || 'Driver';
  }

  requiredDocTypes(): DriverDocType[] {
    return this.settings.get<DriverDocType[]>('driver.requiredDocuments', [
      DriverDocType.LICENCE,
      DriverDocType.VEHICLE_REGISTRATION,
      DriverDocType.INSURANCE,
      DriverDocType.PHOTO,
      DriverDocType.WORK_ELIGIBILITY,
    ]);
  }

  /** Latest document per required type with a validity verdict. */
  async requiredDocState(driverId: string) {
    const docs = await this.docs.find({ where: { driverId }, order: { createdAt: 'DESC' } });
    const today = todayStr();
    return this.requiredDocTypes().map((type) => {
      const ofType = docs.filter((d) => d.type === type);
      const approved = ofType.find((d) => d.status === DocStatus.APPROVED && (!d.expiresAt || d.expiresAt >= today));
      const latest = ofType[0] ?? null;
      return {
        type,
        uploaded: !!latest,
        status: (approved ?? latest)?.status ?? null,
        expiresAt: (approved ?? latest)?.expiresAt ?? null,
        valid: !!approved,
        expired: !approved && ofType.some((d) => d.status === DocStatus.EXPIRED || (d.expiresAt && d.expiresAt < today)),
        documentId: (approved ?? latest)?.id ?? null,
      };
    });
  }

  async trainingProgress(driverId: string) {
    const mods = await this.modules.find({ where: { active: true }, order: { sortOrder: 'ASC' } });
    const attempts = await this.attempts.find({ where: { driverId }, order: { createdAt: 'DESC' } });
    const passMark = this.settings.get<number>('driver.trainingPassMark', 80);
    const rows = mods.map((m) => {
      const mine = attempts.filter((a) => a.moduleId === m.id);
      const best = mine.reduce((b, a) => Math.max(b, a.score), 0);
      const passed = mine.some((a) => a.passed);
      return { moduleId: m.id, title: m.title, attempts: mine.length, bestScore: mine.length ? best : null, passed, passMark: Math.max(m.passMark ?? 0, passMark) };
    });
    const completed = rows.length > 0 && rows.every((r) => r.passed);
    const scored = rows.filter((r) => r.bestScore !== null);
    const avg = scored.length ? Math.round((scored.reduce((s, r) => s + (r.bestScore as number), 0) / scored.length) * 10) / 10 : null;
    return { modules: rows, completed, averageScore: avg, passMark };
  }

  /** SOP-02 / spec 5.1 onboarding checklist: what is done and what is missing. */
  async checklist(p: DriverProfile) {
    const docState = await this.requiredDocState(p.id);
    const training = await this.trainingProgress(p.id);
    const insurance = p.meta?.insurance as { coversDelivery?: boolean; expiresAt?: string } | undefined;
    const all: ChecklistItem[] = [
      { key: 'profile', label: 'Sign up (name, phone, email, city, vehicle)', done: true, owner: 'DRIVER' },
      {
        key: 'documents_uploaded',
        label: 'Upload documents',
        done: docState.every((d) => d.uploaded),
        detail: docState.filter((d) => !d.uploaded).map((d) => d.type).join(', ') || undefined,
        owner: 'DRIVER',
      },
      {
        key: 'documents_approved',
        label: 'Documents approved by Driver Operations',
        done: docState.every((d) => d.valid),
        detail: docState.filter((d) => !d.valid && d.uploaded).map((d) => `${d.type}:${d.status}`).join(', ') || undefined,
        owner: 'OPS',
      },
      {
        key: 'insurance_confirmed',
        label: 'Insurance covers delivery use (expiry recorded)',
        done: !!insurance?.coversDelivery && !!insurance?.expiresAt,
        owner: 'OPS',
      },
      {
        key: 'background_check',
        label: 'Background check clear',
        done: p.backgroundCheckStatus === 'CLEAR',
        detail: p.backgroundCheckStatus,
        owner: 'OPS',
      },
      { key: 'bank', label: 'Bank details for payouts', done: !!p.bank?.accountLast4 || !!p.bank?.debitCardLast4, owner: 'DRIVER' },
      { key: 'tax', label: 'T4A tax information', done: !!p.taxInfo?.sinLast3, owner: 'DRIVER' },
      {
        key: 'training',
        label: `Training + quiz (${training.passMark}% pass mark)`,
        done: p.trainingCompleted || training.completed,
        detail: `${training.modules.filter((m) => m.passed).length}/${training.modules.length} modules passed`,
        owner: 'DRIVER',
      },
      { key: 'notice_ack', label: 'Ontario platform worker notice acknowledged', done: p.ontarioPlatformWorkerNoticeAcked, owner: 'DRIVER' },
      { key: 'insulated_bag', label: 'Insulated bag confirmed', done: p.insulatedBagConfirmed, owner: 'OPS' },
      { key: 'approved', label: 'Approved', done: [DriverStatus.APPROVED, DriverStatus.ACTIVE].includes(p.status), owner: 'OPS' },
      { key: 'zones', label: 'Activated for zones', done: p.status === DriverStatus.ACTIVE && p.zoneIds.length > 0, owner: 'OPS' },
    ];
    // what staff would have checked is optional for a driver who was admitted without that check (docs/verification.md); the Certn check itself
    // stays required for a driver whose verification is automatic, and the manual process is unchanged
    const STAFF_CHECKED = ['documents_uploaded', 'documents_approved', 'insurance_confirmed', 'background_check', 'training', 'insulated_bag'];
    const instantOrWaived = p.verificationMethod === VerificationMethod.INSTANT || p.meta?.verification?.docsWaived === true;
    const optional = instantOrWaived ? STAFF_CHECKED : p.verificationMethod === VerificationMethod.AUTOMATIC ? STAFF_CHECKED.filter((k) => k !== 'background_check') : [];
    const steps: ChecklistItem[] = all.map((s) => (optional.includes(s.key) ? { ...s, optional: true } : s));
    const needed = steps.filter((s) => !s.optional);
    const missing = needed.filter((s) => !s.done);
    return {
      status: p.status,
      statusReason: p.statusReason,
      steps,
      missing: missing.map((m) => m.key),
      driverActions: missing.filter((m) => m.owner === 'DRIVER').map((m) => m.key),
      percent: Math.round((needed.filter((s) => s.done).length / needed.length) * 100),
      complete: missing.length === 0,
    };
  }

  /**
   * Must staff-approved documents be on file for this driver to work? Yes for the manual process (also for drivers created by staff, where
   * the method is not set). No for drivers admitted instantly or verified by the Certn check: that is the point of those modes. No either
   * when a Super Admin verified the driver despite missing documents (`docsWaived`, docs/verification.md).
   */
  docsRequired(p: Pick<DriverProfile, 'verificationMethod' | 'meta'>): boolean {
    if (p.meta?.verification?.docsWaived) return false;
    return p.verificationMethod !== VerificationMethod.INSTANT && p.verificationMethod !== VerificationMethod.AUTOMATIC;
  }

  /** Can the driver go online right now? */
  async goOnlineCheck(p: DriverProfile): Promise<{ ok: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    if (p.status !== DriverStatus.ACTIVE) reasons.push(`Account status is ${p.status}`);
    if (p.user && p.user.status !== UserStatus.ACTIVE) reasons.push(`User account is ${p.user.status}`);
    if (this.docsRequired(p)) {
      const docs = await this.requiredDocState(p.id);
      for (const d of docs) if (!d.valid) reasons.push(d.expired ? `${d.type} has expired` : `${d.type} is ${d.status ?? 'missing'}`);
    }
    if (!p.zoneIds?.length) reasons.push('No zone assigned');
    if (!p.ontarioPlatformWorkerNoticeAcked) reasons.push('Ontario platform worker notice not acknowledged');
    return { ok: reasons.length === 0, reasons };
  }

  /** The zone the courier signed up from, if it still qualifies (see registrationZoneFor). */
  async registrationZoneId(p: DriverProfile): Promise<string | null> {
    const id = p.meta?.registrationZoneId;
    if (!id) return null;
    const zone = await this.zoneRepo.findOne({ where: { id } });
    return registrationZoneFor(p, zone);
  }

  async changeStatus(p: DriverProfile, to: DriverStatus, actor: ActorRef, reason?: string | null, extra: Partial<DriverProfile> = {}) {
    const from = p.status;
    p.status = to;
    p.statusReason = reason ?? null;
    Object.assign(p, extra);
    // approved (or active) with no zone yet: switch on the local zone they signed up from
    if ((to === DriverStatus.APPROVED || to === DriverStatus.ACTIVE) && !p.zoneIds?.length) {
      const zoneId = await this.registrationZoneId(p);
      if (zoneId) p.zoneIds = [zoneId];
    }
    if (to !== DriverStatus.ACTIVE && p.isOnline) this.applyOffline(p);
    await this.profiles.save(p);
    if (from !== to) {
      const payload: StatusChangedEvent = { id: p.id, from, to, reason: reason ?? undefined, actor };
      this.events.emit(Events.DRIVER_STATUS_CHANGED, payload);
      this.rt.emitToDriver(p.id, 'driver.status', { status: to, reason: reason ?? null });
      this.rt.emitToOps('driver.status', { driverId: p.id, status: to, isOnline: p.isOnline });
    }
    return p;
  }

  /** mutate profile to offline (caller saves) and track online minutes for utilisation stats */
  applyOffline(p: DriverProfile) {
    if (p.isOnline && p.wentOnlineAt) {
      const mins = Math.max(0, (Date.now() - new Date(p.wentOnlineAt).getTime()) / 60000);
      const day = new Date().toISOString().slice(0, 10);
      const log: Record<string, number> = { ...(p.meta?.onlineMinutes ?? {}) };
      log[day] = Math.round(((log[day] ?? 0) + mins) * 10) / 10;
      const keys = Object.keys(log).sort().slice(-45);
      p.meta = { ...(p.meta ?? {}), onlineMinutes: Object.fromEntries(keys.map((k) => [k, log[k]])) };
    }
    if (p.activeZoneId) this.rt.server?.in(`driver:${p.id}`).socketsLeave(`zone:${p.activeZoneId}`);
    p.isOnline = false;
    p.activeZoneId = null;
    p.wentOnlineAt = null;
  }

  async forceOffline(p: DriverProfile, reason: string) {
    if (!p.isOnline) return;
    this.applyOffline(p);
    await this.profiles.save(p);
    this.rt.emitToDriver(p.id, 'driver.status', { status: p.status, isOnline: false, reason });
    this.rt.emitToOps('driver.status', { driverId: p.id, status: p.status, isOnline: false });
  }

  async notifyDriver(p: DriverProfile, event: string, vars: Record<string, any> = {}, data: Record<string, any> = {}, literal?: { title: string; body: string }) {
    await this.notifications.notify({ userId: p.userId, audience: 'DRIVER', event, vars, data: { driverId: p.id, ...data }, ...(literal ?? {}) });
  }

  /** SOP-02 step 5: welcome message + first-week boost (per-driver FIRST_WEEK incentive). */
  async sendWelcome(p: DriverProfile) {
    if (p.welcomeBoostSent) return;
    const amount = this.settings.get<number>('driver.welcomeBoostAmount', 2);
    const days = this.settings.get<number>('driver.firstWeekDays', 7);
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + days * 86400000);
    await this.incentives.save(
      this.incentives.create({
        name: 'First-week boost',
        description: `Welcome to FORKY! +$${amount.toFixed(2)} on every trip for your first ${days} days.`,
        type: 'FIRST_WEEK',
        driverId: p.id,
        cityId: p.cityId,
        zoneId: null,
        amountPerTrip: amount,
        percentBoost: 0,
        questTrips: null,
        bonusAmount: 0,
        startsAt,
        endsAt,
        daysOfWeek: [],
        active: true,
      }),
    );
    p.welcomeBoostSent = true;
    await this.profiles.save(p);
    await this.notifyDriver(p, 'driver.welcome', { name: p.user?.firstName ?? '', boost: `$${amount.toFixed(2)}`, days }, {}, {
      title: 'Welcome to FORKY!',
      body: `You are active. Enjoy a +$${amount.toFixed(2)} boost on every trip for your first ${days} days. Go online in your zones to start earning.`,
    });
  }

  /** Literal in-app message to all staff + realtime ops event (for events without a built-in template). */
  async opsNotify(event: string, title: string, body: string, data: Record<string, any> = {}) {
    // staff with access to the module of the event, through the notification matrix (SOS also reaches their phones)
    await this.notifications.notifyOps(event, {}, data, { title, body });
  }

  requireReason(reason?: string) {
    if (!reason || reason.trim().length < 3) throw new BadRequestException('A reason is required');
    return reason.trim();
  }

  actor(user: { id?: string; name?: string }): ActorRef {
    return { type: ActorType.STAFF, id: user?.id ?? null, name: user?.name };
  }
}
