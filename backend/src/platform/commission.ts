import { BadRequestException, Body, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Put, Query, Req } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { IsDateString, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { DataSource, Repository } from 'typeorm';
import { CommissionTier, Restaurant } from '../database/entities';
import { AdminController, Permission } from '../common/decorators';
import { Action, FulfilmentMode, Module as Mod } from '../common/enums';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Commission is charged per METHOD: what the customer chose decides the rate.
 *   delivery   a FORKSY driver delivers (default 20%)
 *   pickup     the customer collects in store (default 8%)
 *   ownDriver  the store's own courier delivers (default 12%)
 * Rate = the store's own override -> the store's tier -> the tier for its kind of store -> the default tier -> the platform default below.
 */
export type CommissionMethod = 'delivery' | 'pickup' | 'ownDriver';
export type CommissionSource = 'RESTAURANT_OVERRIDE' | 'RESTAURANT_TIER' | 'STORE_TYPE_TIER' | 'DEFAULT_TIER' | 'PLATFORM_DEFAULT';
export interface CommissionDefaults {
  delivery: number;
  pickup: number;
  ownDriver: number;
}

const FALLBACK: CommissionDefaults = { delivery: 20, pickup: 8, ownDriver: 12 };
const SETTING_KEYS: Record<CommissionMethod, string> = { delivery: 'commission.default.deliveryPct', pickup: 'commission.default.pickupPct', ownDriver: 'commission.default.ownDriverPct' };

export const methodOf = (f: FulfilmentMode | string): CommissionMethod => (f === FulfilmentMode.PICKUP || f === 'PICKUP' ? 'pickup' : f === FulfilmentMode.OWN_DRIVER || f === 'OWN_DRIVER' ? 'ownDriver' : 'delivery');

/** The platform rates used when a store has no override and no tier (admin setting `commission.default.*Pct`). */
export function commissionDefaults(settings: SettingsService): CommissionDefaults {
  const get = (m: CommissionMethod) => {
    const n = Number(settings.get(SETTING_KEYS[m], FALLBACK[m]));
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : FALLBACK[m];
  };
  return { delivery: get('delivery'), pickup: get('pickup'), ownDriver: get('ownDriver') };
}

const tierPctOf = (t: CommissionTier, m: CommissionMethod) => (m === 'pickup' ? t.pickupPct : m === 'ownDriver' ? t.ownDriverPct : t.deliveryPct);
const overrideOf = (r: Restaurant | null, m: CommissionMethod) => (!r ? null : m === 'pickup' ? r.pickupCommissionPct : m === 'ownDriver' ? r.ownDriverCommissionPct : r.deliveryCommissionPct);

/** The one place that decides a commission rate (orders use it at checkout, the admin screens use it to show the same answer). */
export async function resolveCommission(r: Restaurant | null, method: CommissionMethod, tiers: Repository<CommissionTier>, defaults: CommissionDefaults): Promise<{ pct: number; source: CommissionSource; tier: { id: string; name: string } | null }> {
  let tier: CommissionTier | null = null;
  let tierSource: CommissionSource = 'RESTAURANT_TIER';
  if (r?.commissionTierId) tier = await tiers.findOne({ where: { id: r.commissionTierId } });
  if (!tier && r?.storeType) {
    tier = (await tiers.find({ where: { active: true } })).find((t) => (t.defaultForStoreTypes ?? []).includes(r.storeType)) ?? null;
    tierSource = 'STORE_TYPE_TIER';
  }
  if (!tier) {
    tier = await tiers.findOne({ where: { isDefault: true, active: true } });
    tierSource = 'DEFAULT_TIER';
  }
  const own = overrideOf(r, method);
  if (own !== null && own !== undefined) return { pct: Number(own), source: 'RESTAURANT_OVERRIDE', tier: tier ? { id: tier.id, name: tier.name } : null };
  if (tier) return { pct: Number(tierPctOf(tier, method)), source: tierSource, tier: { id: tier.id, name: tier.name } };
  return { pct: defaults[method], source: 'PLATFORM_DEFAULT', tier: null };
}

export class CommissionDefaultsDto {
  @IsOptional() @IsNumber() @Min(0) @Max(100) delivery?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) pickup?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) ownDriver?: number;
}

export class CommissionSummaryQuery {
  /** default: 30 days ago */
  @IsOptional() @IsDateString() from?: string;
  /** default: now */
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() restaurantId?: string;
  @IsOptional() @IsUUID() cityId?: string;
}

