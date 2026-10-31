import { VerificationAudience, VerificationMethod } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { BackgroundCheckResult } from '../drivers/adapters/certn.adapter';
import { VerificationChoice, VerificationPolicy, VerificationSummary } from './verification-policy';

/** One line of the checklist a subject has to satisfy before it can be verified (shown on the Verification card). */
export interface Gate {
  key: string;
  label: string;
  done: boolean;
  detail?: string;
}

/** What a new sign-up is told right after registering (returned by /auth/driver/register and /auth/restaurant/apply). */
export interface RegistrationResult {
  /** how the account was admitted: INSTANT, MANUAL or AUTOMATIC */
  mode: VerificationMethod;
  /** the lifecycle status after the policy was applied (ACTIVE / LIVE when instant, otherwise the application status) */
  accountStatus: string;
  verification: VerificationSummary;
  /** the courier's zone is full: they are on its waiting list and nothing else happens until they are invited */
  waitlisted?: boolean;
}

export interface ForceOptions {
  method: VerificationChoice;
  dueAt: Date;
  actor: AuthUser;
  reason?: string;
  /** start the Certn check right away (the first few of a big batch); the rest is started by the sweeper */
  startCheckNow: boolean;
  /** take the account off the road right away when the deadline has already passed (small batches); otherwise the sweeper does it */
  blockNow: boolean;
}

export type ForceOutcome = 'BLOCKED' | 'DEFERRED' | 'GRACE' | 'VERIFIED' | 'SKIPPED' | 'FAILED';

export interface ForceItemResult {
  id: string;
  name: string;
  outcome: ForceOutcome;
  note?: string;
}

export interface StatusCounts {
  UNVERIFIED: number;
  PENDING: number;
  NEEDS_REVIEW: number;
  VERIFIED: number;
  REJECTED: number;
  total: number;
  /** accounts that are working right now (driver ACTIVE / business with a live restaurant) without being verified */
  operatingUnverified: number;
  /** accounts waiting for a verification deadline */
  withDeadline: number;
}

export interface SubjectsQueryInput {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * What the Verification service needs from each audience. Drivers and businesses differ in what "active" means and in where the
 * state lives (DriverProfile vs Merchant + its restaurants), so each has its own handler behind this one shape.
 */
export interface AudienceHandler {
  readonly audience: VerificationAudience;
  onRegistered(id: string, policy: VerificationPolicy): Promise<RegistrationResult>;
  /** the Certn result for this audience's subject with that reference, or null when the reference is not theirs */
  applyResult(r: BackgroundCheckResult): Promise<boolean | null>;
  details(id: string, policy: VerificationPolicy): Promise<any>;
  startCheck(id: string, actor: AuthUser): Promise<any>;
  verify(id: string, actor: AuthUser, dto: { note?: string; override?: boolean }, policy: VerificationPolicy): Promise<any>;
  reject(id: string, actor: AuthUser, reason: string): Promise<any>;
  /** ids of the subjects that are UNVERIFIED (optionally limited to `ids`) plus the ones that were asked for but cannot be forced */
  forceTargets(ids?: string[]): Promise<{ targets: string[]; skipped: ForceItemResult[] }>;
  force(id: string, opts: ForceOptions): Promise<ForceItemResult>;
  /** sweeper steps; each returns how many subjects it handled */
  enforceDue(): Promise<number>;
  retryChecks(limit: number): Promise<number>;
  remind(): Promise<number>;
  counts(): Promise<StatusCounts>;
  list(q: SubjectsQueryInput): Promise<{ data: any[]; meta: { page: number; limit: number; total: number; totalPages: number } }>;
}
