/**
 * Unit tests for the demo places of every delivery zone (no server, no database): the table in restaurants.seed-locations.ts must be consistent with the rest of the seed data,
 * because a mistake there only shows when the command runs against a live site: a name that is already taken (the place is silently skipped), a menu or cuisine that does not
 * exist, a zone that does not exist (the place gets no location), an account on the domain that stops a production API from starting. Docs: docs/store-types.md ("Demo data").
 *
 *   cd backend && npx ts-node --transpile-only test/demo-locations.test.ts
 *
 * Prints PASS / FAIL per check and exits 1 on any FAIL.
 */
import 'reflect-metadata';
import { StoreType } from '../src/common/enums';
import { BRAMPTON_ZONES, CUISINES, DEMO_ZONES, ZONES } from '../src/platform/platform.seed';
import { DEFS, DEMO_LOCATION_SLUGS, DEMO_STORE_ACCOUNT_DOMAIN, MENUS } from '../src/restaurants/restaurants.seed';
import { EXTRA_DEFS, EXTRA_MENUS } from '../src/restaurants/restaurants.seed-extra';
import { LOCATION_DEFS } from '../src/restaurants/restaurants.seed-locations';
import { STORE_DEFS, STORE_MENUS } from '../src/restaurants/restaurants.seed-stores';
import { slugify } from '../src/restaurants/restaurants.util';

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};
const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);

const others = [...DEFS, ...EXTRA_DEFS, ...STORE_DEFS];
const menus = { ...MENUS, ...EXTRA_MENUS, ...STORE_MENUS };
const knownZones: Record<string, string> = {};
for (const z of ZONES) knownZones[z.name] = 'Mississauga';
for (const z of BRAMPTON_ZONES) knownZones[z.name] = 'Brampton';
for (const c of DEMO_ZONES) for (const z of c.zones) knownZones[z.name] = c.city;
const STORE_KINDS = [StoreType.BAKERY, StoreType.GROCERY, StoreType.CONVENIENCE, StoreType.SPECIALTY];
const isStore = (d: { storeType?: StoreType }) => !!d.storeType && STORE_KINDS.includes(d.storeType);
const PROVINCE: Record<string, string> = { Mississauga: 'ON', Brampton: 'ON', Edmonton: 'AB', Winnipeg: 'MB' };

