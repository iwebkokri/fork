import { DataSource } from 'typeorm';
import { City, CommissionTier, Cuisine, TaxClass, Zone } from '../database/entities';
import { SeedOptions } from '../database/seed-types';
import { slugify } from './catalog';

/** [lat, lng] rectangle around a centre point (real Mississauga neighbourhoods, approximate footprints). */
function box(lat: number, lng: number, dLat = 0.035, dLng = 0.045): [number, number][] {
  return [
    [+(lat - dLat).toFixed(6), +(lng - dLng).toFixed(6)],
    [+(lat - dLat).toFixed(6), +(lng + dLng).toFixed(6)],
    [+(lat + dLat).toFixed(6), +(lng + dLng).toFixed(6)],
    [+(lat + dLat).toFixed(6), +(lng - dLng).toFixed(6)],
  ];
}

const CITIES: Partial<City>[] = [
  { name: 'Mississauga', province: 'ON', country: 'Canada', timezone: 'America/Toronto', currency: 'CAD', active: true, centerLat: 43.589, centerLng: -79.6441 },
  { name: 'Toronto', province: 'ON', country: 'Canada', timezone: 'America/Toronto', currency: 'CAD', active: false, centerLat: 43.6532, centerLng: -79.3832 },
  { name: 'Brampton', province: 'ON', country: 'Canada', timezone: 'America/Toronto', currency: 'CAD', active: true, centerLat: 43.7315, centerLng: -79.7624 },
  { name: 'Vaughan', province: 'ON', country: 'Canada', timezone: 'America/Toronto', currency: 'CAD', active: false, centerLat: 43.8361, centerLng: -79.5085 },
];

/** Real Mississauga neighbourhoods used as demo delivery zones. */
export const ZONES: { name: string; lat: number; lng: number; targetDrivers: number }[] = [
  { name: 'City Centre', lat: 43.5905, lng: -79.6438, targetDrivers: 40 },
  { name: 'Port Credit', lat: 43.5606, lng: -79.5877, targetDrivers: 20 },
  { name: 'Streetsville', lat: 43.5779, lng: -79.7156, targetDrivers: 15 },
  { name: 'Erin Mills', lat: 43.5567, lng: -79.7132, targetDrivers: 20 },
  { name: 'Meadowvale', lat: 43.5947, lng: -79.7482, targetDrivers: 15 },
];

/** Brampton delivery zones (same generous box footprint as the Mississauga ones). */
export const BRAMPTON_ZONES: { name: string; lat: number; lng: number; targetDrivers: number }[] = [
  { name: 'Downtown Brampton', lat: 43.6875, lng: -79.76, targetDrivers: 25 },
  { name: 'Bramalea', lat: 43.716, lng: -79.723, targetDrivers: 25 },
  { name: 'Springdale', lat: 43.76, lng: -79.708, targetDrivers: 15 },
  { name: 'Heart Lake', lat: 43.75, lng: -79.82, targetDrivers: 15 },
];

/**
 * Edmonton and Winnipeg for the demo places of every location (`seed:demo-locations`): three zones each. A city that exists is used as it is (a site that added them in the
 * Admin Console keeps its own fees and hours); a missing one is created like Brampton, with the pricing of Mississauga. Not part of `seedPlatform`: a site that does not serve
 * these cities should not get them.
 */
export const DEMO_ZONES: { city: string; province: string; timezone: string; centerLat: number; centerLng: number; zones: { name: string; lat: number; lng: number; targetDrivers: number }[] }[] = [
  {
    city: 'Edmonton',
    province: 'AB',
    timezone: 'America/Edmonton',
    centerLat: 53.5461,
    centerLng: -113.4938,
    zones: [
      { name: 'Downtown Edmonton', lat: 53.5444, lng: -113.4909, targetDrivers: 20 },
      { name: 'West Edmonton', lat: 53.5225, lng: -113.6242, targetDrivers: 15 },
      { name: 'Millwoods', lat: 53.463, lng: -113.42, targetDrivers: 10 },
    ],
  },
  {
    city: 'Winnipeg',
    province: 'MB',
    timezone: 'America/Winnipeg',
    centerLat: 49.8954,
    centerLng: -97.1385,
    zones: [
      { name: 'Downtown Winnipeg', lat: 49.8951, lng: -97.1384, targetDrivers: 20 },
      { name: 'Fort Garry', lat: 49.811, lng: -97.15, targetDrivers: 10 },
      { name: 'Transcona', lat: 49.887, lng: -96.966, targetDrivers: 10 },
    ],
  },
];

