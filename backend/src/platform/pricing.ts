import { BadRequestException, Body, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { City, CommissionTier, Restaurant, TaxClass, Zone } from '../database/entities';
import { AdminController, Permission } from '../common/decorators';
import { Action, FulfilmentMode, Module as Mod, OrderType } from '../common/enums';
import { paginateQb, like } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { commissionDefaults } from './commission';
import { OverridesQuery, RestaurantCommissionDto, SimulateDto } from './dto';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class PlatformPricingService {
  constructor(
    @InjectRepository(City) private cities: Repository<City>,
    @InjectRepository(Zone) private zones: Repository<Zone>,
    @InjectRepository(CommissionTier) private tiers: Repository<CommissionTier>,
    @InjectRepository(TaxClass) private taxes: Repository<TaxClass>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    private moduleRef: ModuleRef,
    private settings: SettingsService,
    private audit: AuditService,
  ) {}

  /** "Pricing & Commission Rules" screen for one city: fees, driver pay, zone overrides, tiers and their usage. */
  async citySummary(cityId: string) {
    const city = await this.cities.findOne({ where: { id: cityId } });
    if (!city) throw new NotFoundException('City not found');
    const [zones, tiers, taxes] = await Promise.all([
      this.zones.find({ where: { cityId }, order: { name: 'ASC' } }),
      this.tiers.find({ order: { deliveryPct: 'ASC' } }),
      this.taxes.find({ order: { code: 'ASC' } }),
    ]);
    const perTier: { id: string; n: string }[] = await this.restaurants
      .createQueryBuilder('r')
      .select('r.commissionTierId', 'id')
      .addSelect('COUNT(*)', 'n')
      .where('r.cityId = :cityId', { cityId })
      .groupBy('r.commissionTierId')
      .getRawMany();
    const tm = new Map(perTier.map((t) => [t.id, +t.n]));
    const overrides = await this.restaurants
      .createQueryBuilder('r')
      .where('r.cityId = :cityId', { cityId })
      .andWhere('(r.deliveryCommissionPct IS NOT NULL OR r.pickupCommissionPct IS NOT NULL OR r.ownDriverCommissionPct IS NOT NULL)')
      .getCount();
    const total = await this.restaurants.count({ where: { cityId } });
    return {
      city: {
        id: city.id,
        name: city.name,
        active: city.active,
        customerFees: {
          baseDeliveryFee: city.baseDeliveryFee,
          perKmFee: city.perKmFee,
          serviceFeePct: city.serviceFeePct,
          serviceFeeCap: city.serviceFeeCap,
          smallOrderThreshold: city.smallOrderThreshold,
          smallOrderFee: city.smallOrderFee,
          busyMultiplier: city.busyMultiplier,
        },
        driverPay: {
          baseFare: city.driverBaseFare,
          perKm: city.driverPerKm,
          perWaitMin: city.driverPerWaitMin,
          freeWaitMin: city.driverFreeWaitMin,
          minPerTrip: city.driverMinPerTrip,
        },
        payoutReleaseThreshold: city.payoutReleaseThreshold,
      },
      zones: zones.map((z) => ({
        id: z.id,
        name: z.name,
        active: z.active,
        baseFee: z.baseFee,
        perKmFee: z.perKmFee,
        minimumOrder: z.minimumOrder,
        busyMode: z.busyMode,
        busyMultiplier: z.busyMultiplier,
        effectiveBaseFee: z.baseFee ?? city.baseDeliveryFee,
        effectivePerKmFee: z.perKmFee ?? city.perKmFee,
        overridesCity: z.baseFee !== null || z.perKmFee !== null,
      })),
      commissionTiers: tiers.map((t) => ({ ...t, restaurantsInCity: tm.get(t.id) ?? 0 })),
      restaurantsWithoutTier: tm.get(null as any) ?? 0,
      restaurantsInCity: total,
      restaurantsWithOverrides: overrides,
      taxClasses: taxes,
    };
  }

  /** Restaurants whose commission differs from their tier (per-restaurant overrides). */
  async overrides(q: OverridesQuery) {
    const qb = this.restaurants
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.commissionTier', 'tier')
      .where('(r.deliveryCommissionPct IS NOT NULL OR r.pickupCommissionPct IS NOT NULL OR r.ownDriverCommissionPct IS NOT NULL)');
    if (q.cityId) qb.andWhere('r.cityId = :c', { c: q.cityId });
    if (q.tierId) qb.andWhere('r.commissionTierId = :t', { t: q.tierId });
    if (q.search) qb.andWhere(new Brackets((w) => w.where('r.name ILIKE :s', { s: like(q.search!) })));
    const page = await paginateQb(qb, q, { sortable: { name: 'r.name', updatedAt: 'r.updatedAt' }, defaultSort: ['r.updatedAt', 'DESC'] });
    const def = await this.defaultTier();
    return {
      ...page,
      data: page.data.map((r) => {
        const t = r.commissionTier ?? def;
        return {
          restaurantId: r.id,
          name: r.name,
          merchantId: r.merchantId,
          cityId: r.cityId,
          status: r.status,
          tier: t ? { id: t.id, name: t.name } : null,
          tierRates: { delivery: t?.deliveryPct ?? null, pickup: t?.pickupPct ?? null, ownDriver: t?.ownDriverPct ?? null },
          overrides: { delivery: r.deliveryCommissionPct, pickup: r.pickupCommissionPct, ownDriver: r.ownDriverCommissionPct },
          effective: {
            delivery: r.deliveryCommissionPct ?? t?.deliveryPct ?? commissionDefaults(this.settings).delivery,
            pickup: r.pickupCommissionPct ?? t?.pickupPct ?? commissionDefaults(this.settings).pickup,
            ownDriver: r.ownDriverCommissionPct ?? t?.ownDriverPct ?? commissionDefaults(this.settings).ownDriver,
          },
        };
      }),
    };
  }

  private defaultTier() {
    return this.tiers.findOne({ where: { isDefault: true } });
  }

  /** Set tier and/or per-restaurant % overrides. `null` clears an override. */
  async setRestaurantCommission(restaurantId: string, dto: RestaurantCommissionDto, req: any) {
    const r = await this.restaurants.findOne({ where: { id: restaurantId } });
    if (!r) throw new NotFoundException('Restaurant not found');
    if (dto.commissionTierId) {
      const t = await this.tiers.findOne({ where: { id: dto.commissionTierId } });
      if (!t || !t.active) throw new BadRequestException('Unknown or inactive commission tier');
    }
    const before = { commissionTierId: r.commissionTierId, deliveryCommissionPct: r.deliveryCommissionPct, pickupCommissionPct: r.pickupCommissionPct, ownDriverCommissionPct: r.ownDriverCommissionPct };
    for (const k of Object.keys(before) as (keyof typeof before)[]) {
      if (dto[k] !== undefined) (r as any)[k] = dto[k];
    }
    await this.restaurants.save(r);
    const after = { commissionTierId: r.commissionTierId, deliveryCommissionPct: r.deliveryCommissionPct, pickupCommissionPct: r.pickupCommissionPct, ownDriverCommissionPct: r.ownDriverCommissionPct };
    await this.audit.logReq(req, 'restaurant.commission_change', 'restaurant', restaurantId, before, after);
    return { restaurantId, ...after };
  }

  // ------------------------------------------------------------ simulator
  /** Optional dependency on OrdersModule's PricingService (may not exist yet). */
  private pricingService(): any | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PricingService } = require('../orders/pricing.service');
      return this.moduleRef.get(PricingService, { strict: false });
    } catch {
      return null;
    }
  }

  async simulate(dto: SimulateDto) {
    // Real basket -> use the production pricing engine when it is available.
    if (dto.items?.length && dto.restaurantId) {
      const svc = this.pricingService();
      if (svc?.quote) {
        const type = dto.type === 'PICKUP' ? OrderType.PICKUP : OrderType.DELIVERY;
        const quote = await svc.quote({
          restaurantId: dto.restaurantId,
          type,
          fulfilment: dto.fulfilment as FulfilmentMode | undefined,
          items: dto.items,
          deliveryAddress: dto.deliveryAddress,
          promoCode: dto.promoCode,
          tip: dto.tip,
        });
        return { source: 'PricingService', quote };
      }
      if (dto.subtotal === undefined) throw new BadRequestException('PricingService is not available; send `subtotal` for a manual simulation');
    }
    if (dto.subtotal === undefined) throw new BadRequestException('subtotal is required (or send items + restaurantId)');
    return { source: 'CITY_CONFIG', ...(await this.computeFromConfig(dto)) };
  }

  private async computeFromConfig(dto: SimulateDto) {
    const restaurant = dto.restaurantId ? await this.restaurants.findOne({ where: { id: dto.restaurantId }, relations: { commissionTier: true } }) : null;
    if (dto.restaurantId && !restaurant) throw new NotFoundException('Restaurant not found');
    const zone = dto.zoneId ? await this.zones.findOne({ where: { id: dto.zoneId } }) : restaurant?.zoneId ? await this.zones.findOne({ where: { id: restaurant.zoneId } }) : null;
    const cityId = dto.cityId ?? zone?.cityId ?? restaurant?.cityId;
    const city = cityId ? await this.cities.findOne({ where: { id: cityId } }) : await this.cities.findOne({ where: { active: true }, order: { createdAt: 'ASC' } });
    if (!city) throw new BadRequestException('No city configured; pass cityId');

    const isPickup = dto.type === 'PICKUP' || dto.fulfilment === 'PICKUP';
    const ownDriver = dto.fulfilment === 'OWN_DRIVER';
    const subtotal = dto.subtotal!;
    const distanceKm = dto.distanceKm ?? 3;
    const busy = dto.busy ?? !!zone?.busyMode;
    const busyMultiplier = busy ? (zone?.busyMode && zone.busyMultiplier > 1 ? zone.busyMultiplier : city.busyMultiplier > 1 ? city.busyMultiplier : zone?.busyMultiplier ?? 1) : 1;

    // customer fees
    const baseFee = zone?.baseFee ?? city.baseDeliveryFee;
    const perKm = zone?.perKmFee ?? city.perKmFee;
    const deliveryFee = isPickup ? 0 : ownDriver ? restaurant?.ownDeliveryFee ?? 0 : r2((baseFee + perKm * distanceKm) * busyMultiplier);
    const serviceFee = r2(Math.min((subtotal * city.serviceFeePct) / 100, city.serviceFeeCap));
    const smallOrderFee = subtotal < city.smallOrderThreshold && subtotal > 0 ? city.smallOrderFee : 0;

    // tax
    const taxCode = dto.taxClassCode ?? this.settings.get('taxes.defaultTaxClass', 'HST_ON');
    const taxClass = (await this.taxes.findOne({ where: { code: taxCode } })) ?? (await this.taxes.findOne({ where: { isDefault: true } }));
    const ratePct = taxClass?.ratePct ?? 13;
    const taxOnFees = this.settings.get<boolean>('taxes.taxOnFees', true);
    const taxOnDelivery = this.settings.get<boolean>('taxes.taxOnDeliveryFee', true);
    const foodTax = r2((subtotal * ratePct) / 100);
    const feeBase = (taxOnDelivery ? deliveryFee : 0) + (taxOnFees ? serviceFee + smallOrderFee : 0);
    const feeTax = r2((feeBase * (taxClass?.ratePct ?? 13)) / 100);
    const taxAmount = r2(foodTax + feeTax);

    // discount
    const discount = Math.min(dto.discount ?? 0, subtotal + deliveryFee);
    const fundedBy = dto.discountFundedBy ?? 'PLATFORM';
    const tip = dto.tip ?? 0;
    const total = r2(subtotal + deliveryFee + serviceFee + smallOrderFee + taxAmount + tip - discount);

    // commission: what-if pct -> what-if tier -> restaurant override -> restaurant tier -> default tier
    let tier: CommissionTier | null = restaurant?.commissionTier ?? null;
    if (dto.commissionTierId) tier = await this.tiers.findOne({ where: { id: dto.commissionTierId } });
    if (!tier) tier = await this.defaultTier();
    const field = isPickup ? 'pickup' : ownDriver ? 'ownDriver' : 'delivery';
    const tierPct = tier ? (field === 'pickup' ? tier.pickupPct : field === 'ownDriver' ? tier.ownDriverPct : tier.deliveryPct) : commissionDefaults(this.settings)[field];
    const ovr = restaurant ? (field === 'pickup' ? restaurant.pickupCommissionPct : field === 'ownDriver' ? restaurant.ownDriverCommissionPct : restaurant.deliveryCommissionPct) : null;
    const commissionPct = dto.commissionPct ?? (dto.commissionTierId ? tierPct : ovr ?? tierPct);
    const commissionAmount = r2((subtotal * commissionPct) / 100);
    const restaurantPromo = fundedBy === 'RESTAURANT' ? Math.min(discount, subtotal) : 0;
    const platformPromo = discount - restaurantPromo;
    const restaurantPayout = r2(subtotal + foodTax - commissionAmount - restaurantPromo);

    // driver pay (city config; SPEC 5.4 pay model)
    let driverPay = 0;
    if (!isPickup && !ownDriver) {
      const pickupKm = dto.pickupKm ?? 1.5;
      const waitMin = Math.max(0, (dto.waitMin ?? 0) - city.driverFreeWaitMin);
      driverPay = r2(Math.max(city.driverBaseFare + city.driverPerKm * (pickupKm + distanceKm) + city.driverPerWaitMin * waitMin, city.driverMinPerTrip));
    }
    const platformRevenue = r2(commissionAmount + deliveryFee + serviceFee + smallOrderFee - platformPromo);
    const contributionMargin = r2(platformRevenue - driverPay);

    return {
      inputs: { cityId: city.id, city: city.name, zoneId: zone?.id ?? null, zone: zone?.name ?? null, restaurantId: restaurant?.id ?? null, type: isPickup ? 'PICKUP' : 'DELIVERY', fulfilment: isPickup ? 'PICKUP' : ownDriver ? 'OWN_DRIVER' : 'PLATFORM_DRIVER', subtotal, distanceKm, busy, busyMultiplier },
      customer: { subtotal, deliveryFee, serviceFee, smallOrderFee, taxAmount, tip, discount, total },
      tax: { classCode: taxClass?.code ?? null, ratePct, foodTax, feeTax },
      restaurant: { commissionPct, commissionSource: dto.commissionPct !== undefined ? 'WHAT_IF_PCT' : dto.commissionTierId ? 'WHAT_IF_TIER' : ovr !== null ? 'RESTAURANT_OVERRIDE' : tier ? 'TIER' : 'DEFAULT', tier: tier ? { id: tier.id, name: tier.name } : null, commissionAmount, promoCost: restaurantPromo, payout: restaurantPayout },
      driver: { pay: driverPay, tipPassThrough: tip },
      platform: { revenue: platformRevenue, promoCost: platformPromo, driverCost: driverPay, contributionMargin, takeRatePct: subtotal ? r2((platformRevenue / subtotal) * 100) : 0 },
    };
  }
}

@AdminController('pricing')
export class PricingController {
  constructor(private svc: PlatformPricingService) {}

  @Get('cities/:cityId') @Permission(Mod.PRICING, Action.VIEW)
  citySummary(@Param('cityId', ParseUUIDPipe) cityId: string) {
    return this.svc.citySummary(cityId);
  }

  @Get('commission-overrides') @Permission(Mod.PRICING, Action.VIEW)
  overrides(@Query() q: OverridesQuery) {
    return this.svc.overrides(q);
  }

  @Patch('restaurants/:restaurantId/commission') @Permission(Mod.PRICING, Action.EDIT)
  setCommission(@Param('restaurantId', ParseUUIDPipe) id: string, @Body() dto: RestaurantCommissionDto, @Req() req: any) {
    return this.svc.setRestaurantCommission(id, dto, req);
  }

  @Post('simulate') @Permission(Mod.PRICING, Action.VIEW)
  simulate(@Body() dto: SimulateDto) {
    return this.svc.simulate(dto);
  }
}
