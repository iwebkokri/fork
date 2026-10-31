import { BadRequestException, ForbiddenException } from '@nestjs/common';

export const DEFAULT_MAX_ZONES = 4;

export interface ZoneFacts {
  id: string;
  name: string;
  cityId: string;
  active: boolean;
  /** open for drivers to join (set by staff on the zone) */
  driversOpen: boolean;
}

/**
 * What a driver may do with their zones. Returns the new list of zone ids or throws a message the app can show as it is.
 *
 *  - a zone can only be ADDED while it is active and open for drivers, and only in the driver's own city;
 *  - zones the driver already has can always be kept (even if staff closed signing up since) or removed;
 *  - at most `max` zones in total (default 4);
 *  - a zone cannot be removed while the driver is online in it.
 */
export function checkZoneSelection(o: {
  current: string[];
  requested: string[];
  zones: ZoneFacts[];
  driverCityId: string | null;
  max: number;
  /** the zone the driver is online in right now, if online */
  onlineZoneId?: string | null;
}): string[] {
  const ids = [...new Set(o.requested)];
  const byId = new Map(o.zones.map((z) => [z.id, z]));
  if (ids.some((id) => !byId.has(id))) throw new BadRequestException('One or more zones do not exist');
  if (ids.length > o.max) throw new BadRequestException(`You can have up to ${o.max} zones. Remove one to add another.`);
  for (const id of ids) {
    if (o.current.includes(id)) continue;
    const z = byId.get(id)!;
    if (!z.active || !z.driversOpen) throw new ForbiddenException(`${z.name} is not open for new drivers right now.`);
    if (o.driverCityId && z.cityId !== o.driverCityId) throw new ForbiddenException(`${z.name} is in another city.`);
  }
  if (o.onlineZoneId && o.current.includes(o.onlineZoneId) && !ids.includes(o.onlineZoneId)) {
    throw new BadRequestException(`You are online in ${byId.get(o.onlineZoneId)?.name ?? 'this zone'}. Go offline before removing it.`);
  }
  return ids;
}

/**
 * The zone to switch on for a driver when their account is approved: the one they signed up from, if it is still active and still in their city.
 * `null` means there is nothing to apply (no zone recorded, or it no longer qualifies) and the driver picks zones themselves.
 */
export function registrationZoneFor(
  profile: { cityId: string | null; meta?: Record<string, any> | null },
  zone: { id: string; cityId: string; active: boolean } | null | undefined,
): string | null {
  const wanted = profile.meta?.registrationZoneId;
  if (!wanted || !zone || zone.id !== wanted || !zone.active) return null;
  if (profile.cityId && zone.cityId !== profile.cityId) return null;
  return zone.id;
}
