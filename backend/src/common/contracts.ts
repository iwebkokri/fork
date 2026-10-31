/**
 * Cross-module contracts. Feature modules are built independently against these interfaces.
 * Concrete classes live at the paths listed in docs/ARCHITECTURE.md and are provided by @Global() modules,
 * so any module can simply inject them without importing the owning module.
 */
import {
  ActorType,
  FulfilmentMode,
  LedgerType,
  OrderStatus,
  OrderType,
  PartyType,
  PaymentMethod,
  RefundChargedTo,
  RefundType,
} from './enums';
import { Order, Payout, Promotion, Refund } from '../database/entities';

export interface ActorRef {
  type: ActorType;
  /** users.id of the actor (null for SYSTEM) */
  id?: string | null;
  name?: string;
  ip?: string;
  /** STAFF only: support approval granted (needed to unassign a driver after pickup). */
  supportApproved?: boolean;
}

// ------------------------------------------------------------------ pricing / checkout
export interface QuoteItemInput {
  menuItemId: string;
  quantity: number;
  modifierOptionIds?: string[];
  notes?: string;
  /** retail: what to do when the store does not have the product (default ALLOW a replacement) */
  substitution?: 'ALLOW' | 'REFUND';
}

export interface QuoteInput {
  customerId?: string;
  restaurantId: string;
  type: OrderType;
  /** default: PLATFORM_DRIVER for DELIVERY (or OWN_DRIVER when restaurant ownDeliveryEnabled and requested), PICKUP for PICKUP */
  fulfilment?: FulfilmentMode;
  items: QuoteItemInput[];
  deliveryAddress?: { lat: number; lng: number };
  promoCode?: string;
  /** tip in CAD */
  tip?: number;
  /** apply FORKY wallet balance */
  useWallet?: boolean;
  scheduledFor?: Date | null;
  /** the customer confirmed they are old enough for the age-restricted products in the basket (required when there are any) */
  ageConfirmed?: boolean;
  /** HAND_TO_ME | LEAVE_AT_DOOR | MEET_OUTSIDE: age-restricted baskets cannot be left at the door */
  dropoffMethod?: string;
  /** the customer chose `dropoffMethod` in this request (true) or it is only the saved default of the address (false / missing) */
  dropoffExplicit?: boolean;
  /**
   * true (default): a basket with age-restricted products is refused until `ageConfirmed` (the payment and the order always insist).
   * false: the quote is still priced and says `ageConfirmationRequired` (the page shows the totals first and asks for the confirmation before paying).
   */
  requireAgeConfirmation?: boolean;
}

export interface QuoteLine {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  taxAmount: number;
  taxClassCode: string | null;
  modifiers: { groupName: string; optionId: string; name: string; priceDelta: number }[];
  notes?: string;
  stationId?: string | null;
  allergens: string[];
  // ---- retail line facts (defaults for a plain dish) ----
  sku?: string | null;
  barcode?: string | null;
  packSize?: string | null;
  sellBy?: 'UNIT' | 'WEIGHT';
  weightUnit?: 'KG' | 'LB';
  /** weighed products: `quantity` is a number of steps of this many weight units; `unitPrice` is the price of one step */
  stepSize?: number;
  /** weighed products: quantity x stepSize, in weightUnit */
  estimatedWeight?: number | null;
  minAge?: number;
  temperature?: 'AMBIENT' | 'CHILLED' | 'FROZEN';
  substitution?: 'ALLOW' | 'REFUND';
}

