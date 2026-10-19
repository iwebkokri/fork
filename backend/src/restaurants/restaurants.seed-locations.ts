import type { Def } from './restaurants.seed';
import { StoreType } from '../common/enums';

/**
 * Demo places for every delivery zone (merchants 30+): two restaurants (one of them a cafe in some zones) and one store in each of the nine Mississauga and Brampton zones and
 * in the three zones that the demo adds to each of Edmonton and Winnipeg (`seedDemoZones` in platform.seed.ts). The names are made up. The menus are the templates of the other demo places, so
 * a pizzeria in Edmonton has the same menu as the one in Brampton.
 */

type Kind = 'R' | 'S';
/** [kind, name, menu template, cuisines, street, price level, storeType?, hours?] */
type Place = [Kind, string, string, string[], string, number, StoreType?, Def['hours']?];

interface ZonePlaces {
  zone: string;
  city: string;
  province: string;
  areaCode: string;
  /** first three characters of the postal codes of the zone */
  fsa: string[];
  places: [Place, Place, Place];
}

const ZONES: ZonePlaces[] = [
  // ---- Mississauga ----
  {
    zone: 'City Centre', city: 'Mississauga', province: 'ON', areaCode: '905', fsa: ['L5B', 'L5R'],
    places: [
      ['R', 'Mandarin Garden Kitchen', 'asian', ['Chinese'], '80 Burnhamthorpe Rd W', 2],
      ['R', 'The Brunch Spot', 'cafe', ['Breakfast', 'Sandwiches'], '15 Elm Dr W', 2, StoreType.CAFE],
      ['S', 'Rolling Pin Bakehouse', 'bakery', ['Bakery', 'Desserts'], '77 Webb Dr', 2, StoreType.BAKERY],
    ],
  },
  {
    zone: 'Port Credit', city: 'Mississauga', province: 'ON', areaCode: '905', fsa: ['L5G', 'L5H'],
    places: [
      ['R', 'Port Street Pizzeria', 'pizza', ['Pizza', 'Italian'], '31 Port St E', 2, undefined, 'late'],
      ['R', 'Mehfil Pakistani Grill', 'pakistani', ['Pakistani', 'Halal'], '88 Lakeshore Rd E', 2],
      ['S', 'Harbour Fresh Foods', 'supermarket', ['Grocery', 'Supermarket'], '14 Hurontario St', 2, StoreType.GROCERY, 'conv'],
    ],
  },
  {
    zone: 'Streetsville', city: 'Mississauga', province: 'ON', areaCode: '905', fsa: ['L5M'],
    places: [
      ['R', 'Streetsville Smash Burgers', 'burgers', ['Burgers'], '255 Queen St S', 2, undefined, 'late'],
      ['R', 'Bombay Bites', 'indian', ['Indian'], '25 Thomas St', 2],
      ['S', 'Streetsville Express Convenience', 'convenience', ['Convenience'], '300 Queen St S', 1, StoreType.CONVENIENCE, 'conv'],
    ],
  },
  {
    zone: 'Erin Mills', city: 'Mississauga', province: 'ON', areaCode: '905', fsa: ['L5L', 'L5M'],
    places: [
      ['R', 'Dragon Pearl Kitchen', 'asian', ['Chinese'], '3100 Erin Centre Blvd', 2],
      ['R', 'Taqueria Los Amigos', 'mexican', ['Mexican'], '5090 Glen Erin Dr', 1],
      ['S', 'Erin Mills Asian Mart', 'asianmarket', ['Asian Grocery', 'Grocery'], '2400 Eglinton Ave W', 1, StoreType.GROCERY],
    ],
  },
  {
    zone: 'Meadowvale', city: 'Mississauga', province: 'ON', areaCode: '905', fsa: ['L5N', 'L5W'],
    places: [
      ['R', 'Island Spice Kitchen', 'caribbean', ['Caribbean'], '6750 Winston Churchill Blvd', 2],
      ['R', 'Wood & Crust Pizzeria', 'pizza', ['Pizza', 'Italian'], '6845 Mavis Rd', 2, undefined, 'late'],
      ['S', 'Meadowvale Halal Meats', 'butcher', ['Butcher', 'Halal'], '6700 Financial Dr', 2, StoreType.SPECIALTY],
    ],
  },
  // ---- Brampton ----
  {
    zone: 'Downtown Brampton', city: 'Brampton', province: 'ON', areaCode: '905', fsa: ['L6V', 'L6X', 'L6Y'],
    places: [
      ['R', 'Main Street Cafe', 'cafe', ['Coffee & Tea', 'Breakfast'], '30 George St N', 1, StoreType.CAFE],
      ['R', 'Kabab Factory', 'pakistani', ['Pakistani', 'Halal'], '12 Queen St E', 2],
      ['S', 'Queen Street Fresh Foods', 'supermarket', ['Grocery', 'Supermarket'], '55 Main St S', 2, StoreType.GROCERY, 'conv'],
    ],
  },
  {
    zone: 'Bramalea', city: 'Brampton', province: 'ON', areaCode: '905', fsa: ['L6T', 'L6S'],
    places: [
      ['R', 'Chaat Corner', 'indian', ['Indian'], '100 Clark Blvd', 1],
      ['R', 'Bramalea Burger Co.', 'burgers', ['Burgers'], '8 Kennedy Rd S', 2, undefined, 'late'],
      ['S', 'Bramalea Sweets & Bakery', 'bakery', ['Bakery', 'Desserts'], '2 Orenda Rd', 1, StoreType.BAKERY],
    ],
  },
  {
    zone: 'Springdale', city: 'Brampton', province: 'ON', areaCode: '905', fsa: ['L6R', 'L6P', 'L7A'],
    places: [
      ['R', 'Springdale Taqueria', 'mexican', ['Mexican'], '10 Sandalwood Pkwy E', 1],
      ['R', 'Saffron & Spice', 'indian', ['Indian', 'Halal'], '90 Father Tobin Rd', 2],
      ['S', 'Al-Noor Halal Meats', 'butcher', ['Butcher', 'Halal'], '9800 McLaughlin Rd N', 2, StoreType.SPECIALTY],
    ],
  },
  {
    zone: 'Heart Lake', city: 'Brampton', province: 'ON', areaCode: '905', fsa: ['L6Z', 'L7A'],
    places: [
      ['R', 'Lakeview Lebanese Grill', 'lebanese', ['Lebanese', 'Middle Eastern', 'Halal'], '25 Heart Lake Rd', 2],
      ['R', 'Heart Lake Ramen & Rolls', 'asian', ['Japanese', 'Sushi'], '120 Sandalwood Pkwy W', 2],
      ['S', 'Heart Lake Market', 'supermarket', ['Grocery', 'Supermarket'], '68 Great Lakes Dr', 2, StoreType.GROCERY, 'conv'],
    ],
  },
  // ---- Edmonton ----
  {
    zone: 'Downtown Edmonton', city: 'Edmonton', province: 'AB', areaCode: '780', fsa: ['T5J', 'T5K'],
    places: [
      ['R', 'River Valley Burger Bar', 'burgers', ['Burgers', 'BBQ'], '10150 101 St NW', 2, undefined, 'late'],
      ['R', 'Oasis Lebanese Kitchen', 'lebanese', ['Lebanese', 'Middle Eastern', 'Halal'], '10020 104 Ave NW', 2],
      ['S', 'Capital City Grocers', 'supermarket', ['Grocery', 'Supermarket'], '10110 100A St NW', 2, StoreType.GROCERY, 'conv'],
    ],
  },
  {
    zone: 'West Edmonton', city: 'Edmonton', province: 'AB', areaCode: '780', fsa: ['T5T', 'T5S'],
    places: [
      ['R', 'Northern Lights Pizza', 'pizza', ['Pizza', 'Italian'], '8700 170 St NW', 2, undefined, 'late'],
      ['R', 'Bangkok Street Kitchen', 'asian', ['Thai'], '17010 90 Ave NW', 2],
      ['S', 'Pacific Pearl Asian Market', 'asianmarket', ['Asian Grocery', 'Grocery'], '9930 178 St NW', 1, StoreType.GROCERY],
    ],
  },
  {
    zone: 'Millwoods', city: 'Edmonton', province: 'AB', areaCode: '780', fsa: ['T6L', 'T6K'],
    places: [
      ['R', 'Prairie Punjab Dhaba', 'punjabi', ['Punjabi', 'Indian'], '7210 28 Ave NW', 2],
      ['R', 'Sunrise Cafe', 'cafe', ['Breakfast', 'Coffee & Tea'], '2331 66 St NW', 1, StoreType.CAFE],
      ['S', 'Prairie Halal Meats', 'butcher', ['Butcher', 'Halal'], '5920 34 Ave NW', 2, StoreType.SPECIALTY],
    ],
  },
  // ---- Winnipeg ----
  {
    zone: 'Downtown Winnipeg', city: 'Winnipeg', province: 'MB', areaCode: '204', fsa: ['R3B', 'R3C'],
    places: [
      ['R', 'Portage Pizza Co.', 'pizza', ['Pizza', 'Italian'], '300 Portage Ave', 2, undefined, 'late'],
      ['R', 'Prairie Bowl Noodle House', 'asian', ['Chinese'], '110 Princess St', 2],
      ['S', 'Exchange District Grocers', 'supermarket', ['Grocery', 'Supermarket'], '185 Bannatyne Ave', 2, StoreType.GROCERY, 'conv'],
    ],
  },
  {
    zone: 'Fort Garry', city: 'Winnipeg', province: 'MB', areaCode: '204', fsa: ['R3T', 'R3R'],
    places: [
      ['R', 'Fort Garry Taco Shop', 'mexican', ['Mexican'], '1800 Pembina Hwy', 1],
      ['R', 'Tandoor Palace', 'indian', ['Indian', 'Halal'], '2390 Pembina Hwy', 2],
      ['S', 'Fort Garry Corner Store', 'convenience', ['Convenience'], '1335 Grant Ave', 1, StoreType.CONVENIENCE, 'conv'],
    ],
  },
  {
    zone: 'Transcona', city: 'Winnipeg', province: 'MB', areaCode: '204', fsa: ['R2C', 'R2J'],
    places: [
      ['R', 'Boulevard Burger House', 'burgers', ['Burgers'], '1500 Regent Ave W', 2, undefined, 'late'],
      ['R', 'Golden Spoon Cafe', 'cafe', ['Breakfast', 'Sandwiches'], '965 Day St', 1, StoreType.CAFE],
      ['S', 'Transcona Bread & Pastry', 'bakery', ['Bakery', 'Desserts'], '1 Transcona Blvd', 1, StoreType.BAKERY],
    ],
  },
];

