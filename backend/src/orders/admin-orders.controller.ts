import { Type } from 'class-transformer';
import { Body, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEnum, IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { hasPermission } from '../common/guards';
import { csvRow } from '../common/csv';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminController, CurrentUser, Permission } from '../common/decorators';
import { Action, Module, OrderStatus, RefundChargedTo, RefundType } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { Order, OrderEvent } from '../database/entities';
import { PageQueryDto, like, paginateQb } from '../common/pagination';
import { AuditService } from '../audit/audit.service';
import { OrdersService } from './orders.service';
import { ProofService } from './proof.service';
import { RefundsService } from './refunds.service';
import { actorFor } from './orders.controller';

class RefundBodyDto {
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }) @Min(0.01) @Max(10000) amount: number;
  @IsEnum(RefundChargedTo) chargedTo: RefundChargedTo;
  @IsString() @MaxLength(60) reasonCode: string;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  /** ORIGINAL_PAYMENT (default): back to the payment method the customer used. WALLET: credit the customer's Forky wallet. */
  @IsOptional() @IsIn(['ORIGINAL_PAYMENT', 'WALLET']) refundTo?: 'ORIGINAL_PAYMENT' | 'WALLET';
}
class ForceStatusDto {
  @IsEnum(OrderStatus) status: OrderStatus;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
/** Who at the restaurant agreed (phone / chat / email / in person) when FORKSY cancels an order the restaurant already has. */
class RestaurantApprovalDto {
  @IsString() @MinLength(2) @MaxLength(80) contactName: string;
  @IsIn(['PHONE', 'CHAT', 'EMAIL', 'IN_PERSON']) channel: string;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}
class CancelBodyDto {
  @IsString() @MaxLength(500) reason: string;
  @IsOptional() @ValidateNested() @Type(() => RestaurantApprovalDto) restaurantApproval?: RestaurantApprovalDto;
}
class CancelRequestDto {
  @IsString() @MinLength(3) @MaxLength(500) reason: string;
}
class ReassignBodyDto {
  @IsUUID() driverId: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class ProofReviewDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
class OrdersListQuery extends PageQueryDto {
  @IsOptional() @IsEnum(OrderStatus) status?: OrderStatus;
  @IsOptional() @IsUUID() restaurantId?: string;
  @IsOptional() @IsUUID() cityId?: string;
  @IsOptional() @IsIn(['true', 'false']) isLate?: string;
}

/** SOP: Admin order desk - search/filter/detail/timeline/edit/cancel/refund/reassign/force-status/export (spec §7, §9). */
@AdminController('orders')
export class AdminOrdersController {
  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderEvent) private events: Repository<OrderEvent>,
    private ordersService: OrdersService,
    private refunds: RefundsService,
    private audit: AuditService,
    private proof: ProofService,
  ) {}

  @Get()
  @Permission(Module.ORDERS, Action.VIEW)
  async list(@Query() q: OrdersListQuery, @CurrentUser() user: AuthUser) {
    const { status, restaurantId, cityId, isLate } = q;
    const qb = this.orders.createQueryBuilder('o');
    if (user.scopeCityIds?.length) qb.andWhere('o.cityId IN (:...scopeCities)', { scopeCities: user.scopeCityIds });
    if (user.scopeZoneIds?.length) qb.andWhere('o.zoneId IN (:...scopeZones)', { scopeZones: user.scopeZoneIds });
    if (q.search) qb.andWhere('(o.code ILIKE :s)', { s: like(q.search) });
    if (status) qb.andWhere('o.status = :status', { status });
    if (restaurantId) qb.andWhere('o.restaurantId = :restaurantId', { restaurantId });
    if (cityId) qb.andWhere('o.cityId = :cityId', { cityId });
    if (isLate !== undefined) qb.andWhere('o.isLate = :isLate', { isLate: isLate === 'true' });
    return paginateQb(qb, q, { sortable: { createdAt: 'o.createdAt', total: 'o.total', status: 'o.status' }, defaultSort: ['o.createdAt', 'DESC'] });
  }

