import { Column, Entity, Index, JoinColumn, ManyToOne, OneToOne, Relation } from 'typeorm';
import { BaseEntity, GeoColumn, MoneyColumn, PctColumn } from '../../common/base.entity';
import { DocStatus, DriverDocType, DriverStatus, OfferStatus, VehicleType, VerificationMethod, VerificationStatus } from '../../common/enums';
import { User } from './identity.entities';

@Entity('driver_profiles')
export class DriverProfile extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'uuid' })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: Relation<User>;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  cityId: string | null;

  @Index()
  @Column({ type: 'enum', enum: DriverStatus, default: DriverStatus.APPLIED })
  status: DriverStatus;

  @Column({ type: 'text', nullable: true })
  statusReason: string | null;

  @Column({ type: 'enum', enum: VehicleType, default: VehicleType.CAR })
  vehicleType: VehicleType;

  @Column({ type: 'varchar', nullable: true })
  vehicleMake: string | null;

  @Column({ type: 'varchar', nullable: true })
  vehicleModel: string | null;

  @Column({ type: 'varchar', nullable: true })
  vehicleColor: string | null;

  @Column({ type: 'varchar', nullable: true })
  licensePlate: string | null;

  /** Zones the driver is approved to work in. */
  @Column({ type: 'jsonb', default: [] })
  zoneIds: string[];

  /** Zone the driver is currently online in. */
  @Column({ type: 'uuid', nullable: true })
  activeZoneId: string | null;

  // ---- live state ----
  @Index()
  @Column({ default: false })
  isOnline: boolean;

  /** true while carrying an order. */
  @Column({ default: false })
  onTrip: boolean;

  @GeoColumn()
  lat: number | null;

  @GeoColumn()
  lng: number | null;

  @Column({ type: 'double precision', nullable: true })
  heading: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLocationAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastOfferAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  wentOnlineAt: Date | null;

  // ---- onboarding ----
  @Column({ type: 'varchar', nullable: true })
  backgroundCheckProvider: string | null;

  @Column({ type: 'varchar', default: 'NOT_STARTED' })
  backgroundCheckStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'CLEAR' | 'CONSIDER' | 'FAILED';

  @Column({ type: 'varchar', nullable: true })
  backgroundCheckRef: string | null;

  @Column({ default: false })
  trainingCompleted: boolean;

  @PctColumn({ nullable: true })
  trainingScore: number | null;

  @Column({ default: false })
  insulatedBagConfirmed: boolean;

  @Column({ default: false })
  welcomeBoostSent: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  // ---- verification (docs/verification.md): separate from `status`; an instantly registered driver is ACTIVE but UNVERIFIED ----
  @Index()
  @Column({ type: 'enum', enum: VerificationStatus, default: VerificationStatus.PENDING })
  verificationStatus: VerificationStatus;

  /** How the driver was admitted / verified (null until decided). INSTANT / AUTOMATIC drivers need no staff-approved documents to go online. */
  @Column({ type: 'enum', enum: VerificationMethod, nullable: true })
  verificationMethod: VerificationMethod | null;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  /** staff user who verified the driver (null: verified by the Certn check, or not verified) */
  @Column({ type: 'uuid', nullable: true })
  verifiedBy: string | null;

  /** Force verification (Super Admin): when the driver was told to verify, and the deadline after which an unverified driver is taken off the road. */
  @Column({ type: 'timestamptz', nullable: true })
  verificationForcedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  verificationDueAt: Date | null;

  // ---- payout / tax ----
  @Column({ type: 'jsonb', nullable: true })
  bank: { institution?: string; transit?: string; accountLast4?: string; holder?: string; debitCardLast4?: string } | null;

  @Column({ type: 'varchar', nullable: true })
  stripeAccountId: string | null;

  /** Stripe Connect state (synced from Stripe and the account.updated webhook): NOT_STARTED | PENDING | RESTRICTED | ENABLED */
  @Column({ type: 'varchar', default: 'NOT_STARTED' })
  stripeAccountStatus: string;

  @Column({ type: 'jsonb', nullable: true })
  stripeAccountInfo: Record<string, any> | null;

  /** T4A info: SIN stored as last-3 only; full value is held by the tax provider. */
  @Column({ type: 'jsonb', nullable: true })
  taxInfo: { sinLast3?: string; sinLast4?: string; legalName?: string; address?: string; collectedAt?: string } | null;

  @Column({ type: 'varchar', default: 'WEEKLY' })
  payoutSchedule: 'WEEKLY' | 'INSTANT';

  // ---- performance ----
  @PctColumn({ default: 5 })
  rating: number;

  @Column({ default: 0 })
  ratingCount: number;

  // ---- ratings system (RatingAggregatesService; `rating` above = smoothed rolling-90-day value) ----
  @PctColumn({ nullable: true })
  ratingAllTime: number | null; // Bayesian-smoothed all-time average
  @PctColumn({ nullable: true })
  rating90d: number | null; // smoothed rolling 90 days (same value as `rating` once computed)
  @Column({ default: 0 })
  ratingCount90d: number;
  @PctColumn({ nullable: true })
  rating30d: number | null; // raw rolling-30-day average (used for alerts)
  @Column({ default: 0 })
  ratingCount30d: number;
  /** { distribution:{1..5}, positiveTags:[{tag,count}], negativeTags:[...], trend..., alert } */
  @Column({ type: 'jsonb', default: {} })
  ratingStats: Record<string, any>;
  @Column({ type: 'varchar', nullable: true })
  ratingAlert: string | null; // WARN | REVIEW | null

  @PctColumn({ default: 100 })
  acceptanceRate: number;

  @PctColumn({ default: 100 })
  completionRate: number;

  @PctColumn({ default: 100 })
  onTimeRate: number;

  @Column({ default: 0 })
  totalTrips: number;

  @Column({ default: 0 })
  offersReceived: number;

  @Column({ default: 0 })
  offersAccepted: number;

  // ---- rolling acceptance window (maintained by AcceptanceService; `acceptanceRate` above is the smoothed score) ----
  @Column({ default: 0 })
  offersAccepted14d: number;

  @Column({ default: 0 })
  offersDeclined14d: number;

  @Column({ default: 0 })
  offersExpired14d: number;

  @Column({ default: 0 })
  offersTotal14d: number;

  @Column({ type: 'timestamptz', nullable: true })
  acceptanceUpdatedAt: Date | null;

  @Column({ default: 0 })
  cancellations: number;

  /** Delivery-dispute strikes (never-arrived claims without valid proof, or staff-confirmed NOT_DELIVERED) in the last 30 days; recomputed from meta.deliveryDisputeLog. */
  @Column({ default: 0 })
  deliveryDisputes30d: number;

  @Column({ default: 0 })
  deliveryDisputesTotal: number;

  @MoneyColumn()
  lifetimeEarnings: number;

  /** Earnings not yet paid out. Denormalised; source of truth is the ledger. */
  @MoneyColumn()
  pendingBalance: number;

  @Column({ default: false })
  ontarioPlatformWorkerNoticeAcked: boolean;

  @Column({ type: 'jsonb', default: {} })
  meta: Record<string, any>;
}

