#!/usr/bin/env node
/**
 * FORKSY maps end-to-end test: REAL HTTP against a running API that is wired to the FAKE Mapbox and Google servers.
 *
 *   1.  node backend/test/fakes/fake-mapbox.mjs      (port 4243)
 *   2.  node backend/test/fakes/fake-google.mjs      (port 4244)
 *   3.  an API instance with  MAPBOX_API_BASE=http://localhost:4243  GOOGLE_API_BASE=http://localhost:4244  and NO Mapbox / Google keys in its environment
 *       (the test saves every key through the Integrations API, so it also proves the validation, the masking and the audit trail), on its own
 *       port and database seeded with the demo data (the payments suite uses forksy_pay).
 *   4.  node backend/test/maps-e2e.mjs [API_BASE]      (default http://localhost:4100/api/v1)
 *
 * It proves the FORKSY side: the provider switch (Mapbox <-> Google, Super Admin only, audited, instant), address search through either provider
 * with the same answers, road distances in the delivery quote (off by default, remembered, never failing a quote), the map tile configuration
 * (public keys only) and that no server key ever appears in a response. It does NOT prove that the real Mapbox / Google accept our calls.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const API = (process.argv[2] || process.env.API || 'http://localhost:4100/api/v1').replace(/\/$/, '');
const FAKE_MB = process.env.FAKE_MAPBOX || 'http://localhost:4243';
const FAKE_G = process.env.FAKE_GOOGLE || 'http://localhost:4244';
const SLUG = process.env.SLUG || 'maple-corner-convenience';
const PW = 'Demo@12345';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fake keys, assembled from parts so a secret scanner does not mistake them for real ones
const MB_SK = ['sk', 'fakeserver12345', 'fakeserver67890'].join('.');
const MB_PK = ['pk', 'fakepublic12345', 'fakepublic67890'].join('.');
const gkey = (tag) => 'AIza' + (tag + '0123456789012345678901234567890123456789').slice(0, 35);
const G_SERVER = gkey('FAKEserver');
const G_BROWSER = gkey('FAKEbrowser');
const G_BAD = gkey('INVALIDkey');

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra !== undefined ? '  -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 500) : ''}`);
};
const section = (s) => console.log(`\n--- ${s}`);

async function req(method, url, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  let b;
  if (body !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(body); }
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { method, headers: h, body: b });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
      return { s: r.status, j, text };
    } catch (e) { if (i === 4) throw e; await sleep(1500); }
  }
}
const api = (method, path, token, body) => req(method, API + path, { token, body });
const stats = (base) => req('GET', base + '/_fake/stats').then((r) => r.j);
async function limited(fn) { let r; for (let i = 0; i < 6; i++) { r = await fn(); if (r.s !== 429) return r; await sleep(12000); } return r; }

const db = new Client({ host: process.env.DB_HOST || 'localhost', port: +(process.env.DB_PORT || 5432), user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres', database: process.env.DB_NAME || 'forksy_pay' });
const q = async (sql, params) => (await db.query(sql, params)).rows;

async function login(email, password, app) {
  for (let i = 0; i < 6; i++) {
    const r = await api('POST', '/auth/login', null, { identifier: email, password, ...(app ? { app } : {}) });
    const d = r.j?.data || r.j;
    if (d?.accessToken) return d;
    if (r.s === 429) { await sleep(15000); continue; }
    throw new Error(`login failed for ${email}: ${r.s} ${r.text.slice(0, 100)}`);
  }
}

const S = {};
const sess = () => crypto.randomUUID();
const search = (text, extra = '') => api('GET', `/public/geocode/autocomplete?q=${encodeURIComponent(text)}&sessionToken=${sess()}${extra}`);

async function main() {
  await db.connect();
  section('setup');
  await req('POST', FAKE_MB + '/_fake/reset');
  await req('POST', FAKE_G + '/_fake/reset');
  S.admin = (await login('admin@forksy.ca', 'Admin@12345')).accessToken;
  S.fin = (await login('finance@forksy.ca', PW)).accessToken;
  S.c1 = (await login('customer1@demo.forksy.ca', PW, 'customer')).accessToken;
  check('logged in as the Super Admin, a finance staff member and a customer', S.admin && S.fin && S.c1);
  // a clean slate: no keys, Mapbox, no road distances
  await api('PUT', '/admin/integrations/mapbox', S.admin, { accessToken: '', publicToken: '', style: '' });
  await api('PUT', '/admin/integrations/google', S.admin, { apiKey: '', browserKey: '' });
  await api('PUT', '/admin/integrations/maps', S.admin, { provider: 'mapbox', roadDistances: false });

  // ============================================================ defaults and status
  section('A. defaults and status');
  let r = await api('GET', '/admin/integrations', S.admin);
  check('Mapbox is the default provider, road distances are off, nothing is configured yet', r.s === 200 && r.j.maps.provider === 'mapbox' && r.j.maps.roadDistances === false && r.j.maps.addressSearch === false && r.j.mapbox.configured === false && r.j.google.configured === false, r.j?.maps);
  check('the old read-only Google card is gone from "others" (Google has its own card now)', r.j.others.googleMaps === undefined && !!r.j.others.twilio);
  check('without keys the status says what happens (no address search, estimated distances, OpenStreetMap)', r.j.maps.tiles === 'osm' && /no key yet/i.test((r.j.maps.warnings || []).join(' ')), r.j.maps);
  r = await api('GET', '/admin/maps/config', S.admin);
  check('without keys the admin maps fall back to OpenStreetMap', r.s === 200 && r.j.tiles.provider === 'osm' && /openstreetmap/.test(r.j.tiles.url) && r.j.addressSearch === false, r.text);
  r = await api('GET', '/public/payments/config');
  check('the website is told address search is off', r.j.addressSearch === false);
  r = await search('City Centre');
  check('address search answers { enabled:false } (clients fall back to manual entry)', r.s === 200 && r.j.enabled === false && Array.isArray(r.j.suggestions), r.text);

  // ============================================================ saving keys: validation, masking, audit
  section('B. keys: validation, masking, audit, Super Admin only');
  r = await api('PUT', '/admin/integrations/google', S.fin, { apiKey: G_SERVER });
  check('a staff member without the Super Admin role cannot save Google keys (403)', r.s === 403, r.text);
  r = await api('PUT', '/admin/integrations/maps', S.fin, { provider: 'google' });
  check('...nor switch the provider (403)', r.s === 403, r.text);
  r = await api('PUT', '/admin/integrations/google', S.admin, { apiKey: 'not-a-google-key' });
  check('a Google key of the wrong shape is refused (400) before anything is stored', r.s === 400 && /AIza/.test(r.text), r.text);
  r = await api('PUT', '/admin/integrations/maps', S.admin, { provider: 'bing' });
  check('an unknown provider is refused (400)', r.s === 400, r.text);
  r = await api('PUT', '/admin/integrations/mapbox', S.admin, { style: 'not a style!' });
  check('a Mapbox style of the wrong shape is refused (400)', r.s === 400, r.text);
  r = await api('PUT', '/admin/integrations/mapbox', S.admin, { style: 'mapbox://styles/myteam/custom-day' });
  check('the Style URL of Mapbox Studio is accepted and stored as username/style_id', r.s === 200 && r.j.style === 'myteam/custom-day', r.text);
  r = await api('PUT', '/admin/integrations/mapbox', S.admin, { style: 'https://api.mapbox.com/styles/v1/myteam/custom-day?access_token=' + MB_PK });
  check('an api.mapbox.com address of the style is accepted too, and its token is not stored', r.s === 200 && r.j.style === 'myteam/custom-day' && !r.text.includes(MB_PK), r.text);
  r = await api('PUT', '/admin/integrations/mapbox', S.admin, { accessToken: MB_SK, publicToken: MB_PK, style: 'mapbox/outdoors-v12' });
  check('Mapbox keys and style saved', r.s === 200 && r.j.configured === true && r.j.style === 'mapbox/outdoors-v12', r.text);
  r = await api('PUT', '/admin/integrations/google', S.admin, { apiKey: G_SERVER, browserKey: G_BROWSER });
  check('Google keys saved', r.s === 200 && r.j.configured === true, r.text);
  r = await api('GET', '/admin/integrations', S.admin);
  const dump = r.text;
  check('no key value appears anywhere in the status response (server or browser keys, Mapbox tokens)', ![MB_SK, MB_PK, G_SERVER, G_BROWSER].some((k) => dump.includes(k)));
  check('keys are shown masked: ******** + last 4', r.j.google.keys.apiKey.masked === '********' + G_SERVER.slice(-4) && r.j.google.keys.browserKey.masked === '********' + G_BROWSER.slice(-4) && r.j.mapbox.keys.accessToken.masked === '********' + MB_SK.slice(-4), { g: r.j.google.keys, m: r.j.mapbox.keys });
  check('the keys come from the settings (not the environment)', r.j.google.keys.apiKey.source === 'settings' && r.j.mapbox.keys.accessToken.source === 'settings');
  const rawRow = (await q(`SELECT value::text v FROM settings WHERE key = 'integrations.google.apiKey'`))[0];
  check('the Google server key is stored encrypted, not in clear text', rawRow && rawRow.v.includes('enc1:') && !rawRow.v.includes(G_SERVER), rawRow);
  const aud = (await q(`SELECT action, "after" FROM audit_logs WHERE action IN ('integrations.google.update','integrations.mapbox.update') ORDER BY "createdAt" DESC LIMIT 4`));
  check('saving keys is audited with the field names only, never a value', aud.some((a) => a.action === 'integrations.google.update' && a.after.changed.includes('apiKey')) && !JSON.stringify(aud).includes(G_SERVER) && !JSON.stringify(aud).includes(MB_SK), aud);
  r = await api('PUT', '/admin/settings', S.admin, { values: { 'integrations.maps.provider': 'google' } });
  check('the generic Settings page cannot change the provider (it is edited on System > Integrations)', r.s === 400, r.text);

  // ============================================================ address search through either provider
  section('C. address search: same answers from Mapbox and Google');
  r = await api('GET', '/admin/integrations', S.admin);
  check('provider is Mapbox: address search is on, maps come from Mapbox', r.j.maps.provider === 'mapbox' && r.j.maps.addressSearch === true && r.j.maps.tiles === 'mapbox', r.j.maps);
  await req('POST', FAKE_MB + '/_fake/reset');
  r = await search('1 City Centre');
  const mbSug = r.j?.suggestions || [];
  check('Mapbox: suggestions for "1 City Centre"', r.s === 200 && r.j.enabled === true && mbSug.length >= 1 && mbSug.every((s) => s.id && s.label && s.line1 !== undefined && s.secondary !== undefined), r.text);
  r = await api('GET', `/public/geocode/retrieve?id=${encodeURIComponent(mbSug[0]?.id)}&sessionToken=${sess()}`);
  const mbAddr = r.j?.address;
  check('Mapbox: retrieve gives street, city, province, postal code and position', r.s === 200 && mbAddr?.line1 === '1 City Centre Dr' && mbAddr.city === 'Mississauga' && mbAddr.province === 'ON' && mbAddr.postalCode === 'L5B 2G3' && Math.abs(mbAddr.lat - 43.5929) < 1e-4, r.text);
  const before = (await stats(FAKE_MB)).suggest;
  await search('1 City Centre');
  check('...and an identical search is answered from the FORKSY cache (Mapbox is not asked again)', (await stats(FAKE_MB)).suggest === before);
  r = await search('Main Street Ottawa');
  check('Mapbox: an address outside the Greater Toronto Area is filtered out by the bounding box', r.j.enabled === true && r.j.suggestions.length === 0, r.text);
  r = await api('GET', '/public/geocode/reverse?lat=43.5929&lng=-79.6414');
  check('Mapbox: reverse geocoding gives the nearest address', r.s === 200 && r.j.address?.city === 'Mississauga', r.text);

  r = await api('PUT', '/admin/integrations/maps', S.admin, { provider: 'google' });
  check('switch to Google (Super Admin): takes effect at once', r.s === 200 && r.j.provider === 'google' && r.j.addressSearch === true && r.j.tiles === 'google', r.text);
  const a2 = (await q(`SELECT "after" FROM audit_logs WHERE action = 'integrations.maps.update' ORDER BY "createdAt" DESC LIMIT 1`))[0];
  check('the switch is audited with the old and the new provider', a2?.after?.providerChange?.from === 'mapbox' && a2.after.providerChange.to === 'google', a2);
  r = await search('1 City Centre');
  const gSug = r.j?.suggestions || [];
  check('Google: suggestions have the same shape', r.s === 200 && r.j.enabled === true && gSug.length >= 1 && gSug.every((s) => s.id && s.label && s.line1 !== undefined && s.secondary !== undefined), r.text);
  const lastReq = (await stats(FAKE_G)).lastAutocomplete;
  check('Google was asked for Canada only and restricted to the Greater Toronto Area box (the same search area settings as Mapbox)', lastReq?.includedRegionCodes?.[0] === 'ca' && lastReq.locationRestriction?.rectangle?.low?.longitude === -80.35 && lastReq.locationRestriction.rectangle.high.latitude === 44.2 && !!lastReq.sessionToken, lastReq);
  r = await api('GET', `/public/geocode/retrieve?id=${encodeURIComponent(gSug[0]?.id)}&sessionToken=${sess()}`);
  const gAddr = r.j?.address;
  check('Google: retrieve gives the SAME address fields as Mapbox did', r.s === 200 && gAddr && ['line1', 'city', 'province', 'postalCode'].every((k) => gAddr[k] === mbAddr[k]) && Math.abs(gAddr.lat - mbAddr.lat) < 1e-4 && Math.abs(gAddr.lng - mbAddr.lng) < 1e-4, { gAddr, mbAddr });
  r = await search('Main Street Ottawa');
  check('Google: the bounding box filters Ottawa out too', r.j.enabled === true && r.j.suggestions.length === 0, r.text);
  r = await api('GET', '/public/geocode/reverse?lat=43.5929&lng=-79.6414');
  check('Google: reverse geocoding gives the nearest address', r.s === 200 && r.j.address?.city === 'Mississauga' && r.j.address.postalCode === 'L5B 2G3', r.text);
  const gBefore = (await stats(FAKE_G)).autocomplete;
  await search('1 City Centre');
  check('Google: identical searches are cached too', (await stats(FAKE_G)).autocomplete === gBefore);
  r = await api('GET', '/admin/geocode/autocomplete?q=Dundas&sessionToken=' + sess(), S.admin);
  check('the Admin Console search uses the active provider as well', r.s === 200 && r.j.enabled === true && r.j.suggestions.length >= 1, r.text);

  // a rejected key degrades gracefully
  r = await api('PUT', '/admin/integrations/google', S.admin, { apiKey: G_BAD });
  r = await search('Dundas St');
  check('Google rejects the key: address search answers { enabled:false } instead of an error', r.s === 200 && r.j.enabled === false, r.text);
  r = await api('POST', '/admin/integrations/google/test', S.admin);
  check('"Test connection" reports the rejected key in plain words', r.s < 300 && r.j.ok === false && /rejected the API key/i.test(r.j.reason), r.text);
  await api('PUT', '/admin/integrations/google', S.admin, { apiKey: G_SERVER });
  r = await api('POST', '/admin/integrations/google/test', S.admin);
  check('"Test connection" with a good key: ok, a sample address, routes and tiles checked', r.s < 300 && r.j.ok === true && !!r.j.sample && r.j.routing?.ok === true && r.j.tiles?.ok === true, r.text);
  r = await api('POST', '/admin/integrations/mapbox/test', S.admin);
  check('Mapbox "Test connection": ok, a sample address and the Directions check', r.s < 300 && r.j.ok === true && !!r.j.sample && r.j.routing?.ok === true, r.text);
  check('no key value in a test result', !r.text.includes(MB_SK) && !r.text.includes(MB_PK));

  // ============================================================ map tiles
  section('D. map tiles for the admin screens (public keys only)');
  r = await api('GET', '/admin/maps/config', S.admin);
  check('Google: tile URL with a session and the BROWSER key, never the server key', r.s === 200 && r.j.provider === 'google' && r.j.tiles.provider === 'google' && /\/v1\/2dtiles\/\{z\}\/\{x\}\/\{y\}\?session=fakeSession/.test(r.j.tiles.url) && r.j.tiles.url.includes(G_BROWSER) && !r.text.includes(G_SERVER), r.text);
  r = await api('PUT', '/admin/integrations/maps', S.admin, { provider: 'mapbox' });
  r = await api('GET', '/admin/maps/config', S.admin);
  check('Mapbox: tile URL with the style and the PUBLIC pk. token, never the sk. token', r.j.tiles.provider === 'mapbox' && /\/styles\/v1\/mapbox\/outdoors-v12\/tiles\/256\/\{z\}\/\{x\}\/\{y\}\{r\}\?access_token=/.test(r.j.tiles.url) && r.j.tiles.url.includes(MB_PK) && !r.text.includes(MB_SK), r.text);
  const tileUrl = r.j.tiles.url.replace('{z}', '3').replace('{x}', '2').replace('{y}', '2').replace('{r}', '');
  const tile = await fetch(tileUrl);
  check('...and that URL really serves a tile', tile.status === 200 && /image\/png/.test(tile.headers.get('content-type') || ''), tile.status);
  r = await api('GET', '/admin/maps/config', S.c1);
  check('customers cannot read the map configuration (staff only)', r.s === 401 || r.s === 403, r.s);
  r = await req('GET', API + '/admin/maps/config');
  check('...nor anonymous visitors', r.s === 401, r.s);
  await api('PUT', '/admin/integrations/mapbox', S.admin, { publicToken: '' });
  r = await api('GET', '/admin/maps/config', S.admin);
  check('Mapbox without a public token: the maps fall back to OpenStreetMap (address search still works)', r.j.tiles.provider === 'osm' && r.j.addressSearch === true, r.text);
  await api('PUT', '/admin/integrations/mapbox', S.admin, { publicToken: MB_PK });

  // ============================================================ road distances in the delivery quote
  section('E. road distances (off by default, remembered, never failing a quote)');
  const slugR = await api('GET', '/public/restaurants/' + SLUG);
  const rest = slugR.j.restaurant || slugR.j;
  const menu = Array.isArray(slugR.j.menu) ? slugR.j.menu : slugR.j.menu?.categories || [];
  let item;
  for (const ct of menu) for (const i of ct.items || []) if (!item && !(i.modifierGroups || []).some((g) => g.minSelect > 0 || g.required) && i.available !== false) item = i;
  const cartOk = (await api('POST', '/customer/cart/replace', S.c1, { restaurantId: rest.id || slugR.j.id, items: [{ menuItemId: item.id, quantity: 2 }] })).s < 300;
  const adr = (await api('GET', '/customer/addresses', S.c1)).j;
  const base = (Array.isArray(adr) ? adr : adr.data).find((x) => x.isDefault) || (Array.isArray(adr) ? adr : adr.data)[0];
  check('a restaurant cart and a delivery position exist', cartOk && base?.lat != null, base);
  const quote = async (dLat) => (await limited(() => api('POST', '/customer/checkout/quote', S.c1, { type: 'DELIVERY', lat: Number(base.lat) + dLat, lng: Number(base.lng) + dLat, tip: 0 }))).j;
  await req('POST', FAKE_MB + '/_fake/reset');
  await req('POST', FAKE_G + '/_fake/reset');
  const q0 = await quote(0);
  const straight = q0.distanceKm / 1.3;
  check('road distances OFF: the quote uses the built-in estimate (1.3 x the straight line) and asks no provider', q0.distanceKm > 0 && (await stats(FAKE_MB)).directions === 0, q0);
  let r2 = await api('PUT', '/admin/integrations/maps', S.admin, { roadDistances: true });
  check('road distances switched ON (Super Admin, audited)', r2.s === 200 && r2.j.roadDistances === true && r2.j.roadDistancesActive === true, r2.text);
  await req('POST', FAKE_MB + '/_fake/reset');
  const q1 = await quote(0);
  check('Mapbox: the quote now uses the Directions distance (1.5 x the straight line in the fake) and the drive time', Math.abs(q1.distanceKm / straight - 1.5) < 0.01 && q1.etaMinutes > 0, { q1: q1.distanceKm, straight });
  check('...the delivery fee follows the distance (a longer road distance costs more)', Number(q1.deliveryFee) >= Number(q0.deliveryFee), { off: q0.deliveryFee, on: q1.deliveryFee });
  const q1b = await quote(0);
  check('the same trip again gives the same answer without asking Mapbox again (what the quote said is what the payment and the order will say)', q1b.distanceKm === q1.distanceKm && q1b.deliveryFee === q1.deliveryFee && (await stats(FAKE_MB)).directions === 1, { stats: await stats(FAKE_MB) });
  await api('PUT', '/admin/integrations/maps', S.admin, { provider: 'google' });
  await req('POST', FAKE_G + '/_fake/reset');
  const q2 = await quote(0);
  check('Google: switching the provider switches the distance source (1.4 x the straight line in the fake)', Math.abs(q2.distanceKm / straight - 1.4) < 0.01 && (await stats(FAKE_G)).routes === 1, { q2: q2.distanceKm, straight });
  await req('GET', FAKE_G + '/_fake/fail-routes?n=1');
  const q3 = await quote(0.004);
  const s3 = (await stats(FAKE_G)).routes;
  check('when the provider is down the quote still works, with the estimate (never an error)', q3 && q3.total > 0 && q3.distanceKm > 0, q3);
  const q3b = await quote(0.004);
  check('...and the fallback is remembered for a few minutes, so the payment and the order see the same number (no second provider call)', q3b.distanceKm === q3.distanceKm && (await stats(FAKE_G)).routes === s3, { a: q3.distanceKm, b: q3b.distanceKm });
  const fresh = await quote(0.008);
  check('...a different trip is routed normally again', (await stats(FAKE_G)).routes === s3 + 1 && fresh.distanceKm > 0);
  await api('PUT', '/admin/integrations/maps', S.admin, { roadDistances: false });
  const q4 = await quote(0);
  check('switching road distances OFF returns to the estimate at once', Math.abs(q4.distanceKm - q0.distanceKm) < 0.0015, { q4: q4.distanceKm, q0: q0.distanceKm });

  // ============================================================ the rest
  section('F. production gate and legacy settings');
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', `
    const s = require('./src/common/security');
    const base = { env:'production', jwtSecret:'a'.repeat(5)+'Xk9#mQ2$vL7!pR4&wT6*yU8^zB3@nC5', dbSync:false, exposeOtp:false, corsOrigins:['https://app.example.com'], publicUrl:'https://api.example.com', enforce2fa:true, seedSuperAdminPassword:'Str0ng!Unique#Pass', dbPassword:'Zq8!x7Lm2#vB', dataEncryptionKey:'k'.repeat(40), allowMockPayments:false, fakeProviderBases:false };
    console.log(JSON.stringify({ ok: s.productionProblems(base), fake: s.productionProblems({ ...base, fakeProviderBases: true }) }));
  `], { cwd: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), encoding: 'utf8' });
  const g = JSON.parse(out.trim().split('\n').pop());
  check('production gate: fake provider servers (including GOOGLE_API_BASE) make the API refuse to start', g.fake.some((x) => /GOOGLE_API_BASE/.test(x)) && g.ok.length === 0, g);
  const legacy = await q(`SELECT key FROM settings WHERE key IN ('maps.provider','maps.googleApiKey')`);
  check('the old maps.provider / maps.googleApiKey rows were moved into the integrations group on boot', legacy.length === 0, legacy);
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.log('FATAL', e.stack || e);
  exitCode = 1;
} finally {
  try {
    if (S.admin) {
      await api('PUT', '/admin/integrations/maps', S.admin, { provider: 'mapbox', roadDistances: false });
      await api('PUT', '/admin/integrations/mapbox', S.admin, { accessToken: '', publicToken: '', style: '' });
      await api('PUT', '/admin/integrations/google', S.admin, { apiKey: '', browserKey: '' });
    }
  } catch { /* ignore */ }
  await db.end().catch(() => undefined);
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
failed.forEach((f) => console.log(' FAIL:', f.name));
process.exit(exitCode || (failed.length ? 1 : 0));
