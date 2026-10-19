import { DataSource, In } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import {
  CommissionTier,
  Cuisine,
  KitchenStation,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroup,
  Merchant,
  ModifierGroup,
  ModifierOption,
  Restaurant,
  RestaurantDocument,
  RestaurantHours,
  RestaurantMember,
  User,
  Zone,
} from '../database/entities';
import { DocStatus, MenuEditStatus, RestaurantDocType, RestaurantRole, RestaurantServiceMode, RestaurantStatus, StoreType, UserStatus, UserType, VerificationMethod, VerificationStatus } from '../common/enums';
import { profileOf } from '../common/store-types';
import { SeedOptions } from '../database/seed-types';
import { slugify } from './restaurants.util';
import { EXTRA_DEFS, EXTRA_MENUS } from './restaurants.seed-extra';
import { STORE_DEFS, STORE_MENUS } from './restaurants.seed-stores';
import { LOCATION_DEFS } from './restaurants.seed-locations';

/** [name, price, description, dietary tags, allergens, tax class, catalog fields (SKU, barcode, weight, stock, age... see restaurants.seed-stores.ts)] */
export type Item = [name: string, price: number, description: string, tags?: string[], allergens?: string[], taxClass?: string, extra?: Partial<MenuItem>];
export type Cat = { name: string; station: string; items: Item[] };
export type Group = { name: string; required: boolean; min: number; max: number; options: [string, number][]; appliesTo: string[] };
export type Menu = { categories: Cat[]; groups: Group[] };

export const SIZE: Group = { name: 'Size', required: true, min: 1, max: 1, options: [['Regular', 0], ['Large', 3]], appliesTo: [] };

