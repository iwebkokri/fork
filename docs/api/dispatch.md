# DispatchModule API

`DispatchService` (`src/dispatch/dispatch.service.ts`, exported globally) implements `IDispatchService` (`src/common/contracts.ts`). It is not called directly over HTTP by customers/restaurants; it is consumed by:

- **OrdersModule** indirectly: `DispatchService` listens for `Events.ORDER_STATUS_CHANGED` and starts the offer loop when a `PLATFORM_DRIVER` order reaches the status chosen by `dispatch.startOn` (default `READY`: the kitchen confirmed the food is ready; `ACCEPTED`: legacy), and for `Events.ORDER_CANCELLED` to stop it.
- **Admin live map controller** below (dispatcher tools).
- **Driver offer controller** below (temporary home for the driver-facing offer primitives until DriversModule wires its own `/driver/*` portal - it can keep calling the same `DispatchService` methods).

## Business flow (default, `dispatch.startOn = READY`)

1. Customer places the order: it is `PLACED` instantly (no scheduling delay unless `scheduledFor` is sent).
2. Restaurant accepts and prepares (`ACCEPTED` -> `PREPARING`). **No driver search happens yet.**
3. Kitchen marks the food ready (`POST /restaurant/orders/:id/ready` or `POST /restaurant/kds/:id/ready`) -> status `READY` -> dispatch starts **automatically and immediately** (no ready-time wait): first offer goes to the best nearby eligible driver within a second. Nobody has to click anything; the admin live-map tools are only an override.
4. One driver at a time, `City.offerTimeoutSec` (30 s) window. Driver accepts (`POST /driver/trip/offer/:id/accept`) -> `Order.driverId`, `driverAssignedAt`, `driverPay`, driver `onTrip`, timeline event `DRIVER_ASSIGNED`, realtime `order.assigned`, customer + restaurant + driver notified. **Status stays `READY`.** Decline / expiry -> next driver immediately; anyone who declined or let the offer expire is never offered this order again. After `offersBeforeWiden` offers the radius widens (+boost); after `maxRadiusWidenings` it escalates to ops (flag + `order.no_driver`) and keeps retrying every `dispatch.escalatedRetrySec`.
5. Driver: `arrived-restaurant` -> `picked-up` (pickup code, READY -> PICKED_UP) -> `arrived-customer` -> `delivered` (ledger settled; the card was charged at checkout, nothing more is captured).

`OrdersService.assignDriver`: from `ACCEPTED`/`PREPARING` it moves to `DRIVER_ASSIGNED` (legacy); from `READY` (or later, e.g. admin reassign) it records the driver **without changing the status** (timeline event `DRIVER_ASSIGNED`, realtime `order.driver_assigned`). `unassignDriver` keeps `READY`, frees the driver, and with `{ redispatch: true }` (admin `POST /admin/live-map/orders/:id/unassign`) restarts dispatch excluding the removed driver. Cancelling/rejecting an order also frees its driver (`onTrip=false`).

### Who is eligible (all automatic; reasons visible in `GET /admin/live-map/orders/:id/candidates`)
`OFFLINE`, `STALE_LOCATION` (GPS older than `dispatch.locationFreshSec`, 120 s), `NOT_APPROVED_FOR_ZONE`, `OUT_OF_RADIUS` (current ring; the search starts in the first ring of `dispatch.radiusRingsKm`, default 2 km), `HAS_PENDING_OFFER`, `ON_TRIP` / `BATCH_*`, `VEHICLE_TOO_FAR`, `ORDER_TOO_LARGE_FOR_VEHICLE`.

## Offer loop behaviour (spec 5.4)

- One driver offered at a time; window = `City.offerTimeoutSec` (default 30s).
- Ready-time matching (only with `dispatch.startOn = ACCEPTED`; skipped entirely when the order is already `READY`): `startDispatch` computes the order's expected ready time (`Order.estimatedReadyAt`) and, using the nearest currently-visible candidate's ETA (or setting `dispatch.assumedPickupEtaMin` if none are online yet), delays the loop (`WAITING` state) so the driver is not sent more than `dispatch.readyMatchWindowMin` minutes before food is ready.
- After `City.offersBeforeWiden` offers (default 3) with no acceptance, (or at once when nobody is found in the ring) the search widens to the next ring of `dispatch.radiusRingsKm` (default 2, 5, 10, 20, 30 km). A driver whose pickup distance is beyond `dispatch.extraFreeKm` (default 2 km) is offered extra pay of `dispatch.extraPerKm` (default $0.18) per km beyond it: `DriverOffer.boostAmount`, folded into `Order.driverBoost` via `OrdersService.assignDriver` and shown in the offer's estimated pay.
- After the widest ring (30 km by default) the order is escalated: `Order.unassignedFlag = true` (drives the live-map RED flag), an ops notification (`order.no_driver`) + `dispatch.escalated` realtime event fire once, and the search **keeps retrying** slowly (`dispatch.escalatedRetrySec`, default 45s) rather than stopping.
- State machine persisted at `Order.meta.dispatch` (`DispatchMeta`): `WAITING -> ACTIVE -> (ESCALATED) -> ASSIGNED`, or `MANUAL` when `dispatch.autoAssign` is off, or `STOPPED`/`MANUAL_HOLD` when a dispatcher takes over.
- Realtime events: `driver.offer` / `driver.offer.cancelled` (to `driver:{id}`), `dispatch.offer_sent` / `dispatch.escalated` / `driver.stationary` (to `admin:ops`). Notification event `driver.offer` (DRIVER audience).

