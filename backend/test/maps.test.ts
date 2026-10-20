/**
 * Unit tests for the maps provider layer (no server, no database, no network: settings are a fake and fetch is stubbed):
 *
 *   cd backend && npx ts-node --transpile-only test/maps.test.ts
 *
 * Covers the provider switch (default Mapbox, garbage means Mapbox), road distances (off by default, the estimate when the provider cannot answer, answers remembered
 * so the quote and the order agree), the map tile configuration (public keys only, OpenStreetMap fallback), the request each provider receives (search area, field masks,
 * where the key travels) and how their answers become FORKSY addresses. Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import 'reflect-metadata';
import { roadEstimate } from '../src/common/geo.util';
import { GoogleMapsService } from '../src/integrations/google-maps.service';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateMapboxDto } from '../src/integrations/integrations.controllers';
import { MAPBOX_STYLE_RE, MapboxService, normalizeMapboxStyle } from '../src/integrations/mapbox.service';
import { MapsService } from '../src/integrations/maps.service';

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// fake keys assembled from parts (so a secret scanner does not take them for real ones)
const MB_SK = ['sk', 'fakeserver12345', 'fakeserver67890'].join('.');
const MB_PK = ['pk', 'fakepublic12345', 'fakepublic67890'].join('.');
const gkey = (tag: string) => 'AIza' + (tag + '0123456789012345678901234567890123456789').slice(0, 35);
const G_SERVER = gkey('FAKEserver');
const G_BROWSER = gkey('FAKEbrowser');

const settings = (values: Record<string, any>) => ({ get: <T>(k: string, d?: T) => (k in values ? values[k] : d) as T });
const A = { lat: 43.5931, lng: -79.6413 };
const B = { lat: 43.6114, lng: -79.6296 };
const C = { lat: 43.65, lng: -79.7 };

// ---- a stubbed network ------------------------------------------------------------------------------------------------------
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let answer: (c: Call) => { status?: number; body: any } = () => ({ body: {} });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any = {}) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
  const c: Call = { url: String(url), method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(c);
  const r = answer(c);
  return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
}) as any;
let clock = Date.now();
const realNow = Date.now;
Date.now = () => clock;

const make = (values: Record<string, any>) => {
  const s = settings(values);
  const mapbox = new MapboxService(s as any);
  const google = new GoogleMapsService(s as any);
  return { maps: new MapsService(s as any, mapbox, google), mapbox, google };
};
const directions = (c: Call) => (/\/directions\/v5\//.test(c.url) ? { body: { code: 'Ok', routes: [{ distance: 4200, duration: 600 }] } } : { body: {} });

(async () => {
  // ---- the provider switch ----------------------------------------------------------------------------------------------------
  check('no setting stored: Mapbox is the provider', make({}).maps.provider() === 'mapbox');
  check('"google" selects Google', make({ 'integrations.maps.provider': 'google' }).maps.provider() === 'google');
  check('anything else stored (a typo, a number, null) means Mapbox, never an error', ['bing', 5, null, '', 'GOOGLE'].every((v) => make({ 'integrations.maps.provider': v }).maps.provider() === 'mapbox'));
  check('address search is "enabled" only when the ACTIVE provider has its server key', !make({ 'integrations.google.apiKey': G_SERVER }).maps.enabled && make({ 'integrations.mapbox.accessToken': MB_SK }).maps.enabled && make({ 'integrations.maps.provider': 'google', 'integrations.google.apiKey': G_SERVER }).maps.enabled && !make({ 'integrations.maps.provider': 'google', 'integrations.mapbox.accessToken': MB_SK }).maps.enabled);

  // ---- road distances ---------------------------------------------------------------------------------------------------------
  {
    calls = []; answer = directions;
    const { maps } = make({ 'integrations.mapbox.accessToken': MB_SK });
    const r = await maps.route(A, B);
    const est = roadEstimate(A.lat, A.lng, B.lat, B.lng);
    check('road distances OFF (the default): the built-in estimate, and the provider is never called', r.source === 'estimate' && Math.abs(r.km - est.km) < 1e-9 && r.minutes === est.minutes && calls.length === 0, { r, calls: calls.length });
  }
  {
    calls = []; answer = directions;
    const { maps } = make({ 'integrations.maps.routingEnabled': true });
    const r = await maps.route(A, B);
    check('switch on but the provider has no key: still the estimate, no call', r.source === 'estimate' && calls.length === 0);
  }
  {
    calls = []; answer = directions; clock = Date.now();
    const { maps } = make({ 'integrations.maps.routingEnabled': true, 'integrations.mapbox.accessToken': MB_SK });
    const r = await maps.route(A, B);
    check('Mapbox route: distance in km and time in minutes from the Directions answer', r.source === 'mapbox' && r.km === 4.2 && r.minutes === 10, r);
    const u = new URL(calls[0].url);
    check('...asked as longitude,latitude pairs (Mapbox order), with the server token, no steps and no live traffic profile', u.pathname === `/directions/v5/mapbox/driving/${A.lng.toFixed(6)},${A.lat.toFixed(6)};${B.lng.toFixed(6)},${B.lat.toFixed(6)}` && u.searchParams.get('access_token') === MB_SK && u.searchParams.get('steps') === 'false', calls[0].url.replace(MB_SK, '[token]'));
    await maps.route(A, B);
    check('the same trip again is answered from memory (one provider call)', calls.length === 1);
    clock += 23 * 3_600_000;
    await maps.route(A, B);
    check('...and a real route is remembered for a day', calls.length === 1);
    clock += 2 * 3_600_000;
    await maps.route(A, B);
    check('...then asked again', calls.length === 2);
    await maps.route(A, C);
    check('a different trip is a different question', calls.length === 3);
  }
  {
    calls = []; clock = Date.now();
    answer = () => ({ status: 503, body: { message: 'down' } });
    const { maps } = make({ 'integrations.maps.routingEnabled': true, 'integrations.mapbox.accessToken': MB_SK });
    const r1 = await maps.route(A, B);
    check('the provider is down: the quote still gets an answer, the estimate (never an error)', r1.source === 'estimate' && r1.km > 0 && r1.minutes >= 1, r1);
    answer = directions;
    const r2 = await maps.route(A, B);
    check('...and that fallback is remembered, so the payment and the order see the same distance even when the provider is back', r2.source === 'estimate' && r2.km === r1.km && calls.length === 1, { r2, calls: calls.length });
    clock += 11 * 60_000;
    const r3 = await maps.route(A, B);
    check('...for ten minutes, then the provider is asked again', r3.source === 'mapbox' && calls.length === 2, r3);
    answer = () => ({ status: 401, body: { message: 'Not Authorized' } });
    const r4 = await maps.route(A, C);
    check('a rejected token degrades the same way (estimate)', r4.source === 'estimate');
  }
  {
    calls = []; clock = Date.now();
    answer = (c) => (/computeRoutes/.test(c.url) ? { body: { routes: [{ distanceMeters: 5000, duration: '720s' }] } } : directions(c));
    const { maps } = make({ 'integrations.maps.routingEnabled': true, 'integrations.maps.provider': 'google', 'integrations.google.apiKey': G_SERVER, 'integrations.mapbox.accessToken': MB_SK });
    const r = await maps.route(A, B);
    check('Google route: distance and time from the Routes answer ("720s" = 12 minutes)', r.source === 'google' && r.km === 5 && r.minutes === 12, r);
    const c = calls[0];
    check('...the key travels in a header (not in the URL), with a field mask, DRIVE and no live traffic', c.headers['x-goog-api-key'] === G_SERVER && !c.url.includes(G_SERVER) && /routes\.distanceMeters/.test(c.headers['x-goog-fieldmask']) && c.body.travelMode === 'DRIVE' && c.body.routingPreference === 'TRAFFIC_UNAWARE' && c.body.origin.location.latLng.latitude === A.lat, c);
    check('...and only Google was asked (the Mapbox token was not used)', calls.every((x) => !x.url.includes('mapbox')));
  }

  // ---- map tiles ---------------------------------------------------------------------------------------------------------------
  {
    const { maps } = make({ 'integrations.mapbox.accessToken': MB_SK, 'integrations.mapbox.publicToken': MB_PK });
    const t = await maps.tiles();
    check('Mapbox tiles: Styles API raster URL with the default style, the public token and the {z}/{x}/{y}{r} placeholders', t.provider === 'mapbox' && t.url === `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/256/{z}/{x}/{y}{r}?access_token=${MB_PK}`, t.url);
    check('...never the secret token', !JSON.stringify(await maps.clientConfig()).includes(MB_SK));
  }
  {
    const t = await make({ 'integrations.mapbox.publicToken': MB_PK, 'integrations.mapbox.style': 'myteam/custom-day' }).maps.tiles();
    check('a custom style is used', /\/styles\/v1\/myteam\/custom-day\/tiles\//.test(t.url || ''), t.url);
    const bad = await make({ 'integrations.mapbox.publicToken': MB_PK, 'integrations.mapbox.style': '../../evil?x=1' }).maps.tiles();
    check('a malformed style can never end up in the URL (the default is used)', /\/styles\/v1\/mapbox\/streets-v12\//.test(bad.url || '') && !(bad.url || '').includes('evil'), bad.url);
  }
  // ---- the Map style field takes what Mapbox Studio gives out ------------------------------------------------------------------
  {
    const ID = 'exampleuser/cmz9x8y7w6v5u4t3s2r1q0p9o';
    const forms: string[] = [
      `mapbox://styles/${ID}`,
      `  mapbox://styles/${ID}\n`,
      `https://api.mapbox.com/styles/v1/${ID}?access_token=${MB_PK}`,
      `https://api.mapbox.com/styles/v1/${ID}.html?title=true&access_token=${MB_PK}`,
      `https://studio.mapbox.com/styles/${ID}/edit/#10/43.59/-79.64`,
      ID,
    ];
    check('the Style URL of Mapbox Studio, the api.mapbox.com and studio.mapbox.com addresses and user/id all become user/id', forms.every((f) => normalizeMapboxStyle(f) === ID), forms.map((f) => normalizeMapboxStyle(f)));
    check('the token of a pasted address is dropped', !forms.map((f) => normalizeMapboxStyle(f)).join('|').includes('access_token'));
    const refused: unknown[] = ['mapbox://styles/onlyone', 'http://api.mapbox.com/styles/v1/a/b', 'https://evil.example/styles/v1/a/b', 'mapbox://styles/../../x/y', 'javascript:alert(1)', 'not a style!', '../../evil?x=1', 5, null];
    check('anything else is left alone and still refused by the style pattern', refused.every((r) => typeof normalizeMapboxStyle(r) !== 'string' || !MAPBOX_STYLE_RE.test(normalizeMapboxStyle(r) as string)), refused.map((r) => normalizeMapboxStyle(r)));
    const t = await make({ 'integrations.mapbox.publicToken': MB_PK, 'integrations.mapbox.style': `mapbox://styles/${ID}` }).maps.tiles();
    check('a style stored in the Style URL form still draws the right tiles', t.url === `https://api.mapbox.com/styles/v1/${ID}/tiles/256/{z}/{x}/{y}{r}?access_token=${MB_PK}`, t.url);
    const ok = plainToInstance(UpdateMapboxDto, { style: `mapbox://styles/${ID}` });
    check('Integrations API: the Style URL passes validation and is stored as user/id', validateSync(ok).length === 0 && ok.style === ID, [ok.style, validateSync(ok).map((e) => e.constraints)]);
    check('Integrations API: an empty style still clears it, a bad one is still refused', validateSync(plainToInstance(UpdateMapboxDto, { style: '' })).length === 0 && validateSync(plainToInstance(UpdateMapboxDto, { style: 'not a style!' })).length === 1);
  }
  // ---- "Test connection" also draws one tile of the style ----------------------------------------------------------------------
  {
    const suggest = (c: Call) => (/\/search\/searchbox\/v1\/suggest/.test(c.url) ? { body: { suggestions: [{ mapbox_id: 'x', name: '1 City Centre Dr', full_address: '1 City Centre Dr, Mississauga, Ontario' }] } } : directions(c));
    const styleSettings = { 'integrations.mapbox.accessToken': MB_PK, 'integrations.mapbox.publicToken': MB_PK, 'integrations.mapbox.style': 'exampleuser/cmz9x8y7w6v5u4t3s2r1q0p9o' };
    calls = []; answer = (c) => (/\/tiles\/256\/0\/0\/0/.test(c.url) ? { body: {} } : suggest(c));
    let r: any = await make(styleSettings).mapbox.test();
    check('connection test: the style draws a tile -> map style ok', r.ok === true && r.tiles?.ok === true && r.tiles.style === styleSettings['integrations.mapbox.style'] && calls.some((c) => /\/styles\/v1\/exampleuser\/cmz9x8y7w6v5u4t3s2r1q0p9o\/tiles\/256\/0\/0\/0\?access_token=/.test(c.url)), r);
    answer = (c) => (/\/tiles\//.test(c.url) ? { status: 404, body: { message: 'Not Found' } } : suggest(c));
    r = await make(styleSettings).mapbox.test();
    check('connection test: Mapbox has no such style -> address search still ok, the style line says so', r.ok === true && r.tiles?.ok === false && /has no style/.test(r.tiles.reason), r.tiles);
    answer = (c) => (/\/tiles\//.test(c.url) ? { status: 403, body: { message: 'Forbidden' } } : suggest(c));
    r = await make(styleSettings).mapbox.test();
    check('connection test: the public token may not draw it -> the style line says which token to use', r.ok === true && r.tiles?.ok === false && /cannot draw the style/.test(r.tiles.reason), r.tiles);
    check('connection test: the token never appears in a result', !JSON.stringify(r).includes(MB_PK));
    calls = []; answer = suggest;
    r = await make({ 'integrations.mapbox.accessToken': MB_SK }).mapbox.test();
    check('connection test: no public token -> no tile request, the style line says the maps use OpenStreetMap', r.ok === true && r.tiles?.ok === false && /OpenStreetMap/.test(r.tiles.reason) && !calls.some((c) => /\/tiles\//.test(c.url)), r.tiles);
  }
  {
    check('no public token: OpenStreetMap', (await make({ 'integrations.mapbox.accessToken': MB_SK }).maps.tiles()).provider === 'osm');
    check('a secret (sk.) token in the public token field is refused: OpenStreetMap', (await make({ 'integrations.mapbox.publicToken': MB_SK }).maps.tiles()).provider === 'osm');
  }
  {
    calls = []; answer = (c) => (/createSession/.test(c.url) ? { body: { session: 'sess-abc', expiry: String(Math.floor(Date.now() / 1000) + 14 * 86400), tileWidth: 256, tileHeight: 256, imageFormat: 'png' } } : { body: {} });
    const { maps } = make({ 'integrations.maps.provider': 'google', 'integrations.google.apiKey': G_SERVER, 'integrations.google.browserKey': G_BROWSER });
    const t = await maps.tiles();
    check('Google tiles: 2D tile URL with the session and the BROWSER key', t.provider === 'google' && t.url === `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=sess-abc&key=${G_BROWSER}`, t.url);
    check('...the SERVER key made the session call and is not in the tile URL or the client config', calls.length === 1 && calls[0].url.includes(G_SERVER) && !JSON.stringify(await maps.clientConfig()).includes(G_SERVER));
    await maps.tiles();
    check('...the session is reused (one createSession call)', calls.length === 1);
    check('Google tiles without a browser key: OpenStreetMap', (await make({ 'integrations.maps.provider': 'google', 'integrations.google.apiKey': G_SERVER }).maps.tiles()).provider === 'osm');
    answer = () => ({ status: 403, body: {} });
    check('Google refusing to create a session: OpenStreetMap (the page keeps working)', (await make({ 'integrations.maps.provider': 'google', 'integrations.google.apiKey': G_SERVER, 'integrations.google.browserKey': G_BROWSER }).maps.tiles()).provider === 'osm');
  }

  // ---- address search requests and answers -----------------------------------------------------------------------------------------
  {
    calls = [];
    answer = () => ({ body: { suggestions: [{ placePrediction: { placeId: 'P1', text: { text: '1 City Centre Dr, Mississauga, ON, Canada' }, structuredFormat: { mainText: { text: '1 City Centre Dr' }, secondaryText: { text: 'Mississauga, ON, Canada' } } } }, { queryPrediction: { text: { text: 'ignored' } } }] } });
    const { google } = make({ 'integrations.google.apiKey': G_SERVER, 'integrations.mapbox.country': 'ca,us', 'integrations.mapbox.bbox': '-80.35,43.35,-78.9,44.2', 'integrations.mapbox.proximity': '-79.6441,43.589' });
    const r = await google.autocomplete('1 city centre', { sessionToken: 'sess-1234567' });
    const b = calls[0].body;
    check('Google autocomplete: only place predictions become suggestions', r.enabled && r.suggestions.length === 1 && r.suggestions[0].id === 'P1' && r.suggestions[0].line1 === '1 City Centre Dr' && r.suggestions[0].secondary === 'Mississauga, ON, Canada', r);
    check('...the search area is sent as region codes and a rectangle (bounding box = longitude first in the setting, latitude first for Google)', JSON.stringify(b.includedRegionCodes) === '["ca","us"]' && b.locationRestriction.rectangle.low.latitude === 43.35 && b.locationRestriction.rectangle.low.longitude === -80.35 && b.locationRestriction.rectangle.high.latitude === 44.2 && b.locationRestriction.rectangle.high.longitude === -78.9 && !b.locationBias, b);
    check('...the key is in a header, the session token in the body, and the URL carries no secret', calls[0].headers['x-goog-api-key'] === G_SERVER && b.sessionToken === 'sess-1234567' && !calls[0].url.includes(G_SERVER));
    calls = [];
    const g2 = make({ 'integrations.google.apiKey': G_SERVER, 'integrations.mapbox.bbox': '' }).google;
    await g2.autocomplete('dundas st', { proximity: '-79.7,43.6', sessionToken: 'sess-7654321' });
    check('without a bounding box the proximity becomes a location bias circle (Google allows one or the other)', calls[0].body.locationBias.circle.center.latitude === 43.6 && calls[0].body.locationBias.circle.center.longitude === -79.7 && !calls[0].body.locationRestriction, calls[0].body);
    answer = () => ({ status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } } });
    const bad = await make({ 'integrations.google.apiKey': G_SERVER }).google.autocomplete('anything here', { sessionToken: 'sess-0000000' });
    check('Google rejecting the key: { enabled:false } instead of an error', bad.enabled === false && (bad.suggestions || []).length === 0, bad);
  }
  {
    const { google } = make({ 'integrations.google.apiKey': G_SERVER });
    const place = google.fromPlace({ formattedAddress: '1 City Centre Dr, Mississauga, ON L5B 2G3, Canada', location: { latitude: 43.5929, longitude: -79.6414 }, addressComponents: [{ longText: '1', shortText: '1', types: ['street_number'] }, { longText: 'City Centre Dr', shortText: 'City Centre Dr', types: ['route'] }, { longText: 'Mississauga', shortText: 'Mississauga', types: ['locality'] }, { longText: 'Ontario', shortText: 'ON', types: ['administrative_area_level_1'] }, { longText: 'l5b 2g3', shortText: 'l5b 2g3', types: ['postal_code'] }] });
    check('Google place -> FORKSY address (street, city, province code, upper-case postal code, rounded position)', JSON.stringify(place) === JSON.stringify({ line1: '1 City Centre Dr', city: 'Mississauga', province: 'ON', postalCode: 'L5B 2G3', lat: 43.5929, lng: -79.6414, label: '1 City Centre Dr, Mississauga, ON L5B 2G3, Canada' }), place);
    const geo = google.fromGeocode({ formatted_address: '300 Dundas St W, Mississauga, ON, Canada', geometry: { location: { lat: 43.5851, lng: -79.6496 } }, address_components: [{ long_name: '300', short_name: '300', types: ['street_number'] }, { long_name: 'Dundas St W', short_name: 'Dundas St W', types: ['route'] }, { long_name: 'Mississauga', short_name: 'Mississauga', types: ['locality'] }, { long_name: 'Ontario', short_name: 'ON', types: ['administrative_area_level_1'] }] });
    check('Google geocode result -> FORKSY address', geo?.line1 === '300 Dundas St W' && geo.province === 'ON' && geo.city === 'Mississauga' && geo.postalCode === '', geo);
    check('an answer without a position gives no address (never a made-up one)', google.fromPlace({ formattedAddress: 'x' }) === null && google.fromGeocode({}) === null);
  }

  // ---- keys: saved wins over the environment -------------------------------------------------------------------------------------
  {
    process.env.GOOGLE_MAPS_API_KEY = gkey('FAKEfromenv');
    const env = make({}).google.config();
    const saved = make({ 'integrations.google.apiKey': G_SERVER }).google.config();
    check('a key from the environment is used when nothing is saved (source env), a saved key wins (source settings)', env.key === gkey('FAKEfromenv') && env.keySource === 'env' && saved.key === G_SERVER && saved.keySource === 'settings', { env: env.keySource, saved: saved.keySource });
    delete process.env.GOOGLE_MAPS_API_KEY;
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall maps checks passed');
  Date.now = realNow;
  globalThis.fetch = realFetch;
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e);
  process.exit(2);
});