export const MENUS: Record<string, Menu> = {
  pizza: {
    categories: [
      { name: 'Pizzas', station: 'Oven', items: [['Margherita', 15.5, 'Tomato, mozzarella, basil', ['vegetarian'], ['gluten', 'dairy']], ['Pepperoni', 17.5, 'Double pepperoni, mozzarella', [], ['gluten', 'dairy']], ['Hawaiian', 17, 'Ham, pineapple', [], ['gluten', 'dairy']], ['Veggie Supreme', 17.5, 'Peppers, mushrooms, olives, onion', ['vegetarian'], ['gluten', 'dairy']], ['Meat Lovers', 19.5, 'Pepperoni, sausage, bacon, ham', [], ['gluten', 'dairy']]] },
      { name: 'Sides', station: 'Fryer', items: [['Garlic Bread', 6.5, 'Toasted with garlic butter', ['vegetarian'], ['gluten', 'dairy']], ['Chicken Wings (10)', 13, 'Choice of sauce', [], []], ['Caesar Salad', 9, 'Romaine, parmesan, croutons', [], ['dairy', 'gluten']]] },
      { name: 'Drinks', station: 'Drinks', items: [['Pop 355ml', 2.25, 'Coke, Sprite, Ginger Ale'], ['Sparkling Water', 2.75, '500ml'], ['Lemonade', 3.5, 'Fresh squeezed']] },
    ],
    groups: [{ ...SIZE, appliesTo: ['Pizzas'] }, { name: 'Extra Toppings', required: false, min: 0, max: 4, options: [['Extra Cheese', 2], ['Mushrooms', 1.5], ['Pepperoni', 2], ['Olives', 1.5], ['Jalapenos', 1]], appliesTo: ['Pizzas'] }, { name: 'Wing Sauce', required: true, min: 1, max: 1, options: [['BBQ', 0], ['Hot', 0], ['Honey Garlic', 0]], appliesTo: ['Sides:Chicken Wings (10)'] }],
  },
  burgers: {
    categories: [
      { name: 'Burgers', station: 'Grill', items: [['Classic Cheeseburger', 12.5, 'Beef patty, cheddar, pickles', [], ['gluten', 'dairy']], ['Bacon Double', 16, 'Two patties, bacon, cheddar', [], ['gluten', 'dairy']], ['Crispy Chicken', 13.5, 'Buttermilk fried chicken, slaw', [], ['gluten', 'egg']], ['Plant Burger', 14, 'Plant patty, lettuce, tomato', ['vegan'], ['gluten']], ['Mushroom Swiss', 14.5, 'Sauteed mushrooms, swiss', [], ['gluten', 'dairy']]] },
      { name: 'Sides', station: 'Fryer', items: [['Fries', 4.5, 'Skin-on', ['vegan']], ['Onion Rings', 5.5, 'Beer battered', ['vegetarian'], ['gluten']], ['Poutine', 8.5, 'Fries, cheese curds, gravy', [], ['dairy', 'gluten']]] },
      { name: 'Shakes', station: 'Drinks', items: [['Vanilla Shake', 6, 'Hand spun', ['vegetarian'], ['dairy']], ['Chocolate Shake', 6, 'Hand spun', ['vegetarian'], ['dairy']], ['Pop 355ml', 2.25, '']] },
    ],
    groups: [{ name: 'Make it a Combo', required: false, min: 0, max: 1, options: [['Fries + Pop', 5.5], ['Poutine + Pop', 8]], appliesTo: ['Burgers'] }, { name: 'Extras', required: false, min: 0, max: 3, options: [['Bacon', 2], ['Extra Patty', 4], ['Avocado', 2], ['Fried Egg', 1.5]], appliesTo: ['Burgers'] }],
  },
  asian: {
    categories: [
      { name: 'Rolls', station: 'Cold', items: [['California Roll', 8, 'Crab, avocado, cucumber', [], ['fish', 'sesame']], ['Spicy Tuna Roll', 10, 'Tuna, spicy mayo', [], ['fish', 'egg']], ['Salmon Avocado Roll', 10.5, 'Salmon, avocado', [], ['fish']], ['Veggie Roll', 7, 'Cucumber, avocado, carrot', ['vegan']], ['Dragon Roll', 15, 'Eel, avocado, tobiko', [], ['fish', 'shellfish']]] },
      { name: 'Hot Dishes', station: 'Wok', items: [['Chicken Teriyaki Bowl', 15, 'Rice, vegetables', [], ['soy', 'sesame']], ['Beef Udon', 16, 'Thick noodles, beef broth', [], ['gluten', 'soy']], ['Vegetable Tempura', 11, 'Seasonal vegetables', ['vegetarian'], ['gluten']], ['Gyoza (6)', 7.5, 'Pork dumplings', [], ['gluten', 'soy']]] },
      { name: 'Drinks', station: 'Drinks', items: [['Green Tea', 2.5, 'Hot or iced', ['vegan']], ['Ramune', 3.5, 'Japanese soda']] },
    ],
    groups: [{ name: 'Spice Level', required: false, min: 0, max: 1, options: [['Mild', 0], ['Medium', 0], ['Hot', 0]], appliesTo: ['Hot Dishes'] }, { name: 'Add-ons', required: false, min: 0, max: 3, options: [['Extra Rice', 2], ['Miso Soup', 3], ['Edamame', 4]], appliesTo: ['Hot Dishes'] }],
  },
  indian: {
    categories: [
      { name: 'Mains', station: 'Curry', items: [['Butter Chicken', 16.5, 'Creamy tomato sauce', [], ['dairy', 'nuts']], ['Lamb Rogan Josh', 19, 'Slow-cooked lamb', [], []], ['Palak Paneer', 15, 'Spinach and cheese', ['vegetarian'], ['dairy']], ['Chana Masala', 13.5, 'Spiced chickpeas', ['vegan'], []], ['Chicken Biryani', 16, 'Basmati rice, spices', [], []]] },
      { name: 'Breads & Sides', station: 'Tandoor', items: [['Garlic Naan', 3.5, 'Fresh from the tandoor', ['vegetarian'], ['gluten', 'dairy']], ['Plain Naan', 3, '', ['vegetarian'], ['gluten', 'dairy']], ['Samosa (2)', 5.5, 'Potato and peas', ['vegan'], ['gluten']], ['Basmati Rice', 4, '', ['vegan']]] },
      { name: 'Drinks', station: 'Drinks', items: [['Mango Lassi', 4.5, 'Yogurt drink', ['vegetarian'], ['dairy']], ['Masala Chai', 3.5, '', ['vegetarian'], ['dairy']]] },
    ],
    groups: [{ name: 'Spice Level', required: true, min: 1, max: 1, options: [['Mild', 0], ['Medium', 0], ['Hot', 0], ['Extra Hot', 0]], appliesTo: ['Mains'] }, { name: 'Add Bread', required: false, min: 0, max: 2, options: [['Garlic Naan', 3.5], ['Roti', 2.5]], appliesTo: ['Mains'] }],
  },
  mexican: {
    categories: [
      { name: 'Tacos & Burritos', station: 'Grill', items: [['Carne Asada Tacos (3)', 13, 'Corn tortillas, onion, cilantro', [], []], ['Al Pastor Tacos (3)', 12.5, 'Pork, pineapple', [], []], ['Chicken Burrito', 13.5, 'Rice, beans, cheese', [], ['gluten', 'dairy']], ['Veggie Burrito', 12, 'Black beans, peppers', ['vegetarian'], ['gluten', 'dairy']], ['Quesadilla', 11, 'Cheese and peppers', ['vegetarian'], ['gluten', 'dairy']]] },
      { name: 'Sides', station: 'Cold', items: [['Chips & Guacamole', 7, 'House made', ['vegan']], ['Elote', 5, 'Street corn', ['vegetarian'], ['dairy']], ['Rice & Beans', 4.5, '', ['vegan']]] },
      { name: 'Drinks', station: 'Drinks', items: [['Horchata', 4, '', ['vegetarian'], ['dairy']], ['Jarritos', 3.25, 'Assorted flavours']] },
    ],
    groups: [{ name: 'Protein', required: true, min: 1, max: 1, options: [['Chicken', 0], ['Beef', 1.5], ['Pork', 1], ['Veggie', 0]], appliesTo: ['Tacos & Burritos'] }, { name: 'Toppings', required: false, min: 0, max: 4, options: [['Guacamole', 2], ['Sour Cream', 1], ['Jalapenos', 0.5], ['Pico de Gallo', 1]], appliesTo: ['Tacos & Burritos'] }],
  },
  cafe: {
    categories: [
      { name: 'Breakfast', station: 'Grill', items: [['Egg & Bacon Sandwich', 9, 'Toasted brioche', [], ['egg', 'gluten', 'dairy']], ['Avocado Toast', 10.5, 'Sourdough, chili flakes', ['vegan'], ['gluten']], ['Pancake Stack', 11, 'Maple syrup, butter', ['vegetarian'], ['gluten', 'dairy', 'egg']], ['Breakfast Wrap', 9.5, 'Eggs, cheese, peppers', ['vegetarian'], ['egg', 'gluten', 'dairy']]] },
      { name: 'Lunch', station: 'Cold', items: [['Turkey Club', 12.5, 'Bacon, lettuce, tomato', [], ['gluten', 'egg']], ['Caprese Panini', 11.5, 'Mozzarella, tomato, pesto', ['vegetarian'], ['gluten', 'dairy', 'nuts']], ['Harvest Salad', 12, 'Greens, squash, feta', ['vegetarian'], ['dairy']]] },
      { name: 'Coffee & Drinks', station: 'Drinks', items: [['Latte', 4.75, '', ['vegetarian'], ['dairy']], ['Cappuccino', 4.5, '', ['vegetarian'], ['dairy']], ['Americano', 3.5, '', ['vegan']], ['Iced Tea', 3.5, '', ['vegan']], ['Fresh Orange Juice', 5, '', ['vegan']]] },
      { name: 'Bakery', station: 'Cold', items: [['Butter Croissant', 3.75, '', ['vegetarian'], ['gluten', 'dairy']], ['Blueberry Muffin', 3.5, '', ['vegetarian'], ['gluten', 'dairy', 'egg']], ['Chocolate Chip Cookie', 2.75, '', ['vegetarian'], ['gluten', 'dairy', 'egg']]] },
    ],
    groups: [{ name: 'Milk', required: false, min: 0, max: 1, options: [['Oat', 0.75], ['Almond', 0.75], ['Soy', 0.5]], appliesTo: ['Coffee & Drinks'] }, { ...SIZE, options: [['Small', 0], ['Medium', 0.75], ['Large', 1.5]], appliesTo: ['Coffee & Drinks'] }],
  },
};

