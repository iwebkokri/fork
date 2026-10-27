import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ModuleRef } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CustomerProfile, DriverProfile, Order, OrderEvent, OrderItem, Restaurant } from '../database/entities';
import { ActorType, DropoffMethod, FulfilmentMode, LedgerType, OrderStatus, OrderType, PaymentMethod, PaymentStatus, PartyType, RefundChargedTo, RefundType } from '../common/enums';
import {
  ActorRef,
  Events,
  IOrdersService,
  IPromotionsService,
  PlaceOrderInput,
  TransitionOpts,
} from '../common/contracts';
import { CodesService } from '../core/core.module';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeService } from '../realtime/realtime.module';
import { AuditService } from '../audit/audit.service';
import { PaymentsService, payError } from './payments.service';
import { quoteFingerprint } from './quote-hash';
import { LedgerService } from './ledger.service';
import { WalletService } from './wallet.service';
import { RefundsService } from './refunds.service';
import { Reservation, RetailService } from './retail.service';
import { retailView } from '../common/store-types';
import { PricingService } from './pricing.service';
import { lazyProvider, round2 } from './pricing.math';
import { ProofService } from './proof.service';
import { cleanAccessCode, cleanNotes, maskCode, methodFromLegacy, openCode, sealCode } from './delivery-instructions';

