#!/usr/bin/env node
/**
 * FORKSY hands-off order regression test: REAL HTTP against a running API (+ read-only SQL on driver_offers).
 *
 * Proves the automated order flow: auto-accept -> auto-start prep -> auto-ready -> automatic driver offers -> GPS arrival detection ->
 * pickup code -> PIN delivery. Also exercises the per-restaurant automation overrides (GET/PATCH /restaurant/automation).
 *
 * Run (API and Postgres must be up and seeded with the demo data):
 *
 *   API=http://localhost:4000/api/v1 \
 *   ADMIN_PASSWORD=<seeded super-admin password> DEMO_PASSWORD=<seeded demo-account password> \
 *   PGPASSWORD=<postgres password> node backend/test/dispatch-regression.mjs
 *
 * Optional env: SLUG (restaurant, default napoli-wood-fired-pizza-city-centre), ADMIN_EMAIL (default admin@forksy.ca),
 *   PGHOST / PGPORT / PGUSER / PGDATABASE (defaults localhost / 5432 / postgres / forksy).
 *
 * Notes
 *  - Takes about 2-4 minutes (the kitchen prep timer is real).
 *  - It temporarily sets orders.customerCancelGraceSeconds to 0 and the restaurant's prepTimeMin to 1, and restores both in a finally block.
 *  - Driver search starts BEFORE the kitchen marks READY (dispatch.preReadyMinutes), so offers go out (and can expire after 30 s) while the
 *    order is still PREPARING. The test therefore watches the driver_offers rows (any status) for the whole run and accepts the first
 *    PENDING offer the moment it shows up; if every offer already expired it finishes the trip with an admin assignment.
 *  - The login endpoint is throttled (about 10 per minute per IP): do not run several suites at once.
 *  - Run it on a quiet system: leftover active orders at the same restaurant lengthen the automatic prep time and occupy the drivers.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const API = (process.env.API || 'http://localhost:4000/api/v1').replace(/\/$/, '');
const SLUG = process.env.SLUG || 'napoli-wood-fired-pizza-city-centre';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@forksy.ca';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
if (!ADMIN_PASSWORD || !DEMO_PASSWORD || !process.env.PGPASSWORD) {
  console.error('Set ADMIN_PASSWORD, DEMO_PASSWORD and PGPASSWORD (see the header of this file).');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? '  -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : ''}`);
};

async function api(method, path, token, body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* empty body */ }
  return { s: r.status, j };
}
async function login(identifier, password, app) {
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/auth/login', null, { identifier, password, ...(app ? { app } : {}) });
    const d = r.j && (r.j.data || r.j);
    if (d && d.accessToken) return d;
    if (r.s === 429) { await sleep(15000); continue; }
    throw new Error(`login failed for ${identifier}: ${r.s}`);
  }
  throw new Error(`login throttled for ${identifier}`);
}
const ping = (token, lat, lng) => api('POST', '/driver/location', token, { lat, lng });
const cancel = (admin, orderId) => api('POST', `/admin/orders/${orderId}/cancel`, admin, { reason: 'dispatch-regression cleanup', restaurantApproval: { contactName: 'Dispatch Regression', channel: 'CHAT' } });

let home;
async function place(customerToken) {
  if (!home) home = await api('GET', '/public/restaurants/' + SLUG);
  const menu = home.j.menu; const cats = Array.isArray(menu) ? menu : menu?.categories || [];
  let item;
  for (const ct of cats) { for (const i of ct.items || []) { if (!(i.modifierGroups || []).some((g) => g.minSelect > 0 || g.required)) { item = i; break; } } if (item) break; }
  const restId = home.j.id || home.j.restaurant?.id;
  await api('POST', '/customer/cart/replace', customerToken, { restaurantId: restId, items: [{ menuItemId: item.id, quantity: 2 }] });
  const addrs = (await api('GET', '/customer/addresses', customerToken)).j;
  const addressId = addrs.find((a) => a.isDefault).id;
  const po = await api('POST', '/customer/orders', customerToken, { type: 'DELIVERY', addressId, tip: 2, paymentMethod: 'CARD', paymentToken: 'pm_mock' });
  return { oid: po.j?.id, po, restId };
}

const pg = new Client({ host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD, database: process.env.PGDATABASE || 'forksy' });

