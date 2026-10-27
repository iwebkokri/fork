import { VehicleType } from '../common/enums';

export type DispatchState =
  | 'WAITING' // delayed start: waiting until the driver should be sent to arrive when food is ready
  | 'ACTIVE' // offer loop running
  | 'ESCALATED' // radius widened max times, flagged on the dispatcher's map (slow retry continues)
  | 'ASSIGNED'
  | 'MANUAL' // auto-assign disabled by setting
  | 'MANUAL_HOLD' // dispatcher is handling the order, engine must not react
  | 'STOPPED'; // cancelled / order ended / converted

/** Persisted at orders.meta.dispatch so the loop survives restarts. */
export interface DispatchMeta {
  state: DispatchState;
  cycle: number;
  /** total offers ever sent for the order (DriverOffer.sequence) */
  sequence: number;
  /** offers / empty attempts since the last widening */
  offersInRound: number;
  /** radius widening round */
  widenings: number;
  radiusKm: number;
  /** total boost currently added to driver pay (widen boosts + manual boosts) */
  boost: number;
  manualBoost: number;
  declinedIds: string[];
  offeredIds: string[];
  startAt: string | null;
  startedAt?: string | null;
  nextAttemptAt: string | null;
  emptyAttempts: number;
  pendingOfferId?: string | null;
  assignedDriverId?: string | null;
  escalatedAt?: string | null;
  lastEvent?: string;
  updatedAt?: string;
}

export interface RankedCandidate {
  driverId: string;
  userId: string;
  name: string;
  phone: string | null;
  vehicleType: VehicleType;
  lat: number;
  lng: number;
  /** extra pay for a driver who is far from the restaurant (dispatch.extraPerKm per km beyond dispatch.extraFreeKm); included in estimatedPay */
  distanceExtra: number;
  /** road distance driver -> restaurant (km) */
  distanceKm: number;
  etaMin: number;
  dropKm: number;
  estimatedPay: number;
  score: number;
  breakdown: Record<string, number>;
  factors: Record<string, number>;
  eligible: boolean;
  reasons: string[];
  activeOrders: number;
  onTrip: boolean;
  lastOfferAt: Date | null;
  lastLocationAt: Date | null;
}

export interface OrderFlagConfig {
  autoRejectSec: number;
  pickupOverdueMin: number;
  lateGraceMin: number;
  veryLateMin: number;
}