export interface Quote {
  restaurantId: string;
  type: OrderType;
  fulfilment: FulfilmentMode;
  /** what kind of store this is (RESTAURANT, GROCERY ...) */
  storeType?: string;
  /** age-restricted goods in the basket: ID is checked at hand-over */
  requiresIdCheck?: boolean;
  minAge?: number;
  /** the basket has age-restricted products and the customer has not confirmed their age yet: the payment and the order will refuse until they do */
  ageConfirmationRequired?: boolean;
  /** delivery: the hand-over the order will use. An age-restricted basket is always handed over in person (a saved "leave at the door" is replaced) */
  dropoffMethod?: string | null;
  /** what the picker and the driver need to know about the basket */
  basket?: { units: number; lines: number; weighed: number; chilled: number; frozen: number; estimatedKg: number };
  lines: QuoteLine[];
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  smallOrderFee: number;
  taxAmount: number;
  tip: number;
  discountTotal: number;
  platformPromoAmount: number;
  restaurantPromoAmount: number;
  promotion?: { id: string; code: string | null; name: string } | null;
  walletUsed: number;
  total: number; // card amount = total - walletUsed
  distanceKm: number | null;
  prepTimeMin: number;
  etaMinutes: number | null;
  zoneId: string | null;
  cityId: string | null;
  commissionPct: number;
  commissionAmount: number;
  restaurantPayout: number;
  warnings: string[];
  /** fulfilment types usable at this restaurant right now (service mode + capability flags) */
  availableFulfilment?: { serviceMode: string; serviceModeLabel: string; pickup: boolean; delivery: boolean; platformDelivery: boolean; ownDelivery: boolean };
}

export interface PlaceOrderInput extends QuoteInput {
  addressId?: string;
  deliveryAddress?: { lat: number; lng: number; line1?: string; line2?: string; city?: string; province?: string; postalCode?: string; dropoffNotes?: string; label?: string };
  paymentMethod: PaymentMethod;
  /**
   * Stripe PaymentIntent the customer confirmed on the page (Payment Element). Required for any card amount; the server retrieves it
   * from Stripe and verifies owner / status / amount / quote before the order exists. Replaces paymentToken for card payments.
   */
  paymentIntentId?: string;
  /** DEVELOPMENT MOCK ONLY (ALLOW_MOCK_PAYMENTS=true, no Stripe key): any token = a mock payment. Ignored when Stripe is configured. */
  paymentToken?: string;
  giftCardCode?: string;
  contactless?: boolean;
  /** HAND_TO_ME | LEAVE_AT_DOOR | MEET_OUTSIDE (default HAND_TO_ME; contactless=true maps to LEAVE_AT_DOOR) */
  dropoffMethod?: string;
  /** use a private delivery PIN (default true); false = the driver must photograph the delivered order */
  usePin?: boolean;
  /** delivery instructions for the DRIVER (max 300) */
  dropoffNotes?: string;
  /** buzzer / gate code (sensitive, max 40) */
  accessCode?: string;
  /** note for the RESTAURANT / kitchen */
  customerNotes?: string;
  source?: 'app' | 'web' | 'admin' | 'phone';
}

export interface TransitionOpts {
  reason?: string;
  note?: string;
  /** restaurant accept: prep time in minutes (else restaurant default) */
  prepTimeMin?: number;
  /** staff override: ignore transition rules and time limits */
  force?: boolean;
  /** driver actions */
  code?: string; // pickup code / PIN
  proofPhotoUrl?: string;
  /** validated evidence built by ProofService.prepare (driver delivered step) */
  proof?: any;
  lat?: number;
  lng?: number;
}

// ------------------------------------------------------------------ service interfaces
export interface IPricingService {
  quote(input: QuoteInput): Promise<Quote>;
  /** commission % for a restaurant + fulfilment (restaurant override -> tier -> default) */
  commissionPct(restaurantId: string, fulfilment: FulfilmentMode): Promise<number>;
  /** estimated driver pay for a trip (base + per-km + waiting; zone/city rules; incentives). */
  driverPay(input: { cityId?: string | null; zoneId?: string | null; pickupKm: number; dropKm: number; waitMin?: number; tip?: number; at?: Date }): Promise<{ base: number; boost: number; total: number }>;
}

