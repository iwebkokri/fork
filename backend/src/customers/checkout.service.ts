import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In } from 'typeorm';
import { Address, Order, Restaurant } from '../database/entities';
import { retailView } from '../common/store-types';
import { ActorType, OrderStatus, OrderType } from '../common/enums';
import { Events, PlaceOrderInput, QuoteInput } from '../common/contracts';
import { PageQueryDto, paginateQb } from '../common/pagination';
import { CartService } from './cart.service';
import { ExternalServices } from './lazy';
import { openCode } from '../orders/delivery-instructions';
import { DeliveryProof } from '../database/entities';
import { CheckoutQuoteDto, PaymentIntentDto, PlaceOrderDto, UpdateDeliveryInstructionsDto } from './dto';
import { quoteFingerprint } from '../orders/quote-hash';

/**
 * Glue between the customer app and the shared order-lifecycle services (OrdersService / PricingService).
 * No order/pricing logic lives here - only building their inputs from the customer's cart & saved addresses,
 * and scoping reads/writes to the calling customer.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private cart: CartService,
    private ext: ExternalServices,
    private emitter: EventEmitter2,
  ) {}

  private orders() {
    return this.ds.getRepository(Order);
  }

  // ------------------------------------------------------------------ checkout
  private async resolveDeliveryAddress(customerId: string, dto: { addressId?: string; lat?: number; lng?: number }) {
    if (dto.addressId) {
      const a = await this.ds.getRepository(Address).findOne({ where: { id: dto.addressId, customerId } });
      if (!a) throw new NotFoundException('Address not found');
      if (a.lat == null || a.lng == null) throw new BadRequestException('This address has no coordinates - please edit it');
      return { lat: a.lat, lng: a.lng, line1: a.line1, line2: a.line2 ?? undefined, city: a.city, province: a.province, postalCode: a.postalCode, dropoffNotes: a.dropoffNotes ?? undefined, label: a.label };
    }
    if (dto.lat != null && dto.lng != null) return { lat: dto.lat, lng: dto.lng };
    return undefined;
  }

  private async buildQuoteInput(customerId: string, dto: CheckoutQuoteDto): Promise<QuoteInput> {
    const cart = await this.cart.getOrCreate(customerId);
    if (!cart.restaurantId || !cart.items.length) throw new BadRequestException('Your cart is empty');
    const deliveryAddress = dto.type === OrderType.PICKUP ? undefined : await this.resolveDeliveryAddress(customerId, dto);
    if (dto.type !== OrderType.PICKUP && !deliveryAddress) throw new BadRequestException('A delivery address is required');
    // the hand-over method is part of the quote: baskets with age-restricted products cannot be left at the door (ID is checked)
    let dropoffMethod: string | undefined;
    let dropoffExplicit = false;
    if (dto.type !== OrderType.PICKUP) {
      const def = dto.addressId ? await this.addressDefaults(customerId, dto.addressId) : null;
      const contactless = (dto as { contactless?: boolean }).contactless;
      dropoffExplicit = dto.dropoffMethod !== undefined || contactless !== undefined;
      dropoffMethod = dto.dropoffMethod ?? (contactless !== undefined ? (contactless ? 'LEAVE_AT_DOOR' : 'HAND_TO_ME') : def?.dropoffMethod ?? 'HAND_TO_ME');
    }
    return {
      customerId,
      restaurantId: cart.restaurantId,
      type: dto.type,
      fulfilment: dto.fulfilment,
      items: cart.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity, modifierOptionIds: i.modifierOptionIds, notes: i.notes, substitution: i.substitution })),
      deliveryAddress,
      promoCode: dto.promoCode ?? cart.promoCode ?? undefined,
      tip: dto.tip,
      useWallet: dto.useWallet,
      scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : null,
      ageConfirmed: dto.ageConfirmed === true,
      dropoffMethod,
      dropoffExplicit,
    };
  }

  async quote(customerId: string, dto: CheckoutQuoteDto) {
    const input = await this.buildQuoteInput(customerId, dto);
    // the quote shows the totals of a basket with age-restricted products before the customer has confirmed their age (`ageConfirmationRequired`);
    // the payment intent and the order always insist on the confirmation
    return this.ext.pricing.quote({ ...input, requireAgeConfirmation: false });
  }

  /**
   * POST /customer/payments/intent. The cart is priced again HERE and the intent amount is the card part of that quote
   * (total minus wallet). Nothing about the amount comes from the browser.
   */
  async createPaymentIntent(customerId: string, dto: PaymentIntentDto) {
    const input = await this.buildQuoteInput(customerId, dto);
    const quote = await this.ext.pricing.quote(input);
    const hash = quoteFingerprint(input, quote);
    const r = await this.ext.payments.createCheckoutIntent(customerId, quote, hash, { saveCard: dto.saveCard, paymentMethodId: dto.paymentMethodId, existingIntentId: dto.intentId });
    return { ...r, quote: { total: quote.total, walletUsed: quote.walletUsed, cardAmount: Math.round((quote.total - quote.walletUsed) * 100) / 100 } };
  }

  /**
   * POST /customer/orders. The customer has already paid (the card is charged when they pay at checkout). If the order is refused for a clear reason
   * anywhere on the way (empty cart, restaurant closed, an item sold out ...) that charge is refunded at once and the error says so.
   */
  async placeOrder(customerId: string, dto: PlaceOrderDto) {
    try {
      return await this.placeOrderPaid(customerId, dto);
    } catch (e) {
      throw await this.ext.payments.refundAfterRefusedOrder(customerId, dto.paymentIntentId, e);
    }
  }

  private async placeOrderPaid(customerId: string, dto: PlaceOrderDto) {
    const input = (await this.buildQuoteInput(customerId, dto)) as PlaceOrderInput;
    input.paymentMethod = dto.paymentMethod;
    input.paymentIntentId = dto.paymentIntentId;
    input.paymentToken = dto.paymentToken;
    input.customerNotes = dto.customerNotes; // KITCHEN note
    // delivery instructions: explicit request values win, otherwise the chosen address's saved defaults, otherwise HAND_TO_ME
    const def = dto.addressId && dto.type !== OrderType.PICKUP ? await this.addressDefaults(customerId, dto.addressId) : null;
    input.dropoffMethod = dto.dropoffMethod ?? (dto.contactless !== undefined ? (dto.contactless ? 'LEAVE_AT_DOOR' : 'HAND_TO_ME') : def?.dropoffMethod ?? 'HAND_TO_ME');
    input.contactless = input.dropoffMethod === 'LEAVE_AT_DOOR';
    input.usePin = dto.usePin ?? def?.usePin ?? true;
    input.dropoffNotes = dto.dropoffNotes ?? def?.dropoffNotes ?? undefined;
    input.accessCode = dto.accessCode ?? def?.accessCode ?? undefined;
    input.source = 'app';
    if (dto.addressId) input.addressId = dto.addressId;

    // Redeem the gift card into the wallet up front so PricingService applies it via useWallet.
    if (dto.giftCardCode) {
      await this.ext.giftCards.redeem(customerId, dto.giftCardCode.trim().toUpperCase());
      input.useWallet = true;
    }

    const order = await this.ext.orders.placeOrder(customerId, input);
    await this.cart.clear(customerId);
    return order;
  }

  private async addressDefaults(customerId: string, addressId: string) {
    const a = await this.ds.getRepository(Address).createQueryBuilder('a').addSelect('a.accessCode').where('a.id = :id AND a.customerId = :c', { id: addressId, c: customerId }).getOne();
    if (!a) return null;
    return { dropoffMethod: a.dropoffMethod || 'HAND_TO_ME', usePin: a.usePin !== false, dropoffNotes: a.dropoffNotes?.slice(0, 300) ?? null, accessCode: openCode((a as any).accessCode) };
  }

  updateDeliveryInstructions(customerId: string, id: string, dto: UpdateDeliveryInstructionsDto) {
    return this.ext.orders.updateDeliveryInstructions(id, customerId, dto).then((o) => this.shapeOrder(o));
  }

  /** The customer's own order: PIN and instructions visible, the access code only as a flag, delivery proof summary once delivered. */
  private async shapeOrder(order: Order): Promise<any> {
    const hasCode = !!(await this.orders().createQueryBuilder('o').select('o.accessCode', 'ac').where('o.id = :id', { id: order.id }).getRawOne())?.ac;
    const p = [OrderStatus.DELIVERED, OrderStatus.COLLECTED].includes(order.status) ? await this.ds.getRepository(DeliveryProof).findOne({ where: { orderId: order.id } }) : null;
    const photoOk = p?.photoFile && !p.photoPurgedAt;
    const store = await this.ds.getRepository(Restaurant).findOne({ where: { id: order.restaurantId }, select: ['id', 'storeType'] });
    return Object.assign(order, retailView(order, store?.storeType), {
      deliveryPin: order.requiresPin ? order.deliveryPin : null,
      accessCodeSet: hasCode,
      driverWaitFee: undefined,
      driverWaitMinutes: undefined,
      canCancel: this.ext.orders.customerCancelWindow(order).open,
      cancelUntil: this.ext.orders.customerCancelWindow(order).until,
      kitchenNotes: order.customerNotes,
      deliveryProof: p
        ? { proofType: p.proofType, method: p.method, deliveredAt: p.deliveredAt, pinVerified: p.pinVerified, photoUrl: photoOk ? `/api/v1/orders/${order.id}/proof/photo` : null, location: p.photoLat != null ? { lat: p.photoLat, lng: p.photoLng } : null, dropoff: p.dropoffLat != null ? { lat: p.dropoffLat, lng: p.dropoffLng } : null }
        : null,
    });
  }

  // ------------------------------------------------------------------ reads
  async list(customerId: string, q: PageQueryDto & { status?: string }) {
    const qb = this.orders().createQueryBuilder('o').where('o.customerId = :customerId', { customerId });
    if (q.status) qb.andWhere('o.status = :status', { status: q.status });
    const page = await paginateQb(qb, q, { sortable: { createdAt: 'o.createdAt', total: 'o.total' }, defaultSort: ['o.createdAt', 'DESC'] });
    // what kind of store each order came from, so a list can word the status in the store's own words ("Picking your items") and show who it was
    const ids = [...new Set(page.data.map((o) => o.restaurantId))];
    const stores = ids.length ? await this.ds.getRepository(Restaurant).find({ where: { id: In(ids) }, select: ['id', 'name', 'slug', 'storeType'] }) : [];
    const byId = new Map(stores.map((s) => [s.id, s]));
    return {
      ...page,
      data: page.data.map((o) => {
        const s = byId.get(o.restaurantId);
        return Object.assign(o, { ...retailView({ status: o.status, requiresIdCheck: o.requiresIdCheck, minAge: o.minAge, meta: o.meta, basket: o.basket }, s?.storeType), restaurantName: s?.name ?? null, restaurantSlug: s?.slug ?? null });
      }),
    };
  }

  async detail(customerId: string, id: string): Promise<Order> {
    const order = await this.orders().findOne({ where: { id, customerId }, relations: { items: true } });
    if (!order) throw new NotFoundException('Order not found');
    return this.shapeOrder(order);
  }

  // ------------------------------------------------------------------ actions (delegate to OrdersService)
  async cancel(customerId: string, id: string, reason: string, refundTo?: 'ORIGINAL_PAYMENT' | 'WALLET') {
    await this.detail(customerId, id); // ownership + existence
    return this.ext.orders.cancel(id, { type: ActorType.CUSTOMER, id: customerId }, reason, { refundTo });
  }

  updateTip(customerId: string, id: string, tip: number) {
    return this.ext.orders.updateTip(id, customerId, tip);
  }

  respondToItemRemoval(customerId: string, id: string, approve: boolean) {
    return this.ext.orders.respondToItemRemoval(id, customerId, approve);
  }

  /** Best-effort: re-adds every non-removed line to the cart, skipping items that vanished or went unavailable. */
  async reorder(customerId: string, id: string) {
    const order = await this.detail(customerId, id);
    await this.cart.clear(customerId);
    const skipped: { name: string; reason: string }[] = [];
    let first = true;
    for (const item of order.items.filter((i) => !i.removed && i.menuItemId)) {
      try {
        await this.cart.addItem(customerId, {
          menuItemId: item.menuItemId!,
          quantity: item.quantity,
          modifierOptionIds: (item.modifiers ?? []).map((m) => m.optionId),
          notes: item.notes ?? undefined,
          substitution: item.substitution === 'REFUND' ? 'REFUND' : undefined,
          replaceCart: first,
        });
      } catch (e: any) {
        skipped.push({ name: item.name, reason: e?.message ?? 'No longer available' });
      }
      first = false;
    }
    return { cart: await this.cart.view(customerId), skipped };
  }

  // reviews moved to src/ratings (RatingsService; POST/GET/PATCH /customer/orders/:id/review)
}
