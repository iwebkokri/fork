import { Type, Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../common/pagination';
import { MIN_AGES, SELL_BY, STORE_TYPES, TEMPERATURES, WEIGHT_UNITS } from '../common/store-types';
import { SPICE_LEVELS } from '../common/menu-details';

// ------------------------------------------------------------------ menu
export class CategoryDto {
  @IsString() name: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsArray() dayparts?: string[];
}
export class UpdateCategoryDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsArray() dayparts?: string[];
}

/** Catalog fields of a product (groceries / retail). All optional: a restaurant dish never needs one of them. docs/store-types.md */
export class CatalogFieldsDto {
  /** the store's own product code, unique within the store */
  @IsOptional() @IsString() @MaxLength(64) sku?: string | null;
  /** UPC / EAN / GTIN: 6 to 14 digits */
  @IsOptional() @IsString() @Matches(/^[0-9]{6,14}$/, { message: 'barcode must be 6 to 14 digits (UPC / EAN / GTIN)' }) barcode?: string | null;
  @IsOptional() @IsString() @MaxLength(80) brand?: string | null;
  /** "500 g", "12 x 355 ml" */
  @IsOptional() @IsString() @MaxLength(60) packSize?: string | null;
  /** UNIT (default) or WEIGHT: then `price` is per weightUnit and the customer orders steps of stepSize (weighed when picked) */
  @IsOptional() @IsIn(SELL_BY) sellBy?: 'UNIT' | 'WEIGHT';
  @IsOptional() @IsIn(WEIGHT_UNITS) weightUnit?: 'KG' | 'LB';
  /** weight of one step of a weighed product in weightUnit (0.5 = half a kg per step) */
  @IsOptional() @IsNumber() @Min(0.001) @Max(1000) stepSize?: number;
  /** keep the number on hand: the product sells out at 0 */
  @IsOptional() @IsBoolean() trackStock?: boolean;
  /** pieces on hand (UNIT) or weight on hand in weightUnit (WEIGHT) */
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) stockQty?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) lowStockThreshold?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(99) maxPerOrder?: number | null;
  /** 0 = none, else 18 / 19 / 21: the customer confirms their age at checkout and ID is checked at hand-over */
  @IsOptional() @IsIn(MIN_AGES) minAge?: number;
  @IsOptional() @IsIn(TEMPERATURES) temperature?: 'AMBIENT' | 'CHILLED' | 'FROZEN';

  // ---- menu details (any store type) ----
  /** NONE | MILD | MEDIUM | HOT | EXTRA_HOT; null = not stated */
  @IsOptional() @IsIn([...SPICE_LEVELS, null]) spiceLevel?: 'NONE' | 'MILD' | 'MEDIUM' | 'HOT' | 'EXTRA_HOT' | null;
  /** size in centimetres */
  @IsOptional() @IsNumber() @Min(0) @Max(10_000) lengthCm?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000) widthCm?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(10_000) heightCm?: number | null;
  @IsOptional() @IsString() @MaxLength(2000) ingredients?: string | null;
  /** allergens that may be present through cross-contact */
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) mayContain?: string[];
  /** per serving: fatG, satFatG, carbsG, sugarG, fibreG, proteinG, sodiumMg */
  @IsOptional() @IsObject() nutrition?: Record<string, number> | null;
  @IsOptional() @IsString() @MaxLength(60) servingSize?: string | null;
  @IsOptional() @IsString() @MaxLength(60) countryOfOrigin?: string | null;
  @IsOptional() @IsString() @MaxLength(200) storage?: string | null;
}

