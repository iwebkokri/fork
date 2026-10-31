import { Column, Entity, Index, JoinColumn, ManyToOne, Relation } from 'typeorm';
import { BaseEntity, GeoColumn, MoneyColumn, PctColumn } from '../../common/base.entity';

/** A city the platform operates in. Holds per-city pricing defaults (PDF 8.1 "set per city"). */
@Entity('cities')
export class City extends BaseEntity {
  @Column()
  name: string;

  @Column({ default: 'ON' })
  province: string;

  @Column({ default: 'Canada' })
  country: string;

  @Column({ default: 'America/Toronto' })
  timezone: string;

  @Column({ default: 'CAD' })
  currency: string;

  @Column({ default: true })
  active: boolean;

  @GeoColumn()
  centerLat: number;

  @GeoColumn()
  centerLng: number;

  // ---- customer fees ----
  @MoneyColumn({ default: 1.99 })
  baseDeliveryFee: number;

  @MoneyColumn({ default: 0.5 })
  perKmFee: number;

  @PctColumn({ default: 10 })
  serviceFeePct: number;

  @MoneyColumn({ default: 5 })
  serviceFeeCap: number;

  @MoneyColumn({ default: 15 })
  smallOrderThreshold: number;

  @MoneyColumn({ default: 2 })
  smallOrderFee: number;

  /** Extra multiplier applied to delivery fee while busy mode is on (e.g. 1.25). */
  @PctColumn({ default: 1 })
  busyMultiplier: number;

  // ---- driver pay ----
  @MoneyColumn({ default: 3 })
  driverBaseFare: number;

  @MoneyColumn({ default: 0.6 })
  driverPerKm: number;

  /** Per-minute waiting pay after `driverFreeWaitMin`. */
  @MoneyColumn({ default: 0.25 })
  driverPerWaitMin: number;

  @Column({ default: 5 })
  driverFreeWaitMin: number;

  @MoneyColumn({ default: 4.5 })
  driverMinPerTrip: number;

  // ---- dispatch ----
  @Column({ default: 30 })
  offerTimeoutSec: number;

  @Column({ default: 3 })
  offersBeforeWiden: number;

  @Column({ default: 2 })
  maxRadiusWidenings: number;

  @Column({ default: 2 })
  radiusWidenStepKm: number;

  @MoneyColumn({ default: 2 })
  widenBoostAmount: number;

  @Column({ default: 2 })
  batchMaxOrders: number;

  @PctColumn({ default: 1.5 })
  batchMaxDropDistanceKm: number;

  @Column({ default: 10 })
  batchMaxExtraMinutes: number;

  // ---- order timers (minutes unless noted) ----
  @Column({ default: 180 })
  autoRejectSeconds: number;

  @Column({ default: 10 })
  pickupOverdueMin: number;

  @Column({ default: 10 })
  lateOnTheWayGraceMin: number;

  @Column({ default: 30 })
  veryLateMin: number;

  @MoneyColumn({ default: 250 })
  payoutReleaseThreshold: number;
}

/** Delivery zone (geofence polygon). Zone values override city defaults when not null. */
@Entity('zones')
export class Zone extends BaseEntity {
  @Index()
  @Column({ type: 'uuid' })
  cityId: string;

  @ManyToOne(() => City, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cityId' })
  city: Relation<City>;

  @Column()
  name: string;

  @Column({ default: true })
  active: boolean;

  /** Polygon as array of [lat, lng] pairs (closed implicitly). */
  @Column({ type: 'jsonb', default: [] })
  polygon: [number, number][];

  @GeoColumn()
  centerLat: number;

  @GeoColumn()
  centerLng: number;

  @PctColumn({ nullable: true })
  deliveryRadiusKm: number | null;

  @PctColumn({ nullable: true })
  maxDeliveryRadiusKm: number | null;

  @MoneyColumn({ nullable: true })
  baseFee: number | null;

  @MoneyColumn({ nullable: true })
  perKmFee: number | null;

  @MoneyColumn({ nullable: true })
  minimumOrder: number | null;

  /** { mon: {open:'10:00', close:'23:00', closed:false}, tue: ... } */
  @Column({ type: 'jsonb', default: {} })
  serviceHours: Record<string, { open: string; close: string; closed?: boolean }>;

  /** Busy mode: multiplies delivery fee and optionally shrinks radius. */
  @Column({ default: false })
  busyMode: boolean;

  /** Open for drivers to join: shown (highlighted) on the driver app's zone map, where a driver can add it to their profile (up to driver.maxZones, default 4). */
  @Column({ default: false })
  driversOpen: boolean;

  @PctColumn({ default: 1 })
  busyMultiplier: number;

  @PctColumn({ nullable: true })
  busyRadiusKm: number | null;

  /** Drivers needed per hour (supply forecast helper). */
  @Column({ default: 0 })
  targetDrivers: number;
}

@Entity('tax_classes')
export class TaxClass extends BaseEntity {
  @Index({ unique: true })
  @Column()
  code: string; // e.g. HST_ON, ZERO_RATED, PST_EXEMPT

  @Column()
  name: string;

  /** Total tax rate in percent (Ontario HST = 13). */
  @PctColumn({ default: 13 })
  ratePct: number;

  @Column({ default: true })
  active: boolean;

  @Column({ default: false })
  isDefault: boolean;
}

@Entity('commission_tiers')
export class CommissionTier extends BaseEntity {
  @Index({ unique: true })
  @Column()
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @PctColumn({ default: 20 })
  deliveryPct: number;

  @PctColumn({ default: 8 })
  pickupPct: number;

  @PctColumn({ default: 12 })
  ownDriverPct: number;

  @Column({ default: true })
  active: boolean;

  @Column({ default: false })
  isDefault: boolean;
  /** Store types that use this tier when the location has no tier of its own (groceries run on thinner margins than restaurants). Empty = none. */
  @Column({ type: 'jsonb', default: [] })
  defaultForStoreTypes: string[];
}
