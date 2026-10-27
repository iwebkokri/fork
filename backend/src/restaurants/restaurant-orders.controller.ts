import { BadRequestException, Body, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser, RestaurantController } from '../common/decorators';
import { ActorType, FulfilmentMode, OrderStatus } from '../common/enums';
import { AuthUser } from '../common/auth.types';
import { Order, OrderEvent } from '../database/entities';
import { like, paginateQb } from '../common/pagination';
import { OrdersService } from '../orders/orders.service';
import { RetailService } from '../orders/retail.service';
import { resolveRestaurantId, restaurantActor, restaurantOrderView } from './restaurants.util';
import { AcceptOrderDto, ExtendPrepDto, HandoffDto, OrdersQuery, PickItemDto, RejectOrderDto, RemoveItemDto } from './dto';

const OPEN_STATUSES = [OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY];

class CancelResponseDto {
  /** strict: the string "false" must not become true */
  @Transform(({ obj }) => obj.approve) @IsBoolean() approve: boolean;
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** Restaurant portal live orders: accept (prep +5/+10/+15), reject, ready, handoff (own courier / in-store pickup only; a FORKSY driver marks the pickup himself), partial fulfilment (spec §4.5). */
@RestaurantController('orders')
export class RestaurantOrdersController {
  constructor(
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderEvent) private events: Repository<OrderEvent>,
    private ordersService: OrdersService,
    private retail: RetailService,
  ) {}

  private rid(user: AuthUser, restaurantId?: string) {
    return resolveRestaurantId(user, restaurantId);
  }

  private async orderFor(restaurantId: string, orderId: string): Promise<Order> {
    const order = await this.orders.findOne({ where: { id: orderId, restaurantId }, relations: ['items'] });
    if (order && order.kitchenReleaseAt && !order.kitchenReleasedAt) throw new NotFoundException('Order not found');
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: OrdersQuery, @Query('restaurantId') restaurantId?: string) {
    const rid = this.rid(user, restaurantId);
    // orders still held for the customer's cancellation window are not the restaurant's yet
    const qb = this.orders.createQueryBuilder('o').where('o.restaurantId = :rid', { rid }).andWhere('(o.kitchenReleaseAt IS NULL OR o.kitchenReleasedAt IS NOT NULL)');
    if (q.search) qb.andWhere('o.code ILIKE :s', { s: like(q.search) });
    if (q.status) qb.andWhere('o.status = :status', { status: q.status });
    else if (!q.from && !q.to) qb.andWhere('o.status IN (:...open)', { open: OPEN_STATUSES });
    if (q.type) qb.andWhere('o.fulfilment = :type', { type: q.type });
    if (q.from) qb.andWhere('o.createdAt >= :from', { from: q.from });
    if (q.to) qb.andWhere('o.createdAt <= :to', { to: q.to });
    const page = await paginateQb(qb, q, { sortable: { createdAt: 'o.createdAt', total: 'o.total', status: 'o.status' }, defaultSort: ['o.createdAt', 'ASC'] });
    return { ...page, data: page.data.map(restaurantOrderView) };
  }

  /** Orders a driver has already picked up: not part of the live board, kept here so the restaurant can see who has the order in an emergency. */
  @Get('out-for-delivery')
  outForDelivery(@CurrentUser() user: AuthUser, @Query('restaurantId') restaurantId?: string) {
    return this.ordersService.outForDelivery(this.rid(user, restaurantId));
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    const order = await this.orderFor(this.rid(user, restaurantId), id);
    const timeline = await this.events.find({ where: { orderId: id }, order: { createdAt: 'ASC' } });
    return { order: { ...restaurantOrderView(order), driver: await this.ordersService.driverCardFor(order.driverId) }, timeline };
  }

  @Post(':id/accept')
  async accept(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AcceptOrderDto, @Query('restaurantId') restaurantId?: string) {
    const rid = this.rid(user, restaurantId);
    const order = await this.orderFor(rid, id);
    const prepTimeMin = dto.prepTimeMin ?? (order.prepTimeMin ?? 20) + (dto.addMinutes ?? 0);
    return restaurantOrderView(await this.ordersService.transition(id, OrderStatus.ACCEPTED, restaurantActor(user), { prepTimeMin }));
  }