export interface IOrdersService {
  placeOrder(customerId: string, input: PlaceOrderInput): Promise<Order>;
  getById(id: string, relations?: string[]): Promise<Order>;
  /** Single entry point for every status change (validates transition, owner, time limits, writes OrderEvent, emits realtime, notifies, triggers payment capture/settlement). */
  transition(orderId: string, to: OrderStatus, actor: ActorRef, opts?: TransitionOpts): Promise<Order>;
  cancel(orderId: string, actor: ActorRef, reason: string, opts?: { restaurantApproval?: { contactName: string; channel: string; note?: string } }): Promise<Order>;
  /** Customer cancel grace window (orders.customerCancelGraceSeconds): open while inside it and before pickup; `until` is when it closes. */
  customerCancelWindow(order: Pick<Order, 'status' | 'createdAt' | 'fulfilment' | 'kitchenReleaseAt' | 'kitchenReleasedAt'>): { open: boolean; until: Date | null };
  /** has the order been handed to the kitchen (customer cancellation window over)? */
  isReleased(order: Pick<Order, 'kitchenReleaseAt' | 'kitchenReleasedAt'>): boolean;
  /** Restaurant removes an unavailable item -> customer approval + partial refund flow */
  removeItem(orderId: string, orderItemId: string, actor: ActorRef, reason: string): Promise<Order>;
  addEvent(orderId: string, type: string, actor: ActorRef, note?: string, data?: Record<string, any>): Promise<void>;
  /** update ETA, emit order.eta */
  setEta(orderId: string, estimatedReadyAt?: Date | null, estimatedDeliveryAt?: Date | null): Promise<void>;
  updateTip(orderId: string, customerId: string, tip: number): Promise<Order>;
  /** customer changes handoff method / instructions until the driver picks the food up */
  updateDeliveryInstructions(orderId: string, customerId: string, patch: { dropoffMethod?: string; usePin?: boolean; dropoffNotes?: string | null; accessCode?: string | null }): Promise<Order>;
  /** manual (dispatcher) or automatic assignment; driverId is DriverProfile.id */
  assignDriver(orderId: string, driverId: string, actor: ActorRef, opts?: { boost?: number }): Promise<Order>;
  unassignDriver(orderId: string, actor: ActorRef, reason: string, opts?: { redispatch?: boolean }): Promise<Order>;
  /** Snapshot for the live map and tracking screens. `viewer` masks fields; omitted = full internal view. */
  trackingView(orderId: string, viewer?: 'CUSTOMER' | 'DRIVER' | 'RESTAURANT' | 'STAFF'): Promise<any>;
  /** Driver arrival markers (Arrived at restaurant / Arrived at customer). Does not change the order status. */
  driverArrived(orderId: string, stage: 'RESTAURANT' | 'CUSTOMER', actor: ActorRef, opts?: { lat?: number; lng?: number }): Promise<Order>;
  /** Customer answers a partial-fulfilment (item removed) approval request. */
  respondToItemRemoval(orderId: string, customerId: string, approve: boolean): Promise<Order>;
}

export interface IDispatchService {
  /** Start (or restart) the offer loop for an order that needs a platform driver. */
  startDispatch(orderId: string): Promise<void>;
  cancelDispatch(orderId: string, reason?: string): Promise<void>;
  acceptOffer(offerId: string, driverId: string): Promise<Order>;
  declineOffer(offerId: string, driverId: string, reason?: string): Promise<void>;
  /** pending offer (if any) for a driver profile */
  currentOffer(driverId: string): Promise<any | null>;
  /** Ranked candidate drivers with score breakdown (used by admin manual assignment UI) */
  candidates(orderId: string, limit?: number): Promise<{ driverId: string; name: string; distanceKm: number; etaMin: number; score: number; breakdown: Record<string, number> }[]>;
}