check('45 places: two restaurants or cafes and one store in each of the 15 zones', LOCATION_DEFS.length === 45 && Object.keys(knownZones).length === 15, LOCATION_DEFS.length);
check('every zone has exactly 3 new places, 2 of them restaurants or cafes and 1 a store', Object.keys(knownZones).every((zone) => {
  const here = LOCATION_DEFS.filter((d) => d.zone === zone);
  return here.length === 3 && here.filter(isStore).length === 1;
}), Object.keys(knownZones).filter((z) => LOCATION_DEFS.filter((d) => d.zone === z).length !== 3));
check('every place is in a zone the platform seed or the demo zones create', LOCATION_DEFS.every((d) => knownZones[d.zone]), LOCATION_DEFS.filter((d) => !knownZones[d.zone]).map((d) => d.zone));
check('the city of a place is the city of its zone, and the province is the one of that city', LOCATION_DEFS.every((d) => d.city === knownZones[d.zone] && d.province === PROVINCE[d.city ?? '']), LOCATION_DEFS.filter((d) => d.city !== knownZones[d.zone] || d.province !== PROVINCE[d.city ?? '']).map((d) => d.name));
check('names make unique slugs, also against every other demo place (a taken slug would silently skip the place)', dupes([...LOCATION_DEFS, ...others].map((d) => slugify(d.name))).length === 0, dupes([...LOCATION_DEFS, ...others].map((d) => slugify(d.name))));
check('slug list of the remove command is the list of the places', DEMO_LOCATION_SLUGS.length === 45 && DEMO_LOCATION_SLUGS.every((s, i) => s === slugify(LOCATION_DEFS[i].name)));
check('every place has its own merchant, numbered 30 to 74, none shared with another demo place', new Set(LOCATION_DEFS.map((d) => d.merchant)).size === 45 && LOCATION_DEFS.every((d) => d.merchant >= 30 && d.merchant <= 74) && !others.some((o) => LOCATION_DEFS.some((d) => d.merchant === o.merchant)), LOCATION_DEFS.map((d) => d.merchant));
check('every menu template exists', LOCATION_DEFS.every((d) => menus[d.menu]), LOCATION_DEFS.filter((d) => !menus[d.menu]).map((d) => d.menu));
check('every cuisine exists in the platform seed (a missing one is dropped without a word)', LOCATION_DEFS.every((d) => d.cuisines.every((c) => CUISINES.includes(c))), LOCATION_DEFS.flatMap((d) => d.cuisines).filter((c) => !CUISINES.includes(c)));
check('every commission tier exists; stores are on "Grocery & retail", restaurants and cafes are not', LOCATION_DEFS.every((d) => ['Standard', 'Premium', 'Starter', 'Grocery & retail'].includes(d.tier) && (d.tier === 'Grocery & retail') === isStore(d)), LOCATION_DEFS.map((d) => `${d.name}:${d.tier}`));
check('a store has its store type set, a restaurant is a RESTAURANT or a CAFE (never guessed from the cuisine)', LOCATION_DEFS.every((d) => (isStore(d) ? STORE_KINDS.includes(d.storeType!) : !d.storeType || d.storeType === StoreType.RESTAURANT || d.storeType === StoreType.CAFE)), LOCATION_DEFS.map((d) => `${d.name}:${d.storeType}`));
check('a store sells from a store menu, a restaurant from a restaurant menu', LOCATION_DEFS.every((d) => ['supermarket', 'asianmarket', 'butcher', 'bakery', 'convenience', 'variety'].includes(d.menu) === isStore(d)), LOCATION_DEFS.map((d) => `${d.name}:${d.menu}`));
check('postal codes look Canadian and match the province (L = Ontario, T = Alberta, R = Manitoba)', LOCATION_DEFS.every((d) => /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] \d[ABCEGHJ-NPRSTV-Z]\d$/.test(d.postal ?? '') && d.postal![0] === { ON: 'L', AB: 'T', MB: 'R' }[d.province ?? '']), LOCATION_DEFS.map((d) => d.postal));
check('places sit inside their zone box (no more than 0.01 degrees from its centre)', LOCATION_DEFS.every((d) => Math.abs(d.dLat) <= 0.01 && Math.abs(d.dLng) <= 0.01));
check('no place is marked new (the home page shows a New row from them)', LOCATION_DEFS.every((d) => d.isNew === false));
check('demo owner accounts never match the production start-up check (a live API would refuse to restart)', LOCATION_DEFS.every((d) => !/@demo\.forky\.ca$|@demo-restaurant\.ca$/i.test(`owner${d.merchant}@${DEMO_STORE_ACCOUNT_DOMAIN}`)), DEMO_STORE_ACCOUNT_DOMAIN);
check('the new zones of Edmonton and Winnipeg do not overlap each other (boxes of 0.035 x 0.045 degrees)', DEMO_ZONES.every((c) => c.zones.every((a, i) => c.zones.every((b, j) => i === j || Math.abs(a.lat - b.lat) >= 0.07 || Math.abs(a.lng - b.lng) >= 0.09))));
check('the demo cities have their own time zone and province', DEMO_ZONES.every((c) => c.timezone.startsWith('America/') && c.province === PROVINCE[c.city]) && DEMO_ZONES.find((c) => c.city === 'Winnipeg')?.timezone === 'America/Winnipeg' && DEMO_ZONES.find((c) => c.city === 'Edmonton')?.timezone === 'America/Edmonton');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