export class ItemDto extends CatalogFieldsDto {
  @IsString() name: string;
  @IsNumber() @Min(0) price: number;
  @IsOptional() @IsString() description?: string | null;
  /** the featured photo: a picture uploaded with POST /uploads (JPG, PNG, WebP, GIF) or an https:// picture address; null removes it */
  @IsOptional() @IsString() imageUrl?: string | null;
  /** more photos (at most 8, replaces the current gallery); [] clears it */
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) galleryUrls?: string[];
  @IsOptional() @IsNumber() @Min(0) pickupPrice?: number | null;
  @IsOptional() @IsString() taxClassCode?: string | null;
  @IsOptional() @IsInt() @Min(0) calories?: number | null;
  @IsOptional() @IsArray() allergens?: string[];
  @IsOptional() @IsArray() dietaryTags?: string[];
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsArray() dayparts?: string[];
  @IsOptional() @IsBoolean() isCombo?: boolean;
  /** [{ menuItemId, quantity }] */
  @IsOptional() @IsArray() comboItems?: { menuItemId: string; quantity: number }[];
  @IsOptional() @IsString() categoryId?: string | null;
  @IsOptional() @IsString() stationId?: string | null;
  @IsOptional() @IsInt() @Min(1) prepTimeMin?: number | null;
  @IsOptional() @IsBoolean() isPopular?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  /** modifier group ids attached to this item (replaces the current set) */
  @IsOptional() @IsArray() groupIds?: string[];
}
export class UpdateItemDto extends CatalogFieldsDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() imageUrl?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @IsString({ each: true }) galleryUrls?: string[];
  @IsOptional() @IsNumber() @Min(0) pickupPrice?: number | null;
  @IsOptional() @IsString() taxClassCode?: string | null;
  @IsOptional() @IsInt() @Min(0) calories?: number | null;
  @IsOptional() @IsArray() allergens?: string[];
  @IsOptional() @IsArray() dietaryTags?: string[];
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsArray() dayparts?: string[];
  @IsOptional() @IsBoolean() isCombo?: boolean;
  @IsOptional() @IsArray() comboItems?: { menuItemId: string; quantity: number }[];
  @IsOptional() @IsString() categoryId?: string | null;
  @IsOptional() @IsString() stationId?: string | null;
  @IsOptional() @IsInt() @Min(1) prepTimeMin?: number | null;
  @IsOptional() @IsBoolean() isPopular?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsArray() groupIds?: string[];
}

export class ModifierOptionDto {
  @IsString() name: string;
  @IsOptional() @IsNumber() priceDelta?: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
export class UpdateOptionDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() priceDelta?: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() available?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class ModifierGroupDto {
  @IsString() name: string;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsInt() @Min(0) minSelect?: number;
  @IsOptional() @IsInt() @Min(1) maxSelect?: number;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsArray() options?: ModifierOptionDto[];
  /** items to attach this group to */
  @IsOptional() @IsArray() itemIds?: string[];
}
export class UpdateGroupDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsInt() @Min(0) minSelect?: number;
  @IsOptional() @IsInt() @Min(1) maxSelect?: number;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsArray() itemIds?: string[];
}

export class ReorderDto {
  @IsArray() ids: string[];
}
export class SetGroupsDto {
  @IsArray() groupIds: string[];
}
export class EightySixDto {
  /** ISO date; default = next day 04:00 restaurant time */
  @IsOptional() @IsString() restockAt?: string | null;
  /** false = stay unavailable until manually restocked */
  @IsOptional() @IsBoolean() untilTomorrow?: boolean;
  /** or restock after N hours */
  @IsOptional() @IsInt() @Min(1) @Max(72) hours?: number;
}
/** Paged product list of one store (portal catalog screen). */
export class ProductListQuery {
  @IsOptional() @IsString() restaurantId?: string;
  /** search over name, SKU, barcode and brand */
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  /** same as q (the name the portal's paged lists use) */
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  /** a category id, or "none" for products without one */
  @IsOptional() @IsString() categoryId?: string;
  /** out | low | in | tracked | untracked */
  @IsOptional() @IsIn(['out', 'low', 'in', 'tracked', 'untracked']) stock?: string;
  @IsOptional() @IsIn(['true', 'false']) available?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
  @IsOptional() @IsIn(['name', 'price', 'stock', 'updated', 'sku', 'sort']) sortBy?: string;
  @IsOptional() @IsIn(['ASC', 'DESC', 'asc', 'desc']) sortDir?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() limit?: string;
}

/** Stock level changes by SKU or barcode (what a POS / inventory system sends): set an absolute level or add a delta. */
export class StockUpdateDto {
  /** only the listed products change; products that are not listed keep their stock */
  @IsArray() updates: StockUpdateRowDto[];
}
export class StockUpdateRowDto {
  @IsOptional() @IsString() @MaxLength(64) sku?: string;
  @IsOptional() @IsString() @MaxLength(32) barcode?: string;
  @IsOptional() @IsString() itemId?: string;
  /** absolute stock level */
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) stockQty?: number;
  /** or a change (+ received, - written off) */
  @IsOptional() @IsNumber() @Min(-10_000_000) @Max(10_000_000) delta?: number;
  @IsOptional() @IsBoolean() available?: boolean;
}
export class CsvImportDto {
  @IsString() @MaxLength(1_500_000) csv: string;
  @IsOptional() @IsIn(['merge', 'replace']) mode?: 'merge' | 'replace';
  /** check the file and report what it would do, change nothing */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}