@Entity('driver_documents')
export class DriverDocument extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  driverId: string; // DriverProfile.id

  @Column({ type: 'enum', enum: DriverDocType })
  type: DriverDocType;

  @Column()
  fileUrl: string;

  @Column({ type: 'varchar', nullable: true })
  fileName: string | null;

  @Column({ type: 'enum', enum: DocStatus, default: DocStatus.PENDING })
  status: DocStatus;

  @Column({ type: 'varchar', nullable: true })
  rejectReason: string | null;

  @Column({ type: 'date', nullable: true })
  expiresAt: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  expiryReminderSentAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  reviewedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;
}

/** Scheduled driver shift in a busy zone. */
@Entity('driver_shifts')
export class DriverShift extends BaseEntity {
  /** null = open capacity slot published by ops (status OPEN); drivers book by creating a BOOKED row. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  driverId: string | null;

  @Column({ type: 'uuid' })
  zoneId: string;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz' })
  endsAt: Date;

  @Column({ default: 'BOOKED' })
  status: 'OPEN' | 'BOOKED' | 'STARTED' | 'COMPLETED' | 'MISSED' | 'CANCELLED';

  /** Capacity slot info for shift marketplace (optional). */
  @Column({ type: 'int', nullable: true })
  slotCapacity: number | null;
}