## Admin - Live Operations Map (`AdminLiveMapController`, `src/dispatch/admin-live-map.controller.ts`)

Base path `/api/v1/admin/live-map`. Staff/Super-Admin only.

| Method & path | Permission | Request | Response |
|---|---|---|---|
| `GET /admin/live-map?cityId=` | `LIVE_MAP:VIEW` | query `cityId?` | `{ generatedAt, orders: [{ id, code, status, fulfilment, restaurantId, restaurantName, restaurantLat, restaurantLng, driverId, dropLat, dropLng, estimatedReadyAt, estimatedDeliveryAt, flag: 'NONE'\|'AMBER'\|'RED', flagReasons: string[], minutesLate, dispatch: { state, widenings, radiusKm, sequence } \| null }], drivers: [{ id, name, status, vehicleType, lat, lng, heading, onTrip, rating, lastLocationAt }], restaurants: [{ id, name, lat, lng, status, cityId, zoneId }], counts: { orders, onlineDrivers, driversOnTrip, unassigned, redFlags } }` |
| `GET /admin/live-map/orders/:id/candidates?limit=` | `LIVE_MAP:VIEW` | - | `RankedCandidate[]` - `{ driverId, name, phone, vehicleType, lat, lng, distanceKm, etaMin, dropKm, estimatedPay, score, breakdown, factors, eligible, reasons, activeOrders, onTrip, lastOfferAt, lastLocationAt }[]` (ineligible drivers included, with `reasons` explaining why) |
| `POST /admin/live-map/orders/:id/assign` | `OPERATIONS:EDIT` | `{ driverId, boost? }` | Updated `Order` (stops any running offer loop first; audit-logged `dispatch.manual_assign`) |
| `POST /admin/live-map/orders/:id/reassign` | `OPERATIONS:EDIT` | `{ driverId, reason? }` | Updated `Order` (unassigns current driver, then manual-assigns the new one; audit-logged `dispatch.reassign`) |
| `POST /admin/live-map/orders/:id/start-dispatch` | `OPERATIONS:EDIT` | - | `{ ok: true }` - manually (re)kicks the offer loop for a `MANUAL`/stalled/escalated order (audit-logged `dispatch.restart`) |
| `POST /admin/live-map/orders/:id/offer-alternative` | `OPERATIONS:EDIT` | `{ type: 'CREDIT'\|'PICKUP_OFFER', amount?, reason? }` | `CREDIT`: issues a wallet credit via `RefundsService.issue` (platform-charged, reason code `NO_DRIVER_AVAILABLE`) and returns the `Refund`. `PICKUP_OFFER`: sends the customer the existing `order.no_driver` notification as a nudge and returns `{ ok: true }`. Only allowed while the order still has no driver. Audit-logged `dispatch.offer_credit` / `dispatch.offer_pickup`. |

`flag`/`flagReasons` come from `computeOrderFlag` (`src/dispatch/order-flags.ts`) - reasons include `RESTAURANT_NOT_ACCEPTING`, `KITCHEN_LATE`, `KITCHEN_NEAR_DUE`, `NO_DRIVER_AFTER_READY`, `WIDENED_SEARCH`, `PICKUP_OVERDUE`, `DELIVERY_LATE`, `VERY_LATE`, `NO_DRIVER`, `LATE`.

## Driver offer endpoints (`DriverOfferController`, `src/dispatch/driver-offer.controller.ts`)

Base path `/api/v1/driver/offer`. Driver app only (`DriverController`). Placeholder home for these until DriversModule builds its full `/driver/*` portal - safe to keep calling these same paths/methods.

| Method & path | Request | Response |
|---|---|---|
| `GET /driver/offer/current` | - | Current pending offer for the calling driver, or `null`. Shape: `{ id, orderId, code, restaurant: { id, name, address, lat, lng } \| null, deliveryAddress, itemCount, subtotal, pickupKm, dropKm, estimatedPay, boostAmount, sentAt, expiresAt, secondsLeft }` |
| `POST /driver/offer/:id/accept` | - | Updated `Order` (assigns the driver via `OrdersService.assignDriver`, transitions to `DRIVER_ASSIGNED`). 400 if expired/already resolved/order already has a driver. |
| `POST /driver/offer/:id/decline` | `{ reason? }` | `204`-ish `void` - offer marked `DECLINED`, loop immediately advances to the next candidate. |

