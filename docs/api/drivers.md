# Drivers API

Base: `/api/v1`. Lists return `{ data, meta: { page, limit, total, totalPages } }`. Errors: `{ statusCode, message, details? }`.
Permission column = `Module.DRIVERS` action (`view|create|edit|delete|approve|export`).

Enums: DriverStatus `APPLIED, DOCS_REVIEW, BACKGROUND_CHECK, TRAINING, APPROVED, ACTIVE, SUSPENDED, DEACTIVATED, REJECTED`; VehicleType `CAR, BIKE, E_BIKE, SCOOTER, ON_FOOT`; DriverDocType `LICENCE, VEHICLE_REGISTRATION, INSURANCE, PHOTO, WORK_ELIGIBILITY, BACKGROUND_CHECK, OTHER`; DocStatus `PENDING, APPROVED, REJECTED, EXPIRED`; Incentive type `PEAK_BOOST, QUEST, FIRST_WEEK, WEATHER, SUPPLY_ALERT`; Shift status `OPEN, BOOKED, STARTED, COMPLETED, MISSED, CANCELLED`; SOS status `OPEN, ACKNOWLEDGED, RESOLVED`; background check `NOT_STARTED, IN_PROGRESS, CLEAR, CONSIDER, FAILED`.

## Admin `/admin/drivers` (staff)

| Method | Path | Perm | Request | Response |
|---|---|---|---|---|
| GET | `/` | view | page,limit,search,sortBy,sortDir,status,cityId,zoneId,vehicleType,online(true/false),ratingMin,ratingMax,expiringDays,backgroundCheck,verification (UNVERIFIED, PENDING, NEEDS_REVIEW, VERIFIED, REJECTED) | paginated driver rows (id,name,status,isOnline,rating,rates,nextDocExpiry,verificationStatus,verificationMethod,verifiedAt,verificationDueAt...) |
| GET | `/summary` | view | cityId | `{byStatus,online,onTrip,docsExpiring30d,openSos}` |
| GET | `/export` | export | same filters as list | `{csv}` |
| GET | `/expiring-documents` | view | days(30),type,page,limit | paginated `{id,driverId,driverName,type,status,expiresAt,fileUrl}` |
| GET | `/analytics` | view | cityId,zoneId,days(7),limit | `{windowDays,fleet,topDrivers[]}` |
| GET | `/heat-map` | view | cityId | zones `[{zoneId,zoneName,centerLat,centerLng,onlineDrivers,onTripDrivers,openOrders,demandScore}]` |
| GET | `/incentives` | view | page,limit,zoneId,cityId,driverId,type,active | paginated Incentive |
| POST | `/incentives` | create | name,type,startsAt,endsAt,zoneId?,cityId?,driverId?,amountPerTrip?,percentBoost?,questTrips?,bonusAmount?,daysOfWeek?,startTime?,endTime?,active? | Incentive |
| PATCH | `/incentives/:id` | edit | any creatable field except type/driverId | Incentive |
| DELETE | `/incentives/:id` | delete | - | `{ok}` |
| POST | `/supply-alert` | create | zoneId,boostAmount,durationMinutes(5-720),message?,includeOnline? | Incentive (SUPPLY_ALERT); pushes `driver.supply_alert` to zone + online drivers |
| GET | `/shifts/slots` | view | zoneId,status,from,to,page,limit | open slots with `booked` |
| POST | `/shifts/slots` | create | zoneId,startsAt,endsAt,capacity | slot |
| PATCH | `/shifts/slots/:id` | edit | capacity?,startsAt?,endsAt? | slot |
| DELETE | `/shifts/slots/:id` | delete | - | `{ok}` (cancels) |
| GET | `/shifts` | view | zoneId,driverId,status,from,to | paginated booked shifts |
| GET | `/training-modules` | view | - | TrainingModule[] |
| POST | `/training-modules` | create | title,content,sortOrder?,quiz[{question,options[],correctIndex}],passMark?,active? | module |
| PATCH | `/training-modules/:id` | edit | same, all optional | module |
| DELETE | `/training-modules/:id` | delete | - | `{ok}` |
| GET | `/sos` | view | status,driverId,page,limit | paginated SosAlert |
| POST | `/sos/:id/acknowledge` | edit | note? | SosAlert |
| POST | `/sos/:id/resolve` | edit | note? | SosAlert |
| GET | `/:id` | view | - | full detail (documents, requiredDocuments, insurance, backgroundCheck, training, onboarding checklist, zones, bank (masked), taxInfo (masked), performance, earnings, recentTrips, offers, cases, sosAlerts) |
| POST | `/` | create | email,firstName,lastName,phone,cityId,password?,vehicle fields | `{id,temporaryPassword?}` |
| PATCH | `/:id` | edit | names,phone,cityId,vehicle fields,payoutSchedule,insulatedBagConfirmed,notes | updated row |
| DELETE | `/:id` | delete | - | `{ok}` (only if no trips) |
| POST | `/:id/start-review` | edit | - | checklist |
| PATCH | `/:id/documents/:docId` | approve | status(APPROVED/REJECTED),rejectReason (required on reject),expiresAt (required for licence/insurance/registration) | document |
| PUT | `/:id/insurance` | edit | coversDelivery,expiresAt,provider?,policyNumber? | insurance |
| POST | `/:id/background-check/start` | edit | - | `{provider,ref,status}` (Certn, mock without key). 400 for a driver whose verification is automatic: use `/admin/verification/drivers/:id/start-check` |
| POST | `/:id/background-check/override` | approve | status,note | `{status,driverStatus}`. 400 for a driver whose verification is automatic |
| POST | `/:id/approve` | approve | zoneIds?,insulatedBagConfirmed?,note?,override? | `{status}` (activates if zoneIds). Approving IS the manual verification: the driver becomes VERIFIED (MANUAL) |
| POST | `/:id/activate` | approve | zoneIds[],insulatedBagConfirmed | `{status,zoneIds}`; sends welcome + first-week boost |
| POST | `/:id/reject` | approve | reason | `{status}` |
| POST | `/:id/suspend` | approve | reason,respondWithinDays?,evidence? | `{status,respondBy}` |
| POST | `/:id/deactivate` | approve | reason,respondWithinDays?,evidence? | `{status,respondBy,unpaidBalance}` |
| POST | `/:id/reinstate` | approve | reason? | `{status}` |
| PUT | `/:id/zones` | edit | zoneIds[] | `{before,after}` |

