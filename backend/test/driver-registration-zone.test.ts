/**
 * Unit tests for "a courier who signs up from a local zone gets that zone switched on when their account is approved"
 * (no server, no database):
 *
 *   cd backend && npx ts-node --transpile-only test/driver-registration-zone.test.ts
 *
 * Covers the rule (the zone must still be active and in the courier's city), approval and activation through DriverCoreService.changeStatus
 * with fake repositories, zones that were already chosen are never replaced, and nothing happens for old sign-ups with no zone recorded.
 * Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import 'reflect-metadata';
import { DriverStatus } from '../src/common/enums';
import { DriverCoreService } from '../src/drivers/driver-core.service';
import { registrationZoneFor } from '../src/drivers/zone-rules';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};

const CITY = 'city-1';
const Z = { id: 'zone-1', cityId: CITY, active: true };

// ---- the rule
check('the zone the courier signed up from is used', registrationZoneFor({ cityId: CITY, meta: { registrationZoneId: 'zone-1' } }, Z) === 'zone-1');
check('no zone recorded -> nothing to apply', registrationZoneFor({ cityId: CITY, meta: {} }, Z) === null && registrationZoneFor({ cityId: CITY, meta: null }, Z) === null);
check('a zone that was deactivated since is not applied', registrationZoneFor({ cityId: CITY, meta: { registrationZoneId: 'zone-1' } }, { ...Z, active: false }) === null);
check('a zone that moved to another city is not applied', registrationZoneFor({ cityId: CITY, meta: { registrationZoneId: 'zone-1' } }, { ...Z, cityId: 'other' }) === null);
check('a zone that no longer exists is not applied', registrationZoneFor({ cityId: CITY, meta: { registrationZoneId: 'zone-1' } }, null) === null);
check('a different zone than the one recorded is not applied', registrationZoneFor({ cityId: CITY, meta: { registrationZoneId: 'zone-9' } }, Z) === null);

// ---- through changeStatus, as staff approval / activation / verification do it
const make = (profile: any, zone: any = Z) => {
  const events: any[] = [];
  const svc: any = Object.create(DriverCoreService.prototype);
  svc.profiles = { save: async (p: any) => p };
  svc.zoneRepo = { findOne: async () => zone };
  svc.events = { emit: (_n: string, e: any) => events.push(e) };
  svc.rt = { emitToDriver: () => {}, emitToOps: () => {}, server: undefined };
  const p = { id: 'd1', cityId: CITY, status: DriverStatus.APPLIED, zoneIds: [], isOnline: false, meta: { registrationZoneId: 'zone-1' }, ...profile };
  return { svc, p, events };
};
const actor = { type: 'STAFF' } as any;

(async () => {
  {
    const { svc, p } = make({});
    await svc.changeStatus(p, DriverStatus.APPROVED, actor, null, { approvedAt: new Date() });
    check('approval switches on the zone the courier signed up from', p.zoneIds.join() === 'zone-1' && p.status === DriverStatus.APPROVED, JSON.stringify(p.zoneIds));
  }
  {
    const { svc, p } = make({ status: DriverStatus.APPROVED });
    await svc.changeStatus(p, DriverStatus.ACTIVE, actor, null, {});
    check('activation also does it if the courier still has no zone', p.zoneIds.join() === 'zone-1');
  }
  {
    const { svc, p } = make({ zoneIds: ['zone-7', 'zone-8'] });
    await svc.changeStatus(p, DriverStatus.APPROVED, actor, null, {});
    check('zones already chosen by staff are never replaced', p.zoneIds.join() === 'zone-7,zone-8');
  }
  {
    const { svc, p } = make({}, { ...Z, active: false });
    await svc.changeStatus(p, DriverStatus.APPROVED, actor, null, {});
    check('a zone that is no longer active is left alone: the courier picks one on the map', p.zoneIds.length === 0);
  }
  {
    const { svc, p } = make({ meta: {} });
    await svc.changeStatus(p, DriverStatus.APPROVED, actor, null, {});
    check('an old sign-up with no zone recorded behaves as before', p.zoneIds.length === 0);
  }
  {
    const { svc, p } = make({});
    await svc.changeStatus(p, DriverStatus.SUSPENDED, actor, 'x', {});
    check('only approval / activation switch a zone on (not suspension)', p.zoneIds.length === 0);
  }
  {
    const { svc, p } = make({});
    await svc.changeStatus(p, DriverStatus.REJECTED, actor, 'x', {});
    check('a rejected application gets no zone', p.zoneIds.length === 0);
  }
  {
    const { svc, p } = make({});
    await svc.changeStatus(p, DriverStatus.APPROVED, actor, null, { zoneIds: ['zone-5'] });
    check('zones passed in by the caller win over the signup zone', p.zoneIds.join() === 'zone-5');
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})();