## Settings added (`SETTING_DEFINITIONS`, additive)

| Key | Default | Purpose |
|---|---|---|
| `dispatch.assumedPickupEtaMin` | 8 | Fallback "time to find + drive a driver here" used for ready-time matching when no candidate is visible yet at `startDispatch` time. |
| `dispatch.escalatedRetrySec` | 45 | How often the loop retries once an order has been escalated to the dispatcher. |

(Existing dispatch settings reused as-is: `dispatch.autoAssign`, `dispatch.radiusRingsKm`, `dispatch.extraPerKm`, `dispatch.extraFreeKm`, `dispatch.readyMatchWindowMin`, `dispatch.weights`, `dispatch.batching.enabled`, `dispatch.bikeMaxDistanceKm`, `dispatch.bikeMaxSubtotal`, `dispatch.driverMissingAlertMin`; per-city tuning on `City`: `offerTimeoutSec`, `offersBeforeWiden`, `maxRadiusWidenings`, `radiusWidenStepKm`, `widenBoostAmount`, batching fields.)

## Entities

No new entities were needed - `DriverOffer` (`src/database/entities/driver.entities.ts`) already existed with every column the offer loop needs (`sequence`, `round`, `sentAt`, `expiresAt`, `respondedAt`, `pickupDistanceKm`, `dropoffDistanceKm`, `estimatedPay`, `boostAmount`, `score`, `scoreBreakdown`, `declineReason`).

## Acceptance score (rolling window)

Per driver, over offers whose response/expiry time (`COALESCE(respondedAt, expiresAt)`) is within the last `dispatch.acceptance.windowDays` (14) days. `CANCELLED`/`PENDING` offers are ignored.

```
counted = accepted + declined + (countExpiredAsDecline ? expired : 0)
raw     = 100 * accepted / counted
rate    = raw                                   if counted >= minOffers (5)
rate    = w*raw + (1-w)*priorRate (90)          if 0 < counted < minOffers, w = counted/minOffers
rate    = priorRate (90)                        if counted = 0
```

Stored on `DriverProfile`: `acceptanceRate` (this smoothed score, single source of truth also used by analytics), `offersAccepted14d`, `offersDeclined14d`, `offersExpired14d`, `offersTotal14d`, `acceptanceUpdatedAt`. Recomputed live on every accept / decline / expiry (`AcceptanceService.recompute(driverId)`) and for all drivers hourly (`@Cron EVERY_HOUR`) so old offers drop out; raw history stays in `driver_offers`. `POST /admin/drivers/acceptance/recompute` runs the same job on demand.

Settings: `dispatch.startOn` (READY), `dispatch.acceptance.windowDays` (14), `.countExpiredAsDecline` (true), `.minOffers` (5), `.priorRate` (90), `.lowThreshold` (50), `dispatch.locationFreshSec` (120).

## Ranking weights (`dispatch.weights`, normalised by their sum)

| factor | default weight |
|---|---|
| distance | 0.30 |
| readyMatch | 0.20 |
| vehicleFit | 0.08 |
| load | 0.08 |
| performance (on-time 50% + rating 50%) | 0.06 |
| fairness | 0.08 |
| **acceptance** | **0.20** |

Acceptance factor = `rate/100`, halved when `rate < dispatch.acceptance.lowThreshold` (soft penalty, never a hard block). The candidates endpoint `breakdown` shows weighted points per factor plus `acceptanceRate`; `factors.acceptance` is the raw 0..1 value. Example (equal drivers): 98% -> 19.6 pts, 70% -> 14.0 pts, 45% -> 4.5 pts.

## Additional admin endpoints

| Method & path | Notes |
|---|---|
| `POST /admin/live-map/orders/:id/unassign` `{ reason? }` | Remove driver, keep status (READY stays READY), restart automatic dispatch (removed driver excluded). `OPERATIONS:EDIT`. |
| `GET /admin/drivers/:id/offers?days=14` | Offer history in the window (see drivers.md). |
| `POST /admin/drivers/acceptance/recompute` | Run the rolling recompute now. |

## Delivery handoff and proof (summary)
The active trip payload (`GET /driver/trip/active`) carries the customer's handoff method, driver instructions, the proof rule that applies ("PIN required" / "Photo required") and, once the food is picked up, the access code. Completing the delivery is validated by the proof service (arrival, PIN or photo, geofence, server GPS cross-check, photo hash): see [proof-of-delivery.md](../proof-of-delivery.md). `driver.deliveryGeofenceKm` was replaced by `delivery.proof.geofenceMeters` / `delivery.proof.requireGeofence`.
