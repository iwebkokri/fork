import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { In, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import {
  KitchenStation,
  MenuCategory,
  MenuItem,
  MenuItemModifierGroup,
  ModifierGroup,
  ModifierOption,
  Restaurant,
  RestaurantDocument,
  TaxClass,
} from '../database/entities';
import { DayPart, DocStatus, RestaurantDocType } from '../common/enums';
import { cleanGallery, cleanImageUrl } from '../common/image-url';
import { MIN_AGES } from '../common/store-types';
import { cleanNutrition, cleanTags, nutritionToCell, parseNutritionCell, SPICE_LEVELS } from '../common/menu-details';
import { clampPaging, like, pageMeta } from '../common/pagination';
import { SettingsService } from '../settings/settings.service';
import { CategoryDto, CatalogFieldsDto, ItemDto, ModifierGroupDto, ModifierOptionDto, StockUpdateRowDto } from './dto';
import { nextRestockTime } from './restaurants.util';
import { AvailabilityService } from '../core/core.module';
import { NotificationsService } from '../notifications/notifications.service';

const DAYPARTS = Object.values(DayPart) as string[];

/** minimal RFC4180 CSV parser / writer */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export { csvCell } from '../common/csv';
import { csvCell } from '../common/csv';
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export const MENU_CSV_HEADER = [
  'category',
  'name',
  'description',
  'price',
  'pickup_price',
  'tax_class',
  'calories',
  'allergens',
  'dietary_tags',
  'dayparts',
  'prep_time_min',
  'station',
  'available',
  'image_url',
  'popular',
  'modifier_groups',
  // catalog (groceries / retail); optional in an import: a CSV without these columns leaves them untouched
  'sku',
  'barcode',
  'brand',
  'pack_size',
  'sell_by',
  'weight_unit',
  'step_size',
  'track_stock',
  'stock_qty',
  'low_stock',
  'max_per_order',
  'min_age',
  'temperature',
  // menu details (any store type); optional in an import, an empty cell leaves the value untouched
  'spice_level',
  'length_cm',
  'width_cm',
  'height_cm',
  'ingredients',
  'may_contain',
  'serving_size',
  'nutrition',
  'country_of_origin',
  'storage',
];

@Injectable()
export class MenuService {
  constructor(
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(MenuCategory) private categories: Repository<MenuCategory>,
    @InjectRepository(MenuItem) private items: Repository<MenuItem>,
    @InjectRepository(ModifierGroup) private groups: Repository<ModifierGroup>,
    @InjectRepository(ModifierOption) private options: Repository<ModifierOption>,
    @InjectRepository(MenuItemModifierGroup) private links: Repository<MenuItemModifierGroup>,
    @InjectRepository(KitchenStation) private stations: Repository<KitchenStation>,
    @InjectRepository(TaxClass) private taxClasses: Repository<TaxClass>,
    @InjectRepository(RestaurantDocument) private docs: Repository<RestaurantDocument>,
    private availability: AvailabilityService,
    private notifications: NotificationsService,
    private settings: SettingsService,
  ) {}

  // ------------------------------------------------------------------ read
  async tree(restaurantId: string, includeInactive = true) {
    const [cats, items, groups, links, stations] = await Promise.all([
      this.categories.find({ where: { restaurantId }, order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.items.find({ where: { restaurantId }, order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.groups.find({ where: { restaurantId }, order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.links.find({ where: { menuItemId: In((await this.items.find({ where: { restaurantId }, select: ['id'] })).map((i) => i.id).concat(['00000000-0000-0000-0000-000000000000'])) } }),
      this.stations.find({ where: { restaurantId }, order: { sortOrder: 'ASC' } }),
    ]);
    const opts = groups.length ? await this.options.find({ where: { groupId: In(groups.map((g) => g.id)) }, order: { sortOrder: 'ASC', name: 'ASC' } }) : [];
    const groupView = groups.map((g) => ({ ...g, options: opts.filter((o) => o.groupId === g.id) }));
    const byId = new Map(groupView.map((g) => [g.id, g]));
    const stationById = new Map(stations.map((s) => [s.id, s]));
    const itemView = (i: MenuItem) => ({
      ...i,
      stationName: i.stationId ? stationById.get(i.stationId)?.name ?? null : null,
      modifierGroups: links
        .filter((l) => l.menuItemId === i.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((l) => byId.get(l.groupId))
        .filter(Boolean),
    });
    const visible = includeInactive ? items : items.filter((i) => i.active);
    const views = visible.map(itemView);
    return {
      categories: cats.map((c) => ({ ...c, items: views.filter((i) => i.categoryId === c.id) })),
      uncategorized: views.filter((i) => !i.categoryId || !cats.some((c) => c.id === i.categoryId)),
      combos: views.filter((i) => i.isCombo),
      modifierGroups: groupView,
      stations,
      counts: {
        items: items.length,
        unavailable: items.filter((i) => !i.available).length,
        outOfStock: items.filter((i) => i.trackStock && (i.stockQty ?? 0) <= 0).length,
        lowStock: items.filter((i) => i.trackStock && (i.stockQty ?? 0) > 0 && i.lowStockThreshold != null && (i.stockQty ?? 0) <= i.lowStockThreshold).length,
        categories: cats.length,
        modifierGroups: groups.length,
      },
    };
  }

  /**
   * The structure of the menu without its items: departments with their product counts, modifier groups, stations and counts. A store with a big catalog loads its
   * products page by page (listItems) and only needs this.
   */
  async structure(restaurantId: string) {
    const [cats, groups, stations, perCat, totals] = await Promise.all([
      this.categories.find({ where: { restaurantId }, order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.groups.find({ where: { restaurantId }, order: { sortOrder: 'ASC', name: 'ASC' } }),
      this.stations.find({ where: { restaurantId }, order: { sortOrder: 'ASC' } }),
      this.items.createQueryBuilder('i').select('i.categoryId', 'id').addSelect('COUNT(*)', 'n').where('i.restaurantId = :restaurantId', { restaurantId }).groupBy('i.categoryId').getRawMany<{ id: string | null; n: string }>(),
      this.items
        .createQueryBuilder('i')
        .select('COUNT(*)', 'items')
        .addSelect('COUNT(*) FILTER (WHERE i.available = false)', 'unavailable')
        .addSelect(`COUNT(*) FILTER (WHERE i."trackStock" = true AND COALESCE(i."stockQty", 0) <= 0)`, 'outOfStock')
        .addSelect(`COUNT(*) FILTER (WHERE i."trackStock" = true AND COALESCE(i."stockQty", 0) > 0 AND i."lowStockThreshold" IS NOT NULL AND i."stockQty" <= i."lowStockThreshold")`, 'lowStock')
        .where('i.restaurantId = :restaurantId', { restaurantId })
        .getRawOne<Record<string, string>>(),
    ]);
    const opts = groups.length ? await this.options.find({ where: { groupId: In(groups.map((g) => g.id)) }, order: { sortOrder: 'ASC', name: 'ASC' } }) : [];
    const n = new Map(perCat.map((r) => [r.id, +r.n]));
    return {
      categories: cats.map((c) => ({ ...c, itemCount: n.get(c.id) ?? 0, items: [] as any[] })),
      uncategorized: [] as any[],
      uncategorizedCount: n.get(null) ?? 0,
      combos: [] as any[],
      modifierGroups: groups.map((g) => ({ ...g, options: opts.filter((o) => o.groupId === g.id) })),
      stations,
      counts: { items: +(totals?.items ?? 0), unavailable: +(totals?.unavailable ?? 0), outOfStock: +(totals?.outOfStock ?? 0), lowStock: +(totals?.lowStock ?? 0), categories: cats.length, modifierGroups: groups.length },
    };
  }

  // ------------------------------------------------------------------ categories
  async createCategory(restaurantId: string, dto: CategoryDto) {
    this.checkDayparts(dto.dayparts);
    const max = await this.categories.maximum('sortOrder', { restaurantId });
    return this.categories.save(
      this.categories.create({ restaurantId, name: dto.name, description: dto.description ?? null, sortOrder: dto.sortOrder ?? (max ?? -1) + 1, active: dto.active ?? true, dayparts: (dto.dayparts as DayPart[]) ?? [] }),
    );
  }

  async updateCategory(restaurantId: string, id: string, dto: Partial<CategoryDto>) {
    const c = await this.categories.findOne({ where: { id, restaurantId } });
    if (!c) throw new NotFoundException('Category not found');
    if (dto.dayparts) this.checkDayparts(dto.dayparts);
    if (dto.name !== undefined) c.name = dto.name;
    if (dto.description !== undefined) c.description = dto.description;
    if (dto.sortOrder !== undefined) c.sortOrder = dto.sortOrder;
    if (dto.active !== undefined) c.active = dto.active;
    if (dto.dayparts) c.dayparts = dto.dayparts as DayPart[];
    return this.categories.save(c);
  }

  async deleteCategory(restaurantId: string, id: string, moveItemsTo?: string) {
    const c = await this.categories.findOne({ where: { id, restaurantId } });
    if (!c) throw new NotFoundException('Category not found');
    const n = await this.items.count({ where: { categoryId: id } });
    if (n && !moveItemsTo) throw new ConflictException(`Category still has ${n} item(s); pass moveItemsTo=<categoryId> or delete/move the items first`);
    if (n) {
      if (!(await this.categories.exist({ where: { id: moveItemsTo!, restaurantId } }))) throw new NotFoundException('Target category not found');
      await this.items.update({ categoryId: id }, { categoryId: moveItemsTo! });
    }
    await this.categories.delete(id);
    return { ok: true };
  }

  async reorderCategories(restaurantId: string, ids: string[]) {
    await Promise.all(ids.map((id, i) => this.categories.update({ id, restaurantId }, { sortOrder: i })));
    return { ok: true };
  }

  // ------------------------------------------------------------------ items
  private checkDayparts(d?: string[]) {
    for (const x of d ?? []) if (!DAYPARTS.includes(x)) throw new BadRequestException(`Unknown daypart ${x} (use ${DAYPARTS.join(', ')})`);
  }

  /**
   * The photos of an item after this change: the featured one and the gallery, cleaned (see common/image-url.ts). A value that is not sent keeps what the item has.
   * Setting a new featured photo removes it from the gallery (it would show twice); sending a gallery never contains the featured photo.
   */
  private photos(dto: Partial<ItemDto>, existing?: MenuItem): { imageUrl: string | null; galleryUrls: string[] } {
    const imageUrl = dto.imageUrl === undefined ? existing?.imageUrl ?? null : dto.imageUrl === null || dto.imageUrl === '' ? null : cleanImageUrl(dto.imageUrl);
    const gallery = dto.galleryUrls === undefined ? existing?.galleryUrls ?? [] : dto.galleryUrls;
    return { imageUrl, galleryUrls: cleanGallery(gallery, imageUrl) };
  }

  private async validateItem(restaurantId: string, dto: Partial<ItemDto>) {
    this.checkDayparts(dto.dayparts);
    this.photos(dto);
    if (dto.categoryId && !(await this.categories.exist({ where: { id: dto.categoryId, restaurantId } }))) throw new BadRequestException('Unknown categoryId');
    if (dto.stationId && !(await this.stations.exist({ where: { id: dto.stationId, restaurantId } }))) throw new BadRequestException('Unknown stationId');
    if (dto.taxClassCode && !(await this.taxClasses.exist({ where: { code: dto.taxClassCode } }))) throw new BadRequestException(`Unknown tax class ${dto.taxClassCode}`);
    if (dto.comboItems?.length) {
      const ids = dto.comboItems.map((c) => c.menuItemId);
      const found = await this.items.count({ where: { id: In(ids), restaurantId } });
      if (found !== new Set(ids).size) throw new BadRequestException('comboItems reference unknown items');
    }
    if (dto.groupIds?.length) {
      const found = await this.groups.count({ where: { id: In(dto.groupIds), restaurantId } });
      if (found !== new Set(dto.groupIds).size) throw new BadRequestException('groupIds reference unknown modifier groups');
    }
  }

  // ------------------------------------------------------------------ catalog fields (groceries / retail)
  /** Does the store hold a valid (approved, not expired) liquor or tobacco licence? Age-restricted products may only be listed with one. */
  async hasAgeLicence(restaurantId: string): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.docs.find({ where: { restaurantId, type: In([RestaurantDocType.LIQUOR_LICENCE, RestaurantDocType.TOBACCO_LICENCE]), status: DocStatus.APPROVED } });
    return rows.some((d) => !d.expiresAt || d.expiresAt >= today);
  }

  private async assertMayListAgeRestricted(restaurantId: string) {
    if (!this.settings.get<boolean>('restaurant.ageRestricted.enabled', true)) {
      throw new BadRequestException({ message: 'Age-restricted products (alcohol, tobacco) are not sold on this platform', code: 'AGE_RESTRICTED_DISABLED' });
    }
    if (this.settings.get<boolean>('restaurant.ageRestricted.requireLicence', true) && !(await this.hasAgeLicence(restaurantId))) {
      throw new BadRequestException({
        message: 'Upload your liquor or tobacco licence (Store, Documents) and wait for FORKSY to approve it before listing age-restricted products',
        code: 'LICENCE_REQUIRED',
      });
    }
  }

  /**
   * Validates and normalises the catalog part of an item (create / update / import). Returns only the columns the caller supplied (plus the ones that
   * follow from them), so a partial update never resets what it did not mention.
   */
  private async catalogFields(restaurantId: string, dto: Partial<CatalogFieldsDto>, existing?: MenuItem): Promise<Partial<MenuItem>> {
    const out: Partial<MenuItem> = {};
    const has = (k: keyof CatalogFieldsDto) => dto[k] !== undefined;
    const clean = (s?: string | null) => {
      const v = (s ?? '').trim();
      return v === '' ? null : v;
    };
    if (has('sku')) {
      out.sku = clean(dto.sku);
      if (out.sku) {
        const clash = await this.items.findOne({ where: { restaurantId, sku: out.sku, ...(existing ? { id: Not(existing.id) } : {}) }, select: ['id', 'name'] });
        if (clash) throw new ConflictException(`SKU "${out.sku}" is already used by "${clash.name}"`);
      }
    }
    if (has('barcode')) out.barcode = clean(dto.barcode);
    if (has('brand')) out.brand = clean(dto.brand);
    if (has('packSize')) out.packSize = clean(dto.packSize);

    const sellBy = dto.sellBy ?? existing?.sellBy ?? 'UNIT';
    if (has('sellBy')) out.sellBy = sellBy;
    if (has('weightUnit')) out.weightUnit = dto.weightUnit!;
    if (sellBy === 'WEIGHT') {
      const step = dto.stepSize ?? (existing?.sellBy === 'WEIGHT' ? existing.stepSize : undefined);
      if (!(Number(step) > 0)) throw new BadRequestException('stepSize is required for products sold by weight (for example 0.5 = half a kilo per step)');
      if (has('stepSize') || has('sellBy')) out.stepSize = Math.round(Number(step) * 1000) / 1000;
    } else if (has('sellBy') || has('stepSize')) {
      out.stepSize = 1; // products sold by the piece have no step
    }

    const trackStock = dto.trackStock ?? existing?.trackStock ?? false;
    if (has('trackStock')) out.trackStock = trackStock;
    if (has('stockQty')) out.stockQty = dto.stockQty === null ? null : Math.round(Number(dto.stockQty) * 1000) / 1000;
    const stock = has('stockQty') ? out.stockQty : existing?.stockQty;
    if (trackStock && (stock === null || stock === undefined)) throw new BadRequestException('stockQty is required when stock is tracked');
    if (trackStock && sellBy === 'UNIT' && stock != null && !Number.isInteger(stock)) throw new BadRequestException('stockQty must be a whole number for products sold by the piece');
    if (has('lowStockThreshold')) out.lowStockThreshold = dto.lowStockThreshold ?? null;
    if (has('maxPerOrder')) out.maxPerOrder = dto.maxPerOrder ?? null;

    if (has('minAge')) {
      const age = Number(dto.minAge);
      if (!MIN_AGES.includes(age)) throw new BadRequestException(`minAge must be one of ${MIN_AGES.join(', ')}`);
      if (age > 0 && age !== (existing?.minAge ?? 0)) await this.assertMayListAgeRestricted(restaurantId);
      out.minAge = age;
    }
    if (has('temperature')) out.temperature = dto.temperature!;

    // menu details
    if (has('spiceLevel')) {
      if (dto.spiceLevel !== null && !(SPICE_LEVELS as readonly string[]).includes(dto.spiceLevel!)) throw new BadRequestException(`spiceLevel must be one of ${SPICE_LEVELS.join(', ')}`);
      out.spiceLevel = dto.spiceLevel ?? null;
    }
    for (const k of ['lengthCm', 'widthCm', 'heightCm'] as const) {
      if (!has(k)) continue;
      const n = dto[k];
      if (n !== null && (!Number.isFinite(Number(n)) || Number(n) < 0 || Number(n) > 10_000)) throw new BadRequestException(`${k} must be a number between 0 and 10000 (centimetres)`);
      out[k] = n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100;
    }
    if (has('ingredients')) out.ingredients = clean(dto.ingredients);
    if (has('mayContain')) out.mayContain = cleanTags(dto.mayContain);
    if (has('nutrition')) {
      try {
        out.nutrition = cleanNutrition(dto.nutrition) as any;
      } catch (e: any) {
        throw new BadRequestException(e.message);
      }
    }
    if (has('servingSize')) out.servingSize = clean(dto.servingSize);
    if (has('countryOfOrigin')) out.countryOfOrigin = clean(dto.countryOfOrigin);
    if (has('storage')) out.storage = clean(dto.storage);
    return out;
  }

  async createItem(restaurantId: string, dto: ItemDto) {
    await this.validateItem(restaurantId, dto);
    const catalog = await this.catalogFields(restaurantId, dto);
    const max = await this.items.maximum('sortOrder', { restaurantId, categoryId: dto.categoryId ?? IsNull() });
    const item = await this.items.save(
      this.items.create({
        ...catalog,
        restaurantId,
        categoryId: dto.categoryId ?? null,
        name: dto.name,
        description: dto.description ?? null,
        ...this.photos(dto),
        price: dto.price,
        pickupPrice: dto.pickupPrice ?? null,
        taxClassCode: dto.taxClassCode ?? 'HST_ON',
        calories: dto.calories ?? null,
        allergens: dto.allergens ?? [],
        dietaryTags: dto.dietaryTags ?? [],
        sortOrder: dto.sortOrder ?? (max ?? -1) + 1,
        available: dto.available ?? true,
        dayparts: (dto.dayparts as DayPart[]) ?? [],
        isCombo: dto.isCombo ?? !!dto.comboItems?.length,
        comboItems: dto.comboItems ?? [],
        stationId: dto.stationId ?? null,
        prepTimeMin: dto.prepTimeMin ?? null,
        isPopular: dto.isPopular ?? false,
        active: dto.active ?? true,
      }),
    );
    if (dto.groupIds) await this.setItemGroups(restaurantId, item.id, dto.groupIds);
    return this.getItem(restaurantId, item.id);
  }

  async getItem(restaurantId: string, id: string) {
    const item = await this.items.findOne({ where: { id, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    const links = await this.links.find({ where: { menuItemId: id }, order: { sortOrder: 'ASC' } });
    const groups = links.length ? await this.groups.find({ where: { id: In(links.map((l) => l.groupId)) } }) : [];
    const opts = groups.length ? await this.options.find({ where: { groupId: In(groups.map((g) => g.id)) }, order: { sortOrder: 'ASC' } }) : [];
    return {
      ...item,
      modifierGroups: links.map((l) => groups.find((g) => g.id === l.groupId)).filter(Boolean).map((g) => ({ ...g!, options: opts.filter((o) => o.groupId === g!.id) })),
    };
  }

  async updateItem(restaurantId: string, id: string, dto: Partial<ItemDto>) {
    const item = await this.items.findOne({ where: { id, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    await this.validateItem(restaurantId, dto);
    const catalog = await this.catalogFields(restaurantId, dto, item);
    const before = { imageUrl: item.imageUrl, galleryUrls: item.galleryUrls } as MenuItem; // what the item had, for the photos that were not sent
    const { groupIds, ...rest } = dto;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) (item as any)[k] = v;
    Object.assign(item, catalog); // the validated / normalised catalog values win over the raw ones above
    Object.assign(item, this.photos(dto, before)); // the cleaned photos win too
    if (dto.comboItems && dto.isCombo === undefined) item.isCombo = dto.comboItems.length > 0;
    if (dto.available === true) item.restockAt = null;
    await this.items.save(item);
    if (groupIds) await this.setItemGroups(restaurantId, id, groupIds);
    return this.getItem(restaurantId, id);
  }

  async deleteItem(restaurantId: string, id: string) {
    const item = await this.items.findOne({ where: { id, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    // order history keeps its own snapshot (order_items.name), so a hard delete is safe; combos referencing it are cleaned
    await this.links.delete({ menuItemId: id });
    const combos = await this.items.find({ where: { restaurantId, isCombo: true } });
    for (const c of combos) {
      const next = c.comboItems.filter((x) => x.menuItemId !== id);
      if (next.length !== c.comboItems.length) await this.items.update(c.id, { comboItems: next });
    }
    await this.items.delete(id);
    return { ok: true };
  }

  async reorderItems(restaurantId: string, ids: string[]) {
    await Promise.all(ids.map((id, i) => this.items.update({ id, restaurantId }, { sortOrder: i })));
    return { ok: true };
  }

  async setItemGroups(restaurantId: string, itemId: string, groupIds: string[]) {
    const item = await this.items.findOne({ where: { id: itemId, restaurantId }, select: ['id'] });
    if (!item) throw new NotFoundException('Menu item not found');
    if (groupIds.length && (await this.groups.count({ where: { id: In(groupIds), restaurantId } })) !== new Set(groupIds).size) throw new BadRequestException('Unknown modifier group');
    await this.links.delete({ menuItemId: itemId });
    if (groupIds.length) await this.links.insert([...new Set(groupIds)].map((groupId, i) => ({ menuItemId: itemId, groupId, sortOrder: i })));
    return this.getItem(restaurantId, itemId);
  }

  // ------------------------------------------------------------------ product list (paged, for big catalogs) + stock
  /**
   * Paged, searchable product list for the portal catalog screen (a supermarket has thousands of products: the menu tree is too big).
   * Filters: q (name / SKU / barcode / brand), categoryId ("none" = uncategorised), stock (out | low | in | tracked | untracked), available, active.
   */
  async listItems(restaurantId: string, q: Record<string, string | undefined>) {
    const { page, limit } = clampPaging(q.page, q.limit, 200, 50);
    const qb = this.items.createQueryBuilder('i').where('i.restaurantId = :restaurantId', { restaurantId });
    const text = (q.q ?? q.search ?? '').trim();
    if (text) qb.andWhere('(i.name ILIKE :s OR i.sku ILIKE :s OR i.barcode ILIKE :s OR i.brand ILIKE :s)', { s: like(text) });
    if (q.categoryId === 'none') qb.andWhere('i.categoryId IS NULL');
    else if (q.categoryId && /^[0-9a-f-]{36}$/i.test(q.categoryId)) qb.andWhere('i.categoryId = :cat', { cat: q.categoryId });
    if (q.available === 'true' || q.available === 'false') qb.andWhere('i.available = :av', { av: q.available === 'true' });
    if (q.active === 'true' || q.active === 'false') qb.andWhere('i.active = :ac', { ac: q.active === 'true' });
    switch (q.stock) {
      case 'out':
        qb.andWhere('i.trackStock = true AND COALESCE(i.stockQty, 0) <= 0');
        break;
      case 'low':
        qb.andWhere('i.trackStock = true AND COALESCE(i.stockQty, 0) > 0 AND i.lowStockThreshold IS NOT NULL AND i.stockQty <= i.lowStockThreshold');
        break;
      case 'in':
        qb.andWhere('(i.trackStock = false OR COALESCE(i.stockQty, 0) > 0)');
        break;
      case 'tracked':
        qb.andWhere('i.trackStock = true');
        break;
      case 'untracked':
        qb.andWhere('i.trackStock = false');
        break;
    }
    const sorts: Record<string, string> = { name: 'i.name', price: 'i.price', stock: 'i.stockQty', updated: 'i.updatedAt', sku: 'i.sku', sort: 'i.sortOrder' };
    const dir: 'ASC' | 'DESC' = String(q.sortDir ?? '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    qb.orderBy(sorts[q.sortBy ?? ''] ?? 'i.name', dir).addOrderBy('i.name', 'ASC');
    const [rows, total] = await qb.skip((page - 1) * limit).take(limit).getManyAndCount();
    const cats = await this.categories.find({ where: { restaurantId }, select: ['id', 'name'] });
    const catName = new Map(cats.map((c) => [c.id, c.name]));
    const counts = await this.items
      .createQueryBuilder('i')
      .select('COUNT(*)', 'total')
      .addSelect(`COUNT(*) FILTER (WHERE i.trackStock = true AND COALESCE(i.stockQty, 0) <= 0)`, 'outOfStock')
      .addSelect(`COUNT(*) FILTER (WHERE i.trackStock = true AND COALESCE(i.stockQty, 0) > 0 AND i.lowStockThreshold IS NOT NULL AND i.stockQty <= i.lowStockThreshold)`, 'lowStock')
      .addSelect(`COUNT(*) FILTER (WHERE i.trackStock = true)`, 'tracked')
      .where('i.restaurantId = :restaurantId', { restaurantId })
      .getRawOne<{ total: string; outOfStock: string; lowStock: string; tracked: string }>();
    return {
      data: rows.map((i) => ({ ...i, categoryName: i.categoryId ? catName.get(i.categoryId) ?? null : null, stockState: this.stockState(i) })),
      meta: pageMeta(total, page, limit),
      counts: { total: +(counts?.total ?? 0), outOfStock: +(counts?.outOfStock ?? 0), lowStock: +(counts?.lowStock ?? 0), tracked: +(counts?.tracked ?? 0) },
    };
  }

  /** UNTRACKED | IN_STOCK | LOW | OUT */
  stockState(i: Pick<MenuItem, 'trackStock' | 'stockQty' | 'lowStockThreshold'>) {
    if (!i.trackStock) return 'UNTRACKED';
    const n = i.stockQty ?? 0;
    if (n <= 0) return 'OUT';
    return i.lowStockThreshold != null && n <= i.lowStockThreshold ? 'LOW' : 'IN_STOCK';
  }

  /**
   * Stock counts / deliveries / POS syncs: set or adjust the stock of many products at once, found by id, SKU or barcode.
   * A product without stock tracking starts tracking when it gets a stock level. Prices are NOT changed here (that is menu editing).
   */
  async stockUpdate(restaurantId: string, rows: StockUpdateRowDto[]) {
    if (!Array.isArray(rows) || !rows.length) throw new BadRequestException('Send at least one row in "updates"');
    if (rows.length > 5000) throw new BadRequestException('At most 5000 rows per call');
    const skus = [...new Set(rows.map((r) => r.sku?.trim()).filter(Boolean) as string[])];
    const barcodes = [...new Set(rows.map((r) => r.barcode?.trim()).filter(Boolean) as string[])];
    const ids = [...new Set(rows.map((r) => r.itemId).filter((x) => x && /^[0-9a-f-]{36}$/i.test(x)) as string[])];
    const found = new Map<string, MenuItem>();
    const take = (list: MenuItem[]) => list.forEach((i) => found.set(i.id, i));
    if (skus.length) take(await this.items.find({ where: { restaurantId, sku: In(skus) } }));
    if (barcodes.length) take(await this.items.find({ where: { restaurantId, barcode: In(barcodes) } }));
    if (ids.length) take(await this.items.find({ where: { restaurantId, id: In(ids) } }));
    const bySku = new Map([...found.values()].filter((i) => i.sku).map((i) => [i.sku!, i]));
    const byBarcode = new Map<string, MenuItem[]>();
    for (const i of found.values()) if (i.barcode) byBarcode.set(i.barcode, [...(byBarcode.get(i.barcode) ?? []), i]);

    const result = { updated: 0, unchanged: 0, notFound: [] as { row: number; key: string }[], errors: [] as { row: number; error: string }[] };
    const dirty = new Map<string, MenuItem>();
    rows.forEach((r, idx) => {
      const row = idx + 1;
      const key = r.itemId ?? r.sku ?? r.barcode ?? '';
      let targets: MenuItem[] = [];
      if (r.itemId && found.get(r.itemId)) targets = [found.get(r.itemId)!];
      else if (r.sku?.trim() && bySku.get(r.sku.trim())) targets = [bySku.get(r.sku.trim())!];
      else if (r.barcode?.trim() && byBarcode.get(r.barcode.trim())) targets = byBarcode.get(r.barcode.trim())!;
      if (!targets.length) {
        result.notFound.push({ row, key: key || '(no id, sku or barcode)' });
        return;
      }
      if (r.stockQty === undefined && r.delta === undefined && r.available === undefined) {
        result.errors.push({ row, error: 'nothing to change: send stockQty, delta or available' });
        return;
      }
      for (const item of targets) {
        const before = JSON.stringify([item.stockQty, item.trackStock, item.available]);
        if (r.stockQty !== undefined || r.delta !== undefined) {
          const next = r.stockQty !== undefined ? Number(r.stockQty) : Math.max(0, Math.round(((item.stockQty ?? 0) + Number(r.delta)) * 1000) / 1000);
          if (item.sellBy !== 'WEIGHT' && !Number.isInteger(next)) {
            result.errors.push({ row, error: `"${item.name}" is sold by the piece: the stock must be a whole number` });
            continue;
          }
          item.stockQty = next;
          item.trackStock = true;
          if (next > 0) item.restockAt = null;
        }
        if (r.available !== undefined) {
          item.available = r.available;
          if (r.available) item.restockAt = null;
        }
        if (JSON.stringify([item.stockQty, item.trackStock, item.available]) === before) result.unchanged++;
        else dirty.set(item.id, item);
      }
    });
    if (dirty.size) await this.items.save([...dirty.values()]);
    result.updated = dirty.size;
    return result;
  }

  // ------------------------------------------------------------------ 86 / availability
  private restockDate(opts: { restockAt?: string | null; untilTomorrow?: boolean; hours?: number }, tz: string): Date | null {
    if (opts.restockAt) {
      const d = new Date(opts.restockAt);
      if (isNaN(d.getTime())) throw new BadRequestException('restockAt must be an ISO date');
      return d;
    }
    if (opts.hours) return new Date(Date.now() + opts.hours * 3600_000);
    if (opts.untilTomorrow === false) return null; // stays out until manually restocked
    return nextRestockTime(new Date(), tz); // default: next day 04:00
  }

  /** One-tap 86: unavailable until restockAt (default next 04:00 local). */
  async eightySix(restaurantId: string, itemId: string, opts: { restockAt?: string | null; untilTomorrow?: boolean; hours?: number } = {}) {
    const item = await this.items.findOne({ where: { id: itemId, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    item.available = false;
    item.restockAt = this.restockDate(opts, await this.availability.timezoneFor(r!));
    return this.items.save(item);
  }

  async restockItem(restaurantId: string, itemId: string) {
    const item = await this.items.findOne({ where: { id: itemId, restaurantId } });
    if (!item) throw new NotFoundException('Menu item not found');
    item.available = true;
    item.restockAt = null;
    return this.items.save(item);
  }

  private async optionFor(restaurantId: string, optionId: string) {
    const opt = await this.options.findOne({ where: { id: optionId } });
    if (!opt || !(await this.groups.exist({ where: { id: opt.groupId, restaurantId } }))) throw new NotFoundException('Modifier option not found');
    return opt;
  }

  async eightySixOption(restaurantId: string, optionId: string, opts: { restockAt?: string | null; untilTomorrow?: boolean; hours?: number } = {}) {
    const opt = await this.optionFor(restaurantId, optionId);
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    opt.available = false;
    opt.restockAt = this.restockDate(opts, await this.availability.timezoneFor(r!));
    return this.options.save(opt);
  }

  async restockOption(restaurantId: string, optionId: string) {
    const opt = await this.optionFor(restaurantId, optionId);
    opt.available = true;
    opt.restockAt = null;
    return this.options.save(opt);
  }

  /** Scheduler: auto-restock everything whose restockAt has passed. Returns counts. */
  async restockDue(now = new Date()) {
    const due = await this.items.find({ where: { available: false, restockAt: LessThanOrEqual(now) }, select: ['id', 'name', 'restaurantId'] }).catch(() => [] as MenuItem[]);
    const a = await this.items.update({ available: false, restockAt: LessThanOrEqual(now) }, { available: true, restockAt: null });
    const b = await this.options.update({ available: false, restockAt: LessThanOrEqual(now) }, { available: true, restockAt: null });
    // tell each restaurant which items came back by themselves (86 auto-restock)
    const by = new Map<string, string[]>();
    for (const i of due) by.set(i.restaurantId, [...(by.get(i.restaurantId) ?? []), i.name]);
    for (const [rid, names] of by) {
      const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
      this.notifications.notifyRestaurant(rid, 'menu.item_restocked', { count: names.length, items: shown }, { restaurantId: rid }).catch(() => undefined);
    }
    return { items: a.affected ?? 0, options: b.affected ?? 0 };
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sweepRestock() {
    await this.restockDue().catch(() => undefined);
  }

  // ------------------------------------------------------------------ modifier groups & options
  private checkGroup(dto: Partial<ModifierGroupDto>, cur?: ModifierGroup) {
    const min = dto.minSelect ?? cur?.minSelect ?? 0;
    const max = dto.maxSelect ?? cur?.maxSelect ?? 1;
    if (min < 0 || max < 1 || min > max) throw new BadRequestException('Invalid min/max selection (need 0 <= min <= max, max >= 1)');
    if ((dto.required ?? cur?.required) && min < 1) dto.minSelect = 1;
  }

  async createGroup(restaurantId: string, dto: ModifierGroupDto) {
    this.checkGroup(dto);
    const max = await this.groups.maximum('sortOrder', { restaurantId });
    const g = await this.groups.save(
      this.groups.create({
        restaurantId,
        name: dto.name,
        required: dto.required ?? false,
        minSelect: dto.minSelect ?? (dto.required ? 1 : 0),
        maxSelect: dto.maxSelect ?? 1,
        sortOrder: dto.sortOrder ?? (max ?? -1) + 1,
      }),
    );
    for (const [i, o] of (dto.options ?? []).entries()) await this.createOption(restaurantId, g.id, { ...o, sortOrder: o.sortOrder ?? i });
    if (dto.itemIds?.length) for (const itemId of dto.itemIds) await this.attachGroup(restaurantId, itemId, g.id);
    return this.getGroup(restaurantId, g.id);
  }

  async getGroup(restaurantId: string, id: string) {
    const g = await this.groups.findOne({ where: { id, restaurantId } });
    if (!g) throw new NotFoundException('Modifier group not found');
    const options = await this.options.find({ where: { groupId: id }, order: { sortOrder: 'ASC', name: 'ASC' } });
    const itemIds = (await this.links.find({ where: { groupId: id } })).map((l) => l.menuItemId);
    return { ...g, options, itemIds };
  }

  async updateGroup(restaurantId: string, id: string, dto: Partial<ModifierGroupDto>) {
    const g = await this.groups.findOne({ where: { id, restaurantId } });
    if (!g) throw new NotFoundException('Modifier group not found');
    this.checkGroup(dto, g);
    for (const k of ['name', 'required', 'minSelect', 'maxSelect', 'sortOrder'] as const) if (dto[k] !== undefined) (g as any)[k] = dto[k];
    await this.groups.save(g);
    if (dto.itemIds) {
      await this.links.delete({ groupId: id });
      for (const itemId of new Set(dto.itemIds)) await this.attachGroup(restaurantId, itemId, id);
    }
    return this.getGroup(restaurantId, id);
  }

  async deleteGroup(restaurantId: string, id: string) {
    const g = await this.groups.findOne({ where: { id, restaurantId } });
    if (!g) throw new NotFoundException('Modifier group not found');
    await this.links.delete({ groupId: id });
    await this.options.delete({ groupId: id });
    await this.groups.delete(id);
    return { ok: true };
  }

  async attachGroup(restaurantId: string, itemId: string, groupId: string) {
    if (!(await this.items.exist({ where: { id: itemId, restaurantId } })) || !(await this.groups.exist({ where: { id: groupId, restaurantId } }))) throw new NotFoundException('Item or group not found');
    if (await this.links.exist({ where: { menuItemId: itemId, groupId } })) return;
    const max = await this.links.maximum('sortOrder', { menuItemId: itemId });
    await this.links.insert({ menuItemId: itemId, groupId, sortOrder: (max ?? -1) + 1 });
  }

  async detachGroup(restaurantId: string, itemId: string, groupId: string) {
    if (!(await this.items.exist({ where: { id: itemId, restaurantId } }))) throw new NotFoundException('Item not found');
    await this.links.delete({ menuItemId: itemId, groupId });
    return { ok: true };
  }

  async createOption(restaurantId: string, groupId: string, dto: ModifierOptionDto) {
    if (!(await this.groups.exist({ where: { id: groupId, restaurantId } }))) throw new NotFoundException('Modifier group not found');
    const max = await this.options.maximum('sortOrder', { groupId });
    return this.options.save(
      this.options.create({ groupId, name: dto.name, priceDelta: dto.priceDelta ?? 0, isDefault: dto.isDefault ?? false, available: dto.available ?? true, sortOrder: dto.sortOrder ?? (max ?? -1) + 1 }),
    );
  }

  async updateOption(restaurantId: string, optionId: string, dto: Partial<ModifierOptionDto>) {
    const o = await this.optionFor(restaurantId, optionId);
    for (const k of ['name', 'priceDelta', 'isDefault', 'available', 'sortOrder'] as const) if (dto[k] !== undefined) (o as any)[k] = dto[k];
    if (dto.available === true) o.restockAt = null;
    return this.options.save(o);
  }

  async deleteOption(restaurantId: string, optionId: string) {
    await this.optionFor(restaurantId, optionId);
    await this.options.delete(optionId);
    return { ok: true };
  }

  // ------------------------------------------------------------------ prep targets
  prepTargets(restaurantId: string) {
    return this.items.find({ where: { restaurantId, active: true }, select: ['id', 'name', 'prepTimeMin', 'stationId', 'categoryId'], order: { name: 'ASC' } });
  }

  async setPrepTargets(restaurantId: string, targets: { itemId: string; prepTimeMin: number | null }[]) {
    for (const t of targets) await this.items.update({ id: t.itemId, restaurantId }, { prepTimeMin: t.prepTimeMin });
    return { ok: true, updated: targets.length };
  }

  // ------------------------------------------------------------------ CSV export / import
  private groupsToCell(groups: (ModifierGroup & { options: ModifierOption[] })[]) {
    return groups
      .map((g) => `${g.name}(${g.required ? 'req' : 'opt'},${g.minSelect},${g.maxSelect})=${g.options.map((o) => `${o.name}+${o.priceDelta}`).join('|')}`)
      .join(';');
  }

  private parseGroupsCell(cell: string) {
    const out: { name: string; required: boolean; min: number; max: number; options: { name: string; price: number }[] }[] = [];
    for (const part of cell.split(';').map((s) => s.trim()).filter(Boolean)) {
      const m = part.match(/^(.+?)\((req|opt),(\d+),(\d+)\)=(.*)$/i);
      if (!m) throw new BadRequestException(`Bad modifier_groups cell: "${part}" (expected Name(req|opt,min,max)=Opt+price|Opt+price)`);
      out.push({
        name: m[1].trim(),
        required: m[2].toLowerCase() === 'req',
        min: +m[3],
        max: Math.max(1, +m[4]),
        options: m[5]
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const i = s.lastIndexOf('+');
            return i > 0 ? { name: s.slice(0, i).trim(), price: parseFloat(s.slice(i + 1)) || 0 } : { name: s, price: 0 };
          }),
      });
    }
    return out;
  }

  async exportCsv(restaurantId: string): Promise<string> {
    const t = await this.tree(restaurantId, true);
    const catName = new Map(t.categories.map((c) => [c.id, c.name]));
    const all = [...t.categories.flatMap((c) => c.items), ...t.uncategorized];
    const rows: unknown[][] = [MENU_CSV_HEADER];
    for (const i of all) {
      rows.push([
        i.categoryId ? catName.get(i.categoryId) ?? '' : '',
        i.name,
        i.description ?? '',
        i.price,
        i.pickupPrice ?? '',
        i.taxClassCode ?? '',
        i.calories ?? '',
        (i.allergens ?? []).join('|'),
        (i.dietaryTags ?? []).join('|'),
        (i.dayparts ?? []).join('|'),
        i.prepTimeMin ?? '',
        i.stationName ?? '',
        i.available ? 'true' : 'false',
        i.imageUrl ?? '',
        i.isPopular ? 'true' : 'false',
        this.groupsToCell(i.modifierGroups as any),
        i.sku ?? '',
        i.barcode ?? '',
        i.brand ?? '',
        i.packSize ?? '',
        i.sellBy ?? 'UNIT',
        i.weightUnit ?? 'KG',
        i.sellBy === 'WEIGHT' ? i.stepSize : '',
        i.trackStock ? 'true' : 'false',
        i.trackStock ? i.stockQty ?? '' : '',
        i.lowStockThreshold ?? '',
        i.maxPerOrder ?? '',
        i.minAge ?? 0,
        i.temperature ?? 'AMBIENT',
        i.spiceLevel ?? '',
        i.lengthCm ?? '',
        i.widthCm ?? '',
        i.heightCm ?? '',
        i.ingredients ?? '',
        (i.mayContain ?? []).join('|'),
        i.servingSize ?? '',
        nutritionToCell(i.nutrition as any),
        i.countryOfOrigin ?? '',
        i.storage ?? '',
      ]);
    }
    return toCsv(rows);
  }

  /** A blank file with the header and two example rows, to fill in and import. */
  csvTemplate(): string {
    const ex = (o: Record<string, unknown>) => MENU_CSV_HEADER.map((h) => o[h] ?? '');
    return toCsv([
      MENU_CSV_HEADER,
      ex({ category: 'Mains', name: 'Butter chicken', description: 'Creamy tomato curry', price: 18.5, pickup_price: 17, tax_class: 'HST_ON', calories: 720, allergens: 'milk|tree nuts', dietary_tags: 'halal', prep_time_min: 15, available: 'true', modifier_groups: 'Size(req,1,1)=Regular+0|Large+4;Spice level(req,1,1)=Mild+0|Medium+0|Hot+0', spice_level: 'MEDIUM', may_contain: 'peanuts', serving_size: '1 bowl (350 g)', nutrition: 'fat_g=32|carbs_g=40|protein_g=38|sodium_mg=1100', country_of_origin: 'Canada', ingredients: 'Chicken, tomato, cream, butter, spices' }),
      ex({ category: 'Bakery', name: 'Birthday cake', price: 42, sku: 'CAKE-01', sell_by: 'UNIT', length_cm: 25, width_cm: 25, height_cm: 12, pack_size: '1 cake, serves 10', storage: 'Keep refrigerated, eat within 3 days', temperature: 'CHILLED', allergens: 'wheat|eggs|milk', min_age: 0 }),
    ]);
  }

  /** mode=merge (default): upsert by category+name; mode=replace: wipe the existing menu first. */
  async importCsv(restaurantId: string, csv: string, mode: 'merge' | 'replace' = 'merge', dryRun = false) {
    const rows = parseCsv(csv);
    if (rows.length < 2) throw new BadRequestException('CSV needs a header row and at least one item row');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    if (!header.includes('name') || !header.includes('price')) throw new BadRequestException(`CSV header must contain at least name and price (expected: ${MENU_CSV_HEADER.join(',')})`);
    const col = (r: string[], k: string) => (r[header.indexOf(k)] ?? '').trim();
    const errors: { row: number; error: string }[] = [];
    const parsed: any[] = [];
    const seenSkus = new Set<string>();
    rows.slice(1).forEach((r, idx) => {
      try {
        const price = parseFloat(col(r, 'price'));
        if (!col(r, 'name')) throw new Error('name is required');
        if (!isFinite(price) || price < 0) throw new Error('price must be a number >= 0');
        const list = (k: string) => col(r, k).split(/[|;]/).map((s) => s.trim()).filter(Boolean);
        const dayparts = list('dayparts').map((d) => d.toUpperCase());
        for (const d of dayparts) if (!DAYPARTS.includes(d)) throw new Error(`unknown daypart ${d}`);
        // catalog columns: only those present in the header AND filled in change anything (an empty cell means "no change")
        const catalog: Partial<CatalogFieldsDto> = {};
        const cell = (k: string) => (header.includes(k) ? col(r, k) : '');
        const numCell = (k: string) => {
          const v = cell(k);
          if (v === '') return undefined;
          const n = Number(v);
          if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
          return n;
        };
        const boolCell = (k: string) => (cell(k) === '' ? undefined : /^(true|1|yes|y)$/i.test(cell(k)));
        if (cell('sku')) catalog.sku = cell('sku');
        if (cell('barcode')) {
          if (!/^[0-9]{6,14}$/.test(cell('barcode'))) throw new Error('barcode must be 6 to 14 digits');
          catalog.barcode = cell('barcode');
        }
        if (cell('brand')) catalog.brand = cell('brand');
        if (cell('pack_size')) catalog.packSize = cell('pack_size');
        if (cell('sell_by')) {
          const v = cell('sell_by').toUpperCase();
          if (v !== 'UNIT' && v !== 'WEIGHT') throw new Error('sell_by must be UNIT or WEIGHT');
          catalog.sellBy = v;
        }
        if (cell('weight_unit')) {
          const v = cell('weight_unit').toUpperCase();
          if (v !== 'KG' && v !== 'LB') throw new Error('weight_unit must be KG or LB');
          catalog.weightUnit = v;
        }
        if (numCell('step_size') !== undefined) catalog.stepSize = numCell('step_size');
        if (boolCell('track_stock') !== undefined) catalog.trackStock = boolCell('track_stock');
        if (numCell('stock_qty') !== undefined) {
          catalog.stockQty = numCell('stock_qty');
          if (catalog.trackStock === undefined) catalog.trackStock = true; // a stock level starts tracking
        }
        if (numCell('low_stock') !== undefined) catalog.lowStockThreshold = numCell('low_stock');
        if (numCell('max_per_order') !== undefined) catalog.maxPerOrder = Math.trunc(numCell('max_per_order')!);
        if (numCell('min_age') !== undefined) {
          catalog.minAge = Math.trunc(numCell('min_age')!);
          if (!MIN_AGES.includes(catalog.minAge)) throw new Error(`min_age must be one of ${MIN_AGES.join(', ')}`);
        }
        if (cell('temperature')) {
          const v = cell('temperature').toUpperCase();
          if (v !== 'AMBIENT' && v !== 'CHILLED' && v !== 'FROZEN') throw new Error('temperature must be AMBIENT, CHILLED or FROZEN');
          catalog.temperature = v;
        }
        if (cell('spice_level')) {
          const v = cell('spice_level').toUpperCase().replace(/[\s-]+/g, '_');
          if (!(SPICE_LEVELS as readonly string[]).includes(v)) throw new Error(`spice_level must be one of ${SPICE_LEVELS.join(', ')}`);
          catalog.spiceLevel = v as any;
        }
        for (const [col2, key] of [['length_cm', 'lengthCm'], ['width_cm', 'widthCm'], ['height_cm', 'heightCm']] as const) {
          const n = numCell(col2);
          if (n !== undefined) {
            if (n < 0 || n > 10_000) throw new Error(`${col2} must be between 0 and 10000`);
            (catalog as any)[key] = n;
          }
        }
        if (cell('ingredients')) catalog.ingredients = cell('ingredients');
        if (cell('may_contain')) catalog.mayContain = cell('may_contain').split(/[|;]/).map((x) => x.trim()).filter(Boolean);
        if (cell('serving_size')) catalog.servingSize = cell('serving_size');
        if (cell('nutrition')) catalog.nutrition = parseNutritionCell(cell('nutrition')) as any;
        if (cell('country_of_origin')) catalog.countryOfOrigin = cell('country_of_origin');
        if (cell('storage')) catalog.storage = cell('storage');
        if (catalog.sku) {
          if (seenSkus.has(catalog.sku.toLowerCase())) throw new Error(`sku "${catalog.sku}" appears twice in this file`);
          seenSkus.add(catalog.sku.toLowerCase());
        }
        parsed.push({
          catalog,
          category: col(r, 'category'),
          name: col(r, 'name'),
          description: col(r, 'description') || null,
          price,
          pickupPrice: col(r, 'pickup_price') ? parseFloat(col(r, 'pickup_price')) : null,
          taxClassCode: col(r, 'tax_class') || 'HST_ON',
          calories: col(r, 'calories') ? parseInt(col(r, 'calories'), 10) : null,
          allergens: list('allergens'),
          dietaryTags: list('dietary_tags'),
          dayparts,
          prepTimeMin: col(r, 'prep_time_min') ? parseInt(col(r, 'prep_time_min'), 10) : null,
          station: col(r, 'station'),
          available: col(r, 'available') ? !/^(false|0|no)$/i.test(col(r, 'available')) : true,
          imageUrl: col(r, 'image_url') ? cleanImageUrl(col(r, 'image_url'), 'image_url') : null,
          isPopular: /^(true|1|yes)$/i.test(col(r, 'popular')),
          groups: this.parseGroupsCell(col(r, 'modifier_groups')),
        });
      } catch (e: any) {
        errors.push({ row: idx + 2, error: e.message ?? String(e) });
      }
    });
    if (errors.length) throw new BadRequestException({ message: 'CSV has errors - nothing was imported', details: errors });
    // age-restricted products need the store's licence: refuse the whole file up front instead of failing half way
    if (parsed.some((p) => (p.catalog.minAge ?? 0) > 0)) await this.assertMayListAgeRestricted(restaurantId);
    if (dryRun) return { ok: true, dryRun: true, total: parsed.length, mode };

    if (mode === 'replace') {
      const ids = (await this.items.find({ where: { restaurantId }, select: ['id'] })).map((i) => i.id);
      if (ids.length) await this.links.delete({ menuItemId: In(ids) });
      await this.items.delete({ restaurantId });
      const gs = (await this.groups.find({ where: { restaurantId }, select: ['id'] })).map((g) => g.id);
      if (gs.length) await this.options.delete({ groupId: In(gs) });
      await this.groups.delete({ restaurantId });
      await this.categories.delete({ restaurantId });
    }
    const cats = new Map((await this.categories.find({ where: { restaurantId } })).map((c) => [c.name.toLowerCase(), c]));
    const stations = new Map((await this.stations.find({ where: { restaurantId } })).map((s) => [s.name.toLowerCase(), s]));
    const groupCache = new Map((await this.groups.find({ where: { restaurantId } })).map((g) => [g.name.toLowerCase(), g]));
    let created = 0;
    let updated = 0;
    for (const p of parsed) {
      let cat: MenuCategory | undefined;
      if (p.category) {
        cat = cats.get(p.category.toLowerCase());
        if (!cat) {
          cat = await this.createCategory(restaurantId, { name: p.category });
          cats.set(p.category.toLowerCase(), cat);
        }
      }
      let station: KitchenStation | undefined;
      if (p.station) {
        station = stations.get(p.station.toLowerCase());
        if (!station) {
          station = await this.stations.save(this.stations.create({ restaurantId, name: p.station, sortOrder: stations.size }));
          stations.set(p.station.toLowerCase(), station);
        }
      }
      // the SKU identifies a product when the file has one; otherwise category + name does
      const existing =
        (p.catalog.sku ? await this.items.findOne({ where: { restaurantId, sku: p.catalog.sku } }) : null) ??
        (await this.items.findOne({ where: { restaurantId, name: p.name, categoryId: cat?.id ?? IsNull() } }));
      const catalogFields = await this.catalogFields(restaurantId, p.catalog, existing ?? undefined);
      const fields: Partial<MenuItem> = {
        ...catalogFields,
        categoryId: cat?.id ?? null,
        description: p.description,
        price: p.price,
        pickupPrice: p.pickupPrice,
        taxClassCode: p.taxClassCode,
        calories: p.calories,
        allergens: p.allergens,
        dietaryTags: p.dietaryTags,
        dayparts: p.dayparts,
        prepTimeMin: p.prepTimeMin,
        stationId: station?.id ?? null,
        available: p.available,
        ...(p.imageUrl ? { imageUrl: p.imageUrl } : {}),
        isPopular: p.isPopular,
      };
      let item: MenuItem;
      if (existing) {
        Object.assign(existing, fields);
        existing.name = p.name; // matched by SKU: the file's name wins
        item = await this.items.save(existing);
        updated++;
      } else {
        item = await this.items.save(this.items.create({ restaurantId, name: p.name, sortOrder: created + updated, ...fields }));
        created++;
      }
      const gids: string[] = [];
      for (const gdef of p.groups) {
        let g = groupCache.get(gdef.name.toLowerCase());
        if (!g) {
          const made = await this.createGroup(restaurantId, {
            name: gdef.name,
            required: gdef.required,
            minSelect: gdef.min,
            maxSelect: gdef.max,
            options: gdef.options.map((o: any) => ({ name: o.name, priceDelta: o.price })),
          });
          g = made as ModifierGroup;
          groupCache.set(gdef.name.toLowerCase(), g);
        }
        gids.push(g.id);
      }
      if (gids.length || !existing) await this.setItemGroups(restaurantId, item.id, gids);
    }
    return { ok: true, created, updated, total: parsed.length, mode };
  }
}
