/**
 * Menu details every store type can describe an item with: spice level, size (dimensions), allergens that are contained or may be present, ingredients,
 * nutrition, origin and storage. Shared by the item editor, the CSV import / export and the customer menu.
 */
export const SPICE_LEVELS = ['NONE', 'MILD', 'MEDIUM', 'HOT', 'EXTRA_HOT'] as const;
export type SpiceLevel = (typeof SPICE_LEVELS)[number];

/** Canada's priority food allergens (plus gluten and celery, which menus mention separately): the suggestions the editors offer. */
export const COMMON_ALLERGENS = ['peanuts', 'tree nuts', 'milk', 'eggs', 'fish', 'crustaceans', 'molluscs', 'wheat', 'gluten', 'soy', 'sesame', 'mustard', 'sulphites', 'celery'];
export const COMMON_DIETARY_TAGS = ['vegetarian', 'vegan', 'halal', 'kosher', 'gluten-free', 'dairy-free', 'nut-free', 'organic', 'keto', 'low-sodium'];

/** nutrition per serving; every value optional */
export const NUTRITION_FIELDS = ['fatG', 'satFatG', 'carbsG', 'sugarG', 'fibreG', 'proteinG', 'sodiumMg'] as const;
export type NutritionField = (typeof NUTRITION_FIELDS)[number];
export type Nutrition = Partial<Record<NutritionField, number>>;

/** CSV spelling of the nutrition keys: fat_g=10|sat_fat_g=3|... */
export const NUTRITION_CSV_KEYS: Record<NutritionField, string> = { fatG: 'fat_g', satFatG: 'sat_fat_g', carbsG: 'carbs_g', sugarG: 'sugar_g', fibreG: 'fibre_g', proteinG: 'protein_g', sodiumMg: 'sodium_mg' };

/** Returns a clean nutrition object (only known fields, finite numbers >= 0) or null when nothing is left. Throws a message for a bad value. */
export function cleanNutrition(v: unknown): Nutrition | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('nutrition must be an object like { "fatG": 10, "proteinG": 20 }');
  const out: Nutrition = {};
  for (const k of NUTRITION_FIELDS) {
    const raw = (v as any)[k];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new Error(`nutrition.${k} must be a number between 0 and 100000`);
    out[k] = Math.round(n * 10) / 10;
  }
  return Object.keys(out).length ? out : null;
}

/** "fat_g=10|protein_g=20" -> Nutrition (for CSV) */
export function parseNutritionCell(cell: string): Nutrition | null {
  const obj: Record<string, number> = {};
  const byCsv = Object.fromEntries(Object.entries(NUTRITION_CSV_KEYS).map(([k, c]) => [c, k]));
  for (const part of cell.split('|').map((s) => s.trim()).filter(Boolean)) {
    const [key, val] = part.split('=').map((s) => s.trim());
    const field = byCsv[(key ?? '').toLowerCase()];
    if (!field) throw new Error(`unknown nutrition key "${key}" (use ${Object.values(NUTRITION_CSV_KEYS).join(', ')})`);
    obj[field] = Number(val);
  }
  return cleanNutrition(obj);
}

export function nutritionToCell(n: Nutrition | null | undefined): string {
  if (!n) return '';
  return NUTRITION_FIELDS.filter((k) => n[k] !== undefined).map((k) => `${NUTRITION_CSV_KEYS[k]}=${n[k]}`).join('|');
}

/** lower-case, trimmed, unique, at most 30 entries of at most 40 characters */
export function cleanTags(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((s) => String(s).trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 30);
}

/** The menu details of an item as the customer sees them (the menu of a store, the item dialog). */
export function itemDetailsView(i: {
  spiceLevel?: string | null;
  lengthCm?: number | null;
  widthCm?: number | null;
  heightCm?: number | null;
  ingredients?: string | null;
  mayContain?: string[] | null;
  nutrition?: Record<string, number> | null;
  servingSize?: string | null;
  countryOfOrigin?: string | null;
  storage?: string | null;
}) {
  const dims = i.lengthCm != null || i.widthCm != null || i.heightCm != null ? { lengthCm: i.lengthCm ?? null, widthCm: i.widthCm ?? null, heightCm: i.heightCm ?? null } : null;
  return {
    spiceLevel: i.spiceLevel ?? null,
    dimensions: dims,
    ingredients: i.ingredients ?? null,
    mayContain: i.mayContain ?? [],
    nutrition: i.nutrition ?? null,
    servingSize: i.servingSize ?? null,
    countryOfOrigin: i.countryOfOrigin ?? null,
    storage: i.storage ?? null,
  };
}