  /** FORKSY support asked to cancel this order; the restaurant approves or declines. */
  @Post(':id/cancel-request/respond')
  async respondCancelRequest(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CancelResponseDto, @Query('restaurantId') restaurantId?: string) {
    const rid = this.rid(user, restaurantId);
    await this.orderFor(rid, id);
    return restaurantOrderView(await this.ordersService.respondCancelRequest(id, rid, restaurantActor(user), dto.approve, dto.note));
  }

  @Post(':id/reject')
  async reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RejectOrderDto, @Query('restaurantId') restaurantId?: string) {
    await this.orderFor(this.rid(user, restaurantId), id);
    const reason = dto.note ? `${dto.reason}: ${dto.note}` : dto.reason;
    return restaurantOrderView(await this.ordersService.transition(id, OrderStatus.REJECTED, restaurantActor(user), { reason }));
  }

  @Post(':id/ready')
  async ready(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('restaurantId') restaurantId?: string) {
    await this.orderFor(this.rid(user, restaurantId), id);
    return restaurantOrderView(await this.ordersService.transition(id, OrderStatus.READY, restaurantActor(user)));
  }

  @Post(':id/handoff')
  async handoff(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: HandoffDto, @Query('restaurantId') restaurantId?: string) {
    const order = await this.orderFor(this.rid(user, restaurantId), id);
    // customer collecting in store: the restaurant checks the customer's pickup code and closes the order
    if (order.fulfilment === FulfilmentMode.PICKUP) return restaurantOrderView(await this.ordersService.transition(id, OrderStatus.COLLECTED, restaurantActor(user), { code: dto.code }));
    // restaurant's own courier: no driver app, the restaurant marks it picked up
    if (order.fulfilment === FulfilmentMode.OWN_DRIVER) return restaurantOrderView(await this.ordersService.transition(id, OrderStatus.PICKED_UP, restaurantActor(user), { code: dto.code }));
    // FORKSY driver: nothing to enter. The store checks the order number the driver tells and hands the order over; the driver marks it picked up in his app.
    throw new BadRequestException('A FORKSY driver marks the order picked up in the driver app. Check the order number he tells you and hand the order over.');
  }

  @Post(':id/items/:itemId/remove')
  async removeItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: RemoveItemDto,
    @Query('restaurantId') restaurantId?: string,
  ) {
    await this.orderFor(this.rid(user, restaurantId), id);
    return this.ordersService.removeItem(id, itemId, restaurantActor(user), dto.reason ?? 'Item unavailable');
  }

  /**
   * Picking list of a grocery / retail order, one product at a time: PICKED (weighed products need actualWeight), OUT_OF_STOCK (refunded at once) or
   * REPLACED (another product; the customer pays the lower price). The customer is told and the timeline records it. If every product turns out to be
   * out of stock the empty order is cancelled and fully refunded.
   */
  @Post(':id/items/:itemId/pick')
  async pick(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Body() dto: PickItemDto, @Query('restaurantId') restaurantId?: string) {
    const rid = this.rid(user, restaurantId);
    await this.orderFor(rid, id);
    const done = await this.retail.pick(id, rid, itemId, dto, { type: ActorType.RESTAURANT, id: user.id, name: user.name });
    if (done.allRemoved) await this.ordersService.transition(id, OrderStatus.CANCELLED, restaurantActor(user), { reason: 'Every product in the order is out of stock' });
    return restaurantOrderView(await this.orderFor(rid, id));
  }

  @Post(':id/extend-prep')
  async extendPrep(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ExtendPrepDto, @Query('restaurantId') restaurantId?: string) {
    const order = await this.orderFor(this.rid(user, restaurantId), id);
    const addMs = dto.addMinutes * 60_000;
    const readyAt = order.estimatedReadyAt ? new Date(order.estimatedReadyAt.getTime() + addMs) : new Date(Date.now() + addMs);
    const deliveryAt = order.estimatedDeliveryAt ? new Date(order.estimatedDeliveryAt.getTime() + addMs) : undefined;
    await this.ordersService.setEta(id, readyAt, deliveryAt);
    return restaurantOrderView(await this.orderFor(this.rid(user, restaurantId), id));
  }
}