export type Def = {
  name: string; merchant: number; cuisines: string[]; menu: string; zone: string; dLat: number; dLng: number; street: string; price: number; tier: string; prep: number;
  /** extras only */
  city?: string; postal?: string; hours?: 'std' | 'late' | 'conv' | 'allday'; mode?: RestaurantServiceMode; featured?: boolean; minOrder?: number;
  /** default: CONVENIENCE for a "Convenience" cuisine, RESTAURANT otherwise */
  storeType?: StoreType;
  /** default 'ON' / '416' (the places of the Mississauga and Brampton demo) */
  province?: string; areaCode?: string;
  /** default: the last two of the base restaurants are new */
  isNew?: boolean;
};

/** seedDefs options for a set of places that is not the first demo: `indexBase` keeps phones, tablet codes and ratings apart from the other sets, `ownerOnly` creates the owner account only. */
type DefsOptions = { indexBase?: number; ownerOnly?: boolean };

/** merchant 1 owns two locations (City Centre + Port Credit); every other merchant has one. */
export const DEFS: Def[] = [
  { name: 'Napoli Wood Fired Pizza - City Centre', merchant: 1, cuisines: ['Pizza', 'Italian'], menu: 'pizza', zone: 'City Centre', dLat: 0.002, dLng: 0.001, street: '100 City Centre Dr', price: 2, tier: 'Standard', prep: 20 },
  { name: 'Napoli Wood Fired Pizza - Port Credit', merchant: 1, cuisines: ['Pizza', 'Italian'], menu: 'pizza', zone: 'Port Credit', dLat: 0.001, dLng: 0.002, street: '45 Lakeshore Rd E', price: 2, tier: 'Standard', prep: 20 },
  { name: 'Burger Barn', merchant: 2, cuisines: ['Burgers'], menu: 'burgers', zone: 'City Centre', dLat: -0.004, dLng: 0.003, street: '3 Robert Speck Pkwy', price: 2, tier: 'Premium', prep: 15 },
  { name: 'Sakura Sushi House', merchant: 3, cuisines: ['Sushi', 'Japanese'], menu: 'asian', zone: 'Erin Mills', dLat: 0.003, dLng: 0.002, street: '5100 Erin Mills Pkwy', price: 3, tier: 'Standard', prep: 25 },
  { name: 'Spice Route Indian Kitchen', merchant: 4, cuisines: ['Indian', 'Halal'], menu: 'indian', zone: 'Meadowvale', dLat: 0.001, dLng: -0.003, street: '6677 Meadowvale Town Centre Cir', price: 2, tier: 'Standard', prep: 25 },
  { name: 'Casa Taco', merchant: 5, cuisines: ['Mexican'], menu: 'mexican', zone: 'Streetsville', dLat: 0.002, dLng: -0.001, street: '282 Queen St S', price: 1, tier: 'Starter', prep: 15 },
  { name: 'Lakeside Cafe', merchant: 6, storeType: StoreType.CAFE, cuisines: ['Breakfast', 'Sandwiches'], menu: 'cafe', zone: 'Port Credit', dLat: -0.003, dLng: -0.002, street: '28 Stavebank Rd', price: 2, tier: 'Standard', prep: 12 },
  { name: 'Golden Wok', merchant: 7, cuisines: ['Chinese'], menu: 'asian', zone: 'City Centre', dLat: 0.005, dLng: -0.004, street: '50 Burnhamthorpe Rd W', price: 2, tier: 'Standard', prep: 20 },
  { name: 'Thai Orchid', merchant: 8, cuisines: ['Thai'], menu: 'asian', zone: 'Erin Mills', dLat: -0.004, dLng: -0.003, street: '2225 Erin Centre Blvd', price: 2, tier: 'Premium', prep: 22 },
  { name: 'Tandoori Nights', merchant: 9, cuisines: ['Indian'], menu: 'indian', zone: 'Streetsville', dLat: -0.003, dLng: 0.002, street: '318 Queen St S', price: 2, tier: 'Standard', prep: 25 },
  { name: 'Slice Republic', merchant: 10, cuisines: ['Pizza'], menu: 'pizza', zone: 'Meadowvale', dLat: -0.002, dLng: 0.002, street: '6765 Financial Dr', price: 1, tier: 'Starter', prep: 18 },
  { name: 'Grill House 905', merchant: 11, cuisines: ['Burgers', 'BBQ'], menu: 'burgers', zone: 'Port Credit', dLat: 0.004, dLng: 0.001, street: '70 Port St E', price: 3, tier: 'Premium', prep: 20 },
  { name: 'The Daily Grind Cafe', merchant: 12, storeType: StoreType.CAFE, cuisines: ['Breakfast', 'Coffee & Tea'], menu: 'cafe', zone: 'City Centre', dLat: -0.001, dLng: -0.005, street: '1 Square One Dr', price: 1, tier: 'Starter', prep: 10 },
];

