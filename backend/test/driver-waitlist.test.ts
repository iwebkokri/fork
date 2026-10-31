/**
 * Unit tests for zone driver limits and the waiting list (no server, no database):
 *
 *   cd backend && npx ts-node --transpile-only test/driver-waitlist.test.ts
 *
 * A zone takes a limited number of drivers. A courier who signs up from a full zone waits: no documents, no approval, no going online. When places
 * open (staff raise the limit) the longest-waiting couriers are invited, one per free place, and then go through verification like a new sign-up.
 * Database counts are stubbed; the decisions are the real code. Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import 'reflect-metadata';
import { Events } from '../src/common/contracts';
import { DriverStatus } from '../src/common/enums';
import { DriverCoreService } from '../src/drivers/driver-core.service';
import { holdsPlace, isWaitlisted } from '../src/drivers/zone-capacity';
import { checkZoneSelection } from '../src/drivers/zone-rules';

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

// ---- who holds a place
const P = (over: any = {}) => ({ status: 'APPLIED', zoneIds: [] as string[], meta: {} as any, ...over });
check('a driver who has the zone holds a place', holdsPlace(P({ status: 'ACTIVE', zoneIds: ['z1'] }), 'z1'));
check('a driver who signed up from the zone holds a place (documents may still be pending)', holdsPlace(P({ meta: { registrationZoneId: 'z1' } }), 'z1'));
check('a driver of another zone does not', !holdsPlace(P({ status: 'ACTIVE', zoneIds: ['z2'] }), 'z1'));
check('a rejected or deactivated driver frees the place', !holdsPlace(P({ status: 'REJECTED', zoneIds: ['z1'] }), 'z1') && !holdsPlace(P({ status: 'DEACTIVATED', zoneIds: ['z1'] }), 'z1'));
check('a courier still waiting does not hold a place', !holdsPlace(P({ meta: { registrationZoneId: 'z1', waitlist: { zoneId: 'z1', joinedAt: 'x', invitedAt: null } } }), 'z1'));
check('an invited courier does', holdsPlace(P({ meta: { registrationZoneId: 'z1', waitlist: { zoneId: 'z1', joinedAt: 'x', invitedAt: 'y' } } }), 'z1'));
check('isWaitlisted: waiting yes, invited no, never no', isWaitlisted({ waitlist: { invitedAt: null } }) && !isWaitlisted({ waitlist: { invitedAt: 'x' } }) && !isWaitlisted({}) && !isWaitlisted(null));

// ---- the service, with the two database counts stubbed
function make(opts: { capacity: number | null; occupied: number; waiting?: any[]; zone?: boolean }) {
  const sent: any[] = [];
  const emitted: any[] = [];
  const saved: any[] = [];
  const svc: any = Object.create(DriverCoreService.prototype);
  const zone = opts.zone === false ? null : { id: 'z1', name: 'Downtown', driverCapacity: opts.capacity };
  svc.zoneRepo = { findOne: async () => zone };
  svc.zoneOccupancy = async () => opts.occupied;
  svc.waitlistedFor = async () => opts.waiting ?? [];
  svc.profiles = { save: async (p: any) => (saved.push(JSON.parse(JSON.stringify(p.meta))), p) };
  svc.notifyDriver = async (_p: any, event: string, _v: any, _d: any, lit: any) => void sent.push({ event, title: lit?.title });
  svc.rt = { emitToDriver: (_id: string, name: string) => emitted.push(name), emitToOps: () => {} };
  svc.events = { emitAsync: async (name: string, e: any) => (emitted.push(`${name}:${e.id}`), []), emit: () => {} };
  svc.settings = { get: <T>(_k: string, d?: T) => d as T };
  return { svc, sent, emitted, saved };
}
const driver = (over: any = {}) => ({ id: 'd1', userId: 'u1', status: DriverStatus.APPLIED, zoneIds: [], isOnline: false, meta: { registrationZoneId: 'z1' }, ...over });

(async () => {
  // limit 2: the new courier counts themselves among the 3 holding places, so there are 2 others: full
  {
    const { svc, sent } = make({ capacity: 2, occupied: 3 });
    const p: any = driver();
    const waits = await svc.waitlistIfFull(p);
    check('a courier who signs up from a full zone goes on the waiting list', waits === true && isWaitlisted(p.meta) && p.meta.waitlist.zoneId === 'z1');
    check('they are told, with the zone name', sent.length === 1 && /waiting list for Downtown/.test(sent[0].title), JSON.stringify(sent));
    check('calling it again changes nothing (idempotent) and does not message twice', (await svc.waitlistIfFull(p)) === true && sent.length === 1);
  }
  {
    const { svc } = make({ capacity: 3, occupied: 3 });
    const p: any = driver();
    check('one place left (limit 3, two others): the courier is NOT put on the list', (await svc.waitlistIfFull(p)) === false && !p.meta.waitlist);
  }
  {
    const { svc } = make({ capacity: null, occupied: 9999 });
    check('no limit on the zone: nobody waits', (await svc.waitlistIfFull(driver())) === false);
  }
  {
    const { svc } = make({ capacity: 1, occupied: 5 });
    check('a sign-up with no zone recorded never waits', (await svc.waitlistIfFull(driver({ meta: {} }))) === false);
  }
  {
    const { svc } = make({ capacity: 1, occupied: 5 });
    const p: any = driver({ meta: { registrationZoneId: 'z1', waitlist: { zoneId: 'z1', joinedAt: 'x', invitedAt: 'y' } } });
    check('an invited courier is not put back on the list', (await svc.waitlistIfFull(p)) === false);
  }

  // ---- inviting
  const waiter = (id: string, at: string) => driver({ id, userId: `u-${id}`, meta: { registrationZoneId: 'z1', waitlist: { zoneId: 'z1', joinedAt: at, invitedAt: null } } });
  {
    const waiting = [waiter('a', '2026-01-01T10:00:00Z'), waiter('b', '2026-01-01T11:00:00Z'), waiter('c', '2026-01-01T12:00:00Z'), waiter('d', '2026-01-01T13:00:00Z')];
    const { svc, sent, emitted } = make({ capacity: 5, occupied: 3, waiting });
    const n = await svc.inviteFromWaitlist('z1');
    check('two free places -> the two longest-waiting couriers are invited', n === 2 && !isWaitlisted(waiting[0].meta) && !isWaitlisted(waiting[1].meta) && isWaitlisted(waiting[2].meta) && isWaitlisted(waiting[3].meta));
    check('each invited courier is told to upload their documents', sent.filter((s) => s.event === 'driver.waitlist_invite').length === 2 && /A place opened in Downtown/.test(sent[0].title), JSON.stringify(sent));
    check('and the verification policy is started for each, like a new sign-up', emitted.includes(`${Events.VERIFICATION_SUBJECT_REGISTERED}:a`) && emitted.includes(`${Events.VERIFICATION_SUBJECT_REGISTERED}:b`) && !emitted.includes(`${Events.VERIFICATION_SUBJECT_REGISTERED}:c`));
    check('the app is told live', emitted.filter((e) => e === 'driver.waitlist_invited').length === 2);
  }
  {
    const waiting = [waiter('a', '1'), waiter('b', '2')];
    const { svc } = make({ capacity: 3, occupied: 3, waiting });
    check('no free place -> nobody is invited', (await svc.inviteFromWaitlist('z1')) === 0 && isWaitlisted(waiting[0].meta));
  }
  {
    const waiting = [waiter('a', '1'), waiter('b', '2'), waiter('c', '3')];
    const { svc } = make({ capacity: null, occupied: 99, waiting });
    check('the limit removed -> everyone waiting is invited', (await svc.inviteFromWaitlist('z1')) === 3);
  }
  {
    const { svc } = make({ capacity: 10, occupied: 0, waiting: [] });
    check('nobody waiting -> nothing to do', (await svc.inviteFromWaitlist('z1')) === 0);
    const gone = make({ capacity: 10, occupied: 0, waiting: [waiter('a', '1')], zone: false });
    check('a zone that no longer exists -> nothing to do', (await gone.svc.inviteFromWaitlist('z1')) === 0);
  }
  {
    const waiting = [waiter('a', '1')];
    const { svc } = make({ capacity: 2, occupied: 1, waiting });
    await svc.inviteFromWaitlist('z1');
    check('after an invite the place is theirs: they no longer wait and hold a place', !isWaitlisted(waiting[0].meta) && holdsPlace(waiting[0], 'z1') && waiting[0].meta.waitlist.invitedAt);
  }

  // ---- what a waiting courier cannot do
  {
    const { svc } = make({ capacity: 1, occupied: 5 });
    const w: any = waiter('a', '1');
    check('a waiting courier cannot be approved', /waiting list/i.test((await rejects(() => svc.changeStatus(w, DriverStatus.APPROVED, { type: 'STAFF' }, null, {}))) ?? ''));
    check('nor activated', /waiting list/i.test((await rejects(() => svc.changeStatus(w, DriverStatus.ACTIVE, { type: 'STAFF' }, null, {}))) ?? ''));
    check('being rejected is still possible', (await rejects(() => svc.changeStatus(w, DriverStatus.REJECTED, { type: 'STAFF' }, 'no', {}))) === null);
    const invited: any = driver({ meta: { registrationZoneId: 'z1', waitlist: { zoneId: 'z1', joinedAt: 'x', invitedAt: 'y' } } });
    check('an invited courier can be approved normally', (await rejects(() => svc.changeStatus(invited, DriverStatus.APPROVED, { type: 'STAFF' }, null, {}))) === null);
  }
  {
    const { svc } = make({ capacity: 1, occupied: 5 });
    const w: any = waiter('a', '1');
    w.user = { status: 'ACTIVE' };
    svc.docsRequired = () => false;
    const r = await svc.goOnlineCheck(w);
    check('a waiting courier cannot go online, and is told why first', r.ok === false && /waiting list/i.test(r.reasons[0]), JSON.stringify(r.reasons));
  }
  {
    const line = [waiter('a', '1'), waiter('b', '2'), waiter('c', '3')];
    const { svc } = make({ capacity: 1, occupied: 5, waiting: line });
    const info = await svc.waitlistInfo(line[2]);
    check("a waiting courier sees their zone and place in line (3rd -> position 3, 2 ahead)", info?.zoneName === 'Downtown' && info.position === 3 && info.ahead === 2, JSON.stringify(info));
    check('someone not waiting sees nothing', (await svc.waitlistInfo(driver())) === null);
  }

  // ---- a full zone cannot be joined from the map
  {
    const zones = [{ id: 'z1', name: 'Downtown', cityId: 'c', active: true, driversOpen: true, full: true }];
    const base = { current: [] as string[], zones, driverCityId: 'c', max: 4 };
    check('a driver cannot add a zone that is full', /full right now/i.test((await rejects(() => checkZoneSelection({ ...base, requested: ['z1'] }))) ?? ''));
    check('but keeps a full zone they already have', checkZoneSelection({ ...base, current: ['z1'], requested: ['z1'] }).join() === 'z1');
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})();