export class PrepTargetsDto {
  @IsArray() targets: { itemId: string; prepTimeMin: number | null }[];
}

// ------------------------------------------------------------------ store settings (portal + admin)
export class UpdateStoreDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string | null;
  @IsOptional() @IsString() logoUrl?: string | null;
  @IsOptional() @IsString() coverUrl?: string | null;
  @IsOptional() @IsArray() photos?: string[];
  @IsOptional() @IsString() phone?: string | null;
  @IsOptional() @IsEmail() email?: string | null;
  @IsOptional() @IsString() website?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(4) priceLevel?: number;
  @IsOptional() @IsArray() cuisineIds?: string[];
  @IsOptional() @IsString() addressLine1?: string;
  @IsOptional() @IsString() addressLine2?: string | null;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() postalCode?: string;
}

export class FulfilmentDto {
  @IsOptional() @IsBoolean() deliveryEnabled?: boolean;
  @IsOptional() @IsBoolean() ownDeliveryEnabled?: boolean;
  @IsOptional() @IsNumber() @Min(0) ownDeliveryFee?: number;
  @IsOptional() @IsBoolean() pickupEnabled?: boolean;
  @IsOptional() @IsBoolean() scheduledEnabled?: boolean;
  @IsOptional() @IsBoolean() dineInEnabled?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(180) prepTimeMin?: number;
  @IsOptional() @IsInt() @Min(1) @Max(180) pickupPrepTimeMin?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(50) deliveryRadiusKm?: number;
  @IsOptional() @IsNumber() @Min(0) minimumOrder?: number;
  @IsOptional() @IsString() pickupInstructions?: string | null;
  @IsOptional() @IsString() parkingNotes?: string | null;
  @IsOptional() @IsIn([5, 10, 15, 20, 30, 60]) slotMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100) maxOrdersPerSlot?: number;
  @IsOptional() @IsInt() @Min(0) @Max(600) scheduleLeadMin?: number;
  @IsOptional() @IsInt() @Min(30) @Max(900) autoRejectSeconds?: number;
}

export class HoursDto {
  /** one entry per open interval; a day may appear twice (split shifts); closed:true = closed that day */
  @IsArray() hours: { dayOfWeek: number; openTime?: string; closeTime?: string; closed?: boolean }[];
}

export class ClosureDto {
  @IsDateString() startDate: string;
  @IsDateString() endDate: string;
  @IsOptional() @IsBoolean() closed?: boolean;
  @IsOptional() @IsString() openTime?: string | null;
  @IsOptional() @IsString() closeTime?: string | null;
  @IsOptional() @IsString() reason?: string | null;
}

export class StationDto {
  @IsString() @MaxLength(80) name: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}
export class UpdateStationDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

export class BusyModeDto {
  /** add N minutes prep time to all orders (0 clears) */
  @IsOptional() @IsIn([0, 5, 10, 15, 20, 30]) extraPrepMin?: number;
  /** pause new orders for 15/30/60 minutes */
  @IsOptional() @IsIn([15, 30, 60]) pauseMinutes?: number;
}

export class ServiceModeDto {
  @IsIn(['CLOSED', 'PICKUP_ONLY', 'PICKUP_AND_DELIVERY']) mode: 'CLOSED' | 'PICKUP_ONLY' | 'PICKUP_AND_DELIVERY';
  /** optional auto-switch-back to PICKUP_AND_DELIVERY at this time (only with CLOSED / PICKUP_ONLY) */
  @IsOptional() @IsDateString() resumeAt?: string | null;
}