const POSTAL = ['L5B 1M2', 'L5G 1A1', 'L5M 2B7', 'L5N 7T4', 'L5L 3R9', 'L5R 3K1'];

/** Idempotent: natural keys are restaurant slug, merchant businessName, user email. Demo data only when opts.demo. */
export async function seedRestaurants(ds: DataSource, opts: SeedOptions): Promise<void> {
  if (!opts.demo) return;
  await seedDefs(ds, opts, DEFS, MENUS, false);
}

/** Additional Brampton + Mississauga restaurants/convenience stores (merchants 13+). Runs after the orders seed so historical orders stay unchanged. */
export async function seedRestaurantsExtra(ds: DataSource, opts: SeedOptions): Promise<void> {
  if (!opts.demo) return;
  await seedDefs(ds, opts, [...DEFS, ...EXTRA_DEFS, ...STORE_DEFS], { ...MENUS, ...EXTRA_MENUS, ...STORE_MENUS }, true);
}

/** the demo accounts of `npm run seed` end in this; the production start-up check refuses a database that has any (docs/deployment.md) */
const DEMO_ACCOUNT_DOMAIN = 'demo-restaurant.ca';

async function seedDefs(ds: DataSource, opts: SeedOptions, defs: Def[], menus: Record<string, Menu>, extraOnly: boolean, domain: string = DEMO_ACCOUNT_DOMAIN, more: DefsOptions = {}): Promise<void> {
  const merchants = ds.getRepository(Merchant);
  const restaurants = ds.getRepository(Restaurant);
  const users = ds.getRepository(User);
  const members = ds.getRepository(RestaurantMember);
  const hash = await bcrypt.hash(opts.demoPassword, 10);

  const zones = new Map((await ds.getRepository(Zone).find()).map((z) => [z.name, z]));
  const tiers = new Map((await ds.getRepository(CommissionTier).find()).map((t) => [t.name, t]));
  const cuisines = new Map((await ds.getRepository(Cuisine).find()).map((c) => [c.name, c]));

  const ensureUser = async (email: string, first: string, last: string, phone: string) => {
    let u = await users.findOne({ where: { email } });
    if (!u) u = await users.save(users.create({ type: UserType.RESTAURANT, status: UserStatus.ACTIVE, email, phone, firstName: first, lastName: last, emailVerified: true, phoneVerified: true, passwordHash: hash }));
    return u;
  };
  const ensureMember = async (userId: string, merchantId: string, role: RestaurantRole, restaurantId: string | null) => {
    if (await members.findOne({ where: { userId, merchantId, role, restaurantId: restaurantId ?? (null as any) } })) return;
    await members.save(members.create({ userId, merchantId, role, restaurantId, active: true }));
  };

  const merchantRows = new Map<number, Merchant>();
  let created = 0;
  for (const [i, d] of defs.entries()) {
    if (extraOnly && i < DEFS.length) continue; // base restaurants were handled by seedRestaurants
    const n = (more.indexBase ?? 0) + i;
    const area = d.areaCode ?? '416';
    const brand = d.merchant === 1 ? 'Napoli Wood Fired Pizza Inc.' : `${d.name} Ltd.`;
    let merchant = merchantRows.get(d.merchant) ?? (await merchants.findOne({ where: { businessName: brand } }));
    if (!merchant) {
      merchant = await merchants.save(
        merchants.create({
          businessName: brand,
          legalName: brand,
          hstNumber: `8${String(10000000 + d.merchant * 1111).slice(0, 8)}RT0001`,
          contactEmail: `owner${d.merchant}@${domain}`,
          contactPhone: `+1${area}555${String(1000 + d.merchant).padStart(4, '0')}`,
          bank: { institution: '004', transit: '12345', accountLast4: '6789', holder: brand, verified: true },
          agreementSignedAt: new Date(Date.now() - 90 * 86400_000),
          agreementSignedBy: `Owner ${d.merchant}`,
          // demo businesses are live, so they went through the manual process (same as the migration's backfill)
          verificationStatus: VerificationStatus.VERIFIED,
          verificationMethod: VerificationMethod.MANUAL,
          verifiedAt: new Date(Date.now() - 60 * 86400_000),
        }),
      );
    }
    merchantRows.set(d.merchant, merchant);

    // ---- people (one owner per merchant; manager/cashier/kitchen at the merchant's first location) ----
    const m = d.merchant;
    const owner = await ensureUser(`owner${m}@${domain}`, 'Olivia', `Owner${m}`, `+1416555${String(2000 + m).padStart(4, '0')}`);
    await ensureMember(owner.id, merchant.id, RestaurantRole.OWNER, null);

    const slug = slugify(d.name);
    let r = await restaurants.findOne({ where: { slug } });
    const storeType = d.storeType ?? (d.cuisines.includes('Convenience') ? StoreType.CONVENIENCE : d.cuisines.includes('Bakery') && !d.cuisines.includes('Pizza') ? StoreType.BAKERY : StoreType.RESTAURANT);
    if (r && r.storeType !== storeType) {
      // a location seeded before store types existed: give it its type (idempotent)
      await restaurants.update(r.id, { storeType });
      r.storeType = storeType;
    }
    if (!r) {
      const zone = zones.get(d.zone) ?? null;
      r = await restaurants.save(
        restaurants.create({
          merchantId: merchant.id,
          name: d.name,
          slug,
          storeType,
          kdsEnabled: profileOf(storeType).kdsDefault,
          description: profileOf(storeType).retail ? `${d.name} - ${profileOf(storeType).label.toLowerCase()} in ${d.city ?? 'Mississauga'}. Picked fresh for you and delivered.` : `${d.name} - fresh, made to order in ${d.city ?? 'Mississauga'}.`,
          phone: `+1${area}555${String(3000 + n).padStart(4, '0')}`,
          email: `orders+${slug}@${domain}`,
          addressLine1: d.street,
          city: d.city ?? 'Mississauga',
          province: d.province ?? 'ON',
          postalCode: d.postal ?? POSTAL[n % POSTAL.length],
          lat: zone ? +(zone.centerLat + d.dLat).toFixed(6) : 43.589 + d.dLat,
          lng: zone ? +(zone.centerLng + d.dLng).toFixed(6) : -79.6441 + d.dLng,
          zoneId: zone?.id ?? null,
          cityId: zone?.cityId ?? null,
          cuisines: d.cuisines.map((c) => cuisines.get(c)).filter(Boolean) as Cuisine[],
          priceLevel: d.price,
          status: RestaurantStatus.LIVE,
          wentLiveAt: new Date(Date.now() - 60 * 86400_000),
          acceptingOrders: true,
          commissionTierId: tiers.get(d.tier)?.id ?? null,
          prepTimeMin: d.prep,
          pickupPrepTimeMin: Math.max(8, d.prep - 5),
          deliveryRadiusKm: 6,
          minimumOrder: d.minOrder ?? 10,
          tabletActivated: true,
          tabletCode: String(100000 + n * 7919).slice(0, 6),
          rating: +(4.1 + ((n * 7) % 9) / 10).toFixed(2),
          ratingCount: 0,
          isFeatured: d.featured ?? n < 3,
          isNew: d.isNew ?? (extraOnly ? i >= DEFS.length + 4 : i >= DEFS.length - 2),
          menuEditStatus: MenuEditStatus.ALLOWED,
          ...(d.mode ? { serviceMode: d.mode } : {}),
        }),
      );
      created++;

      await seedHours(ds, r.id, d.hours ?? 'std');
      const menu = menus[d.menu];
      const sellsAgeRestricted = menu.categories.some((c) => c.items.some((it) => (it[6]?.minAge ?? 0) > 0));
      await seedDocuments(ds, r.id, [...profileOf(storeType).requiredDocuments, ...(sellsAgeRestricted ? ['LIQUOR_LICENCE'] : [])] as RestaurantDocType[]);
      await seedMenu(ds, r.id, menu);
    }

    if (more.ownerOnly) continue;
    // first location of each merchant gets the staff roles; merchant 1's second location gets its own manager
    const firstOfMerchant = defs.findIndex((x) => x.merchant === d.merchant) === i;
    const suffix = firstOfMerchant ? '' : 'b';
    const manager = await ensureUser(`manager${m}${suffix}@${domain}`, 'Marco', `Manager${m}${suffix}`, `+1416555${String(4000 + m * 2 + (firstOfMerchant ? 0 : 1)).padStart(4, '0')}`);
    await ensureMember(manager.id, merchant.id, RestaurantRole.LOCATION_MANAGER, r.id);
    if (firstOfMerchant) {
      const cashier = await ensureUser(`cashier${m}@${domain}`, 'Casey', `Cashier${m}`, `+1416555${String(5000 + m).padStart(4, '0')}`);
      await ensureMember(cashier.id, merchant.id, RestaurantRole.CASHIER, r.id);
      const kitchen = await ensureUser(`kitchen${m}@${domain}`, 'Kim', `Kitchen${m}`, `+1416555${String(6000 + m).padStart(4, '0')}`);
      await ensureMember(kitchen.id, merchant.id, RestaurantRole.KITCHEN, r.id);
    }
  }
  console.log(`  + ${created} demo restaurants (${defs.length} total defined)`);
}