/** where the three places of a zone sit around its centre (degrees) */
const SLOTS: [number, number][] = [[0.004, 0.003], [-0.003, 0.004], [0.002, -0.004]];
const LETTERS = 'ABCEGHJKLMNPRSTVWXYZ';
/** one featured restaurant per city */
const FEATURED = ['Mandarin Garden Kitchen', 'Main Street Cafe', 'River Valley Burger Bar', 'Portage Pizza Co.'];
const FIRST_MERCHANT = 30;

const TIERS = ['Standard', 'Premium', 'Starter'];

export const LOCATION_DEFS: Def[] = ZONES.flatMap((z, zi) =>
  z.places.map(([kind, name, menu, cuisines, street, price, storeType, hours], pi): Def => {
    const k = zi * 3 + pi;
    const retail = kind === 'S';
    return {
      name,
      merchant: FIRST_MERCHANT + k,
      cuisines,
      menu,
      zone: z.zone,
      dLat: SLOTS[pi][0],
      dLng: SLOTS[pi][1],
      street,
      postal: `${z.fsa[pi % z.fsa.length]} ${1 + (k % 9)}${LETTERS[(k * 7) % LETTERS.length]}${1 + ((k * 3) % 9)}`,
      price,
      tier: retail ? 'Grocery & retail' : TIERS[k % TIERS.length],
      prep: retail ? (menu === 'supermarket' ? 30 : menu === 'bakery' ? 10 : menu === 'convenience' ? 8 : 20) : price === 1 ? 15 : 22,
      city: z.city,
      province: z.province,
      areaCode: z.areaCode,
      hours: hours ?? 'std',
      storeType,
      featured: FEATURED.includes(name),
      isNew: false,
      ...(retail ? { minOrder: menu === 'convenience' ? 8 : 15 } : {}),
    };
  }),
);