/** Idempotent: finds the cities by name and the zones by city + name, creates what is missing. Returns the names of the zones it created. */
export async function seedDemoZones(ds: DataSource): Promise<string[]> {
  const cityRepo = ds.getRepository(City);
  const zoneRepo = ds.getRepository(Zone);
  const made: string[] = [];
  for (const spec of DEMO_ZONES) {
    let city = await cityRepo.findOne({ where: { name: spec.city } });
    if (!city) {
      const base = await cityRepo.findOne({ where: { name: 'Mississauga' } });
      const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = (base ?? {}) as any;
      const data: Partial<City> = { ...rest, name: spec.city, province: spec.province, country: 'Canada', timezone: spec.timezone, currency: 'CAD', active: true, centerLat: spec.centerLat, centerLng: spec.centerLng };
      city = await cityRepo.save(cityRepo.create(data));
      console.log(`  + city ${spec.city}`);
    } else if (!city.active) console.log(`  ! ${spec.city} is switched off: its demo places only show once the city is active`);
    for (const z of spec.zones) {
      if (await zoneRepo.findOne({ where: { cityId: city.id, name: z.name } })) continue;
      await zoneRepo.save(zoneRepo.create({ cityId: city.id, name: z.name, active: true, polygon: box(z.lat, z.lng), centerLat: z.lat, centerLng: z.lng, targetDrivers: z.targetDrivers, serviceHours: {} }));
      made.push(z.name);
      console.log(`  + zone ${z.name} (${spec.city})`);
    }
  }
  return made;
}

const TAX_CLASSES: Partial<TaxClass>[] = [
  { code: 'HST_ON', name: 'Ontario HST', ratePct: 13, active: true, isDefault: true },
  { code: 'ZERO_RATED', name: 'Zero-rated (basic groceries)', ratePct: 0, active: true, isDefault: false },
];

const TIERS: Partial<CommissionTier>[] = [
  { name: 'Standard', description: 'Default commission tier for new restaurants.', deliveryPct: 20, pickupPct: 8, ownDriverPct: 12, active: true, isDefault: true },
  { name: 'Premium', description: 'Reduced rates for high-volume / strategic partners.', deliveryPct: 18, pickupPct: 6, ownDriverPct: 10, active: true, isDefault: false },
  { name: 'Starter', description: 'Introductory tier for restaurants in their first months.', deliveryPct: 25, pickupPct: 10, ownDriverPct: 14, active: true, isDefault: false },
  { name: 'Grocery & retail', description: 'Thinner rates for grocery, convenience and specialty food stores (baskets are large, margins are small). Used by every retail store without a tier of its own.', deliveryPct: 12, pickupPct: 4, ownDriverPct: 6, active: true, isDefault: false, defaultForStoreTypes: ['GROCERY', 'CONVENIENCE', 'SPECIALTY'] },
];

/** 20+ cuisines, slugs stable so downstream seeds (restaurants) can look them up. */
export const CUISINES = [
  'Pizza', 'Burgers', 'Sushi', 'Chinese', 'Indian', 'Thai', 'Italian', 'Mexican', 'Mediterranean', 'Greek',
  'Vietnamese', 'Korean', 'Japanese', 'Caribbean', 'Middle Eastern', 'BBQ', 'Vegan', 'Breakfast', 'Sandwiches',
  'Desserts', 'Coffee & Tea', 'Seafood', 'Halal', 'Wings', 'Salads', 'Bubble Tea',
  'Convenience', 'Pakistani', 'Portuguese', 'Lebanese', 'Bakery', 'Punjabi',
  // grocery and specialty food stores (store types GROCERY / CONVENIENCE / SPECIALTY, docs/store-types.md)
  'Grocery', 'Supermarket', 'Asian Grocery', 'Halal Grocery', 'Indian Grocery', 'Butcher', 'Fish Market', 'Produce', 'Deli', 'Health Food', 'Organic',
];