async function seedHours(ds: DataSource, restaurantId: string, kind: 'std' | 'late' | 'conv' | 'allday' = 'std') {
  const rows: Partial<RestaurantHours>[] = [];
  for (let day = 0; day < 7; day++) {
    const [openTime, closeTime] =
      kind === 'allday' ? ['00:00', '00:00'] : kind === 'conv' ? ['06:00', day === 5 || day === 6 ? '02:00' : '00:00'] : kind === 'late' ? ['11:00', day === 5 || day === 6 ? '01:00' : '23:00'] : [day === 0 ? '11:00' : '10:30', day === 5 || day === 6 ? '23:00' : '22:00'];
    rows.push({ restaurantId, dayOfWeek: day, openTime, closeTime, closed: false });
  }
  await ds.getRepository(RestaurantHours).insert(rows);
}

async function seedDocuments(ds: DataSource, restaurantId: string, types: RestaurantDocType[] = [RestaurantDocType.BUSINESS_LICENCE, RestaurantDocType.HEALTH_CERTIFICATE, RestaurantDocType.VOID_CHEQUE]) {
  const expires = new Date(Date.now() + 300 * 86400_000).toISOString().slice(0, 10);
  await ds.getRepository(RestaurantDocument).insert(
    types.map((type) => ({ restaurantId, type, fileUrl: `/uploads/demo/${type.toLowerCase()}.pdf`, fileName: `${type.toLowerCase()}.pdf`, status: DocStatus.APPROVED, expiresAt: type === RestaurantDocType.VOID_CHEQUE ? null : expires, reviewedAt: new Date() })),
  );
}