export class MenuAccessRequestDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class MenuAccessDecisionDto {
  /** true = the restaurant may edit its menu; false = read-only */
  @Transform(({ obj }) => obj.allowed) // strict: the string "false" must not become true
  @IsBoolean() allowed: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class MenuAccessQuery {
  @IsOptional() @IsIn(['NOT_ALLOWED', 'REQUESTED', 'ALLOWED']) status?: string;
}

export class AcceptingDto {
  @IsBoolean() accepting: boolean;
}

export class PrinterSettingsDto {
  @IsOptional() @IsBoolean() receiptPrinterEnabled?: boolean;
  @IsOptional() @IsBoolean() kitchenPrinterEnabled?: boolean;
  /** free-form printer config: { receipt: { model, ip, paperWidth }, kitchen: {...}, autoPrint: bool, copies: n } */
  @IsOptional() @IsObject() config?: Record<string, any>;
}

export class NotificationSettingsDto {
  /** { newOrderSound: bool, soundName: string, volume: 0-100, repeatSeconds: n, emailOnNewOrder: bool, smsOnNewOrder: bool, lowStockAlerts: bool } */
  @IsObject() settings: Record<string, any>;
}

export class KdsSettingsDto {
  @IsOptional() @IsBoolean() largeFont?: boolean;
  @IsOptional() @IsBoolean() soundOn?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(60) recentPickedUpMinutes?: number;
  @IsOptional() @IsBoolean() autoLoadPrep?: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(30) capacityTickets?: number;
}

export class TabletHeartbeatDto {
  @IsOptional() @IsString() deviceId?: string;
  @IsOptional() @IsString() appVersion?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) battery?: number;
  @IsOptional() @IsString() network?: string;
  @IsOptional() @IsInt() queuedActions?: number;
}
export class TabletActivateDto {
  @IsString() code: string;
  @IsOptional() @IsString() deviceId?: string;
}