Mutations are audit-logged. `DRIVER_STATUS_CHANGED` event emitted on status changes.

## Registration and verification

How a new driver is admitted (instant, manual or automatic), Force verification, the Verification card and Certn are described in [../verification.md](../verification.md). Driver routes: `GET /api/v1/admin/verification/drivers/:id` (drivers:view) and `POST .../verify`, `.../reject`, `.../start-check` (drivers:approve); the policy, Force verification and the account table are Super Admin only (`/api/v1/admin/verification`). `POST /api/v1/auth/driver/register` answers `verification: {mode: INSTANT|MANUAL|AUTOMATIC, accountStatus, status, method, dueAt, verifiedAt, nextStep}` next to the tokens, and `GET /driver/profile` carries `verification` (same fields without mode / accountStatus). A driver admitted instantly or verified by Certn does not need staff-approved documents to go online (the Ontario platform worker notice is still required).

## Public webhook

| POST | `/public/webhooks/certn` | shared secret | Certn payload | `{ok}` (settles drivers and businesses; implemented in the verification module) |

## Driver app `/driver/*` (DRIVER users)

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/profile` | - | profile + onboarding checklist |
| PATCH | `/profile` | firstName,lastName,language,avatarUrl,vehicle fields,payoutSchedule | profile |
| POST | `/notice/ack` | - | `{ok}` (Ontario platform worker notice) |
| GET | `/checklist` | - | `{steps,missing,driverActions,percent,complete}` |
| GET | `/documents` | - | `{required[],history[]}` |
| POST | `/documents` | type,fileUrl (from `/uploads`),fileName?,expiresAt? | document (PENDING) |
| PATCH | `/documents/:id` | fileUrl,fileName?,expiresAt? | document (reset to PENDING) |
| PUT | `/bank` | **currentPassword (required, re-auth)**,institution,transit,accountNumber (only last 4 kept),holder,debitCardLast4 | masked bank; instant cash-out is held 24 h after a change |
| PUT | `/tax` | sin (last 3 kept),legalName,address | masked tax info |
| GET | `/training` | - | modules (quiz without answers) + progress |
| POST | `/training/:moduleId/quiz` | answers[] (index per question) | `{attempt,passed,score,progress}` |
| PUT | `/zones` | zoneIds[] (subset of approved) | `{zoneIds}` |
| POST | `/online` | zoneId?,lat?,lng? | `{isOnline,activeZoneId}`; 400 lists blocking reasons |
| POST | `/offline` | - | `{isOnline:false}` (blocked while on trip) |
| POST | `/location` | lat,lng,heading?,speed?,orderId? | `{ok,onTrip,etaMin?}` (WS `driver.location` also supported) |
| GET | `/trip/offer` | - | current pending offer or null (DispatchService) |
| POST | `/trip/offer/:offerId/accept` | - | Order |
| POST | `/trip/offer/:offerId/decline` | reason? | `{ok}` |
| GET | `/trip/active` | - | tracking view (DRIVER-masked) or null. Includes `dropoff:{method,contactless,notes,accessCode,proofRule,proofLabel,exceptionReasons}` (`notes` and `accessCode` only once the food is picked up; the access code never before) and `maskedCall` |
| POST | `/trip/:orderId/still-here` | - | `{ok, pending:false, nextCheckAt?}`. Answer to the "are you still on your way?" check (see below). `{ok:false, expired:true}` if the time ran out |
| POST | `/trip/:orderId/arrived-restaurant` | lat?,lng? | Order |
| POST | `/trip/:orderId/picked-up` | code,lat?,lng? | Order (PICKED_UP) |
| POST | `/trip/:orderId/arrived-customer` | lat?,lng? | Order |
| POST | `/trip/:orderId/delivered` | pin?, proofPhotoUrl?, lat?, lng?, accuracy?, capturedAt?, exceptionReason? (CUSTOMER_UNREACHABLE/PIN_NOT_AVAILABLE/SAFETY_CONCERN), note? | Order (DELIVERED). Layered proof of delivery, see [proof-of-delivery.md](../proof-of-delivery.md): `arrived-customer` first; HAND_TO_ME / MEET_OUTSIDE need the customer PIN; LEAVE_AT_DOOR needs a photo uploaded by this driver via `POST /uploads` (JPEG/PNG, our URL) with lat, lng, accuracy, capturedAt; delivery location must be within `delivery.proof.geofenceMeters` (403 otherwise; retry or use the exception path = photo + reason, flagged WEAK_PROOF); photo reuse = 409; 5 wrong PINs lock the PIN path |
| POST | `/trip/:orderId/call` | party(CUSTOMER/RESTAURANT) | `{sessionId,proxyNumber,expiresAt,provider}` |
| GET | `/earnings` | - | `{today,week:{trips,basePay,tips,boosts,total},unpaidBalance,lifetimeEarnings,payoutSchedule}` |
| GET | `/trips` | page,limit,from,to | paginated trip history |
| POST | `/cash-out` | - | Payout (PayoutsService.instantCashOut); 503 if unavailable |
| GET | `/shifts/available` | zoneId,from,to | open slots with capacity |
| POST | `/shifts/:slotId/book` | - | booked shift |
| GET | `/shifts` | - | my shifts |
| DELETE | `/shifts/:id` | - | cancelled shift |
| GET | `/incentives` | - | active incentives applicable to me |
| GET | `/ratings` | - | performance rates (as before) plus the rating summary: `{rating or null, ratingLabel, ratingCount, minCountToShow, smoothedRolling, smoothedAllTime, rawAverage, rolling{days,count,average,smoothed}, last30{count,average}, distribution{1..5}, positiveTags[], negativeTags[], trend[{week,count,avg}], recent[{rating,tags,comment,customer (first name only),createdAt}], recentReviews (same list, legacy name)}`; `rating` is `null` with `ratingLabel:'New'` until 5 ratings |
| POST | `/trip/:orderId/rate-customer` | `{rating 1-5, tags[] (ADDRESS_HARD_TO_FIND, NO_ANSWER, RUDE, ABUSIVE, UNSAFE, LONG_WAIT, FRIENDLY, GOOD_TIPPER, CLEAR_INSTRUCTIONS, EASY_HANDOFF), note? <=500}` | `{ok,orderId,rating,tags}`. Only the order's own FORKSY driver, after DELIVERED, within `ratings.partnerWindowDays` (3), once per order (409). Private: the customer and their average are never returned. Rate limited 10/min |
| GET | `/heat-map` | - | zone demand/supply (same as admin) |
| POST | `/sos` | orderId?,lat?,lng?,message? | SosAlert; ops get `sos.alert` |
| GET | `/sos` | - | my SOS history |

### Are you still on your way? (presence check)

While a driver is on the way to the restaurant, the server expects the pickup run to take as long as the accepted offer's pickup distance implies (28 km/h, at least `driver.presence.minMinutes`). If the driver has not arrived after `driver.presence.multiplier` x that time (default 2x, so 3 min away means a question at 6 min), the driver app gets socket event `driver.presence_check` `{orderId, code, restaurant, deadlineAt, seconds}` plus a push, and `GET /driver/trip/active` carries `presenceCheck:{deadlineAt, seconds}` until it is answered. The driver confirms with `POST /driver/trip/:orderId/still-here`. With no answer by the deadline (`driver.presence.confirmSeconds`, default 90) the order is unassigned (`OrdersService.unassignDriver`, redispatch) and offered to other drivers; the driver gets `driver.presence_timeout` and `order.unassigned` and a push. A confirmed driver is asked again after another expected-pickup interval if still not there. Not asked: drivers already within 150 m of the restaurant, orders past arrival (`driverArrivedRestaurantAt`), own-driver and pickup orders. Settings (all optional): `driver.presence.enabled` (true), `.multiplier` (2), `.minMinutes` (2), `.confirmSeconds` (90). Code: `backend/src/drivers/driver-presence.service.ts` (cron every 20 s).

Realtime: `driver.presence_check`, `driver.presence_timeout`, `driver.status`, `driver.offer`, `driver.offer.cancelled`, `driver.supply_alert` (driver room/zone room); ops room receives `driver.location`, `driver.status`, `sos.alert`.

## Acceptance score (rolling 14 days)

`GET /driver/profile` and the ratings/performance endpoint now include `acceptance: { rate, accepted, declined, expired, total, windowDays: 14, since, lastUpdatedAt }` (`acceptanceRate` is kept and equals `acceptance.rate`). Formula, settings and ranking influence: see [dispatch.md](dispatch.md#acceptance-score-rolling-window). Updates immediately when the driver accepts, declines or lets an offer expire, and hourly so offers older than the window drop out.

Driver trip flow works from `READY`: `GET /driver/trip/offer` -> `POST /driver/trip/offer/:id/accept|decline` -> `arrived-restaurant` -> `picked-up` (pickup code) -> `arrived-customer` -> `delivered`.

Admin: `GET /admin/drivers` rows and `GET /admin/drivers/:id` (also under `performance`) carry `acceptance`. `GET /admin/drivers/:id/offers?days=14` (`DRIVERS:VIEW`) returns `{ acceptance, offers: [{ id, orderId, orderCode, outcome (ACCEPTED|DECLINED|EXPIRED|CANCELLED), sentAt, respondedAt, responseSec, declineReason, pickupKm, estimatedPay, score, countedInScore }] }`. Admin console: list column "Acceptance (14d)" (green >= 90, amber 70-89, red < 70) and an acceptance card + offer table on the Performance tab.

New `driver_profiles` columns (additive): `offersAccepted14d`, `offersDeclined14d`, `offersExpired14d`, `offersTotal14d`, `acceptanceUpdatedAt`.

## Ratings admin (`/admin/ratings`)
| Method | Path | Permission | Response |
|---|---|---|---|
| GET | `/admin/ratings/drivers/:driverId` | drivers:view | summary as above plus `alert` (WARN/REVIEW/null) and `recent[]` with review `id,status,flagReasons,moderation,orderCode,customerName` |
| GET | `/admin/ratings/driver-reviews?status=FLAGGED` or `HIDDEN` | drivers:view | the moderation queue of driver-side ratings |
| POST | `/admin/ratings/driver-reviews/:id/moderate` | drivers:approve | `{action: HIDE/FLAG/RESTORE, reason (3-500, required)}`; audit-logged (`review.hide`, `review.flag`, `review.restore`); the driver's aggregates update immediately |
| POST | `/admin/ratings/recompute` | settings:edit | recompute all aggregates now (also nightly 03:00) |

Thresholds: below `ratings.driver.warnBelow` (4.5, 30-day, >= 20 ratings) the driver gets a coaching notification (`rating.driver_warn`) and ops are told; below `ratings.driver.reviewBelow` (4.2) the SOP-08 detector (`support/review-cases.service.ts`, trigger LOW_RATING) also proposes a review case. Dispatch scoring reads the smoothed `rating` ([dispatch.md](dispatch.md)). Policy: [../ratings.md](../ratings.md).