async function seedMenu(ds: DataSource, restaurantId: string, menu: Menu) {
  const stationNames = [...new Set(menu.categories.map((c) => c.station).filter(Boolean))]; // retail departments have no kitchen station
  const stations = await ds.getRepository(KitchenStation).save(stationNames.map((name, i) => ({ restaurantId, name, sortOrder: i })));
  const stationId = (n: string) => stations.find((s) => s.name === n)?.id ?? null;

  const groupRepo = ds.getRepository(ModifierGroup);
  const optRepo = ds.getRepository(ModifierOption);
  const groupIds = new Map<string, string>();
  for (const [gi, g] of menu.groups.entries()) {
    const row = await groupRepo.save(groupRepo.create({ restaurantId, name: g.name, required: g.required, minSelect: g.min, maxSelect: g.max, sortOrder: gi }));
    groupIds.set(g.name, row.id);
    await optRepo.insert(g.options.map(([name, priceDelta], oi) => ({ groupId: row.id, name, priceDelta, isDefault: g.required && oi === 0, sortOrder: oi })));
  }

  const catRepo = ds.getRepository(MenuCategory);
  const itemRepo = ds.getRepository(MenuItem);
  const linkRepo = ds.getRepository(MenuItemModifierGroup);
  for (const [ci, c] of menu.categories.entries()) {
    const cat = await catRepo.save(catRepo.create({ restaurantId, name: c.name, sortOrder: ci }));
    for (const [ii, [name, price, description, tags, allergens, taxClass, extra]] of c.items.entries()) {
      const item = await itemRepo.save(
        itemRepo.create({
          restaurantId,
          categoryId: cat.id,
          name,
          description: description || null,
          price,
          pickupPrice: c.station === 'Drinks' || !c.station ? null : +(price * 0.95).toFixed(2), // shelf prices are the same for pickup
          taxClassCode: taxClass ?? 'HST_ON',
          dietaryTags: tags ?? [],
          allergens: allergens ?? [],
          sortOrder: ii,
          stationId: stationId(c.station),
          isPopular: ii === 0,
          calories: 200 + ((ci * 37 + ii * 53) % 600),
          ...(extra ?? {}),
        }),
      );
      const linked = menu.groups.filter((g) => g.appliesTo.includes(c.name) || g.appliesTo.includes(`${c.name}:${name}`));
      if (linked.length) await linkRepo.insert(linked.map((g, li) => ({ menuItemId: item.id, groupId: groupIds.get(g.name)!, sortOrder: li })));
    }
  }
}

