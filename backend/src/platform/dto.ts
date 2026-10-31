import { applyDecorators } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { PageQueryDto } from '../common/pagination';
import { STORE_TYPES } from '../common/store-types';

/** Optional number with bounds. */
const Num = (min = 0, max?: number) =>
  applyDecorators(IsOptional(), IsNumber({ allowNaN: false, allowInfinity: false }), Min(min), ...(max !== undefined ? [Max(max)] : []));
const Int = (min = 0, max?: number) =>
  applyDecorators(IsOptional(), IsInt(), Min(min), ...(max !== undefined ? [Max(max)] : []));
// ------------------------------------------------------------------ cities
export class CityTuningDto {
  @IsOptional() @IsString() @MaxLength(60) province?: string;
  @IsOptional() @IsString() @MaxLength(60) country?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  // customer fees
  @Num(0, 100) baseDeliveryFee?: number;
  @Num(0, 20) perKmFee?: number;
  @Num(0, 50) serviceFeePct?: number;
  @Num(0, 100) serviceFeeCap?: number;
  @Num(0, 200) smallOrderThreshold?: number;
  @Num(0, 50) smallOrderFee?: number;
  @Num(1, 5) busyMultiplier?: number;
  // driver pay
  @Num(0, 50) driverBaseFare?: number;
  @Num(0, 10) driverPerKm?: number;
  @Num(0, 5) driverPerWaitMin?: number;
  @Int(0, 60) driverFreeWaitMin?: number;
  @Num(0, 50) driverMinPerTrip?: number;
  // dispatch
  @Int(5, 300) offerTimeoutSec?: number;
  @Int(1, 20) offersBeforeWiden?: number;
  @Int(0, 10) maxRadiusWidenings?: number;
  @Num(0, 20) radiusWidenStepKm?: number;
  @Num(0, 50) widenBoostAmount?: number;
  @Int(1, 5) batchMaxOrders?: number;
  @Num(0, 20) batchMaxDropDistanceKm?: number;
  @Int(0, 60) batchMaxExtraMinutes?: number;
  // timers
  @Int(30, 3600) autoRejectSeconds?: number;
  @Int(1, 120) pickupOverdueMin?: number;
  @Int(1, 120) lateOnTheWayGraceMin?: number;
  @Int(5, 240) veryLateMin?: number;
  @Num(0, 1000000) payoutReleaseThreshold?: number;
}

export class CreateCityDto extends CityTuningDto {
  @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsNumber() @Min(-90) @Max(90) centerLat: number;
  @IsNumber() @Min(-180) @Max(180) centerLng: number;
}

export class UpdateCityDto extends CityTuningDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) centerLat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) centerLng?: number;
}

export class CityQuery extends PageQueryDto {
  @IsOptional() @IsIn(['true', 'false']) active?: string;
}

// ------------------------------------------------------------------ zones
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class DayHoursDto {
  @Matches(HHMM) open: string;
  @Matches(HHMM) close: string;
  @IsOptional() @IsBoolean() closed?: boolean;
}

export class ZoneTuningDto {
  /** [[lat,lng], ...] at least 3 points */
  @IsOptional() @IsArray() @ArrayMinSize(3) @ArrayMaxSize(500) polygon?: [number, number][];
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsNumber() @Min(-90) @Max(90) centerLat?: number;
  @IsOptional() @IsNumber() @Min(-180) @Max(180) centerLng?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) deliveryRadiusKm?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(200) maxDeliveryRadiusKm?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) baseFee?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(20) perKmFee?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(500) minimumOrder?: number | null;
  @IsOptional() @IsObject() serviceHours?: Record<string, DayHoursDto>;
  @IsOptional() @IsBoolean() busyMode?: boolean;
  /** Open for drivers to join (they pick it themselves on the driver app's map, up to 4 zones each). */
  @IsOptional() @IsBoolean() driversOpen?: boolean;
  @IsOptional() @IsNumber() @Min(1) @Max(5) busyMultiplier?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) busyRadiusKm?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(1000) targetDrivers?: number;
}

export class CreateZoneDto extends ZoneTuningDto {
  @IsUUID() cityId: string;
  @IsString() @MinLength(2) @MaxLength(80) name: string;
}