/** Dispatch offer sent to one driver at a time. */
@Entity('driver_offers')
export class DriverOffer extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  orderId: string;

  @Index()
  @Column({ type: 'uuid' })
  driverId: string; // DriverProfile.id

  @Column({ type: 'enum', enum: OfferStatus, default: OfferStatus.PENDING })
  status: OfferStatus;

  /** 1-based offer number for the order (3 offers -> widen radius). */
  @Column({ default: 1 })
  sequence: number;

  /** radius widening round at time of offer */
  @Column({ default: 0 })
  round: number;

  @Column({ type: 'timestamptz' })
  sentAt: Date;

  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt: Date | null;

  @PctColumn({ nullable: true })
  pickupDistanceKm: number | null;

  @PctColumn({ nullable: true })
  dropoffDistanceKm: number | null;

  @MoneyColumn()
  estimatedPay: number;

  @MoneyColumn()
  boostAmount: number;

  @PctColumn({ nullable: true })
  score: number | null;

  @Column({ type: 'jsonb', nullable: true })
  scoreBreakdown: Record<string, number> | null;

  @Column({ type: 'varchar', nullable: true })
  declineReason: string | null;
}

/** Driver incentives / peak boosts / first-week boost. */
@Entity('incentives')
export class Incentive extends BaseEntity {
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ default: 'PEAK_BOOST' })
  type: 'PEAK_BOOST' | 'QUEST' | 'FIRST_WEEK' | 'WEATHER' | 'SUPPLY_ALERT';

  @Index()
  @Column({ type: 'uuid', nullable: true })
  zoneId: string | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  cityId: string | null;

  /** flat $ per trip added */
  @MoneyColumn()
  amountPerTrip: number;

  /** or % of trip pay */
  @PctColumn({ default: 0 })
  percentBoost: number;

  /** QUEST: complete N trips to earn `bonusAmount` */
  @Column({ type: 'int', nullable: true })
  questTrips: number | null;

  @MoneyColumn()
  bonusAmount: number;

  @Column({ type: 'timestamptz' })
  startsAt: Date;

  @Column({ type: 'timestamptz' })
  endsAt: Date;

  /** [0-6] days of week; empty = every day */
  @Column({ type: 'jsonb', default: [] })
  daysOfWeek: number[];

  @Column({ type: 'varchar', nullable: true })
  startTime: string | null; // HH:mm

  @Column({ type: 'varchar', nullable: true })
  endTime: string | null;

  @Column({ default: true })
  active: boolean;

  /** Per-driver incentive (e.g. FIRST_WEEK welcome boost). null = applies to everyone in scope. */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  driverId: string | null;
}

@Entity('training_modules')
export class TrainingModule extends BaseEntity {
  @Column()
  title: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ default: 0 })
  sortOrder: number;

  /** [{ question, options: string[], correctIndex }] */
  @Column({ type: 'jsonb', default: [] })
  quiz: { question: string; options: string[]; correctIndex: number }[];

  @PctColumn({ default: 80 })
  passMark: number;

  @Column({ default: true })
  active: boolean;
}

@Entity('training_attempts')
export class TrainingAttempt extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'uuid' })
  moduleId: string;

  @PctColumn()
  score: number;

  @Column({ default: false })
  passed: boolean;

  @Column({ type: 'jsonb', default: [] })
  answers: number[];
}

/** SOS / safety button. */
@Entity('sos_alerts')
export class SosAlert extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  @GeoColumn()
  lat: number | null;

  @GeoColumn()
  lng: number | null;

  @Column({ type: 'text', nullable: true })
  message: string | null;

  @Column({ default: 'OPEN' })
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';

  @Column({ type: 'uuid', nullable: true })
  handledById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  handledAt: Date | null;
}

/** GPS trail (kept for dispute evidence). Written every 4-5 s while on a trip (sampled). */
@Entity('driver_location_logs')
@Index(['orderId', 'createdAt'])
export class DriverLocationLog extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'uuid', nullable: true })
  orderId: string | null;

  @Column({ type: 'double precision' })
  lat: number;

  @Column({ type: 'double precision' })
  lng: number;

  @Column({ type: 'double precision', nullable: true })
  speed: number | null;
}