@Injectable()
export class CommissionService {
  constructor(
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(CommissionTier) private tiers: Repository<CommissionTier>,
    @InjectDataSource() private ds: DataSource,
    private settings: SettingsService,
    private audit: AuditService,
  ) {}

  getDefaults() {
    return { ...commissionDefaults(this.settings), note: 'Used when a store has no override and no tier. A store override or tier wins over these.' };
  }

  async setDefaults(dto: CommissionDefaultsDto, req: any) {
    const before = commissionDefaults(this.settings);
    for (const m of ['delivery', 'pickup', 'ownDriver'] as CommissionMethod[]) if (dto[m] !== undefined) await this.settings.set(SETTING_KEYS[m], dto[m]);
    const after = commissionDefaults(this.settings);
    await this.audit.logReq(req, 'commission.defaults_change', 'settings', undefined, before, after);
    return this.getDefaults();
  }

  /** What a store pays for each method, and where every rate comes from. */
  async effective(restaurantId: string) {
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    if (!r) throw new NotFoundException('Store not found');
    const defaults = commissionDefaults(this.settings);
    const out: Record<string, unknown> = {};
    for (const m of ['delivery', 'pickup', 'ownDriver'] as CommissionMethod[]) out[m] = await resolveCommission(r, m, this.tiers, defaults);
    return { restaurantId: r.id, name: r.name, storeType: r.storeType, rates: out };
  }

  /** Commission earned on completed orders, split by method (delivery / pickup / own driver). */
  async summary(q: CommissionSummaryQuery) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (!(from < to)) throw new BadRequestException('"from" must be before "to"');
    const params: unknown[] = [from, to];
    let where = `o.status IN ('DELIVERED','COLLECTED') AND o."createdAt" >= $1 AND o."createdAt" < $2`;
    if (q.restaurantId) {
      params.push(q.restaurantId);
      where += ` AND o."restaurantId" = $${params.length}`;
    }
    if (q.cityId) {
      params.push(q.cityId);
      where += ` AND o."cityId" = $${params.length}`;
    }
    const rows: { fulfilment: string; orders: number; subtotal: number; commission: number }[] = await this.ds.query(
      `SELECT o.fulfilment, COUNT(*)::int AS orders, COALESCE(SUM(o.subtotal),0)::float AS subtotal, COALESCE(SUM(o."commissionAmount"),0)::float AS commission FROM orders o WHERE ${where} GROUP BY o.fulfilment`,
      params,
    );
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const methods = (['delivery', 'pickup', 'ownDriver'] as CommissionMethod[]).map((m) => {
      const row = rows.find((x) => methodOf(x.fulfilment) === m);
      const subtotal = r2(row?.subtotal ?? 0);
      const commission = r2(row?.commission ?? 0);
      return { method: m, orders: row?.orders ?? 0, subtotal, commission, averageRatePct: subtotal ? r2((commission / subtotal) * 100) : 0 };
    });
    const subtotal = r2(methods.reduce((s, x) => s + x.subtotal, 0));
    const commission = r2(methods.reduce((s, x) => s + x.commission, 0));
    return { from: from.toISOString(), to: to.toISOString(), methods, total: { orders: methods.reduce((s, x) => s + x.orders, 0), subtotal, commission, averageRatePct: subtotal ? r2((commission / subtotal) * 100) : 0 } };
  }
}

/**
 * Commission controls for the admin team (Pricing permission): platform default rates per method, a store's effective rates and where they come from,
 * and the commission earned per method. A store's own rates / tier are changed with PATCH /admin/pricing/restaurants/:id/commission,
 * tiers with /admin/commission-tiers.
 */
@AdminController('commission')
export class CommissionController {
  constructor(private svc: CommissionService) {}

  @Get('defaults') @Permission(Mod.PRICING, Action.VIEW)
  defaults() {
    return this.svc.getDefaults();
  }

  @Put('defaults') @Permission(Mod.PRICING, Action.EDIT)
  setDefaults(@Body() dto: CommissionDefaultsDto, @Req() req: any) {
    return this.svc.setDefaults(dto, req);
  }

  @Get('restaurants/:restaurantId') @Permission(Mod.PRICING, Action.VIEW)
  effective(@Param('restaurantId', ParseUUIDPipe) restaurantId: string) {
    return this.svc.effective(restaurantId);
  }

  @Get('summary') @Permission(Mod.PRICING, Action.VIEW)
  summary(@Query() q: CommissionSummaryQuery) {
    return this.svc.summary(q);
  }
}