export class UpdateZoneDto extends ZoneTuningDto {
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
}

export class ZoneQuery extends PageQueryDto {
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsIn(['true', 'false']) active?: string;
  @IsOptional() @IsIn(['true', 'false']) busy?: string;
}

export class BusyModeDto {
  @IsBoolean() enabled: boolean;
  @IsOptional() @IsNumber() @Min(1) @Max(5) multiplier?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) radiusKm?: number | null;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

export class ServiceHoursDto {
  @IsObject() serviceHours: Record<string, DayHoursDto>;
}

export class ResolveDto {
  @IsNumber() @Min(-90) @Max(90) lat: number;
  @IsNumber() @Min(-180) @Max(180) lng: number;
}

export class PublicResolveQuery {
  @Type(() => Number) @IsNumber() @Min(-90) @Max(90) lat: number;
  @Type(() => Number) @IsNumber() @Min(-180) @Max(180) lng: number;
}

// ------------------------------------------------------------------ tax classes
export class CreateTaxClassDto {
  @IsString() @Matches(/^[A-Z0-9_]{2,40}$/, { message: 'code must be UPPER_SNAKE_CASE' }) code: string;
  @IsString() @MinLength(2) name: string;
  @IsNumber() @Min(0) @Max(50) ratePct: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
export class UpdateTaxClassDto {
  @IsOptional() @IsString() @MinLength(2) name?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(50) ratePct?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

// ------------------------------------------------------------------ commission tiers
export class TierFieldsDto {
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @Num(0, 60) deliveryPct?: number;
  @Num(0, 60) pickupPct?: number;
  @Num(0, 60) ownDriverPct?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  /** store types that use this tier when a location has none of its own (e.g. a grocery tier with thinner rates) */
  @IsOptional() @IsArray() @IsIn(STORE_TYPES, { each: true }) defaultForStoreTypes?: string[];
}
export class CreateTierDto extends TierFieldsDto {
  @IsString() @MinLength(2) @MaxLength(60) name: string;
}
export class UpdateTierDto extends TierFieldsDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(60) name?: string;
}
export class ApplyTierDto {
  /** explicit restaurants; or filter by city/zone/current tier (at least one selector required) */
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) restaurantIds?: string[];
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsUUID() fromTierId?: string;
  /** also clear per-restaurant % overrides so the tier rates take effect (default false) */
  @IsOptional() @IsBoolean() clearOverrides?: boolean;
  /** dry run: only count the matching restaurants */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

/** null (or omitted) = fall back to the tier. Send `null` explicitly to clear. */
export class RestaurantCommissionDto {
  @IsOptional() @IsUUID() commissionTierId?: string | null;
  @IsOptional() @IsNumber() @Min(0) @Max(60) deliveryCommissionPct?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(60) pickupCommissionPct?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(60) ownDriverCommissionPct?: number | null;
}

export class OverridesQuery extends PageQueryDto {
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsUUID() tierId?: string;
}

// ------------------------------------------------------------------ cuisines
export class CreateCuisineDto {
  @IsString() @MinLength(2) @MaxLength(60) name: string;
  @IsOptional() @IsString() @Matches(/^[a-z0-9-]{2,60}$/, { message: 'slug must be lowercase letters, digits, dashes' }) slug?: string;
  @IsOptional() @IsString() iconUrl?: string | null;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
export class UpdateCuisineDto extends PartialType(CreateCuisineDto) {}
export class ReorderDto {
  @IsArray() @ArrayMinSize(1) @IsUUID('all', { each: true }) ids: string[];
}
export class CuisineQuery extends PageQueryDto {
  @IsOptional() @IsIn(['true', 'false']) active?: string;
}

// ------------------------------------------------------------------ pricing simulator
export class SimItemDto {
  @IsUUID() menuItemId: string;
  @IsInt() @Min(1) quantity: number;
  @IsOptional() @IsArray() modifierOptionIds?: string[];
}
export class DeliveryPointDto {
  @IsNumber() lat: number;
  @IsNumber() lng: number;
}
export class SimulateDto {
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsUUID() zoneId?: string;
  @IsOptional() @IsUUID() restaurantId?: string;
  @IsOptional() @IsIn(['DELIVERY', 'PICKUP']) type?: 'DELIVERY' | 'PICKUP';
  @IsOptional() @IsIn(['PLATFORM_DRIVER', 'OWN_DRIVER', 'PICKUP']) fulfilment?: string;
  /** food subtotal in CAD (manual mode) */
  @IsOptional() @IsNumber() @Min(0) subtotal?: number;
  /** restaurant -> customer distance (km) */
  @IsOptional() @IsNumber() @Min(0) distanceKm?: number;
  /** driver -> restaurant distance (km) used for driver pay */
  @IsOptional() @IsNumber() @Min(0) pickupKm?: number;
  @IsOptional() @IsNumber() @Min(0) waitMin?: number;
  @IsOptional() @IsNumber() @Min(0) tip?: number;
  @IsOptional() @IsNumber() @Min(0) discount?: number;
  /** who funds the discount */
  @IsOptional() @IsIn(['PLATFORM', 'RESTAURANT']) discountFundedBy?: 'PLATFORM' | 'RESTAURANT';
  /** simulate busy mode (zone busyMode is used when zone is given and busy) */
  @IsOptional() @IsBoolean() busy?: boolean;
  @IsOptional() @IsString() taxClassCode?: string;
  /** what-if overrides */
  @IsOptional() @IsUUID() commissionTierId?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) commissionPct?: number;
  /** real-basket mode: delegates to PricingService.quote when available */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SimItemDto) items?: SimItemDto[];
  @IsOptional() @ValidateNested() @Type(() => DeliveryPointDto) deliveryAddress?: DeliveryPointDto;
  @IsOptional() @IsString() promoCode?: string;
}