// ------------------------------------------------------------------ the three demo stores (for a live site that has no restaurants yet)
/** Fresh Basket Supermarket, Seoul Asian Market and Prime Cut Halal Butcher: a grocery with ~40 products in 10 departments (weighed, chilled, age-restricted), an Asian grocery and a halal butcher. */
export const DEMO_STORE_SLUGS: string[] = STORE_DEFS.map((d) => slugify(d.name));
/**
 * The accounts of the demo stores end in this, NOT in the demo domain of `npm run seed`: a production API refuses to start while any @demo-restaurant.ca account exists, and these
 * accounts have a password of the owner's choosing, so they are not what that check protects against.
 */
export const DEMO_STORE_ACCOUNT_DOMAIN = 'stores.forksy.ca';
/** also the demo domain: stores seeded by an earlier version of this command used it */
const DEMO_STORE_EMAILS: string[] = STORE_DEFS.flatMap((d) => ['owner', 'manager', 'cashier', 'kitchen'].flatMap((role) => [DEMO_STORE_ACCOUNT_DOMAIN, DEMO_ACCOUNT_DOMAIN].map((dom) => `${role}${d.merchant}@${dom}`)));

/**
 * Only the three demo stores, with their merchants, owner and staff accounts (all with `opts.demoPassword`). No customers, drivers or orders.
 * Idempotent: a store that exists is left as it is. Run `seedPlatform` first (zones, the "Grocery & retail" commission tier, cuisines).
 */
export async function seedDemoStores(ds: DataSource, opts: SeedOptions): Promise<void> {
  await seedDefs(ds, { ...opts, demo: true }, STORE_DEFS, STORE_MENUS, false, DEMO_STORE_ACCOUNT_DOMAIN);
}