export interface IPaymentsService {
  /** Checkout step 1: an automatic-capture PaymentIntent for the card part of the priced cart (amount is always computed by the server). The card is charged when the customer pays. */
  createCheckoutIntent(customerId: string, quote: Quote, quoteHash: string, opts?: { saveCard?: boolean; paymentMethodId?: string; existingIntentId?: string }): Promise<any>;
  /** Only for an order that is still an old manual-capture hold: capture it (all, or `amount` of it). Orders charged at checkout never need this. */
  capture(order: Order, amount?: number): Promise<void>;
  /** Only for an order that is still an old manual-capture hold: release it. */
  release(order: Order): Promise<void>;
  /** A rejected / cancelled order: its card payment goes back to the card (all of it, or all except `keep`, the late-cancellation fee). */
  refundOnCancel(order: Order, keep?: number): Promise<{ mode: 'refunded' | 'released' | 'none'; refunded: number; kept: number }>;
  /** An order was refused after the customer's card was charged: a clear refusal refunds the charge at once. Returns the error to throw (decorated when refunded). */
  refundAfterRefusedOrder(customerId: string, paymentIntentId: string | undefined, error: any): Promise<any>;
  /** card part is refunded to the card (idempotent per refundId); `walletCredit` is what the card could not take and must be credited to the wallet */
  refund(order: Order, amount: number, reason?: string, refundId?: string): Promise<{ externalId?: string; cardAmount: number; walletCredit: number }>;
  adjustTip(order: Order, newTip: number): Promise<void>;
  /** Saved cards (Stripe customer). Card data never touches our servers. */
  createSetupIntent(customerId: string): Promise<{ clientSecret: string; customerId?: string; publishableKey?: string | null; mock?: boolean }>;
  listPaymentMethods(customerId: string): Promise<{ id: string; brand: string; last4: string; expMonth: number; expYear: number; isDefault?: boolean; wallet?: string | null }[]>;
  setDefaultPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
  detachPaymentMethod(customerId: string, paymentMethodId: string): Promise<void>;
}

export interface IPayoutsService {
  /** Driver instant cash-out of the unpaid balance (fee from settings payments.instantPayoutFee*). */
  instantCashOut(driverId: string, actor: ActorRef): Promise<Payout>;
}

export interface IGiftCardsService {
  /** Redeem a gift card code into the customer's wallet. Returns amount added and new wallet balance. */
  redeem(customerId: string, code: string): Promise<{ amount: number; balance: number }>;
}

export interface ILedgerService {
  /** Called when an order reaches DELIVERED/COLLECTED: writes restaurant / driver / platform ledger rows. Idempotent. */
  settleOrder(order: Order): Promise<void>;
  /** Unpaid balance for a party (rows with payoutId IS NULL). partyId = merchantId | driver profile id */
  balance(partyType: PartyType, partyId: string | null): Promise<number>;
  add(entry: { partyType: PartyType; partyId: string | null; restaurantId?: string | null; orderId?: string | null; type: LedgerType; amount: number; description?: string; meta?: Record<string, any> }): Promise<void>;
}

export interface IRefundsService {
  /**
   * Issue a refund / credit. Enforces the staff refund limit (actor role) - over-limit => PENDING_APPROVAL.
   * Writes payment + ledger rows (charged party) + wallet credit when type=CREDIT, notifies the customer.
   */
  issue(input: {
    orderId: string;
    amount: number;
    type?: RefundType;
    chargedTo: RefundChargedTo;
    reasonCode: string;
    notes?: string;
    ticketId?: string;
    actor: ActorRef & { refundLimit?: number | null; staff?: boolean };
    auto?: boolean;
  }): Promise<Refund>;
  /** Approve a PENDING_APPROVAL refund (finance / supervisor). The approver's own refundLimit is enforced. */
  approve(refundId: string, actor: ActorRef & { refundLimit?: number | null }, notes?: string): Promise<Refund>;
  reject(refundId: string, actor: ActorRef & { refundLimit?: number | null }, reason?: string): Promise<Refund>;
}

export interface IWalletService {
  balance(customerId: string): Promise<number>;
  credit(customerId: string, amount: number, type: 'CREDIT' | 'REFUND' | 'TOPUP' | 'GIFT_CARD' | 'REFERRAL' | 'ADJUSTMENT' | 'PROMO', opts?: { orderId?: string; note?: string; actorId?: string }): Promise<number>;
  /** throws if insufficient */
  debit(customerId: string, amount: number, type: 'PURCHASE' | 'ADJUSTMENT', opts?: { orderId?: string; note?: string; actorId?: string }): Promise<number>;
}

export interface PromotionEvaluation {
  promotion: Promotion;
  discountTotal: number;
  platformAmount: number;
  restaurantAmount: number;
  freeDelivery: boolean;
}