// ------------------------------------------------------------------ orders (portal)
export class AcceptOrderDto {
  /** absolute prep time in minutes (overrides the calculation) */
  @IsOptional() @IsInt() @Min(1) @Max(240) prepTimeMin?: number;
  /** +5 / +10 / +15 on top of the restaurant default prep time */
  @IsOptional() @IsIn([0, 5, 10, 15]) addMinutes?: number;
}
export class RejectOrderDto {
  @IsIn(['BUSY', 'ITEM_UNAVAILABLE', 'CLOSING', 'OTHER']) reason: 'BUSY' | 'ITEM_UNAVAILABLE' | 'CLOSING' | 'OTHER';
  @IsOptional() @IsString() note?: string;
}
export class HandoffDto {
  /** customer collecting in store: the customer's pickup code */
  @IsString() code: string;
}
export class RemoveItemDto {
  @IsOptional() @IsString() reason?: string;
}
/** One step of the picking list of a grocery / retail order (POST /restaurant/orders/:id/items/:itemId/pick). */
export class PickItemDto {
  /** PICKED (found it), OUT_OF_STOCK (refund, the product shows as sold out) or REPLACED (another product instead) */
  @IsIn(['PICKED', 'OUT_OF_STOCK', 'REPLACED']) status: 'PICKED' | 'OUT_OF_STOCK' | 'REPLACED';
  /** weighed products (PICKED): what the scale says, in the product's weight unit. The customer pays for the weight up to the estimate, never more. */
  @IsOptional() @IsNumber() @Min(0.001) @Max(1000) actualWeight?: number;
  /** REPLACED: the product of this store that goes in the bag instead (no required options). The customer pays the LOWER of the two prices. */
  @IsOptional() @IsString() replacementItemId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(99) replacementQuantity?: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

export class ExtendPrepDto {
  @IsInt() @Min(1) @Max(60) addMinutes: number;
}
export class OrdersQuery extends PageQueryDto {
  @IsOptional() @IsString() restaurantId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

export class BumpDto {
  @IsOptional() @IsString() stationId?: string;
}
export class ItemStatusDto {
  @IsIn(['NEW', 'PREPARING', 'READY']) status: 'NEW' | 'PREPARING' | 'READY';
}
export class KdsSyncDto {
  /** offline queue replay: ops are applied in order and are idempotent */
  @IsArray() ops: { opId?: string; op: 'start' | 'bump' | 'ready' | 'item'; orderId: string; stationId?: string; itemId?: string; status?: string; at?: string }[];
}

// ------------------------------------------------------------------ members
export class MemberDto {
  @IsString() firstName: string;
  @IsString() lastName: string;
  @IsEmail() email: string;
  @IsOptional() @IsString() phone?: string;
  @IsIn(['OWNER', 'LOCATION_MANAGER', 'CASHIER', 'KITCHEN']) role: 'OWNER' | 'LOCATION_MANAGER' | 'CASHIER' | 'KITCHEN';
  /** location the member works at (not needed for OWNER). Defaults to the restaurant in the URL / your only location. */
  @IsOptional() @IsString() restaurantId?: string;
  @IsOptional() @IsString() @MinLength(8) password?: string;
}
export class UpdateMemberDto {
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsString() lastName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsIn(['LOCATION_MANAGER', 'CASHIER', 'KITCHEN', 'OWNER']) role?: 'OWNER' | 'LOCATION_MANAGER' | 'CASHIER' | 'KITCHEN';
  @IsOptional() @IsString() restaurantId?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

// ------------------------------------------------------------------ reviews
export class ReplyDto {
  @IsString() @MinLength(1) reply: string;
}
export class ModerateReviewDto {
  @IsIn(['VISIBLE', 'HIDDEN', 'FLAGGED']) status: 'VISIBLE' | 'HIDDEN' | 'FLAGGED';
  /** required: why the review is hidden / flagged / restored (audit-logged) */
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

// ------------------------------------------------------------------ documents
export class DocumentUploadDto {
  @IsString() type: string;
  @IsString() fileUrl: string;
  @IsOptional() @IsString() fileName?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
}
export class ApproveDocDto {
  @IsOptional() @IsDateString() expiresAt?: string;
}
export class RejectDocDto {
  @IsString() @MinLength(3) reason: string;
}

// ------------------------------------------------------------------ admin: restaurants / merchants
export class MerchantDto {
  @IsString() businessName: string;
  @IsOptional() @IsString() legalName?: string;
  @IsOptional() @IsString() hstNumber?: string;
  @IsOptional() @IsEmail() contactEmail?: string;
  @IsOptional() @IsString() contactPhone?: string;
  @IsOptional() @IsString() stripeAccountId?: string;
  @IsOptional() @IsObject() bank?: Record<string, any>;
}
export class UpdateMerchantDto {
  @IsOptional() @IsString() businessName?: string;
  @IsOptional() @IsString() legalName?: string | null;
  @IsOptional() @IsString() hstNumber?: string | null;
  @IsOptional() @IsEmail() contactEmail?: string | null;
  @IsOptional() @IsString() contactPhone?: string | null;
  @IsOptional() @IsString() stripeAccountId?: string | null;
  @IsOptional() @IsObject() bank?: Record<string, any> | null;
}
export class OwnerDto {
  @IsEmail() email: string;
  @IsString() firstName: string;
  @IsString() lastName: string;
  @IsOptional() @IsString() phone?: string;
}

export class CreateRestaurantDto {
  @IsString() name: string;
  /** existing merchant, or supply `merchant` to create one */
  @IsOptional() @IsString() merchantId?: string;
  @IsOptional() @IsObject() merchant?: MerchantDto;
  /** creates an OWNER login (temporary password returned once) */
  @IsOptional() @IsObject() owner?: OwnerDto;
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() addressLine1?: string;
  @IsOptional() @IsString() addressLine2?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() province?: string;
  @IsOptional() @IsString() postalCode?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsString() hstNumber?: string;
  @IsOptional() @IsArray() cuisineIds?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(4) priceLevel?: number;
  @IsOptional() @IsString() commissionTierId?: string;
  /** RESTAURANT (default), CAFE, BAKERY, GROCERY, CONVENIENCE, SPECIALTY: see docs/store-types.md */
  @IsOptional() @IsIn(STORE_TYPES) storeType?: string;
}

export class AdminUpdateRestaurantDto extends UpdateStoreDto {
  @IsOptional() @IsString() slug?: string;
  /** changing the type changes the catalog / picking behaviour, the documents asked for and the commission tier used */
  @IsOptional() @IsIn(STORE_TYPES) storeType?: string;
  @IsOptional() @IsString() province?: string;
  @IsOptional() @IsString() hstNumber?: string | null;
  @IsOptional() @IsBoolean() isFeatured?: boolean;
  @IsOptional() @IsBoolean() isNew?: boolean;
  /** Admin console "Edit restaurant" form (same ceilings as FulfilmentDto) */
  @IsOptional() @IsNumber() @Min(0) minimumOrder?: number;
  @IsOptional() @IsInt() @Min(1) @Max(180) prepTimeMin?: number;
  @IsOptional() @IsIn(['WEEKLY', 'DAILY']) payoutSchedule?: 'WEEKLY' | 'DAILY';
  @IsOptional() @IsNumber() @Min(0) @Max(100) reliabilityScore?: number;
  @IsOptional() @IsBoolean() kdsEnabled?: boolean;
  @IsOptional() @IsString() merchantId?: string;
}

export class RestaurantsQuery extends PageQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() cityId?: string;
  @IsOptional() @IsString() zoneId?: string;
  @IsOptional() @IsString() cuisineId?: string;
  @IsOptional() @IsString() cuisine?: string;
  /** one or more store types, comma separated (GROCERY,CONVENIENCE) */
  @IsOptional() @IsString() storeType?: string;
  /** FOOD (restaurant, cafe, bakery) or RETAIL (grocery, convenience, specialty) */
  @IsOptional() @IsString() vertical?: string;
  @IsOptional() @IsString() merchantId?: string;
  @IsOptional() @IsString() minRating?: string;
  @IsOptional() @IsString() maxRating?: string;
  @IsOptional() @IsString() commissionTierId?: string;
  /** NOT_ALLOWED | REQUESTED | ALLOWED: menu editing permission */
  @IsOptional() @IsIn(['NOT_ALLOWED', 'REQUESTED', 'ALLOWED']) menuAccess?: string;
  /** "true": only restaurants having a document expiring within `expiringDays` (default 30) or already expired */
  @IsOptional() @IsString() hasExpiringDocs?: string;
  @IsOptional() @IsString() expiringDays?: string;
  /** verification state of the business (merchant): UNVERIFIED, PENDING, NEEDS_REVIEW, VERIFIED or REJECTED (docs/verification.md) */
  @IsOptional() @IsIn(['UNVERIFIED', 'PENDING', 'NEEDS_REVIEW', 'VERIFIED', 'REJECTED']) verification?: string;
}

export class MerchantsQuery extends PageQueryDto {
  @IsOptional() @IsString() hasLocations?: string;
  /** verification state: UNVERIFIED, PENDING, NEEDS_REVIEW, VERIFIED or REJECTED (docs/verification.md) */
  @IsOptional() @IsIn(['UNVERIFIED', 'PENDING', 'NEEDS_REVIEW', 'VERIFIED', 'REJECTED']) verification?: string;
}

export class CommissionDto {
  @IsOptional() @IsString() commissionTierId?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) deliveryCommissionPct?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pickupCommissionPct?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) ownDriverCommissionPct?: number | null;
}

export class LocationDto {
  @IsNumber() lat: number;
  @IsNumber() lng: number;
  /** omit to auto-resolve from the polygon */
  @IsOptional() @IsString() zoneId?: string;
  @IsOptional() @IsString() addressLine1?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() postalCode?: string;
}

export class AgreementDto {
  @IsString() signedBy: string;
  @IsOptional() @IsDateString() signedAt?: string;
  @IsOptional() @IsString() documentUrl?: string;
  @IsOptional() @IsString() notes?: string;
}

export class MenuReviewDto {
  @IsOptional() @IsBoolean() approved?: boolean;
  @IsOptional() @IsString() notes?: string;
}

export class TestOrderDto {
  /** 'request' = ask the restaurant to place / expect a test order; 'complete' = mark the test order done */
  @IsIn(['request', 'complete']) action: 'request' | 'complete';
  @IsOptional() @IsString() orderId?: string;
  @IsOptional() @IsString() notes?: string;
}

export class ReasonDto {
  @IsString() @MinLength(3) reason: string;
  /** pause: auto-resume after N hours (optional) */
  @IsOptional() @IsInt() @Min(1) resumeAfterHours?: number;
}
export class OptionalReasonDto {
  @IsOptional() @IsString() reason?: string;
  /** super admin only: skip the go-live checklist */
  @IsOptional() @IsBoolean() force?: boolean;
}

export class BulkDto {
  @IsArray() restaurantIds: string[];
  @IsIn(['pause', 'reactivate', 'suspend', 'apply-tier']) action: 'pause' | 'reactivate' | 'suspend' | 'apply-tier';
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() commissionTierId?: string;
}

export class IntegrationDto {
  @IsString() provider: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsObject() config?: Record<string, any>;
}
export class UpdateIntegrationDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsObject() config?: Record<string, any>;
}

export class ReviewsQuery extends PageQueryDto {
  @IsOptional() @IsString() restaurantId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() maxRating?: string;
  @IsOptional() @IsString() replied?: string;
}

export class StatsQuery {
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() days?: number;
}
