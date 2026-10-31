/**
 * Unit tests for a driver choosing their own delivery zones (no server, no database):
 *
 *   cd backend && npx ts-node --transpile-only test/driver-zones.test.ts
 *
 * Staff open zones for drivers; a driver adds them from the map, up to 4. Covers the rules (open zones only, own city only, the cap of 4,
 * keeping a zone staff has closed since, no removing the zone you are online in) and the join / leave calls with fake repositories.
 * Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import 'reflect-metadata';
import { DriverStatus } from '../src/common/enums';
import { DriverAppService } from '../src/drivers/driver-app.service';
import { checkZoneSelection, ZoneFacts } from '../src/drivers/zone-rules';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};
const rejects = async (fn: () => unknown) => {
  try {
    await fn();
    return null;
  } catch (e: any) {
    return String(e?.message ?? e);
  }
};

const CITY = 'city-1';
const zone = (id: string, over: Partial<ZoneFacts> = {}): ZoneFacts => ({ id, name: `Zone ${id}`, cityId: CITY, active: true, driversOpen: true, ...over });
const ZONES = ['a', 'b', 'c', 'd', 'e'].map((id) => zone(id));

(async () => {
  // ---- the rules
  const base = { current: [] as string[], zones: ZONES, driverCityId: CITY, max: 4 };
  check('a driver can add an open zone', checkZoneSelection({ ...base, requested: ['a'] }).join() === 'a');
  check('up to four zones are fine', checkZoneSelection({ ...base, requested: ['a', 'b', 'c', 'd'] }).length === 4);
  check('a fifth zone is refused with a clear message', /up to 4 zones/i.test((await rejects(() => checkZoneSelection({ ...base, requested: ['a', 'b', 'c', 'd', 'e'] }))) ?? ''));
  check('duplicates in the request count once', checkZoneSelection({ ...base, requested: ['a', 'a', 'b'] }).length === 2);
  check('a zone that is not open for drivers cannot be added', /not open/i.test((await rejects(() => checkZoneSelection({ ...base, zones: [zone('a', { driversOpen: false })], requested: ['a'] }))) ?? ''));
  check('an inactive zone cannot be added', /not open/i.test((await rejects(() => checkZoneSelection({ ...base, zones: [zone('a', { active: false })], requested: ['a'] }))) ?? ''));
  check('a zone in another city cannot be added', /another city/i.test((await rejects(() => checkZoneSelection({ ...base, zones: [zone('a', { cityId: 'other' })], requested: ['a'] }))) ?? ''));
  check('a driver without a city on file can still join an open zone', checkZoneSelection({ ...base, driverCityId: null, zones: [zone('a', { cityId: 'other' })], requested: ['a'] }).join() === 'a');
  check('an unknown zone id is refused', /do not exist/i.test((await rejects(() => checkZoneSelection({ ...base, requested: ['zzz'] }))) ?? ''));
  check('a zone staff has closed since is kept, not dropped', checkZoneSelection({ ...base, current: ['a'], zones: [zone('a', { driversOpen: false })], requested: ['a'] }).join() === 'a');
  check('a zone staff closed can still be removed', checkZoneSelection({ ...base, current: ['a'], zones: [zone('a', { driversOpen: false })], requested: [] }).length === 0);
  check('at the cap, swapping one for another is fine', checkZoneSelection({ ...base, current: ['a', 'b', 'c', 'd'], requested: ['a', 'b', 'c', 'e'] }).join() === 'a,b,c,e');
  check('the zone you are online in cannot be removed', /online in Zone a/i.test((await rejects(() => checkZoneSelection({ ...base, current: ['a', 'b'], requested: ['b'], onlineZoneId: 'a' }))) ?? ''));
  check('another zone can be removed while online', checkZoneSelection({ ...base, current: ['a', 'b'], requested: ['a'], onlineZoneId: 'a' }).join() === 'a');
  check('a custom cap is honoured (max 2)', /up to 2 zones/i.test((await rejects(() => checkZoneSelection({ ...base, max: 2, requested: ['a', 'b', 'c'] }))) ?? ''));

  // ---- the join / leave calls, with fake repositories
  const make = (init: { zoneIds: string[]; status?: DriverStatus; isOnline?: boolean; activeZoneId?: string | null }, opts: { settings?: Record<string, any>; zones?: ZoneFacts[] } = {}) => {
    const profile: any = { id: 'd1', cityId: CITY, status: init.status ?? DriverStatus.ACTIVE, zoneIds: [...init.zoneIds], isOnline: !!init.isOnline, activeZoneId: init.activeZoneId ?? null };
    const rows = opts.zones ?? ZONES;
    const svc: any = Object.create(DriverAppService.prototype);
    svc.core = {
      getProfile: async () => profile,
      profiles: { save: async (p: any) => p },
      settings: { get: <T>(k: string, d?: T) => (opts.settings && k in opts.settings ? opts.settings[k] : d) as T },
    };
    svc.zones = { find: async ({ where }: any) => { const ids: string[] = where.id._value ?? where.id.value ?? []; return rows.filter((z) => ids.includes(z.id)); } };
    return { svc, profile };
  };

  {
    const { svc, profile } = make({ zoneIds: [] });
    const r = await svc.joinZone('d1', 'a');
    check('joining a zone saves it on the driver profile', profile.zoneIds.join() === 'a' && r.count === 1 && r.max === 4, JSON.stringify(r));
    await svc.joinZone('d1', 'b'); await svc.joinZone('d1', 'c'); await svc.joinZone('d1', 'd');
    check('four zones joined', profile.zoneIds.length === 4);
    check('the fifth join is refused and the profile is unchanged', /up to 4/i.test((await rejects(() => svc.joinZone('d1', 'e'))) ?? '') && profile.zoneIds.length === 4);
    await svc.leaveZone('d1', 'a');
    check('leaving a zone frees a place', profile.zoneIds.join() === 'b,c,d');
    await svc.joinZone('d1', 'e');
    check('and another zone can be added after that', profile.zoneIds.join() === 'b,c,d,e');
    await svc.joinZone('d1', 'e');
    check('joining a zone you already have changes nothing', profile.zoneIds.length === 4);
  }
  {
    const { svc } = make({ zoneIds: [], status: DriverStatus.APPLIED });
    check('a driver who is not approved yet cannot choose zones', /approved/i.test((await rejects(() => svc.joinZone('d1', 'a'))) ?? ''));
  }
  {
    const { svc, profile } = make({ zoneIds: ['a', 'b'], isOnline: true, activeZoneId: 'a' });
    check('leaving the zone you are online in is refused', /Go offline/i.test((await rejects(() => svc.leaveZone('d1', 'a'))) ?? '') && profile.zoneIds.length === 2);
    await svc.leaveZone('d1', 'b');
    check('leaving another zone while online works', profile.zoneIds.join() === 'a');
  }
  {
    const { svc, profile } = make({ zoneIds: ['a'], activeZoneId: 'a', isOnline: false });
    await svc.leaveZone('d1', 'a');
    check('leaving the last active zone while offline clears the active zone', profile.zoneIds.length === 0 && profile.activeZoneId === null);
  }
  {
    const { svc } = make({ zoneIds: [] }, { settings: { 'driver.maxZones': 2 } });
    await svc.joinZone('d1', 'a'); await svc.joinZone('d1', 'b');
    check('the cap follows the driver.maxZones setting', /up to 2/i.test((await rejects(() => svc.joinZone('d1', 'c'))) ?? ''));
  }
  {
    const { svc } = make({ zoneIds: [] }, { zones: [zone('a', { driversOpen: false })] });
    check('a closed zone cannot be joined through the single-zone call either', /not open/i.test((await rejects(() => svc.joinZone('d1', 'a'))) ?? ''));
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})();