/** Idempotent: find by natural key, insert if missing. Foundational (city/tax/tier/cuisine/zone) data always seeds, regardless of opts.demo. */
export async function seedPlatform(ds: DataSource, _opts: SeedOptions): Promise<void> {
  const cityRepo = ds.getRepository(City);
  const zoneRepo = ds.getRepository(Zone);
  const taxRepo = ds.getRepository(TaxClass);
  const tierRepo = ds.getRepository(CommissionTier);
  const cuisineRepo = ds.getRepository(Cuisine);

  // ---- cities ----
  const cityByName = new Map<string, City>();
  for (const c of CITIES) {
    let row = await cityRepo.findOne({ where: { name: c.name } });
    if (!row) {
      let data: Partial<City> = c;
      if (c.name === 'Brampton') {
        // copy pricing / driver-pay / dispatch / timer columns from Mississauga
        const base = await cityRepo.findOne({ where: { name: 'Mississauga' } });
        if (base) {
          const { id: _i, createdAt: _c, updatedAt: _u, ...rest } = base as any;
          data = { ...rest, ...c };
        }
      }
      row = await cityRepo.save(cityRepo.create(data));
      console.log(`  + city ${c.name}`);
    }
    cityByName.set(c.name!, row);
  }
  const mississauga = cityByName.get('Mississauga')!;

  const brampton = cityByName.get('Brampton')!;

  // ---- zones (Mississauga + Brampton) ----
  const allZones = [...ZONES.map((z) => ({ ...z, city: mississauga })), ...BRAMPTON_ZONES.map((z) => ({ ...z, city: brampton }))];
  for (const z of allZones) {
    const existing = await zoneRepo.findOne({ where: { cityId: z.city.id, name: z.name } });
    if (existing) {
      const wanted = box(z.lat, z.lng);
      if (JSON.stringify(existing.polygon) !== JSON.stringify(wanted)) {
        await zoneRepo.update(existing.id, { polygon: wanted } as any);
        console.log(`  ~ zone ${z.name} polygon widened`);
      }
      continue;
    }
    await zoneRepo.save(
      zoneRepo.create({
        cityId: z.city.id,
        name: z.name,
        active: true,
        polygon: box(z.lat, z.lng),
        centerLat: z.lat,
        centerLng: z.lng,
        targetDrivers: z.targetDrivers,
        serviceHours: {},
      }),
    );
    console.log(`  + zone ${z.name} (${z.city.name})`);
  }

  // ---- tax classes ----
  for (const t of TAX_CLASSES) {
    const existing = await taxRepo.findOne({ where: { code: t.code } });
    if (existing) continue;
    await taxRepo.save(taxRepo.create(t));
    console.log(`  + tax class ${t.code}`);
  }

  // ---- commission tiers ----
  for (const t of TIERS) {
    const existing = await tierRepo.findOne({ where: { name: t.name } });
    if (existing) continue;
    await tierRepo.save(tierRepo.create(t));
    console.log(`  + commission tier ${t.name}`);
  }

  // ---- cuisines ----
  let sortOrder = 1;
  for (const name of CUISINES) {
    const slug = slugify(name);
    const existing = await cuisineRepo.findOne({ where: { slug } });
    if (!existing) {
      await cuisineRepo.save(cuisineRepo.create({ name, slug, sortOrder, active: true }));
      console.log(`  + cuisine ${name}`);
    }
    sortOrder++;
  }

  // Ops checklist templates (SOP-03) and default settings (orders.newOrdersPaused, taxes.defaultTaxClass, ...)
  // are foundational SETTING_DEFINITIONS entries (src/settings/settings.service.ts) inserted automatically by
  // SettingsService.onModuleInit() on every app boot (including this seed run), so no action needed here.
}
