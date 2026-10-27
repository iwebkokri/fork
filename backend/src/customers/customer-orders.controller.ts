import { Body, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CustomerController, CurrentUser } from '../common/decorators';
import { AuthUser } from '../common/auth.types';
import { PageQueryDto } from '../common/pagination';
import { CheckoutService } from './checkout.service';
import { CustomerOrdersQuery, ItemRemovalResponseDto, PlaceOrderDto, TipDto, UpdateDeliveryInstructionsDto } from './dto';

class CancelOrderDto {
  @IsString() @MaxLength(500) reason: string;
  /** where the refund goes: the payment method used (default) or the Forky wallet */
  @IsOptional() @IsIn(['ORIGINAL_PAYMENT', 'WALLET']) refundTo?: 'ORIGINAL_PAYMENT' | 'WALLET';
}

/**
 * /customer/orders - place / list / detail / cancel / reorder / tip-edit / review.
 * Live tracking + chat are shared across all four apps: GET/POST /orders/:id/tracking|messages (src/orders/orders.controller.ts).
 * All lifecycle logic lives in OrdersService/PricingService (@Global, OrdersModule) - this controller only builds
 * their inputs from the customer's cart/addresses and scopes reads to the calling customer.
 */
@CustomerController('orders')
export class CustomerOrdersController {
  constructor(private checkout: CheckoutService) {}

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  place(@CurrentUser() user: AuthUser, @Body() dto: PlaceOrderDto) {
    return this.checkout.placeOrder(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: CustomerOrdersQuery) {
    return this.checkout.list(user.id, q as PageQueryDto & { status?: string });
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.checkout.detail(user.id, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CancelOrderDto) {
    return this.checkout.cancel(user.id, id, dto.reason, dto.refundTo);
  }

  @Post(':id/reorder')
  reorder(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.checkout.reorder(user.id, id);
  }

  /** Change the handoff method / driver instructions / access code until the driver has picked the order up. */
  @Patch(':id/delivery-instructions')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  deliveryInstructions(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateDeliveryInstructionsDto) {
    return this.checkout.updateDeliveryInstructions(user.id, id, dto);
  }

  @Patch(':id/tip')
  tip(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: TipDto) {
    return this.checkout.updateTip(user.id, id, dto.tip);
  }

  @Post(':id/item-removal-response')
  itemRemovalResponse(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ItemRemovalResponseDto) {
    return this.checkout.respondToItemRemoval(user.id, id, dto.approve);
  }
}
