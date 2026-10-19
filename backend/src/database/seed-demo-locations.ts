import 'reflect-metadata';
import { AppDataSource } from './data-source';
import { seedDemoZones, seedPlatform } from '../platform/platform.seed';
import { DEMO_LOCATION_SLUGS, DEMO_STORE_ACCOUNT_DOMAIN, removeDemoLocations, seedDemoLocations } from '../restaurants/restaurants.seed';

/**
 * Puts demo restaurants, cafes and stores in every delivery zone of the site (or takes them out again): two restaurants and one store per zone in Mississauga and Brampton,
 * and in Edmonton and Winnipeg, which get three zones each (a city that is already there is used as it is). Uses the database only (no API process is started), so it is safe
 * next to a running API.
 *
 *   DEMO_STORES_PASSWORD='<at least 12 characters>' npm run seed:demo-locations     (production image: node dist/database/seed-demo-locations)
 *   npm run seed:demo-locations -- --remove
 *
 * DEMO_STORES_PASSWORD becomes the password of the owner accounts (owner30@ ... owner74@ stores.forksy.ca). It has no default on purpose: the demo password of the repository
 * is public. Docs: docs/store-types.md ("Demo data").
 */
async function main() {
  const remove = process.argv.includes('--remove');
  await AppDataSource.initialize();
  try {
    if (remove) {
      const r = await removeDemoLocations(AppDataSource);
      if (r.refused) {
        console.error(r.refused);
        process.exitCode = 1;
      } else console.log(r.removed.length ? `Removed ${r.removed.length} demo places (the cities and zones stay).` : 'The demo places are not there.');
      return;
    }
    const password = process.env.DEMO_STORES_PASSWORD ?? '';
    if (password.length < 12) throw new Error('Set DEMO_STORES_PASSWORD (at least 12 characters): it is the password of the demo owner accounts. There is no default on purpose.');
    const opts = { demo: true, demoPassword: password };
    await seedPlatform(AppDataSource, opts); // zones of Mississauga and Brampton, tiers, store cuisines (only what is missing)
    await seedDemoZones(AppDataSource); // Edmonton and Winnipeg
    await seedDemoLocations(AppDataSource, opts);
    console.log(`Demo places ready: ${DEMO_LOCATION_SLUGS.length} in 15 zones. Owner logins: owner30@${DEMO_STORE_ACCOUNT_DOMAIN} ... owner${29 + DEMO_LOCATION_SLUGS.length}@${DEMO_STORE_ACCOUNT_DOMAIN} (restaurant portal, /portal)`);
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