  @Get(':id')
  @Permission(Module.ORDERS, Action.VIEW)
  async detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const order = await this.ordersService.getById(id, ['items']);
    if (user.scopeCityIds?.length && !(order.cityId && user.scopeCityIds.includes(order.cityId))) throw new ForbiddenException('Outside your city scope');
    if (user.scopeZoneIds?.length && !(order.zoneId && user.scopeZoneIds.includes(order.zoneId))) throw new ForbiddenException('Outside your zone scope');
    const timeline = await this.events.find({ where: { orderId: id }, order: { createdAt: 'ASC' } });
    return { order, timeline };
  }

  private async scoped(id: string, user: AuthUser) {
    const order = await this.ordersService.getById(id, []);
    if (user.scopeCityIds?.length && !(order.cityId && user.scopeCityIds.includes(order.cityId))) throw new ForbiddenException('Outside your city scope');
    if (user.scopeZoneIds?.length && !(order.zoneId && user.scopeZoneIds.includes(order.zoneId))) throw new ForbiddenException('Outside your zone scope');
    return order;
  }

  /** Full delivery evidence record (immutable), the proof rule that applied, and what the customer asked for. */
  @Get(':id/proof')
  @Permission(Module.ORDERS, Action.VIEW)
  async deliveryProof(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const order = await this.scoped(id, user);
    const p = await this.proof.find(id);
    return {
      orderId: id,
      status: order.status,
      requirement: this.proof.requirementFor(order),
      instructions: { method: order.dropoffMethod, dropoffNotes: order.dropoffNotes, requiresPin: order.requiresPin },
      dropoff: order.deliveryAddress ? { lat: order.deliveryAddress.lat, lng: order.deliveryAddress.lng, line1: order.deliveryAddress.line1, city: order.deliveryAddress.city } : null,
      proof: this.proof.staffView(p),
      valid: this.proof.isValid(p),
      legacyPhoto: !p && !!order.proofPhotoUrl, // seeded / pre-evidence orders: a photo URL without an evidence record cannot be verified
    };
  }

  @Post(':id/proof/review')
  @Permission(Module.ORDERS, Action.EDIT)
  async reviewProof(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Body() dto: ProofReviewDto) {
    await this.scoped(id, user);
    const p = await this.proof.markReviewed(id, user.id, dto.note);
    await this.audit.log({ actor: user, action: 'order.proof.review', entity: 'Order', entityId: id, after: { note: dto.note } });
    return this.proof.staffView(p);
  }

  /** Reveal the buzzer / gate code: only after pickup, audit-logged every time. */
  @Post(':id/access-code/reveal')
  @Permission(Module.ORDERS, Action.VIEW)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async revealAccessCode(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    await this.scoped(id, user);
    const r = await this.ordersService.revealAccessCode(id);
    await this.audit.log({ actor: user, action: 'order.access_code.reveal', entity: 'Order', entityId: id, after: { revealed: !!r.accessCode } });
    return r;
  }

  @Patch(':id/status')
  @Permission(Module.ORDERS, Action.EDIT)
  async forceStatus(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Body() dto: ForceStatusDto) {
    const { status, reason } = dto;
    // forcing an order to a settled state moves money (capture + payouts): needs the approve permission, not just edit
    if ([OrderStatus.DELIVERED, OrderStatus.COLLECTED].includes(status) && !hasPermission(user, Module.ORDERS, Action.APPROVE)) throw new ForbiddenException('Missing permission: orders:approve');
    const before = await this.ordersService.getById(id);
    const order = await this.ordersService.transition(id, status, { ...actorFor(user), supportApproved: true }, { reason, force: true, note: 'Forced by staff' });
    await this.audit.log({ actor: user, action: 'order.force_status', entity: 'Order', entityId: id, before: { status: before.status }, after: { status } });
    return order;
  }

  @Post(':id/cancel')
  @Permission(Module.ORDERS, Action.EDIT)
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Body() dto: CancelBodyDto) {
    const reason = dto.reason;
    const order = await this.ordersService.cancel(id, { ...actorFor(user), supportApproved: true }, reason, { restaurantApproval: dto.restaurantApproval });
    await this.audit.log({ actor: user, action: 'order.cancel', entity: 'Order', entityId: id, after: { reason, restaurantApproval: dto.restaurantApproval ?? (order.meta?.cancelRequest?.status === 'APPROVED' ? 'via portal request' : undefined) } });
    return order;
  }

  /** Waive the driver wait-time charge (e.g. after a restaurant dispute): the restaurant is made whole, FORKSY absorbs it, the driver keeps the pay. */
  @Post(':id/wait-fee/waive')
  @Permission(Module.ORDERS, Action.APPROVE)
  async waiveWaitFee(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Body() dto: CancelRequestDto) {
    const order = await this.ordersService.waiveWaitFee(id, actorFor(user), dto.reason);
    await this.audit.log({ actor: user, action: 'order.wait_fee_waived', entity: 'Order', entityId: id, after: { reason: dto.reason } });
    return order;
  }

  /** Ask the restaurant for permission to cancel an order it already has. The restaurant answers in its portal. */
  @Post(':id/cancel-request')
  @Permission(Module.ORDERS, Action.EDIT)
  async cancelRequest(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Body() dto: CancelRequestDto) {
    const order = await this.ordersService.requestCancelApproval(id, { ...actorFor(user), supportApproved: true }, dto.reason);
    await this.audit.log({ actor: user, action: 'order.cancel_requested', entity: 'Order', entityId: id, after: { reason: dto.reason } });
    return order;
  }

  @Post(':id/refund')
  @Permission(Module.ORDERS, Action.APPROVE)
  async refund(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: RefundBodyDto,
  ) {
    const { amount, chargedTo, reasonCode, notes } = dto;
    const refund = await this.refunds.issue({ orderId: id, amount, chargedTo, reasonCode, notes, type: dto.refundTo === 'WALLET' ? RefundType.CREDIT : RefundType.REFUND, actor: { ...actorFor(user), refundLimit: (user.type as string) === 'SUPER_ADMIN' ? null : user.refundLimit } });
    await this.audit.log({ actor: user, action: 'order.refund', entity: 'Order', entityId: id, after: { amount, chargedTo, reasonCode, refundTo: dto.refundTo ?? 'ORIGINAL_PAYMENT' } });
    return refund;
  }

  @Post(':id/reassign-driver')
  @Permission(Module.ORDERS, Action.EDIT)
  async reassignDriver(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser, @Body() dto: ReassignBodyDto) {
    const { driverId, reason } = dto;
    await this.ordersService.unassignDriver(id, { ...actorFor(user), supportApproved: true }, reason ?? 'Reassigned by staff');
    const order = await this.ordersService.assignDriver(id, driverId, { ...actorFor(user), supportApproved: true });
    await this.audit.log({ actor: user, action: 'order.reassign_driver', entity: 'Order', entityId: id, after: { driverId } });
    return order;
  }

  @Get('export/csv')
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // exports are heavy: 10 per minute per user
  @Permission(Module.ORDERS, Action.EXPORT)
  async export(@Query('from') from?: string, @Query('to') to?: string, @CurrentUser() user?: AuthUser) {
    const qb = this.orders.createQueryBuilder('o').orderBy('o.createdAt', 'DESC').limit(5000);
    if (user?.scopeCityIds?.length) qb.andWhere('o.cityId IN (:...scopeCities)', { scopeCities: user.scopeCityIds });
    if (user?.scopeZoneIds?.length) qb.andWhere('o.zoneId IN (:...scopeZones)', { scopeZones: user.scopeZoneIds });
    if (from) qb.andWhere('o.createdAt >= :from', { from });
    if (to) qb.andWhere('o.createdAt <= :to', { to });
    const rows = await qb.getMany();
    const header = 'code,status,fulfilment,subtotal,deliveryFee,total,createdAt\n';
    const body = rows.map((o) => csvRow([o.code, o.status, o.fulfilment, o.subtotal, o.deliveryFee, o.total, o.createdAt.toISOString()])).join('\n');
    return { csv: header + body };
  }
}
