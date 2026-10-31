/**
 * Unit tests for the "are you still on your way?" check (no server, no database):
 *
 *   cd backend && npx ts-node --transpile-only test/driver-presence.test.ts
 *
 * Plays out the 3-minutes-away example with fake repositories: the expected pickup time comes from the accepted offer, the question is
 * asked at twice that time (not before), an answer keeps the order, silence unassigns it for redispatch, a driver already at the
 * restaurant is never asked, a driver who arrived is never asked, and the switch / multiplier settings are honoured.
 * Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import 'reflect-metadata';
import { FulfilmentMode, OfferStatus, OrderStatus } from '../src/common/enums';
import { DriverPresenceService } from '../src/drivers/driver-presence.service';

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed++;
};

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
let clock = T0;
const realNow = Date.now;
Date.now = () => clock;
const advance = (ms: number) => { clock += ms; };

type Fixture = { settings?: Record<string, any>; pickupKm?: number | null; driverAt?: { lat: number; lng: number }; arrived?: boolean };

function setup(f: Fixture = {}) {
  const restaurant = { name: 'Saffron Kitchen', lat: 43.65, lng: -79.38 };
  const order: any = {
    id: 'o1', code: 'FK-1', driverId: 'd1', status: OrderStatus.DRIVER_ASSIGNED, fulfilment: FulfilmentMode.PLATFORM_DRIVER,
    driverAssignedAt: new Date(T0), driverArrivedRestaurantAt: f.arrived ? new Date(T0) : null, meta: {}, restaurant,
  };
  const driver = { id: 'd1', userId: 'u1', ...(f.driverAt ?? { lat: 43.7, lng: -79.5 }) };
  const events: { name: string; payload: any }[] = [];
  const notes: string[] = [];
  const unassigned: any[] = [];
  const offers = { findOne: async () => (f.pickupKm === null ? null : { pickupDistanceKm: f.pickupKm ?? 1.4, status: OfferStatus.ACCEPTED }) };
  const orders = {
    find: async () => (order.driverId && !order.driverArrivedRestaurantAt ? [order] : []),
    findOne: async () => order,
    update: async (_w: any, v: any) => Object.assign(order, v),
  };
  const core: any = {
    settings: { get: <T>(k: string, d?: T) => (f.settings && k in f.settings ? f.settings[k] : d) as T },
    profiles: { findOne: async () => driver },
    rt: { emitToDriver: (_id: string, name: string, payload: any) => events.push({ name, payload }) },
    notifyDriver: async (_p: any, event: string) => { notes.push(event); },
  };
  const ordersService: any = {
    unassignDriver: async (id: string, actor: any, reason: string, opts: any) => {
      unassigned.push({ id, actor, reason, opts });
      order.driverId = null;
      order.status = OrderStatus.ACCEPTED;
    },
  };
  const svc = new DriverPresenceService(core, ordersService, orders as any, offers as any);
  return { svc, order, events, notes, unassigned };
}

(async () => {
  // 1.4 km at 28 km/h is 3 minutes, so the question comes at 6 minutes
  {
    clock = T0;
    const { svc, order, events, unassigned } = setup();
    await svc.sweep();
    check('expected pickup time is worked out from the accepted offer (1.4 km -> 3 min)', order.meta.presence?.expectedMin === 3, JSON.stringify(order.meta.presence));
    check('the question is due at 2x the expected time (6 min after assignment)', new Date(order.meta.presence.dueAt).getTime() === T0 + 6 * MIN);

    advance(5 * MIN + 30_000);
    await svc.sweep();
    check('nothing is asked before 6 minutes', events.length === 0);

    advance(40_000); // 6 min 10 s
    await svc.sweep();
    check('at 6 minutes the driver is asked over the socket', events.length === 1 && events[0].name === 'driver.presence_check', JSON.stringify(events));
    check('the question carries the order code, restaurant and a 90 s deadline', events[0].payload.code === 'FK-1' && events[0].payload.restaurant === 'Saffron Kitchen' && events[0].payload.seconds === 90);
    check('the open question is stored on the order', !!order.meta.presence.check);
    check('an open question is not repeated by the next sweep', (await svc.sweep(), events.length === 1));
    check('the open question is visible to GET /driver/trip/active', svc.openCheck(order)?.seconds === 90 || (svc.openCheck(order)?.seconds ?? 0) > 80);

    advance(95_000);
    await svc.sweep();
    check('no answer: the order is unassigned with redispatch', unassigned.length === 1 && unassigned[0].opts?.redispatch === true && unassigned[0].id === 'o1', JSON.stringify(unassigned));
    check('the reason says the driver did not confirm', /did not confirm/i.test(unassigned[0]?.reason ?? ''));
    check('the driver is told the order was reassigned', events.some((e) => e.name === 'driver.presence_timeout'));
    check('the presence record is cleared after the release', order.meta.presence === undefined);
  }

  // answering keeps the order
  {
    clock = T0;
    const { svc, order, events, unassigned } = setup();
    await svc.sweep();
    advance(6 * MIN + 10_000);
    await svc.sweep();
    advance(30_000);
    const r = await svc.confirm('d1', 'o1');
    check('confirming in time is accepted', r.ok === true && r.pending === false, JSON.stringify(r));
    check('the open question is cleared', !order.meta.presence.check);
    advance(2 * MIN);
    await svc.sweep();
    check('a confirmed driver keeps the order', unassigned.length === 0 && order.driverId === 'd1');
    check('and is not asked again straight away', events.filter((e) => e.name === 'driver.presence_check').length === 1);
    advance(2 * MIN); // 3 min after the confirmation: asked again if still not there
    await svc.sweep();
    check('a driver who confirmed but still is not there is asked again later', events.filter((e) => e.name === 'driver.presence_check').length === 2);
    check('someone else cannot answer for the driver', await svc.confirm('other', 'o1').then(() => false, () => true));
  }

  // confirming too late
  {
    clock = T0;
    const { svc } = setup();
    await svc.sweep();
    advance(6 * MIN + 10_000);
    await svc.sweep();
    advance(120_000);
    const r = await svc.confirm('d1', 'o1');
    check('an answer long after the deadline does not count', r.ok === false && (r as any).expired === true, JSON.stringify(r));
  }

  // never asked
  {
    clock = T0;
    const nearby = setup({ driverAt: { lat: 43.6502, lng: -79.3801 } }); // ~15 m from the restaurant
    await nearby.svc.sweep();
    advance(7 * MIN);
    await nearby.svc.sweep();
    check('a driver already at the restaurant is not asked', nearby.events.length === 0);

    clock = T0;
    const arrived = setup({ arrived: true });
    advance(7 * MIN);
    await arrived.svc.sweep();
    check('a driver who has arrived is not asked', arrived.events.length === 0 && arrived.unassigned.length === 0);

    clock = T0;
    const off = setup({ settings: { 'driver.presence.enabled': false } });
    advance(7 * MIN);
    await off.svc.sweep();
    check('the switch driver.presence.enabled=false turns the check off', off.events.length === 0);
  }

  // settings and fallbacks
  {
    clock = T0;
    const s = setup({ settings: { 'driver.presence.multiplier': 3, 'driver.presence.confirmSeconds': 60 } });
    await s.svc.sweep();
    advance(7 * MIN);
    await s.svc.sweep();
    check('multiplier 3 -> not asked at 7 min (due at 9)', s.events.length === 0);
    advance(2 * MIN);
    await s.svc.sweep();
    check('multiplier 3 -> asked at 9 min, with a 60 s deadline', s.events.length === 1 && s.events[0].payload.seconds === 60, JSON.stringify(s.events));

    clock = T0;
    const noOffer = setup({ pickupKm: null }); // no accepted offer on record: estimated from the driver's position instead
    await noOffer.svc.sweep();
    check('without an offer the expected time falls back to the driver position and is at least the minimum', noOffer.order.meta.presence.expectedMin >= 2);

    clock = T0;
    const tiny = setup({ pickupKm: 0.2 });
    await tiny.svc.sweep();
    check('a very short pickup still waits at least 2 x 2 minutes', tiny.order.meta.presence.expectedMin === 2 && new Date(tiny.order.meta.presence.dueAt).getTime() === T0 + 4 * MIN);
  }

  Date.now = realNow;
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})();