/** Which statuses a transition may originate from. Missing `to` key = no direct transition allowed. */
const ALLOWED: Partial<Record<OrderStatus, OrderStatus[]>> = {
  [OrderStatus.PLACED]: [OrderStatus.ACCEPTED, OrderStatus.REJECTED, OrderStatus.CANCELLED],
  [OrderStatus.ACCEPTED]: [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.DRIVER_ASSIGNED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.DRIVER_ASSIGNED, OrderStatus.CANCELLED],
  [OrderStatus.READY]: [OrderStatus.PICKED_UP, OrderStatus.COLLECTED, OrderStatus.CANCELLED],
  [OrderStatus.PICKED_UP]: [OrderStatus.ON_THE_WAY, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
  [OrderStatus.ON_THE_WAY]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
};

const END_STATUSES = new Set([OrderStatus.DELIVERED, OrderStatus.COLLECTED, OrderStatus.CANCELLED, OrderStatus.REJECTED]);

const TIMESTAMP_FIELD: Partial<Record<OrderStatus, keyof Order>> = {
  [OrderStatus.ACCEPTED]: 'acceptedAt',
  [OrderStatus.DRIVER_ASSIGNED]: 'driverAssignedAt',
  [OrderStatus.PREPARING]: 'preparingAt',
  [OrderStatus.READY]: 'readyAt',
  [OrderStatus.PICKED_UP]: 'pickedUpAt',
  [OrderStatus.ON_THE_WAY]: 'onTheWayAt',
  [OrderStatus.DELIVERED]: 'deliveredAt',
  [OrderStatus.COLLECTED]: 'deliveredAt',
  [OrderStatus.CANCELLED]: 'cancelledAt',
  [OrderStatus.REJECTED]: 'cancelledAt',
};

/** event name (see notifications.service.ts DEFAULT_MESSAGES) for each status, when we should tell the customer. */
const CUSTOMER_EVENT: Partial<Record<OrderStatus, string>> = {
  [OrderStatus.ACCEPTED]: 'order.accepted',
  [OrderStatus.REJECTED]: 'order.rejected',
  [OrderStatus.READY]: 'order.ready',
  [OrderStatus.PICKED_UP]: 'order.picked_up',
  [OrderStatus.DELIVERED]: 'order.delivered',
  [OrderStatus.COLLECTED]: 'order.delivered',
  [OrderStatus.CANCELLED]: 'order.cancelled',
};

/**
 * Single entry point for the whole order lifecycle (spec section 7). Every status change goes
 * through `transition()`, which validates the move, stamps timing fields, writes the immutable
 * OrderEvent timeline, pushes realtime + notifications, and (on delivery) triggers payment
 * capture + ledger settlement. Simplifications are called out inline where the full spec nuance
 * was traded for shipping a correct, working core within scope.
 */
/** Constant-time comparison; undefined / empty input never matches. */
function codeMatches(given: string | undefined | null, expected: string): boolean {
  if (typeof given !== 'string' || !given.length || given.length > 32) return false;
  const a = Buffer.from(given.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class OrdersService implements IOrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectDataSource() private ds: DataSource,
    @InjectRepository(Order) private orders: Repository<Order>,
    @InjectRepository(OrderItem) private items: Repository<OrderItem>,
    @InjectRepository(OrderEvent) private events: Repository<OrderEvent>,
    @InjectRepository(Restaurant) private restaurants: Repository<Restaurant>,
    @InjectRepository(DriverProfile) private drivers: Repository<DriverProfile>,
    @InjectRepository(CustomerProfile) private customerProfiles: Repository<CustomerProfile>,
    private moduleRef: ModuleRef,
    private pricing: PricingService,
    private payments: PaymentsService,
    private ledger: LedgerService,
    private wallet: WalletService,
    private refunds: RefundsService,
    private codes: CodesService,
    private settings: SettingsService,
    private notifications: NotificationsService,
    private realtime: RealtimeService,
    private audit: AuditService,
    private emitter: EventEmitter2,
    private proof: ProofService,
    private retail: RetailService,
  ) {}

  private promotions(): IPromotionsService | null {
    return lazyProvider<IPromotionsService>(this.moduleRef, '../marketing/promotions.service', 'PromotionsService');
  }

  // ---------------------------------------------------------------------- create

  /**
   * Place an order. Payment comes first: the customer has already paid (the card is charged when they pay at checkout, before this call, and an order
   * fully covered by wallet credit takes the wallet balance here). The payment is verified, the order is created and the payment recorded.
   * The caller (CheckoutService) refunds the charge when this refuses the order for a clear reason (PaymentsService.refundAfterRefusedOrder).
   */
  async placeOrder(customerId: string, input: PlaceOrderInput): Promise<Order> {
    const quote = await this.pricing.quote(input);
    const restaurant = await this.restaurants.findOne({ where: { id: input.restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    // ---- payment policy. Everything that takes money goes through Stripe and is taken BEFORE the order exists: the card is charged when the customer
    // pays at checkout and the charge is verified here. Wallet / gift-card BALANCE is store credit (not a gateway payment): an order fully covered by it needs no card.
    const cardAmount = round2(quote.total - quote.walletUsed);
    if (input.paymentMethod === PaymentMethod.CASH) throw new BadRequestException('Cash payments are not available. Pay by card, Apple Pay, Google Pay or wallet credit.');
    if ((input.paymentMethod === PaymentMethod.WALLET || input.paymentMethod === PaymentMethod.GIFT_CARD) && cardAmount > 0.009) {
      throw new BadRequestException('Your wallet balance does not cover this order');
    }
    const paid =
      cardAmount > 0.009
        ? await this.payments.verifyPayment(customerId, { paymentIntentId: input.paymentIntentId, paymentToken: input.paymentToken, amount: cardAmount, quoteHash: quoteFingerprint(input, quote), declaredMethod: input.paymentMethod })
        : null;

    const code = await this.codes.orderCode();
    let dropoffMethod = methodFromLegacy(input.contactless, input.dropoffMethod);
    if (!Object.values(DropoffMethod).includes(dropoffMethod)) throw new BadRequestException('Unknown delivery method');
    // age-restricted products are handed over in person: a saved "leave at the door" of the address is replaced (an explicit choice was refused at the quote)
    if (quote.requiresIdCheck && quote.type === OrderType.DELIVERY && dropoffMethod === DropoffMethod.LEAVE_AT_DOOR) dropoffMethod = DropoffMethod.HAND_TO_ME;
    const usePin = input.usePin !== false;
    const requiresPin = this.proof.shouldHavePin(dropoffMethod, quote.total, quote.fulfilment, usePin);
    const autoRejectSec = restaurant.autoRejectSeconds || this.settings.get<number>('orders.autoRejectSeconds', 180);
    // the kitchen only gets the order after the customer's cancellation window
    const graceSec = Math.max(0, Number(this.settings.get<number>('orders.customerCancelGraceSeconds', 120)));

    const itemRows = quote.lines.map((l) =>
        this.items.create({
          menuItemId: l.menuItemId,
          name: l.name,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
          taxAmount: l.taxAmount,
          taxClassCode: l.taxClassCode,
          modifiers: l.modifiers,
          notes: l.notes ?? null,
          stationId: l.stationId ?? null,
          allergens: l.allergens ?? [],
          sku: l.sku ?? null,
          barcode: l.barcode ?? null,
          packSize: l.packSize ?? null,
          sellBy: l.sellBy ?? 'UNIT',
          weightUnit: l.weightUnit ?? 'KG',
          stepSize: l.stepSize ?? 1,
          estimatedWeight: l.estimatedWeight ?? null,
          minAge: l.minAge ?? 0,
          temperature: l.temperature ?? 'AMBIENT',
          substitution: l.substitution ?? 'ALLOW',
        }),
    );
    let order = this.orders.create({
      code,
      customerId,
      restaurantId: restaurant.id,
      zoneId: quote.zoneId,
      cityId: quote.cityId,
      type: quote.type,
      fulfilment: quote.fulfilment,
      status: OrderStatus.PLACED,
      deliveryAddress: quote.fulfilment === FulfilmentMode.PICKUP ? null : { ...input.deliveryAddress!, label: input.deliveryAddress?.label },
      isScheduled: !!input.scheduledFor,
      scheduledFor: input.scheduledFor ?? null,
      prepTimeMin: quote.prepTimeMin,
      estimatedReadyAt: new Date(Date.now() + quote.prepTimeMin * 60_000),
      estimatedDeliveryAt: quote.etaMinutes ? new Date(Date.now() + quote.etaMinutes * 60_000) : null,
      kitchenReleaseAt: new Date(Date.now() + graceSec * 1000),
      acceptDeadlineAt: new Date(Date.now() + (graceSec + autoRejectSec) * 1000),
      subtotal: quote.subtotal,
      deliveryFee: quote.deliveryFee,
      serviceFee: quote.serviceFee,
      smallOrderFee: quote.smallOrderFee,
      taxAmount: quote.taxAmount,
      tip: quote.tip,
      discountTotal: quote.discountTotal,
      platformPromoAmount: quote.platformPromoAmount,
      restaurantPromoAmount: quote.restaurantPromoAmount,
      walletUsed: quote.walletUsed,
      total: quote.total,
      promotionId: quote.promotion?.id ?? null,
      promoCode: quote.promotion?.code ?? null,
      commissionPct: quote.commissionPct,
      commissionAmount: quote.commissionAmount,
      restaurantPayout: quote.restaurantPayout,
      distanceKm: quote.distanceKm,
      paymentMethod: paid ? paid.method : input.paymentMethod === PaymentMethod.GIFT_CARD ? PaymentMethod.GIFT_CARD : PaymentMethod.WALLET,
      paymentIntentId: paid?.intentId ?? null,
      paymentStatus: PaymentStatus.PENDING,
      pickupCode: quote.fulfilment === FulfilmentMode.OWN_DRIVER ? null : this.codes.pin(4),
      deliveryPin: requiresPin ? this.codes.pin(4) : null,
      requiresPin,
      usePin,
      contactless: dropoffMethod === DropoffMethod.LEAVE_AT_DOOR,
      dropoffMethod,
      dropoffNotes: quote.fulfilment === FulfilmentMode.PICKUP ? null : cleanNotes(input.dropoffNotes),
      accessCode: quote.fulfilment === FulfilmentMode.PICKUP ? null : sealCode(cleanAccessCode(input.accessCode)),
      customerNotes: input.customerNotes?.slice(0, 1000) ?? null,
      hasAllergyFlag: quote.lines.some((l) => l.allergens?.length > 0),
      requiresIdCheck: quote.requiresIdCheck ?? false,
      minAge: quote.minAge ?? 0,
      ageConfirmed: (quote.minAge ?? 0) > 0 && input.ageConfirmed === true,
      basket: quote.basket ?? null,
      cancellationFee: 0,
      source: input.source ?? 'app',
      meta: {},
    });
    // the basket leaves the shelves now (atomic per product: the last one can only be taken once). Refused with INSUFFICIENT_STOCK when something just sold out
    // (the caller refunds the payment). Given back below if the order cannot be completed.
    const reserved: Reservation[] = await this.retail.reserve(quote.lines);
    try {
      order = await this.orders.save(order);
    } catch (e: any) {
      await this.retail.release(reserved);
      // the payment stays untouched: another order owns it (23505), or the customer retries (the clean-up returns it if no order ever uses it)
      if (e?.code === '23505' && /paymentIntentId/i.test(String(e?.detail ?? e?.message ?? ''))) throw payError(409, 'PAYMENT_INTENT_USED', 'This payment was already used for another order.');
      throw e;
    }
    await this.items.save(itemRows.map((i) => Object.assign(i, { orderId: order.id })));

    // Reserve the promo FIRST (atomic: usage limit / budget / per-user limit are enforced inside the redemption). If it is gone, the order is abandoned.
    const promoSvc = quote.promotion ? this.promotions() : null;
    if (quote.promotion && promoSvc) {
      try {
        await promoSvc.redeem(quote.promotion.id, customerId, order.id, quote.discountTotal);
      } catch (e) {
        await this.retail.release(reserved);
        await this.orders.delete(order.id);
        throw e instanceof BadRequestException ? e : new BadRequestException('This promo code is no longer available. Please remove it and try again.');
      }
    }

    // the card payment was verified above (the intent is already claimed by this order's unique paymentIntentId): link it, take the wallet part and
    // record the payment. The order is PAID from the moment it exists; nothing is captured later.
    let walletDebited = false;
    try {
      if (paid) await this.payments.bindPayment(order, paid);
      order.paymentStatus = PaymentStatus.CAPTURED;
      if (quote.walletUsed > 0) {
        await this.wallet.debit(customerId, quote.walletUsed, 'PURCHASE', { orderId: order.id, note: `Order ${order.code}` });
        walletDebited = true;
      }
      order = await this.orders.save(order);
      if (paid) await this.payments.recordCharge(order, paid);
    } catch (e) {
      // undo everything this attempt did; the card payment stays the customer's (placeOrder refunds it for a clear refusal, a retry can use it otherwise)
      await this.retail.release(reserved);
      await promoSvc?.unredeem(order.id).catch(() => undefined);
      if (walletDebited) await this.wallet.credit(customerId, quote.walletUsed, 'ADJUSTMENT', { orderId: order.id, note: `Order ${order.code} could not be placed - wallet credit returned` }).catch(() => undefined);
      await this.payments.forgetPayments(order.id);
      await this.orders.delete(order.id);
      if (paid) await this.payments.unbindPayment(paid);
      throw e;
    }

    await this.customerProfiles.increment({ userId: customerId }, 'totalOrders', 1);
    await this.customerProfiles.update({ userId: customerId }, { lastOrderAt: new Date() } as any);

    await this.addEvent(order.id, 'STATUS_CHANGE', { type: ActorType.CUSTOMER, id: customerId }, undefined, { to: OrderStatus.PLACED });
    this.realtime.emitToOps('order.new', { orderId: order.id, code: order.code, restaurantId: restaurant.id });
    this.emitter.emit(Events.ORDER_PLACED, { order });
    // the restaurant is told only when the cancellation window closes (immediately when the window is 0)
    if (graceSec <= 0) await this.releaseToKitchen(order.id);
    else {
      const timer = setTimeout(() => this.releaseToKitchen(order.id).catch((e) => this.logger.warn(`release ${order.code}: ${e.message}`)), graceSec * 1000 + 250);
      (timer as any).unref?.();
    }

    return this.getById(order.id);
  }

  // ---------------------------------------------------------------------- reads

  async getById(id: string, relations: string[] = ['items']): Promise<Order> {
    const order = await this.orders.findOne({ where: { id }, relations });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private async getByCode(code: string): Promise<Order> {
    const order = await this.orders.findOne({ where: { code }, relations: ['items'] });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // ---------------------------------------------------------------------- transition

  async transition(orderId: string, to: OrderStatus, actor: ActorRef, opts: TransitionOpts = {}): Promise<Order> {
    const order = await this.getById(orderId);
    const from = order.status;
    if (from === to) return order;
    if (END_STATUSES.has(from)) throw new BadRequestException(`Order ${order.code} has already ended (${from})`);
    if (!opts.force && !(ALLOWED[from] ?? []).includes(to)) {
      throw new BadRequestException(`Cannot move order ${order.code} from ${from} to ${to}`);
    }

    // ---- proof-of-handover checks come BEFORE anything is changed. A missing / empty code is a failure, never a pass.
    const isDriver = actor.type === ActorType.DRIVER;
    const staffOverride = actor.type === ActorType.STAFF && !!(actor as any).supportApproved;
    if (to === OrderStatus.ACCEPTED && !this.isReleased(order)) throw new BadRequestException('This order is still inside the customer cancellation window and has not been sent to the restaurant yet');
    if (to === OrderStatus.COLLECTED && order.pickupCode && isDriver) {
      if (!codeMatches(opts.code, order.pickupCode)) throw new ForbiddenException('Pickup code does not match');
    }
    if (to === OrderStatus.DELIVERED && order.requiresPin && order.deliveryPin && !staffOverride && !opts.proof) {
      if (!codeMatches(opts.code, order.deliveryPin)) throw new ForbiddenException('Delivery PIN is required and must match');
    }

    // ---- atomic claim: of N concurrent requests for this transition exactly one proceeds (double cancel / double settle protection)
    const claim = await this.orders.createQueryBuilder().update(Order).set({ status: to }).where('id = :id AND status = :from', { id: orderId, from }).execute();
    if (!claim.affected) throw new ConflictException('This order was just updated by someone else. Refresh and try again.');
    try {
      return await this.applyTransition(order, from, to, actor, opts);
    } catch (e) {
      // side effects failed: put the status back so the order is not left half-transitioned
      await this.orders.createQueryBuilder().update(Order).set({ status: from }).where('id = :id AND status = :to', { id: orderId, to }).execute();
      throw e;
    }
  }

  private async applyTransition(order: Order, from: OrderStatus, to: OrderStatus, actor: ActorRef, opts: TransitionOpts): Promise<Order> {
    const field = TIMESTAMP_FIELD[to];
    if (field && !order[field]) (order as any)[field] = new Date();

    if (to === OrderStatus.ACCEPTED) {
      order.prepTimeMin = opts.prepTimeMin ?? order.prepTimeMin;
      // the promised ready time never moves afterwards (even if the kitchen extends the prep): driver wait fees count from it
      if (!order.meta?.promisedReadyAt) order.meta = { ...(order.meta ?? {}), promisedReadyAt: new Date(Date.now() + (opts.prepTimeMin ?? order.prepTimeMin ?? 20) * 60_000).toISOString() };
      order.estimatedReadyAt = new Date(Date.now() + (order.prepTimeMin ?? 20) * 60_000);
      if (order.isScheduled && order.scheduledFor && order.fulfilment !== FulfilmentMode.PICKUP) {
        const due = new Date(order.scheduledFor.getTime() - Number(this.settings.get<number>('automation.scheduled.driveMinutes', 20)) * 60_000);
        if (due.getTime() > order.estimatedReadyAt.getTime()) order.estimatedReadyAt = due;
      }
    }
    if ((to === OrderStatus.REJECTED || to === OrderStatus.CANCELLED) && !order.meta?.stockRestored) {
      // the products go back on the shelves (once per order)
      await this.retail.restoreFor(order);
      order.meta = { ...(order.meta ?? {}), stockRestored: true };
    }
    if (to === OrderStatus.REJECTED) {
      order.rejectReason = opts.reason ?? null;
      order.cancelledBy = actor.type;
      const oldHold = order.paymentStatus === PaymentStatus.AUTHORIZED; // placed before "charge at checkout": the card was only held
      await this.refundCancelled(order);
      order.paymentStatus = oldHold ? PaymentStatus.RELEASED : PaymentStatus.REFUNDED;
      if (order.walletUsed > 0) await this.wallet.credit(order.customerId, order.walletUsed, 'ADJUSTMENT', { orderId: order.id, note: 'Order rejected - wallet portion returned' });
    }
    if (to === OrderStatus.CANCELLED) {
      order.cancelReason = opts.reason ?? null;
      order.cancelledBy = actor.type;
      await this.applyCancellationMoney(order, actor);
    }
    if (to === OrderStatus.DRIVER_ASSIGNED && order.driverId) {
      await this.drivers.update(order.driverId, { onTrip: true });
    }
    if (to === OrderStatus.COLLECTED) {
      await this.settleDelivered(order);
    }
    if (to === OrderStatus.DELIVERED) {
      // evidence first: if it cannot be stored the transition fails and the status is rolled back
      if (opts.proof) await this.proof.persist(order, opts.proof);
      else await this.proof.recordForced(order, actor.id);
      if (opts.proof?.idCheck) order.meta = { ...(order.meta ?? {}), idCheck: { result: opts.proof.idCheck, minAge: order.minAge, at: new Date().toISOString() } };
      await this.settleDelivered(order);
      if (order.driverId) {
        // a stacked second order may still be in progress: the driver stays "on trip" until the last one is done
        const others = await this.orders
          .createQueryBuilder('o')
          .where('o.driverId = :d AND o.id != :id AND o.status IN (:...st)', { d: order.driverId, id: order.id, st: [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY] })
          .getCount();
        if (!others) await this.drivers.update(order.driverId, { onTrip: false });
      }
    }

    if (to === OrderStatus.PICKED_UP) this.computeDriverWait(order);
    order.status = to;
    await this.orders.save(order);
    // an assigned driver must not stay stuck "on trip" when the order is cancelled / rejected (unless they still hold another active order)
    if ((to === OrderStatus.CANCELLED || to === OrderStatus.REJECTED) && order.driverId) {
      const others = await this.orders
        .createQueryBuilder('o')
        .where('o.driverId = :d AND o.id != :id AND o.status IN (:...st)', { d: order.driverId, id: order.id, st: [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY] })
        .getCount();
      if (!others) await this.drivers.update(order.driverId, { onTrip: false });
    }

    await this.addEvent(order.id, 'STATUS_CHANGE', actor, opts.note ?? opts.reason, { from, to });
    // the recipient could not show ID: the age-restricted products stay with the driver / store and are refunded (after the order is saved: the refund updates it too)
    if (to === OrderStatus.DELIVERED && opts.proof?.idCheck === 'REFUSED') await this.retail.refuseAgeRestricted(order, actor);
    if (to === OrderStatus.PICKED_UP && Number(order.driverWaitFee) > 0) {
      const amount = `$${Number(order.driverWaitFee).toFixed(2)}`;
      await this.addEvent(order.id, 'DRIVER_WAIT_FEE', { type: ActorType.SYSTEM }, `Driver waited ${order.driverWaitMinutes} min at the restaurant: ${amount} paid to the driver and deducted from the restaurant payout`, { amount: Number(order.driverWaitFee), minutes: order.driverWaitMinutes });
      await this.notifications.notifyRestaurant(order.restaurantId, 'wait.fee_charged', { code: order.code, minutes: order.driverWaitMinutes, amount }, { orderId: order.id }).catch(() => undefined);
      const dp = order.driverId ? await this.drivers.findOne({ where: { id: order.driverId } }).catch(() => null) : null;
      if (dp?.userId) await this.notifications.notify({ userId: dp.userId, audience: 'DRIVER', event: 'wait.fee_charged', vars: { code: order.code, minutes: order.driverWaitMinutes, amount }, data: { orderId: order.id } }).catch(() => undefined);
    }
    this.realtime.emitToOrder(order.id, 'order.status', { orderId: order.id, status: to });
    if (this.isReleased(order)) this.realtime.emitToRestaurant(order.restaurantId, 'order.status', { orderId: order.id, status: to });
    if (order.driverId) this.realtime.emitToDriver(order.driverId, 'order.status', { orderId: order.id, status: to });

    const evt = CUSTOMER_EVENT[to];
    if (evt) {
      await this.notifications.notify({
        userId: order.customerId,
        audience: 'CUSTOMER',
        event: evt,
        vars: { code: order.code, restaurant: await this.restaurantNameOf(order.restaurantId), prepMinutes: order.prepTimeMin, reason: opts.reason, driverName: undefined, refundNote: this.refundNote(order) },
        data: { orderId: order.id },
      });
    }

    this.emitter.emit(Events.ORDER_STATUS_CHANGED, { order, from, to, actor });
    if (to === OrderStatus.DELIVERED || to === OrderStatus.COLLECTED) this.emitter.emit(Events.ORDER_DELIVERED, { order, from, to, actor });
    if (to === OrderStatus.CANCELLED || to === OrderStatus.REJECTED) this.emitter.emit(Events.ORDER_CANCELLED, { order, from, to, actor });

    return this.getById(order.id);
  }

  /** Settings of the driver wait-time pay (all editable in System > Platform Settings). */
  waitFeeConfig() {
    return {
      enabled: this.settings.get<boolean>('orders.waitFee.enabled', true),
      graceMinutes: Math.max(0, Number(this.settings.get<number>('orders.waitFee.graceMinutes', 5))),
      perMinute: Math.max(0, Number(this.settings.get<number>('orders.waitFee.perMinute', 0.5))),
      maxPerOrder: Math.max(0, Number(this.settings.get<number>('orders.waitFee.maxPerOrder', 10))),
    };
  }

  /**
   * When the clock for the driver's waiting starts: the later of the driver's arrival and the ORIGINAL promised ready time. If the restaurant had already
   * marked the order Ready when the driver arrived, the order was declared ready: the clock starts at the arrival, whatever the promised time was
   * (the driver stands there while items are still being prepared).
   */
  waitClockStart(order: Pick<Order, 'driverArrivedRestaurantAt' | 'meta' | 'estimatedReadyAt' | 'readyAt'>): Date | null {
    if (!order.driverArrivedRestaurantAt) return null;
    if (order.readyAt && order.readyAt.getTime() <= order.driverArrivedRestaurantAt.getTime()) return order.driverArrivedRestaurantAt;
    const promised = order.meta?.promisedReadyAt ? new Date(order.meta.promisedReadyAt) : order.estimatedReadyAt;
    if (!promised) return order.driverArrivedRestaurantAt;
    return new Date(Math.max(order.driverArrivedRestaurantAt.getTime(), promised.getTime()));
  }

  /**
   * Driver waited at the restaurant: minutes beyond the grace period (default 5) after max(arrival, promised ready time) are charged per minute,
   * paid to the driver and deducted from the restaurant's payout (ledger rows are written when the order is settled).
   */
  private computeDriverWait(order: Order) {
    const cfg = this.waitFeeConfig();
    if (!cfg.enabled || order.fulfilment !== FulfilmentMode.PLATFORM_DRIVER || !order.driverId || !order.pickedUpAt) return;
    const start = this.waitClockStart(order);
    if (!start) return; // no arrival record: nothing to prove the wait
    const waitMin = Math.max(0, (order.pickedUpAt.getTime() - start.getTime()) / 60_000);
    order.driverWaitMinutes = Math.floor(waitMin);
    const chargeable = Math.ceil(Math.max(0, waitMin - cfg.graceMinutes));
    const fee = Math.min(cfg.maxPerOrder, round2(chargeable * cfg.perMinute));
    order.driverWaitFee = chargeable > 0 ? fee : 0;
    order.meta = { ...(order.meta ?? {}), waitFee: { waitMinutes: Math.round(waitMin * 10) / 10, chargeableMinutes: chargeable, amount: order.driverWaitFee, from: start.toISOString(), to: order.pickedUpAt.toISOString(), graceMinutes: cfg.graceMinutes, perMinute: cfg.perMinute } };
  }

  /** Live view of the driver's waiting at the restaurant (driver, restaurant and staff only). */
  waitingInfo(order: Order) {
    const cfg = this.waitFeeConfig();
    if (!cfg.enabled || order.fulfilment !== FulfilmentMode.PLATFORM_DRIVER) return undefined;
    const recorded = order.meta?.waitFee;
    if (order.pickedUpAt) return recorded ? { waitMinutes: recorded.waitMinutes, chargeableMinutes: recorded.chargeableMinutes, fee: Number(order.driverWaitFee), waived: !!recorded.waived, perMinute: cfg.perMinute, graceMinutes: cfg.graceMinutes } : undefined;
    const start = this.waitClockStart(order);
    if (!start) return undefined;
    const waited = Math.max(0, (Date.now() - start.getTime()) / 60_000);
    const chargeable = Math.ceil(Math.max(0, waited - cfg.graceMinutes));
    return { since: start.toISOString(), feeStartsAt: new Date(start.getTime() + cfg.graceMinutes * 60_000).toISOString(), graceMinutes: cfg.graceMinutes, perMinute: cfg.perMinute, waitedMinutes: Math.floor(waited), accruedFee: Math.min(cfg.maxPerOrder, round2(chargeable * cfg.perMinute)) };
  }

  /** Staff waive the wait fee (e.g. after a restaurant dispute): the restaurant is made whole and FORKSY absorbs it; the driver keeps the pay. */
  async waiveWaitFee(orderId: string, actor: ActorRef, reason: string): Promise<Order> {
    const order = await this.getById(orderId);
    const fee = Number(order.driverWaitFee);
    if (!(fee > 0)) throw new BadRequestException('This order has no driver wait fee');
    if (order.meta?.waitFee?.waived) throw new BadRequestException('The wait fee was already waived');
    const settled = (await this.ledgerEntries(order.id)) > 0;
    order.meta = { ...(order.meta ?? {}), waitFee: { ...(order.meta?.waitFee ?? {}), waived: true, waivedBy: actor.name ?? actor.id ?? null, waivedAt: new Date().toISOString(), waiveReason: reason.slice(0, 300) } };
    if (settled) {
      const restaurant = await this.restaurants.findOne({ where: { id: order.restaurantId } });
      await this.ledger.add({ partyType: PartyType.RESTAURANT, partyId: restaurant?.merchantId ?? null, restaurantId: order.restaurantId, orderId: order.id, type: LedgerType.WAIT_FEE, amount: fee, description: `Wait-time charge waived on ${order.code}: ${reason}` });
      await this.ledger.add({ partyType: PartyType.PLATFORM, partyId: null, orderId: order.id, type: LedgerType.ADJUSTMENT, amount: -fee, description: `Wait-time charge on ${order.code} absorbed by FORKSY (waived)` });
    } else {
      order.driverWaitFee = 0; // not settled yet: nothing was posted, so the fee simply disappears; the driver is paid by FORKSY below
      await this.ledger.add({ partyType: PartyType.DRIVER, partyId: order.driverId, orderId: order.id, type: LedgerType.WAIT_FEE, amount: fee, description: `Wait-time pay (paid by FORKSY, charge waived) for ${order.code}` }).catch(() => undefined);
    }
    await this.orders.save(order);
    await this.addEvent(order.id, 'WAIT_FEE_WAIVED', actor, reason, { amount: fee });
    return this.getById(order.id);
  }

  private async ledgerEntries(orderId: string): Promise<number> {
    const rows: { n: string }[] = await this.orders.manager.query(`SELECT COUNT(*)::int AS n FROM ledger_entries WHERE "orderId" = $1`, [orderId]);
    return Number(rows[0]?.n ?? 0);
  }

  private async settleDelivered(order: Order) {
    // the card was charged at checkout: nothing is captured now. Only an order placed as an old manual-capture hold is captured at delivery.
    if (order.paymentStatus !== PaymentStatus.CAPTURED && !(await this.payments.hasCharge(order))) {
      try {
        await this.payments.capture(order);
      } catch (e: any) {
        // the failure still propagates (the transition is rolled back); staff and the customer are told
        this.notifications.notifyOps('payment.failed', { code: order.code, reason: String(e?.message ?? 'capture failed').slice(0, 160) }, { orderId: order.id }).catch(() => undefined);
        this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'payment.issue', vars: { code: order.code }, data: { orderId: order.id } }).catch(() => undefined);
        throw e;
      }
      order.paymentStatus = PaymentStatus.CAPTURED;
    }
    await this.ledger.settleOrder(order);
  }

  private async restaurantNameOf(id: string): Promise<string> {
    const rows: { name: string }[] = await this.orders.manager.query('SELECT name FROM restaurants WHERE id = $1', [id]).catch(() => []);
    return rows[0]?.name ?? 'The restaurant';
  }

  /** one sentence about the money for a cancelled / rejected order (customer notification) */
  private refundNote(order: Order): string {
    const toCard = !!order.paymentIntentId && order.meta?.refundTo !== 'WALLET'; // the customer can ask for the refund to go to the wallet
    if (order.cancellationFee && Number(order.cancellationFee) > 0) return `A cancellation fee of $${Number(order.cancellationFee).toFixed(2)} applies; the rest of your payment is ${toCard ? 'refunded to your card (it can take 5-10 business days to show on your statement)' : 'returned to your wallet'}.`;
    if (order.paymentStatus === PaymentStatus.RELEASED) return 'You have not been charged: the payment hold was released.'; // an order placed before "charge at checkout"
    if (order.paymentStatus === PaymentStatus.REFUNDED) return toCard ? 'Your payment is refunded in full to your card (it can take 5-10 business days to show on your statement).' : 'Your payment is returned to your wallet.';
    return 'Your payment will be refunded.';
  }

  /**
   * Gives the card payment back for a cancelled / rejected order: to the card it was paid with (default) or, when the customer asked for it
   * (order.meta.refundTo = WALLET), into their Forky wallet. A payment hold that was never captured is simply released (no money moved).
   */
  private async refundCancelled(order: Order, keep = 0) {
    const r = await this.payments.refundOnCancel(order, keep, order.meta?.refundTo === 'WALLET');
    if (r.walletCredit && r.walletCredit > 0) {
      await this.wallet.credit(order.customerId, r.walletCredit, 'REFUND', { orderId: order.id, note: 'Order cancelled - refunded to your wallet as you asked' });
    }
    return r;
  }

  /** Reject / cancel: give the card payment back (or an old hold is released), keeping the cancellation fee when one applies, per section 7 rules. */
  private async applyCancellationMoney(order: Order, actor: ActorRef) {
    // already delivered: the order is settled, money goes back only through the refund flow
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COLLECTED) return;
    const oldHold = order.paymentStatus === PaymentStatus.AUTHORIZED; // placed before "charge at checkout": the card was only held

    const freeUntil = this.settings.get<string>('orders.freeCancelUntil', 'ACCEPTED');
    const isStaffOrRestaurant = actor.type === ActorType.STAFF || actor.type === ActorType.RESTAURANT;
    const restaurantLate = order.acceptDeadlineAt ? false : order.estimatedReadyAt != null && Date.now() > order.estimatedReadyAt.getTime();

    // inside the customer's grace window the cancellation is always free, even if the kitchen has already started
    const withinGrace = actor.type === ActorType.CUSTOMER && this.customerCancelWindow(order).open;
    const freeCancel = order.status === OrderStatus.PLACED || isStaffOrRestaurant || restaurantLate || (freeUntil === order.status) || withinGrace;

    if (freeCancel) {
      await this.refundCancelled(order);
      order.paymentStatus = oldHold ? PaymentStatus.RELEASED : PaymentStatus.REFUNDED;
      if (order.walletUsed > 0) await this.wallet.credit(order.customerId, order.walletUsed, 'ADJUSTMENT', { orderId: order.id, note: 'Order cancelled - wallet portion returned' });
      if (actor.type === ActorType.RESTAURANT && order.status !== OrderStatus.PLACED) {
        // restaurant cancelling after accept counts against its reliability score (section 9.3)
        const penalty = this.settings.get<number>('orders.reliabilityPenaltyPerCancel', 5);
        await this.restaurants.decrement({ id: order.restaurantId }, 'reliabilityScore', penalty);
      }
      return;
    }

    // Customer-initiated cancellation after acceptance, restaurant on time: forfeit the food cost (capped),
    // refund fees + tip. The card was charged at checkout, so "keeping" the fee means refunding everything except that
    // slice. (An order placed as an old hold keeps the fee by capturing just that slice; Stripe releases the rest of the hold.)
    const capPct = this.settings.get<number>('orders.cancellationFeeMaxPctOfFood', 100);
    const fee = round2(Math.min(Number(order.subtotal) * (capPct / 100), Number(order.total)));
    order.cancellationFee = fee;
    // the fee is kept from the card payment first; if wallet credit paid part of the order and the card cannot cover the whole fee, the wallet keeps the difference
    const cardFee = fee > 0 && order.paymentIntentId ? Math.min(fee, await this.payments.cardAtStake(order)) : 0;
    const walletKeeps = round2(fee - cardFee);
    await this.refundCancelled(order, cardFee);
    if (fee > 0) await this.ledger.add({ partyType: PartyType.PLATFORM, partyId: null, orderId: order.id, type: LedgerType.ADJUSTMENT, amount: fee, description: `Late-cancellation fee on ${order.code}` });
    order.paymentStatus = fee > 0 ? PaymentStatus.PARTIALLY_REFUNDED : oldHold ? PaymentStatus.RELEASED : PaymentStatus.REFUNDED;
    const walletBack = round2(Number(order.walletUsed) - Math.min(Number(order.walletUsed), walletKeeps));
    if (walletBack > 0) await this.wallet.credit(order.customerId, walletBack, 'ADJUSTMENT', { orderId: order.id, note: 'Order cancelled - wallet portion returned' });
  }

  // ---------------------------------------------------------------------- cancellation window and hand-over to the kitchen

  /** Orders created before the rule (kitchenReleaseAt = null) count as released. */
  isReleased(order: Pick<Order, 'kitchenReleaseAt' | 'kitchenReleasedAt'>): boolean {
    return !order.kitchenReleaseAt || !!order.kitchenReleasedAt;
  }

  /**
   * Customer cancel window: from payment completion for orders.customerCancelGraceSeconds (default 120 s). While it is open the order is held
   * by FORKSY and is NOT with the kitchen; cancelling then costs nothing and the restaurant never sees the order. When it closes the order is
   * released to the restaurant and customers can no longer cancel (only FORKSY staff, with the restaurant's approval).
   */
  customerCancelWindow(order: Pick<Order, 'status' | 'createdAt' | 'fulfilment' | 'kitchenReleaseAt' | 'kitchenReleasedAt'>): { open: boolean; until: Date | null } {
    const grace = Number(this.settings.get<number>('orders.customerCancelGraceSeconds', 120));
    const until = order.kitchenReleaseAt ?? (grace > 0 ? new Date(order.createdAt.getTime() + grace * 1000) : null);
    const open = !!until && order.status === OrderStatus.PLACED && !order.kitchenReleasedAt && Date.now() <= until.getTime();
    return { open, until };
  }

  /** Hands a held order to the restaurant: starts its response clock, tells the kitchen and lets the automation accept it. Idempotent. */
  async releaseToKitchen(orderId: string): Promise<boolean> {
    const claim = await this.orders
      .createQueryBuilder()
      .update(Order)
      .set({ kitchenReleasedAt: new Date() })
      .where('id = :id AND status = :st AND "kitchenReleasedAt" IS NULL', { id: orderId, st: OrderStatus.PLACED })
      .execute();
    if (!claim.affected) return false;
    const order = await this.getById(orderId);
    const r = await this.restaurants.findOne({ where: { id: order.restaurantId } });
    const sec = r?.autoRejectSeconds || this.settings.get<number>('orders.autoRejectSeconds', 180);
    await this.orders.update(orderId, { acceptDeadlineAt: new Date(Date.now() + sec * 1000) });
    await this.addEvent(order.id, 'SENT_TO_KITCHEN', { type: ActorType.SYSTEM }, 'Cancellation window over - order sent to the restaurant');
    this.realtime.emitToRestaurant(order.restaurantId, 'order.new', { orderId: order.id, code: order.code });
    this.realtime.emitToOrder(order.id, 'order.released', { orderId: order.id });
    // Who tells the restaurant, and how loudly, is decided right after: the order is either accepted automatically (a quiet notice) or it waits for the
    // restaurant to accept it (the loud alarm + popup). See OrderAutomationService.onPlaced / tellRestaurantNewOrder.
    this.emitter.emit(Events.ORDER_RELEASED, { order });
    return true;
  }

  /**
   * Tell the restaurant about an order that has just been handed to it.
   *  MANUAL: it must be accepted by a person: THE loud alert (alarm sound, push that stays on screen, and the Accept / Reject popup in the portal).
   *  AUTO:   it was accepted automatically: a quiet notice only, nobody has to do anything.
   * MANUAL is skipped when somebody already handled the order in the meantime.
   */
  async tellRestaurantNewOrder(orderId: string, mode: 'MANUAL' | 'AUTO'): Promise<void> {
    const order = await this.getById(orderId);
    if (mode === 'MANUAL' && order.status !== OrderStatus.PLACED) return;
    const r = await this.restaurants.findOne({ where: { id: order.restaurantId } });
    const sec = r?.autoRejectSeconds || this.settings.get<number>('orders.autoRejectSeconds', 180);
    const qty = (order.items ?? []).filter((i: any) => !i.removed).reduce((n: number, i: any) => n + Number(i.quantity ?? 1), 0);
    const vars = { code: order.code, type: String(order.fulfilment ?? 'delivery').toLowerCase().replace('_', ' '), itemCount: qty || (order.items ?? []).length, total: `$${Number(order.total ?? 0).toFixed(2)}` };
    if (mode === 'MANUAL') await this.notifications.notifyRestaurant(order.restaurantId, 'order.placed', { ...vars, acceptMinutes: Math.max(1, Math.round(sec / 60)) }, { orderId: order.id });
    else await this.notifications.notifyRestaurant(order.restaurantId, 'order.auto_accepted', { ...vars, prepMinutes: order.prepTimeMin ?? '' }, { orderId: order.id });
  }

  /** Safety net for the in-process timer (restarts, clock drift): release everything whose window has closed. */
  @Cron('*/5 * * * * *')
  async sweepRelease() {
    const due = await this.orders
      .createQueryBuilder('o')
      .select(['o.id'])
      .where('o.status = :s AND o.kitchenReleaseAt IS NOT NULL AND o.kitchenReleasedAt IS NULL AND o.kitchenReleaseAt <= now()', { s: OrderStatus.PLACED })
      .limit(100)
      .getMany();
    for (const o of due) await this.releaseToKitchen(o.id).catch((e) => this.logger.warn(`release failed: ${(e as Error).message}`));
  }

  // ---- staff cancel after the restaurant already has the order: needs the restaurant's approval
  /** FORKSY staff ask the restaurant for permission to cancel; the restaurant answers in its portal. */
  async requestCancelApproval(orderId: string, actor: ActorRef, reason: string): Promise<Order> {
    const order = await this.getById(orderId);
    if (!this.isReleased(order)) throw new BadRequestException('This order is still held by FORKSY (customer cancellation window) - no restaurant approval is needed to cancel it');
    if (![OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.DRIVER_ASSIGNED].includes(order.status)) throw new BadRequestException('This order can no longer be cancelled through a restaurant approval');
    if (order.meta?.cancelRequest?.status === 'PENDING') throw new ConflictException('A cancellation request is already waiting for the restaurant');
    order.meta = { ...(order.meta ?? {}), cancelRequest: { status: 'PENDING', reason: String(reason).slice(0, 500), requestedBy: { id: actor.id ?? null, name: actor.name ?? 'FORKSY support' }, requestedAt: new Date().toISOString() } };
    await this.orders.save(order);
    await this.addEvent(order.id, 'CANCEL_REQUESTED', actor, reason);
    this.realtime.emitToRestaurant(order.restaurantId, 'order.cancel_requested', { orderId: order.id, code: order.code, reason });
    await this.notifications.notifyRestaurant(order.restaurantId, 'order.cancel_requested', { code: order.code, reason }, { orderId: order.id });
    return this.getById(order.id);
  }

  /** The restaurant approves or declines FORKSY's cancellation request. */
  async respondCancelRequest(orderId: string, restaurantId: string, actor: ActorRef, approve: boolean, note?: string): Promise<Order> {
    const order = await this.getById(orderId);
    if (order.restaurantId !== restaurantId) throw new NotFoundException('Order not found');
    const req = order.meta?.cancelRequest;
    if (!req || req.status !== 'PENDING') throw new BadRequestException('There is no cancellation request waiting for an answer');
    order.meta = { ...(order.meta ?? {}), cancelRequest: { ...req, status: approve ? 'APPROVED' : 'DECLINED', respondedBy: { id: actor.id ?? null, name: actor.name ?? 'Restaurant' }, respondedAt: new Date().toISOString(), note: note?.slice(0, 300) ?? null } };
    await this.orders.save(order);
    await this.addEvent(order.id, approve ? 'CANCEL_APPROVED_BY_RESTAURANT' : 'CANCEL_DECLINED_BY_RESTAURANT', actor, note);
    this.realtime.emitToRestaurant(order.restaurantId, 'order.cancel_request_answered', { orderId: order.id, decision: approve ? 'approved' : 'declined' });
    await this.notifications.notifyOps('order.cancel_request_answered', { code: order.code, decision: approve ? 'approved' : 'declined', note: note ?? '' }, { orderId: order.id });
    return this.getById(order.id);
  }

  async cancel(orderId: string, actor: ActorRef, reason: string, opts: { restaurantApproval?: { contactName: string; channel: string; note?: string }; refundTo?: 'ORIGINAL_PAYMENT' | 'WALLET' } = {}): Promise<Order> {
    const order = await this.getById(orderId);
    if (actor.type === ActorType.CUSTOMER) {
      if (!this.customerCancelWindow(order).open) {
        throw new ForbiddenException('The cancellation window for this order has closed. Please contact support if there is a problem with your order.');
      }
    } else if (actor.type === ActorType.STAFF) {
      const beforePickup = [OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.DRIVER_ASSIGNED].includes(order.status);
      if (beforePickup && this.isReleased(order)) {
        // the restaurant already has the job: FORKSY can only cancel with the restaurant's approval
        const approved = order.meta?.cancelRequest?.status === 'APPROVED';
        const manual = opts.restaurantApproval;
        if (!approved && !(manual && manual.contactName?.trim().length >= 2)) {
          throw new BadRequestException("The restaurant already has this order. Ask the restaurant for approval first (send a cancellation request, or record who at the restaurant approved it) before cancelling.");
        }
        if (!approved && manual) {
          order.meta = { ...(order.meta ?? {}), cancelApproval: { by: manual.contactName.trim().slice(0, 80), channel: manual.channel, note: manual.note?.slice(0, 300) ?? null, recordedBy: actor.name ?? actor.id ?? null, at: new Date().toISOString() } };
          await this.orders.save(order);
          await this.addEvent(order.id, 'CANCEL_APPROVAL_RECORDED', actor, `Restaurant approval recorded: ${manual.contactName.trim()} (${manual.channel})${manual.note ? ' - ' + manual.note : ''}`);
        }
      }
    } else if (order.status !== OrderStatus.PLACED && order.status !== OrderStatus.ACCEPTED) {
      throw new ForbiddenException('This order can no longer be cancelled from the app - contact support');
    }
    if ((order.status === OrderStatus.PICKED_UP || order.status === OrderStatus.ON_THE_WAY) && actor.type === ActorType.STAFF && !actor.supportApproved) {
      throw new ForbiddenException('Cancelling after pickup needs support approval');
    }
    // where the money goes: back to the payment method used (default), or into the customer's Forky wallet to spend on the next order
    if (opts.refundTo === 'WALLET' || opts.refundTo === 'ORIGINAL_PAYMENT') {
      await this.orders.update(order.id, { meta: { ...(order.meta ?? {}), refundTo: opts.refundTo } as Record<string, any> });
    }
    return this.transition(orderId, OrderStatus.CANCELLED, actor, { reason });
  }

  // ---------------------------------------------------------------------- partial fulfilment

  async removeItem(orderId: string, orderItemId: string, actor: ActorRef, reason: string): Promise<Order> {
    const order = await this.getById(orderId);
    const item = order.items.find((i) => i.id === orderItemId);
    if (!item) throw new NotFoundException('Order item not found');
    if (item.removed) return order;

    item.removed = true;
    item.removedReason = reason;
    await this.items.save(item);

    const amount = round2(Number(item.lineTotal) + Number(item.taxAmount));
    order.meta = { ...order.meta, pendingItemRemoval: { orderItemId, amount, reason, requestedAt: new Date().toISOString() } };
    await this.orders.save(order);

    await this.addEvent(order.id, 'PARTIAL_FULFILMENT', actor, reason, { orderItemId, amount });
    this.realtime.emitToOrder(order.id, 'order.item_removed', { orderId: order.id, orderItemId, amount });
    await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'order.item_removed', data: { orderId: order.id }, vars: { restaurant: await this.restaurantNameOf(order.restaurantId), item: item.name, code: order.code, amount: `$${amount.toFixed(2)}` } });
    return this.getById(order.id);
  }

  async respondToItemRemoval(orderId: string, customerId: string, approve: boolean): Promise<Order> {
    const order = await this.getById(orderId);
    if (order.customerId !== customerId) throw new ForbiddenException('Not your order');
    const pending = order.meta?.pendingItemRemoval;
    if (!pending) throw new BadRequestException('No pending item change on this order');

    if (approve) {
      await this.refunds.issue({
        orderId: order.id,
        amount: pending.amount,
        type: RefundType.REFUND,
        chargedTo: RefundChargedTo.RESTAURANT,
        reasonCode: 'MISSING_ITEM',
        notes: pending.reason,
        actor: { type: ActorType.SYSTEM, staff: false },
        auto: true,
      });
      order.meta = { ...order.meta, pendingItemRemoval: null };
      await this.orders.save(order);
      return this.getById(order.id);
    }
    order.meta = { ...order.meta, pendingItemRemoval: null };
    await this.orders.save(order);
    return this.cancel(orderId, { type: ActorType.CUSTOMER, id: customerId }, 'Declined item substitution');
  }

  // ---------------------------------------------------------------------- misc

  async addEvent(orderId: string, type: string, actor: ActorRef, note?: string, data?: Record<string, any>): Promise<void> {
    await this.events.insert({
      orderId,
      type,
      fromStatus: data?.from ?? null,
      toStatus: data?.to ?? null,
      actorType: actor.type,
      actorId: actor.id ?? null,
      note: note ?? null,
      data: data ?? null,
    });
  }

  async setEta(orderId: string, estimatedReadyAt?: Date | null, estimatedDeliveryAt?: Date | null): Promise<void> {
    const patch: Partial<Order> = {};
    if (estimatedReadyAt !== undefined) patch.estimatedReadyAt = estimatedReadyAt;
    if (estimatedDeliveryAt !== undefined) patch.estimatedDeliveryAt = estimatedDeliveryAt;
    await this.orders.update(orderId, patch);
    this.realtime.emitToOrder(orderId, 'order.eta', { orderId, estimatedReadyAt, estimatedDeliveryAt });
  }

  async updateTip(orderId: string, customerId: string, tip: number): Promise<Order> {
    const order = await this.getById(orderId);
    if (order.customerId !== customerId) throw new ForbiddenException('Not your order');
    // tips can be changed while the order is live, or for N minutes after delivery - never on cancelled orders, never later
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REJECTED) throw new BadRequestException('This order was cancelled');
    if (order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COLLECTED) {
      const minutes = this.settings.get<number>('orders.tipEditableMinutes', 60);
      const deadline = new Date((order.deliveredAt ?? order.updatedAt).getTime() + minutes * 60_000);
      if (Date.now() > deadline.getTime()) throw new BadRequestException('The tip window for this order has closed');
      order.tipEditableUntil = deadline;
    }
    if (!Number.isFinite(tip)) throw new BadRequestException('Invalid tip');
    const maxTip = this.settings.get<number>('orders.maxTip', 200);
    const newTip = Math.min(Math.max(round2(tip), 0), maxTip);
    const delta = round2(newTip - Number(order.tip));
    if (delta !== 0) {
      await this.payments.adjustTip(order, newTip);
      if ((order.status === OrderStatus.DELIVERED || order.status === OrderStatus.COLLECTED) && order.driverId) {
        await this.ledger.add({ partyType: PartyType.DRIVER, partyId: order.driverId, orderId: order.id, type: LedgerType.TIP, amount: delta, description: `Tip adjustment on ${order.code}` });
      }
    }
    order.tip = newTip;
    await this.orders.save(order);
    if (order.driverId) {
      const dp = await this.drivers.findOne({ where: { id: order.driverId }, select: ['id', 'userId'] }).catch(() => null);
      if (dp?.userId) await this.notifications.notify({ userId: dp.userId, audience: 'DRIVER', event: 'order.tip_updated', vars: { code: order.code, tip: `$${newTip.toFixed(2)}` }, data: { orderId: order.id } });
    }
    await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'order.tip_updated', vars: { code: order.code, tip: `$${newTip.toFixed(2)}` }, data: { orderId: order.id } }).catch(() => undefined);
    return order;
  }

  // ---------------------------------------------------------------------- driver assignment

  /**
   * Assign a driver. Before the food is ready (ACCEPTED/PREPARING) this moves the order to DRIVER_ASSIGNED (legacy flow).
   * When the order is already READY (dispatch.startOn = READY) or later (admin manual (re)assign) the status is NOT moved
   * backwards: the driver is recorded on the order, the timeline gets a DRIVER_ASSIGNED event and everyone is notified.
   */
  async assignDriver(orderId: string, driverId: string, actor: ActorRef, opts: { boost?: number } = {}): Promise<Order> {
    const order = await this.getById(orderId);
    if (order.fulfilment === FulfilmentMode.PICKUP) throw new BadRequestException('Pickup orders do not need a driver');
    if (END_STATUSES.has(order.status)) throw new BadRequestException(`Order ${order.code} has already ended (${order.status})`);
    // owner rule: never more than 2 orders assigned to one driver at the same time (applies to automatic offers AND manual assignment)
    const carrying = await this.orders
      .createQueryBuilder('o')
      .where('o.driverId = :d AND o.id != :id AND o.status IN (:...st)', { d: driverId, id: order.id, st: [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY, OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY] })
      .getCount();
    if (carrying >= 2) throw new BadRequestException('A driver can carry at most 2 orders at the same time');
    const prevStatus = order.status;
    order.driverId = driverId;
    if (opts.boost) order.driverBoost = round2(opts.boost);
    const driverPay = await this.pricing.driverPay({ cityId: order.cityId, zoneId: order.zoneId, pickupKm: Number(order.distanceKm ?? 0) / 2, dropKm: Number(order.distanceKm ?? 0) / 2, tip: Number(order.tip) });
    order.driverPay = driverPay.total;
    order.driverAssignedAt = new Date();
    await this.orders.save(order);
    await this.drivers.update(driverId, { onTrip: true });

    let updated: Order;
    if (prevStatus === OrderStatus.ACCEPTED) {
      updated = await this.transition(orderId, OrderStatus.DRIVER_ASSIGNED, actor);
    } else {
      // PREPARING (driver found shortly before the food is ready) / READY / DRIVER_ASSIGNED / PICKED_UP / ON_THE_WAY: keep the status, just record the driver on the timeline
      await this.addEvent(order.id, 'DRIVER_ASSIGNED', actor, undefined, { status: prevStatus, driverId });
      this.realtime.emitToOrder(order.id, 'order.driver_assigned', { orderId: order.id, driverId, status: prevStatus });
      this.realtime.emitToRestaurant(order.restaurantId, 'order.driver_assigned', { orderId: order.id, driverId, status: prevStatus });
      updated = await this.getById(order.id);
    }
    this.realtime.emitToDriver(driverId, 'order.assigned', { orderId: order.id, code: order.code });
    this.realtime.emitToOps('order.driver_assigned', { orderId: order.id, code: order.code, driverId });

    const dp = await this.drivers.findOne({ where: { id: driverId }, relations: ['user'] }).catch(() => null);
    const driverName = `${dp?.user?.firstName ?? 'Your driver'} ${dp?.user?.lastName?.[0] ?? ''}`.trim();
    if (dp?.userId) await this.notifications.notify({ userId: dp.userId, audience: 'DRIVER', event: 'offer.accepted', vars: { code: order.code }, data: { orderId: order.id } }).catch(() => undefined);
    await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'driver.assigned', vars: { code: order.code, driverName, vehicle: dp?.vehicleType ?? 'vehicle' }, data: { orderId: order.id } }).catch(() => undefined);
    await this.notifications.notifyRestaurant(order.restaurantId, 'driver.assigned', { code: order.code, driverName, etaMinutes: 5 }, { orderId: order.id }).catch(() => undefined);
    return updated;
  }

  /** Remove the driver. DRIVER_ASSIGNED falls back to ACCEPTED; READY and later keep their status. `redispatch` restarts the driver search. */
  async unassignDriver(orderId: string, actor: ActorRef, reason: string, opts: { redispatch?: boolean } = {}): Promise<Order> {
    const order = await this.getById(orderId);
    if (!order.driverId) return order;
    const afterPickup = [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(order.status);
    if (afterPickup && actor.type === ActorType.STAFF && !actor.supportApproved) {
      throw new ForbiddenException('Unassigning a driver after pickup needs support approval');
    }
    const oldDriverId = order.driverId;
    await this.drivers.update(oldDriverId, { onTrip: false });
    order.driverId = null;
    if (order.status === OrderStatus.DRIVER_ASSIGNED) order.status = OrderStatus.ACCEPTED;
    await this.orders.save(order);
    await this.addEvent(order.id, 'REASSIGN', actor, reason, { status: order.status, driverId: oldDriverId });
    this.realtime.emitToOrder(order.id, 'order.driver_unassigned', { orderId: order.id });
    this.realtime.emitToDriver(oldDriverId, 'order.unassigned', { orderId: order.id });
    const oldDp = await this.drivers.findOne({ where: { id: oldDriverId }, select: ['id', 'userId'] }).catch(() => null);
    if (oldDp?.userId) await this.notifications.notify({ userId: oldDp.userId, audience: 'DRIVER', event: 'order.reassigned', vars: { code: order.code, reason: reason ?? '' }, data: { orderId: order.id } }).catch(() => undefined);
    if (opts.redispatch) this.emitter.emit(Events.DRIVER_UNASSIGNED, { orderId: order.id, driverId: oldDriverId });
    return this.getById(order.id);
  }

  /** The driver of an order as the restaurant may see him: enough to recognise him at the counter or to reach him in an emergency. */
  private restaurantDriverCard(d: DriverProfile | undefined) {
    if (!d) return null;
    return { name: `${d.user?.firstName ?? ''} ${d.user?.lastName?.[0] ? d.user.lastName[0] + '.' : ''}`.trim(), vehicleType: d.vehicleType, vehicleColor: d.vehicleColor, licensePlate: d.licensePlate, lat: d.lat, lng: d.lng, lastLocationAt: d.lastLocationAt, phone: d.user?.phone ?? null };
  }

  async driverCardFor(driverId: string | null) {
    if (!driverId) return null;
    return this.restaurantDriverCard((await this.drivers.findOne({ where: { id: driverId }, relations: ['user'] })) ?? undefined);
  }

  /** Orders already in a driver's hands (picked up / on the way) for the restaurant's "Out for delivery" tab: who has it, how to recognise them, where they are. */
  async outForDelivery(restaurantId: string) {
    const rows = await this.orders.find({ where: [{ restaurantId, status: OrderStatus.PICKED_UP }, { restaurantId, status: OrderStatus.ON_THE_WAY }], order: { pickedUpAt: 'DESC' }, take: 100 });
    const ids = [...new Set(rows.map((o) => o.driverId).filter((x): x is string => !!x))];
    const profiles = ids.length ? await this.drivers.find({ where: ids.map((id) => ({ id })), relations: ['user'] }) : [];
    const byId = new Map(profiles.map((d) => [d.id, d]));
    return rows.map((o) => {
      const d = o.driverId ? byId.get(o.driverId) : undefined;
      return {
        id: o.id,
        code: o.code,
        status: o.status,
        total: o.total,
        pickedUpAt: o.pickedUpAt,
        estimatedDeliveryAt: o.estimatedDeliveryAt,
        driver: this.restaurantDriverCard(d),
      };
    });
  }

  async driverArrived(orderId: string, stage: 'RESTAURANT' | 'CUSTOMER', actor: ActorRef, opts: { lat?: number; lng?: number } = {}): Promise<Order> {
    const order = await this.getById(orderId);
    const field = stage === 'RESTAURANT' ? 'driverArrivedRestaurantAt' : 'driverArrivedCustomerAt';
    (order as any)[field] = new Date();
    await this.orders.save(order);
    await this.addEvent(order.id, `DRIVER_ARRIVED_${stage}`, actor, undefined, opts);
    this.realtime.emitToOrder(order.id, 'order.driver_arrived', { orderId: order.id, stage });
    if (stage === 'CUSTOMER') {
      // heads-up for the customer, worded for the method they chose
      const m = order.dropoffMethod;
      const pin = order.requiresPin ? order.deliveryPin : null;
      const body =
        m === DropoffMethod.LEAVE_AT_DOOR
          ? `Your driver has arrived with order ${order.code} and will leave it at your door.`
          : m === DropoffMethod.MEET_OUTSIDE
            ? `Your driver has arrived outside with order ${order.code}.${pin ? ` Tell them PIN ${pin}.` : ''}`
            : `Your driver has arrived with order ${order.code}.${pin ? ` Tell them PIN ${pin}.` : ''}`;
      // the in-app text may carry the PIN; the push never does (see notifications/events.ts: only {code, methodNote} reach it)
      const methodNote = m === DropoffMethod.LEAVE_AT_DOOR ? 'It will be left at your door.' : m === DropoffMethod.MEET_OUTSIDE ? `They are waiting outside.${pin ? ' Have your delivery PIN ready.' : ''}` : `Meet your driver.${pin ? ' Have your delivery PIN ready.' : ''}`;
      await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'delivery.driver_arrived', title: 'Your driver has arrived', body, vars: { code: order.code, methodNote }, data: { orderId: order.id } }).catch(() => undefined);
    } else if (order.driverId) {
      // the driver is at the restaurant: tell the customer and (loudly) the kitchen
      const dp = await this.drivers.findOne({ where: { id: order.driverId }, relations: ['user'] }).catch(() => null);
      const driverName = `${dp?.user?.firstName ?? 'Your driver'} ${dp?.user?.lastName?.[0] ? dp.user.lastName[0] + '.' : ''}`.trim();
      const rows: { name: string }[] = await this.orders.manager.query('SELECT name FROM restaurants WHERE id = $1', [order.restaurantId]).catch(() => []);
      const vars = { code: order.code, driverName, restaurant: rows[0]?.name ?? 'the restaurant' };
      await this.notifications.notify({ userId: order.customerId, audience: 'CUSTOMER', event: 'driver.arrived_restaurant', vars, data: { orderId: order.id } }).catch(() => undefined);
      await this.notifications.notifyRestaurant(order.restaurantId, 'driver.arrived_restaurant', vars, { orderId: order.id }).catch(() => undefined);
    }
    return order;
  }

  // ---------------------------------------------------------------------- delivery instructions
  private static readonly BEFORE_PICKUP = [OrderStatus.PLACED, OrderStatus.ACCEPTED, OrderStatus.DRIVER_ASSIGNED, OrderStatus.PREPARING, OrderStatus.READY];

  /** Customer changes the handoff method / driver instructions / access code until the driver has picked the food up. */
  async updateDeliveryInstructions(orderId: string, customerId: string, patch: { dropoffMethod?: string; usePin?: boolean; dropoffNotes?: string | null; accessCode?: string | null }): Promise<Order> {
    const order = await this.getById(orderId, []);
    if (order.customerId !== customerId) throw new NotFoundException('Order not found');
    if (order.fulfilment === FulfilmentMode.PICKUP) throw new BadRequestException('Pickup orders have no delivery instructions');
    if (!OrdersService.BEFORE_PICKUP.includes(order.status)) throw new BadRequestException('Your driver already has the order - delivery instructions can no longer be changed. Use chat to reach your driver.');
    const set: Partial<Order> = {};
    const before = { method: order.dropoffMethod, requiresPin: order.requiresPin, usePin: order.usePin };
    let method = order.dropoffMethod;
    if (patch.dropoffMethod !== undefined) {
      if (!Object.values(DropoffMethod).includes(patch.dropoffMethod as DropoffMethod)) throw new BadRequestException('Unknown delivery method');
      method = patch.dropoffMethod as DropoffMethod;
      set.dropoffMethod = method;
      set.contactless = method === DropoffMethod.LEAVE_AT_DOOR;
    }
    if (patch.dropoffMethod !== undefined || patch.usePin !== undefined) {
      const usePin = patch.usePin ?? order.usePin;
      set.usePin = usePin;
      const needPin = this.proof.shouldHavePin(method, Number(order.total), order.fulfilment, usePin);
      set.requiresPin = needPin;
      if (needPin && !order.deliveryPin) set.deliveryPin = this.codes.pin(4);
    }
    if (patch.dropoffNotes !== undefined) set.dropoffNotes = cleanNotes(patch.dropoffNotes);
    if (patch.accessCode !== undefined) set.accessCode = sealCode(cleanAccessCode(patch.accessCode));
    if (!Object.keys(set).length) return order;
    await this.orders.update(orderId, set as any);
    const after = await this.getById(orderId, []);
    const rule = this.proof.requirementFor(after);
    await this.addEvent(orderId, 'DELIVERY_INSTRUCTIONS_CHANGED', { type: ActorType.CUSTOMER, id: customerId }, undefined, {
      methodFrom: before.method,
      methodTo: after.dropoffMethod,
      usePinFrom: before.usePin,
      usePinTo: after.usePin,
      notesChanged: patch.dropoffNotes !== undefined,
      accessCodeChanged: patch.accessCode !== undefined, // the code itself is never logged
      proof: rule.rule,
    });
    const payload = { orderId, code: after.code, dropoffMethod: after.dropoffMethod, usePin: after.usePin, dropoffNotes: after.dropoffNotes, proofRule: rule.rule, proofLabel: rule.label, accessCodeChanged: patch.accessCode !== undefined };
    if (after.driverId) {
      this.realtime.emitToDriver(after.driverId, 'order.instructions_changed', payload);
      const dp = await this.drivers.findOne({ where: { id: after.driverId } });
      if (dp?.userId) {
        await this.notifications
          .notify({ userId: dp.userId, audience: 'DRIVER', event: 'delivery.instructions_changed', title: `Delivery instructions updated - ${after.code}`, body: `The customer changed the handoff to "${after.dropoffMethod.replace(/_/g, ' ').toLowerCase()}" (${rule.label}).${after.dropoffNotes ? ' Note: ' + after.dropoffNotes : ''}`, data: { orderId } })
          .catch(() => undefined);
      }
    }
    this.realtime.emitToOrder(orderId, 'order.instructions_changed', { orderId, dropoffMethod: after.dropoffMethod, proofRule: rule.rule });
    return after;
  }

  /** The decrypted access code, or null. Callers decide who may see it. */
  async accessCodeOf(orderId: string): Promise<string | null> {
    const row = await this.orders.createQueryBuilder('o').select('o.accessCode', 'ac').where('o.id = :id', { id: orderId }).getRawOne();
    return openCode(row?.ac);
  }

  /** Staff "Reveal": only once the driver has the food, audit-logged by the caller. */
  async revealAccessCode(orderId: string): Promise<{ accessCode: string | null; purged: boolean }> {
    const order = await this.getById(orderId, []);
    if (!order.pickedUpAt && ![OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY, OrderStatus.DELIVERED].includes(order.status)) throw new ForbiddenException('The access code can only be revealed after the driver has picked up the order');
    return { accessCode: await this.accessCodeOf(orderId), purged: !!order.accessCodePurgedAt };
  }

  // ---------------------------------------------------------------------- tracking

  async trackingView(orderId: string, viewer?: 'CUSTOMER' | 'DRIVER' | 'RESTAURANT' | 'STAFF'): Promise<any> {
    const order = await this.orders.findOne({ where: { id: orderId }, relations: ['items', 'restaurant'] });
    if (!order) throw new NotFoundException('Order not found');
    const driver = order.driverId ? await this.drivers.findOne({ where: { id: order.driverId }, relations: ['user'] }) : null;
    const timeline = await this.events.find({ where: { orderId }, order: { createdAt: 'ASC' } });
    const full = viewer === 'STAFF' || !viewer;
    const active = [OrderStatus.PICKED_UP, OrderStatus.ON_THE_WAY].includes(order.status);
    const rule = this.proof.requirementFor(order);
    const accessCode = viewer === 'DRIVER' && active && order.driverId ? await this.accessCodeOf(orderId) : null;
    const hasCode = !!(await this.orders.createQueryBuilder('o').select('o.accessCode', 'ac').where('o.id = :id', { id: orderId }).getRawOne())?.ac;
    const proofRow = [OrderStatus.DELIVERED, OrderStatus.COLLECTED].includes(order.status) && order.fulfilment !== FulfilmentMode.PICKUP ? await this.proof.find(orderId) : null;
    const cancelWindow = viewer === 'CUSTOMER' ? this.customerCancelWindow(order) : null;
    const dropoff =
      viewer === 'RESTAURANT'
        ? { method: order.dropoffMethod, contactless: order.dropoffMethod === DropoffMethod.LEAVE_AT_DOOR }
        : {
            method: order.dropoffMethod,
            contactless: order.dropoffMethod === DropoffMethod.LEAVE_AT_DOOR,
            notes: viewer === 'DRIVER' && !order.pickedUpAt ? null : order.dropoffNotes, // drivers see the instructions together with the address
            accessCode, // DRIVER only, from pickup until delivery; staff use the audited reveal action
            accessCodeSet: viewer === 'CUSTOMER' || full ? hasCode : undefined,
            proofRule: rule.rule,
            proofLabel: rule.label,
            // driver app contract: pinInput.required => show 4 digit boxes (send them as "pin"); photoRequired => camera + upload (proofPhotoUrl, lat, lng, accuracy, capturedAt)
            pinInput: viewer === 'DRIVER' ? { required: rule.pinRequired, length: 4 } : undefined,
            photoRequired: viewer === 'DRIVER' ? rule.photoRequired : undefined,
            // PIN off: the driver chooses "handed to the customer" (no photo needed) or "delivered / left" (photo compulsory)
            deliveryActions: viewer === 'DRIVER' ? rule.deliveryActions : undefined,
            usePin: viewer === 'CUSTOMER' || full ? order.usePin : undefined,
            exceptionReasons: viewer === 'DRIVER' ? rule.exceptionReasons : undefined,
          };

    return {
      id: order.id,
      code: order.code,
      status: order.status,
      ...retailView(order, order.restaurant.storeType),
      fulfilment: order.fulfilment,
      restaurant: {
        id: order.restaurant.id,
        name: order.restaurant.name,
        address: full || viewer === 'CUSTOMER' ? `${order.restaurant.addressLine1}, ${order.restaurant.city}` : null,
        lat: order.restaurant.lat,
        lng: order.restaurant.lng,
      },
      items: order.items.filter((i) => !i.removed),
      /** lines that are gone (out of stock, ID not shown): shown to the customer with the refund, never to the driver */
      removedItems: viewer === 'DRIVER' ? undefined : order.items.filter((i) => i.removed).map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, reason: i.removedReason, pickStatus: i.pickStatus, refunded: Number(i.adjustmentRefund ?? 0) })),
      total: order.total,
      waiting: viewer !== 'CUSTOMER' ? this.waitingInfo(order) : undefined,
      kitchenReleaseAt: viewer === 'CUSTOMER' || full ? order.kitchenReleaseAt : undefined,
      sentToKitchen: viewer === 'CUSTOMER' || full ? this.isReleased(order) : undefined,
      canCancel: cancelWindow ? cancelWindow.open : undefined,
      cancelUntil: cancelWindow?.until ?? undefined,
      // the driver never gets a pickup code for a delivery: he tells the restaurant the order number; only a customer collecting in store has a code
      pickupCode: viewer === 'DRIVER' ? (order.fulfilment === FulfilmentMode.PICKUP ? order.pickupCode : null) : full || viewer === 'CUSTOMER' ? order.pickupCode : null,
      deliveryPin: (viewer === 'CUSTOMER' || full) && order.requiresPin ? order.deliveryPin : null,
      dropoff,
      kitchenNotes: viewer === 'DRIVER' ? null : order.customerNotes,
      deliveryProof: proofRow ? (viewer === 'CUSTOMER' || viewer === 'DRIVER' ? this.proof.customerView(proofRow) : viewer === 'RESTAURANT' ? { proofType: proofRow.proofType, deliveredAt: proofRow.deliveredAt } : this.proof.summary(proofRow)) : null,
      deliveryAddress: viewer === 'DRIVER' && !order.pickedUpAt ? null : viewer === 'RESTAURANT' || !order.deliveryAddress ? (order.deliveryAddress ? { ...order.deliveryAddress, dropoffNotes: undefined } : null) : order.deliveryAddress,
      driver: driver
        ? {
            id: driver.id,
            name: `${driver.user?.firstName ?? 'Your'} ${driver.user?.lastName?.[0] ?? ''}`.trim(),
            vehicleType: driver.vehicleType,
            vehicleColor: driver.vehicleColor,
            licensePlate: driver.licensePlate,
            lat: driver.lat,
            lng: driver.lng,
            phone: full ? driver.user?.phone : null,
          }
        : null,
      estimatedReadyAt: order.estimatedReadyAt,
      estimatedDeliveryAt: order.estimatedDeliveryAt,
      isLate: order.isLate,
      timeline: timeline.map((e) => ({ type: e.type, toStatus: e.toStatus, note: full ? e.note : null, createdAt: e.createdAt })),
    };
  }

  // ---------------------------------------------------------------------- scheduled sweeps

  /** Auto-reject orders the restaurant hasn't actioned within its accept window (section 7). */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweepAutoReject() {
    if (this.settings.get<boolean>('orders.newOrdersPaused', false)) return;
    const stale = await this.orders.find({ where: { status: OrderStatus.PLACED } });
    const now = Date.now();
    for (const o of stale) {
      if (o.acceptDeadlineAt && o.acceptDeadlineAt.getTime() < now) {
        await this.transition(o.id, OrderStatus.REJECTED, { type: ActorType.SYSTEM }, { reason: 'Restaurant did not respond in time', force: true }).catch((e) =>
          this.logger.warn(`auto-reject failed for ${o.code}: ${(e as Error).message}`),
        );
      }
    }
  }

  /** Flag orders running behind their quoted ETA so the live map / dispatcher can react. */
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepLateFlags() {
    const active = await this.orders.find({
      where: [{ status: OrderStatus.PREPARING }, { status: OrderStatus.READY }, { status: OrderStatus.PICKED_UP }, { status: OrderStatus.ON_THE_WAY }],
    });
    const now = Date.now();
    for (const o of active) {
      const target = o.estimatedDeliveryAt?.getTime() ?? o.estimatedReadyAt?.getTime();
      const late = !!target && now > target;
      if (late !== o.isLate) {
        await this.orders.update(o.id, { isLate: late });
        if (late) {
          this.realtime.emitToOps('order.late', { orderId: o.id, code: o.code });
          this.emitter.emit(Events.ORDER_LATE, { orderId: o.id, code: o.code });
        }
      }
    }
  }
}