// ------------------------------------------------------------------ incidents
export class CreateIncidentDto {
  @IsString() @MinLength(3) @MaxLength(200) title: string;
  @IsIn(['P1', 'P2', 'P3']) severity: 'P1' | 'P2' | 'P3';
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsString() @MaxLength(300) bannerMessage?: string;
  @IsOptional() @IsBoolean() bannerActive?: boolean;
  @IsOptional() @IsBoolean() pauseNewOrders?: boolean;
  @IsOptional() @IsUUID() ownerId?: string;
}
export class UpdateIncidentDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsIn(['P1', 'P2', 'P3']) severity?: 'P1' | 'P2' | 'P3';
  @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @IsOptional() @IsUUID() ownerId?: string | null;
}
export class IncidentQuery extends PageQueryDto {
  @IsOptional() @IsIn(['OPEN', 'MITIGATED', 'RESOLVED', 'ACTIVE']) status?: string;
  @IsOptional() @IsIn(['P1', 'P2', 'P3']) severity?: string;
  @IsOptional() @IsIn(['true', 'false']) reportOverdue?: string;
}
export class TimelineDto {
  @IsString() @MinLength(1) @MaxLength(2000) note: string;
}
export class BannerDto {
  @IsBoolean() active: boolean;
  @IsOptional() @IsString() @MaxLength(300) message?: string;
}
export class PauseOrdersDto {
  @IsBoolean() paused: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
export class ResolveIncidentDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}
export class ReportDto {
  @IsString() @MinLength(20) @MaxLength(20000) report: string;
}

// ------------------------------------------------------------------ checklists
export class ChecklistItemTemplateDto {
  @IsString() @Matches(/^[a-z0-9_]{2,50}$/) key: string;
  @IsString() @MinLength(3) @MaxLength(300) label: string;
}
export class ChecklistTemplateDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @ValidateNested({ each: true }) @Type(() => ChecklistItemTemplateDto) items: ChecklistItemTemplateDto[];
}
export class ChecklistQuery extends PageQueryDto {
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsIn(['OPEN', 'CLOSE']) kind?: 'OPEN' | 'CLOSE';
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsIn(['true', 'false']) completed?: string;
}
export class CurrentChecklistQuery {
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}
export class ChecklistItemDto {
  @IsBoolean() done: boolean;
}
export class ChecklistNotesDto {
  @IsString() @MaxLength(4000) notes: string;
}
export class CompleteChecklistDto {
  /** complete even if some items are still open */
  @IsOptional() @IsBoolean() force?: boolean;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

// ------------------------------------------------------------------ supply
export class SupplyQuery {
  @IsOptional() @IsUUID() cityId?: string;
}
