import { Repository } from 'typeorm';
import { DriverProfile } from '../database/entities';

/** What is kept on `driver_profiles.meta.waitlist` for a courier who signed up from a full zone. */
export interface WaitlistMeta {
  zoneId: string;
  joinedAt: string;
  /** set when the courier has been invited to upload their documents (they no longer wait, and now hold a place) */
  invitedAt?: string | null;
}

/** On the waiting list and not invited yet: cannot upload documents, be approved or go online. */
export const isWaitlisted = (meta?: Record<string, any> | null): boolean => !!meta?.waitlist && !meta.waitlist.invitedAt;

const TURNED_AWAY = ['REJECTED', 'DEACTIVATED'];

/**
 * Does this driver take up one of the zone's places? Yes when the zone is theirs (or the one they signed up from), unless they were turned
 * away or are still waiting. (`countZoneDrivers` is the same rule as SQL.)
 */
export function holdsPlace(p: { status: string; zoneIds?: string[] | null; meta?: Record<string, any> | null }, zoneId: string): boolean {
  if (TURNED_AWAY.includes(p.status) || isWaitlisted(p.meta)) return false;
  return !!p.zoneIds?.includes(zoneId) || p.meta?.registrationZoneId === zoneId;
}

/** Drivers holding a place in the zone (same rule as holdsPlace, as a database count). */
export function countZoneDrivers(repo: Repository<DriverProfile>, zoneId: string): Promise<number> {
  return repo
    .createQueryBuilder('p')
    .where(`("p"."zoneIds" @> :zj::jsonb OR "p"."meta"->>'registrationZoneId' = :z)`, { zj: JSON.stringify([zoneId]), z: zoneId })
    .andWhere(`"p"."status" NOT IN ('REJECTED', 'DEACTIVATED')`)
    .andWhere(`NOT ("p"."meta"->'waitlist' IS NOT NULL AND "p"."meta"->'waitlist'->>'invitedAt' IS NULL)`)
    .getCount();
}

/** Couriers waiting for the zone, longest-waiting first. */
export async function listWaitlisted(repo: Repository<DriverProfile>, zoneId: string): Promise<DriverProfile[]> {
  const rows = await repo
    .createQueryBuilder('p')
    .where(`"p"."meta"->'waitlist'->>'zoneId' = :z`, { z: zoneId })
    .andWhere(`"p"."meta"->'waitlist'->>'invitedAt' IS NULL`)
    .getMany();
  return rows.sort((a, b) => String(a.meta.waitlist.joinedAt).localeCompare(String(b.meta.waitlist.joinedAt)));
}

export function countWaitlisted(repo: Repository<DriverProfile>, zoneId: string): Promise<number> {
  return repo
    .createQueryBuilder('p')
    .where(`"p"."meta"->'waitlist'->>'zoneId' = :z`, { z: zoneId })
    .andWhere(`"p"."meta"->'waitlist'->>'invitedAt' IS NULL`)
    .getCount();
}

/** Zones that have couriers waiting (for the periodic sweep). */
export async function zonesWithWaitlist(repo: Repository<DriverProfile>): Promise<string[]> {
  const rows: { z: string }[] = await repo
    .createQueryBuilder('p')
    .select(`DISTINCT "p"."meta"->'waitlist'->>'zoneId'`, 'z')
    .where(`"p"."meta"->'waitlist' IS NOT NULL`)
    .andWhere(`"p"."meta"->'waitlist'->>'invitedAt' IS NULL`)
    .getRawMany();
  return rows.map((r) => r.z).filter(Boolean);
}