export interface IPromotionsService {
  /**
   * Validate a code (or auto-apply promos when code is undefined) against an order draft.
   * Throws BadRequestException with a customer-friendly message for a bad code.
   * Returns null when nothing applies.
   */
  evaluate(input: {
    code?: string;
    customerId?: string;
    restaurantId: string;
    cityId?: string | null;
    zoneId?: string | null;
    orderType: OrderType;
    subtotal: number;
    deliveryFee: number;
    items: { menuItemId: string; quantity: number; unitPrice: number }[];
  }): Promise<PromotionEvaluation | null>;
  redeem(promotionId: string, customerId: string, orderId: string, discount: number): Promise<void>;
  /** undo a redemption when an order is cancelled before capture */
  unredeem(orderId: string): Promise<void>;
}

// ------------------------------------------------------------------ domain events (@nestjs/event-emitter)
/** Listen with @OnEvent(Events.X). Emit with EventEmitter2.emit(Events.X, payload). Listeners must not throw. */
export const Events = {
  ORDER_PLACED: 'order.placed',
  /** payload: { order } - the customer's cancellation window is over and the order has been handed to the restaurant */
  ORDER_RELEASED: 'order.released',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_DELIVERED: 'order.delivered', // DELIVERED or COLLECTED (after payment capture + settlement)
  ORDER_CANCELLED: 'order.cancelled', // CANCELLED or REJECTED
  ORDER_LATE: 'order.late',
  OFFER_RESPONDED: 'offer.responded',
  /** payload: { orderId, driverId } - a driver was removed from an order and it needs a new one */
  DRIVER_UNASSIGNED: 'order.driver_unassigned_redispatch',
  REVIEW_CREATED: 'review.created',
  REFUND_ISSUED: 'refund.issued',
  DRIVER_STATUS_CHANGED: 'driver.status_changed',
  /** payload: { driverId, lat, lng, active: Order[] } - every recorded GPS ping of a driver (used for automatic arrival detection) */
  DRIVER_LOCATION: 'driver.location_recorded',
  RESTAURANT_STATUS_CHANGED: 'restaurant.status_changed',
  /** payload: { id, from, to, resumeAt, actor } where from/to are RestaurantServiceMode values */
  RESTAURANT_SERVICE_MODE_CHANGED: 'restaurant.service_mode_changed',
  TICKET_CREATED: 'ticket.created',
  PAYOUT_PAID: 'payout.paid',
  /**
   * payload: SubjectRegisteredEvent - a driver or business signed up by themselves. Emitted with emitAsync: the VerificationService listener applies the
   * registration policy (instant activation, manual queue or Certn check) and answers with what the person should be told.
   */
  VERIFICATION_SUBJECT_REGISTERED: 'verification.subject_registered',
  /** payload { zoneId }: staff changed a zone's driver limit. The drivers module invites waitlisted couriers into the places that opened up. */
  ZONE_CAPACITY_CHANGED: 'zone.capacity_changed',
} as const;

export interface SubjectRegisteredEvent {
  audience: 'DRIVER' | 'BUSINESS';
  /** DriverProfile.id for a driver, Restaurant.id (the first location) for a business */
  id: string;
}

export interface OrderStatusEvent {
  order: Order;
  from: OrderStatus | null;
  to: OrderStatus;
  actor: ActorRef;
}
export interface OfferRespondedEvent {
  orderId: string;
  driverId: string;
  offerId: string;
  status: 'ACCEPTED' | 'DECLINED' | 'EXPIRED';
}
export interface ReviewCreatedEvent {
  reviewId: string;
  orderId: string;
  restaurantId: string;
  driverId: string | null;
  restaurantRating: number | null;
  driverRating: number | null;
}
export interface StatusChangedEvent {
  id: string; // driver profile id | restaurant id
  from: string;
  to: string;
  reason?: string;
  actor?: ActorRef;
}

export interface PayoutPaidEvent {
  payoutId: string;
  partyType: PartyType;
  /** merchantId | driver profile id */
  partyId: string;
  net: number;
  fee: number;
  instant: boolean;
  batchId: string | null;
}