async function main() {
  await pg.connect();
  const S = {};
  S.admin = (await login(ADMIN_EMAIL, ADMIN_PASSWORD)).accessToken;
  S.c1 = (await login('customer1@demo.forksy.ca', DEMO_PASSWORD, 'customer')).accessToken;
  const d6 = await login('driver6@demo.forksy.ca', DEMO_PASSWORD, 'driver'); S.d6 = d6.accessToken; S.d6id = d6.user.driverId;
  const d21 = await login('driver21@demo.forksy.ca', DEMO_PASSWORD, 'driver'); S.d21 = d21.accessToken; S.d21id = d21.user.driverId;
  const driverByEmail = { 'driver6@demo.forksy.ca': { token: S.d6, id: S.d6id }, 'driver21@demo.forksy.ca': { token: S.d21, id: S.d21id } };
  const driverFor = async (email) => driverByEmail[email] || (async () => { const l = await login(email, DEMO_PASSWORD, 'driver'); return { token: l.accessToken, id: l.user.driverId }; })();

  // fixtures: no customer cancel window (so the order is sent to the kitchen at once); 1 minute prep. Both restored in finally.
  const graceRow = ((await api('GET', '/admin/settings?group=orders', S.admin)).j.data || []).find((s) => s.key === 'orders.customerCancelGraceSeconds');
  const origGrace = graceRow ? graceRow.value : 120;
  let rid = null; let origPrep = null; const placed = [];
  try {
    let r = await api('PUT', '/admin/settings', S.admin, { values: { 'orders.customerCancelGraceSeconds': 0 } }); check('customer cancel grace set to 0 for the run', r.s < 300, r);
    const a = await place(S.c1); placed.push(a.oid); rid = a.restId; await cancel(S.admin, a.oid);
    const imp = await api('POST', `/admin/restaurants/${rid}/impersonate`, S.admin, {});
    const ownerTok = imp.j && (imp.j.accessToken || (imp.j.data && imp.j.data.accessToken)); check('impersonation token for the owner', !!ownerTok, imp);
    const q = `?restaurantId=${rid}`;
    const rest = (await api('GET', `/admin/restaurants/${rid}`, S.admin)).j;
    origPrep = rest.prepTimeMin; const lat = Number(rest.lat), lng = Number(rest.lng);
    console.log('restaurant', rest.name, 'prep', origPrep, lat, lng);
    r = await api('PATCH', `/admin/restaurants/${rid}`, S.admin, { prepTimeMin: 1 }); check('prep time set to 1 min for the test', r.s < 300, r);

    // ---------- automation config API
    const cfg = (await api('GET', '/restaurant/automation' + q, ownerTok)).j;
    check('GET /restaurant/automation: platform defaults on', cfg.effective?.autoAccept === true && cfg.effective.autoStartPrep === true && cfg.effective.autoReady === true && cfg.overrides.autoAccept === null, cfg);
    r = await api('PATCH', '/restaurant/automation' + q, ownerTok, { autoAccept: false }); check('restaurant switches auto-accept off', r.s < 300 && r.j.effective.autoAccept === false && r.j.overrides.autoAccept === false, r);
    const off = await place(S.c1); placed.push(off.oid); await sleep(5000);
    let co = (await api('GET', `/customer/orders/${off.oid}`, S.c1)).j; check('auto-accept OFF: order waits in PLACED', co.status === 'PLACED', co.status);
    await cancel(S.admin, off.oid);
    r = await api('PATCH', '/restaurant/automation' + q, ownerTok, { autoAccept: null }); check('back to platform default (null)', r.s < 300 && r.j.effective.autoAccept === true && r.j.overrides.autoAccept === null, r);
    r = await api('PATCH', '/restaurant/automation' + q, ownerTok, { autoReady: 'false' }); check('string "false" rejected (strict boolean)', r.s === 400, r.s);
    r = await api('PATCH', `/admin/restaurants/${rid}/automation`, S.admin, { autoReady: true }); check('admin can set an override too', r.s < 300 && r.j.overrides.autoReady === true, r);
    await api('PATCH', `/admin/restaurants/${rid}/automation`, S.admin, { autoReady: null });
    r = await api('PATCH', '/restaurant/automation' + q, S.c1, { autoAccept: false }); check('a customer cannot change it', r.s === 401 || r.s === 403, r.s);

    // ---------- fully hands-off order
    console.log('--- hands-off order');
    for (const tok of [S.d6, S.d21]) { await api('POST', '/driver/online', tok, {}); await ping(tok, lat + 0.004, lng + 0.003); }
    await sleep(500);
    const b = await place(S.c1); placed.push(b.oid); check('order placed', b.po.s < 300 && b.oid, b.po.j);
    const t0 = Date.now(); const seen = {};
    const view = async () => (await api('GET', `/admin/orders/${b.oid}`, S.admin)).j;
    const stOf = (x) => (x.order || x).status; const stamp = (st) => { if (!seen[st]) seen[st] = Math.round((Date.now() - t0) / 1000); };

    // Watch driver_offers (any status) the whole time; accept the first PENDING offer as soon as it appears (that is the driver's only manual step).
    const offersSeen = new Map(); let accepted = null;
    const poll = async () => {
      const rows = (await pg.query('SELECT o.id, o.status, u.email FROM driver_offers o JOIN driver_profiles d ON d.id = o."driverId" JOIN users u ON u.id = d."userId" WHERE o."orderId" = $1 ORDER BY o."sentAt"', [b.oid])).rows;
      for (const row of rows) if (!offersSeen.has(row.id)) offersSeen.set(row.id, row);
      const pend = rows.find((x) => x.status === 'PENDING');
      if (pend && !accepted) {
        const drv = await driverFor(pend.email);
        const ac = await api('POST', `/driver/trip/offer/${pend.id}/accept`, drv.token, {});
        check('driver accepts the offer as soon as it arrives (the kitchen may still be preparing)', ac.s < 300, ac);
        accepted = { email: pend.email, token: drv.token };
      }
    };
    let o = await view();
    for (let i = 0; i < 170 && !(seen.READY && offersSeen.size); i++) { await sleep(1500); o = await view(); stamp(stOf(o)); await poll(); }
    console.log('   status reached (seconds after placement):', JSON.stringify(seen), ' offers:', JSON.stringify([...offersSeen.values()].map((x) => x.email + ':' + x.status)));
    const tl = ((o.order || o).timeline || o.timeline || []).map((e) => `${e.type}:${e.toStatus || ''}:${(e.note || '').slice(0, 40)}`);
    check('ACCEPTED automatically (within 10 s)', seen.ACCEPTED !== undefined || seen.PREPARING !== undefined, seen);
    check('PREPARING automatically', seen.PREPARING !== undefined || seen.READY !== undefined, seen);
    check('READY automatically when prep time elapsed', seen.READY !== undefined || ['READY', 'DRIVER_ASSIGNED'].includes(stOf(o)), seen);
    check('timeline marks the steps as Auto', tl.filter((x) => /Auto/.test(x)).length >= 3, tl);
    await poll();
    check('a nearby driver was offered the order automatically', offersSeen.size > 0, 'no driver_offers rows for the order');
    if (!accepted && offersSeen.size) { // every offer expired before we could react: finish the trip with an admin assignment
      const first = [...offersSeen.values()][0]; const drv = await driverFor(first.email);
      r = await api('POST', `/admin/orders/${b.oid}/reassign-driver`, S.admin, { driverId: drv.id, reason: 'dispatch-regression (offers had expired)' });
      check('admin assigns the offered driver (offers had expired)', r.s < 300, r); accepted = { email: first.email, token: drv.token };
    }
    if (accepted) {
      console.log('   driver:', accepted.email);
      await ping(accepted.token, lat, lng); await sleep(1500);
      o = await view(); const oo = o.order || o; check('arrival at the restaurant detected from GPS (no tap)', !!oo.driverArrivedRestaurantAt, { at: oo.driverArrivedRestaurantAt });
      co = (await api('GET', `/customer/orders/${b.oid}`, S.c1)).j;
      r = await api('POST', `/restaurant/orders/${b.oid}/handoff`, ownerTok, { code: co.code }); check('restaurant cannot mark a FORKSY driver pickup (the driver does)', r.s === 400, r);
      r = await api('POST', `/driver/trip/${b.oid}/picked-up`, accepted.token, {}); check('driver confirms the pickup without any code', r.s < 300, r);
      const D = { lat: co.deliveryAddress.lat, lng: co.deliveryAddress.lng };
      await ping(accepted.token, D.lat, D.lng); await sleep(1500);
      o = await view(); const o2 = o.order || o; check('arrival at the customer detected from GPS (no tap)', !!o2.driverArrivedCustomerAt, { at: o2.driverArrivedCustomerAt });
      r = await api('POST', `/driver/trip/${b.oid}/delivered`, accepted.token, { pin: co.deliveryPin, lat: D.lat, lng: D.lng }); check('PIN delivery completes', r.s < 300 && r.j?.status === 'DELIVERED', r);
    }
  } finally {
    // restore everything the run changed (and cancel anything still open that this run placed)
    for (const oid of placed) { try { const st = (await api('GET', `/admin/orders/${oid}`, S.admin)).j; const s = (st.order || st).status; if (s && !['DELIVERED', 'CANCELLED', 'REJECTED'].includes(s)) await cancel(S.admin, oid); } catch { /* best effort */ } }
    if (rid && origPrep != null) await api('PATCH', `/admin/restaurants/${rid}`, S.admin, { prepTimeMin: origPrep });
    await api('PUT', '/admin/settings', S.admin, { values: { 'orders.customerCancelGraceSeconds': origGrace } });
    await pg.end();
  }
  const fails = results.filter((x) => !x.ok);
  console.log(`\nSUMMARY ${results.length - fails.length}/${results.length} passed`); fails.forEach((x) => console.log('  FAILED:', x.name));
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error('CRASH', e); process.exit(1); });