/** Tables that carry a store's own rows (by restaurantId) and may simply go with it. Orders, ledger entries, reviews and tickets are real activity: they stop a removal. */
const STORE_OWN_TABLES = ['assistant_kb_drafts', 'assistant_kb_requests', 'assistant_sessions', 'carts', 'favorites', 'kitchen_stations', 'promotions', 'restaurant_closures', 'restaurant_documents', 'restaurant_hours', 'restaurant_integrations', 'restaurant_members'];
const STORE_ACTIVITY_TABLES: [string, string][] = [['orders', 'order'], ['ledger_entries', 'ledger entry'], ['reviews', 'review'], ['tickets', 'support ticket']];

/**
 * Takes the demo stores out again: the stores with their menus, hours and documents, the merchants, and the owner and staff accounts.
 * Refused (nothing changes) when an order, ledger entry, review or support ticket exists for one of them: suspend those stores in the Admin Console instead.
 */
export async function removeDemoStores(ds: DataSource): Promise<{ removed: string[]; refused?: string }> {
  return removePlaces(ds, DEMO_STORE_SLUGS, DEMO_STORE_EMAILS, 'demo stores');
}

async function removePlaces(ds: DataSource, slugs: string[], emails: string[], what: string): Promise<{ removed: string[]; refused?: string }> {
  const stores = await ds.getRepository(Restaurant).find({ where: { slug: In(slugs) } });
  if (!stores.length) return { removed: [] };
  const ids = stores.map((s) => s.id);
  for (const [table, activity] of STORE_ACTIVITY_TABLES) {
    const [{ n }] = await ds.query(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE "restaurantId" = ANY($1)`, [ids]);
    if (n > 0) return { removed: [], refused: `${n} ${activity}(s) exist for the ${what}. Suspend the places in the Admin Console instead of removing them.` };
  }
  const merchantIds = [...new Set(stores.map((s) => s.merchantId))];
  await ds.transaction(async (m) => {
    await m.query(`DELETE FROM menu_item_modifier_groups WHERE "menuItemId" IN (SELECT id FROM menu_items WHERE "restaurantId" = ANY($1))`, [ids]);
    await m.query(`DELETE FROM menu_items WHERE "restaurantId" = ANY($1)`, [ids]);
    await m.query(`DELETE FROM menu_categories WHERE "restaurantId" = ANY($1)`, [ids]);
    await m.query(`DELETE FROM modifier_groups WHERE "restaurantId" = ANY($1)`, [ids]); // its options go with it
    for (const table of STORE_OWN_TABLES) await m.query(`DELETE FROM "${table}" WHERE "restaurantId" = ANY($1)`, [ids]);
    await m.query(`DELETE FROM restaurants WHERE id = ANY($1)`, [ids]);
    await m.query(`DELETE FROM restaurant_members WHERE "merchantId" = ANY($1)`, [merchantIds]);
    await m.query(`DELETE FROM merchants WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM restaurants r WHERE r."merchantId" = merchants.id)`, [merchantIds]);
    await m.query(`DELETE FROM users WHERE email = ANY($1) AND type = 'RESTAURANT'`, [emails]);
  });
  return { removed: stores.map((s) => s.name) };
}

// ------------------------------------------------------------------ demo places for every delivery zone
/** Two restaurants and one store in each zone of Mississauga, Brampton, Edmonton and Winnipeg (45 places, merchants 30-74, owner accounts only). */
export const DEMO_LOCATION_SLUGS: string[] = LOCATION_DEFS.map((d) => slugify(d.name));
const DEMO_LOCATION_EMAILS: string[] = LOCATION_DEFS.map((d) => `owner${d.merchant}@${DEMO_STORE_ACCOUNT_DOMAIN}`);

/**
 * Restaurants, cafes and stores in every zone (docs/store-types.md, "Demo data"), each with its own merchant and an owner account (`owner30@` ... `owner74@` on the demo store
 * domain, password `opts.demoPassword`). Idempotent: a place that exists is left as it is. Run `seedPlatform` and `seedDemoZones` first (zones, tiers, cuisines).
 */
export async function seedDemoLocations(ds: DataSource, opts: SeedOptions): Promise<void> {
  await seedDefs(ds, { ...opts, demo: true }, LOCATION_DEFS, { ...MENUS, ...EXTRA_MENUS, ...STORE_MENUS }, false, DEMO_STORE_ACCOUNT_DOMAIN, { indexBase: 100, ownerOnly: true });
}

/** Takes those places out again, like `removeDemoStores`. The cities and zones stay (they are cheap, and may carry settings: remove them in the Admin Console, "Zones"). */
export async function removeDemoLocations(ds: DataSource): Promise<{ removed: string[]; refused?: string }> {
  return removePlaces(ds, DEMO_LOCATION_SLUGS, DEMO_LOCATION_EMAILS, 'demo places');
}
