# Platform module API (`src/platform/`)

All admin routes are under `/api/v1/admin/...`, require a JWT for `STAFF` or `SUPER_ADMIN`, and the listed
`@Permission(Module.X, Action.Y)` (SUPER_ADMIN bypasses the permission check). Public routes are under
`/api/v1/public/...` and need no auth. Every mutating admin call is written to `AuditService` (`AuditLog`).

Enums used below: `Action = view|create|edit|delete|approve|export`. `Module` values referenced here:
`zones`, `pricing`, `content`, `operations`.

## Cities — `admin/cities` (`Module.ZONES`)

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/cities` | ZONES.view | `PageQueryDto` (+`search`, `active=true\|false`) | `{data:City[+zoneCount,restaurantCount], meta}` |
| `GET /admin/cities/:id` | ZONES.view | - | `City & {zones:[{id,name,active,busyMode}]}` |
| `POST /admin/cities` | ZONES.create | `CreateCityDto` (name, centerLat, centerLng, + all `CityTuningDto` fields below) | created `City` |
| `PATCH /admin/cities/:id` | ZONES.edit | `UpdateCityDto` (any subset) | updated `City` |
| `DELETE /admin/cities/:id` | ZONES.delete | - | `{deleted:true}` (409 if zones/restaurants/drivers exist) |

`CityTuningDto` fields (all optional on update): `province, country, timezone, currency, active`,
customer fees `baseDeliveryFee, perKmFee, serviceFeePct, serviceFeeCap, smallOrderThreshold, smallOrderFee, busyMultiplier`,
driver pay `driverBaseFare, driverPerKm, driverPerWaitMin, driverFreeWaitMin, driverMinPerTrip`,
dispatch `offerTimeoutSec, offersBeforeWiden, maxRadiusWidenings, radiusWidenStepKm, widenBoostAmount, batchMaxOrders, batchMaxDropDistanceKm, batchMaxExtraMinutes`,
timers `autoRejectSeconds, pickupOverdueMin, lateOnTheWayGraceMin, veryLateMin, payoutReleaseThreshold`.

## Zones — `admin/zones` (`Module.ZONES`)

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/zones` | ZONES.view | `PageQueryDto` + `cityId, active, busy` (true/false) | `{data:Zone[+city{id,name},restaurantCount,effective], meta}` |
| `POST /admin/zones/resolve` | ZONES.view | `{lat,lng}` | `{serviceable, insidePolygon, zone, city, effective}` |
| `GET /admin/zones/:id` | ZONES.view | - | `Zone & {restaurantCount, onlineDrivers, effective}` |
| `POST /admin/zones` | ZONES.create | `CreateZoneDto`: `cityId, name` + `ZoneTuningDto` (`polygon:[[lat,lng]≥3], centerLat/Lng, deliveryRadiusKm, maxDeliveryRadiusKm, baseFee, perKmFee, minimumOrder, serviceHours, busyMode, busyMultiplier, busyRadiusKm, targetDrivers`) | created `Zone` |
| `PATCH /admin/zones/:id` | ZONES.edit | `UpdateZoneDto` (same fields, all optional) | updated `Zone` |
| `PUT /admin/zones/:id/service-hours` | ZONES.edit | `{serviceHours:{mon:{open,close,closed?},...}}` | updated `Zone` |
| `POST /admin/zones/:id/busy-mode` | ZONES.edit | `{enabled, multiplier?, radiusKm?, reason?}` | updated `Zone`; emits `zone.busy` to zone room + ops |
| `DELETE /admin/zones/:id` | ZONES.delete | - | `{deleted:true}` (409 if restaurants assigned) |

`serviceHours` day keys: `mon,tue,wed,thu,fri,sat,sun`; each `{open:'HH:mm', close:'HH:mm', closed?:boolean}`.

## Tax classes — `admin/tax-classes` (`Module.PRICING`)

| Method & path | Permission | Body | Response |
|---|---|---|---|
| `GET /admin/tax-classes` | PRICING.view | `PageQueryDto` | `{data:TaxClass[+menuItemCount], meta}` |
| `GET /admin/tax-classes/:id` | PRICING.view | - | `TaxClass` |
| `POST /admin/tax-classes` | PRICING.create | `{code (UPPER_SNAKE), name, ratePct(0-50), active?, isDefault?}` | created `TaxClass` |
| `PATCH /admin/tax-classes/:id` | PRICING.edit | `{name?, ratePct?, active?, isDefault?}` | updated `TaxClass` |
| `DELETE /admin/tax-classes/:id` | PRICING.delete | - | `{deleted:true}` (409 if default or in use by menu items) |

Seeded: `HST_ON` (13%, default), `ZERO_RATED` (0%).

## Commission tiers — `admin/commission-tiers` (`Module.PRICING`)

| Method & path | Permission | Body | Response |
|---|---|---|---|
| `GET /admin/commission-tiers` | PRICING.view | `PageQueryDto` | `{data:CommissionTier[+restaurantCount], meta}` |
| `GET /admin/commission-tiers/:id` | PRICING.view | - | `CommissionTier & {restaurantCount}` |
| `POST /admin/commission-tiers` | PRICING.create | `{name, description?, deliveryPct, pickupPct, ownDriverPct, active?, isDefault?}` | created tier |
| `PATCH /admin/commission-tiers/:id` | PRICING.edit | subset of the above | updated tier |
| `POST /admin/commission-tiers/:id/apply` | PRICING.edit | `ApplyTierDto`: `restaurantIds?[]` and/or `cityId?, zoneId?, fromTierId?` (≥1 selector), `clearOverrides?`, `dryRun?` | `{matched, updated, dryRun, restaurants?[](dry run) \| tier:{id,name}}` |
| `DELETE /admin/commission-tiers/:id` | PRICING.delete | - | `{deleted:true}` (409 if default or restaurants on it) |

Seeded: **Standard** 20/8/12 (default), **Premium** 18/6/10, **Starter** 25/10/14 (delivery/pickup/ownDriver %).
Bulk-apply writes `Restaurant.commissionTierId` directly (repository access, no `RestaurantsModule` import) and
audit-logs the full before/after restaurant list.

## Commission by method — `admin/commission` (`Module.PRICING`)
Stores are charged a different commission for each method the customer chooses: **delivery** (a FORKSY driver delivers, default 20%), **pickup** (the customer collects in store, default 8%) and **own driver** (the store's courier, default 12%).
Rate used at checkout: the store's own override -> the store's tier -> the tier for its kind of store -> the default tier -> the platform default below. One resolver (`platform/commission.ts`) serves checkout and these screens.

| Endpoint | Permission | Body / query | Returns |
|---|---|---|---|
| `GET /admin/commission/defaults` | PRICING.view | - | `{delivery, pickup, ownDriver}` platform default % |
| `PUT /admin/commission/defaults` | PRICING.edit | `{delivery?, pickup?, ownDriver?}` (0 to 100) | the new defaults (audited) |
| `GET /admin/commission/restaurants/:id` | PRICING.view | - | `{rates:{delivery,pickup,ownDriver}}` each `{pct, source, tier}`; source is `RESTAURANT_OVERRIDE`, `RESTAURANT_TIER`, `STORE_TYPE_TIER`, `DEFAULT_TIER` or `PLATFORM_DEFAULT` |
| `GET /admin/commission/summary` | PRICING.view | `from?, to?, restaurantId?, cityId?` | commission earned on completed orders per method, with the average rate |

A store's own rates or tier: `PATCH /admin/pricing/restaurants/:id/commission` (or `PATCH /admin/restaurants/:id/commission`). Tiers: `admin/commission-tiers`. Settings: `commission.default.deliveryPct|pickupPct|ownDriverPct`.

## Cuisines — `admin/cuisines` (`Module.CONTENT`) + public

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/cuisines` | CONTENT.view | `PageQueryDto` + `active` | `{data:Cuisine[+restaurantCount], meta}` |
| `PUT /admin/cuisines/reorder` | CONTENT.edit | `{ids:[uuid,...]}` (new order) | `{ok:true}` |
| `GET /admin/cuisines/:id` | CONTENT.view | - | `Cuisine` |
| `POST /admin/cuisines` | CONTENT.create | `{name, slug?, iconUrl?, sortOrder?, active?}` | created `Cuisine` (slug auto-generated + de-duplicated if omitted) |
| `PATCH /admin/cuisines/:id` | CONTENT.edit | partial of create dto | updated `Cuisine` |
| `DELETE /admin/cuisines/:id` | CONTENT.delete | - | `{deleted:true}` (409 if restaurants use it) |
| `GET /public/cuisines` | none (public) | - | `[{id,name,slug,iconUrl,sortOrder}]` (active only) |

Seeded: 26 cuisines (Pizza, Burgers, Sushi, Chinese, Indian, Thai, Italian, Mexican, Mediterranean, Greek,
Vietnamese, Korean, Japanese, Caribbean, Middle Eastern, BBQ, Vegan, Breakfast, Sandwiches, Desserts,
Coffee & Tea, Seafood, Halal, Wings, Salads, Bubble Tea) with stable slugs.

## Pricing & commission rules — `admin/pricing` (`Module.PRICING`)

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/pricing/cities/:cityId` | PRICING.view | - | City summary: `{city:{...fees,driverPay,payoutReleaseThreshold}, zones:[{...,effectiveBaseFee,effectivePerKmFee,overridesCity}], commissionTiers:[+restaurantsInCity], restaurantsWithoutTier, restaurantsInCity, restaurantsWithOverrides, taxClasses}` |
| `GET /admin/pricing/commission-overrides` | PRICING.view | `PageQueryDto` + `cityId?, tierId?` | `{data:[{restaurantId,name,merchantId,cityId,status,tier,tierRates,overrides,effective}], meta}` |
| `PATCH /admin/pricing/restaurants/:restaurantId/commission` | PRICING.edit | `RestaurantCommissionDto`: `commissionTierId?`, `deliveryCommissionPct?/pickupCommissionPct?/ownDriverCommissionPct?` (send `null` to clear an override) | `{restaurantId, commissionTierId, deliveryCommissionPct, pickupCommissionPct, ownDriverCommissionPct}` |
| `POST /admin/pricing/simulate` | PRICING.view | `SimulateDto` (see below) | `{source:'PricingService'\|'CITY_CONFIG', ...}` |

`SimulateDto`:
- Real-basket mode (delegates to `OrdersModule`'s `PricingService.quote` when injectable): `restaurantId`, `items:[{menuItemId,quantity,modifierOptionIds?}]`, `deliveryAddress?{lat,lng}`, `promoCode?`, `tip?`, `type?('DELIVERY'|'PICKUP')`, `fulfilment?`.
- Manual/what-if mode (falls back automatically, or always when no `items`): `subtotal` (required), `distanceKm?, pickupKm?, waitMin?, tip?, discount?, discountFundedBy?('PLATFORM'|'RESTAURANT'), busy?, taxClassCode?, cityId?/zoneId?/restaurantId?, commissionTierId?, commissionPct?` (what-if overrides).
  Response `CITY_CONFIG` shape: `{inputs, customer:{subtotal,deliveryFee,serviceFee,smallOrderFee,taxAmount,tip,discount,total}, tax:{classCode,ratePct,foodTax,feeTax}, restaurant:{commissionPct,commissionSource,tier,commissionAmount,promoCost,payout}, driver:{pay,tipPassThrough}, platform:{revenue,promoCost,driverCost,contributionMargin,takeRatePct}}`.

## Incidents (SOP-10) — `admin/incidents` (`Module.OPERATIONS`) + public status

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/incidents` | OPERATIONS.view | `PageQueryDto` + `status(OPEN\|MITIGATED\|RESOLVED\|ACTIVE), severity(P1\|P2\|P3), reportOverdue` | `{data:Incident[+stakeholderUpdate*,reportOverdue], meta}` |
| `GET /admin/incidents/active` | OPERATIONS.view | - | `{incidents:[...], state:{ordersPaused,ordersPausedMessage,banner,maintenance}}` |
| `GET /admin/incidents/:id` | OPERATIONS.view | - | `Incident` view (+ computed fields) |
| `POST /admin/incidents` | OPERATIONS.create | `{title, severity(P1\|P2\|P3), description?, bannerMessage?, bannerActive?, pauseNewOrders?, ownerId?}` | created incident; P1/P2 pages ops via `NotificationsService.notifyOps` |
| `PATCH /admin/incidents/:id` | OPERATIONS.edit | `{title?, severity?, description?, ownerId?}` | updated incident |
| `POST /admin/incidents/:id/timeline` | OPERATIONS.edit | `{note}` | updated incident (appends timeline entry) |
| `POST /admin/incidents/:id/banner` | OPERATIONS.edit | `{active, message?}` | updated incident |
| `POST /admin/incidents/:id/pause-orders` | OPERATIONS.approve | `{paused, reason?}` | updated incident; mirrors into `Settings['orders.newOrdersPaused']` for `OrdersModule` to read |
| `POST /admin/incidents/:id/mitigate` | OPERATIONS.edit | `{note?}` | status → `MITIGATED` |
| `POST /admin/incidents/:id/resolve` | OPERATIONS.edit | `{note?}` | status → `RESOLVED`, clears banner/pause, sets 48h `reportDueAt` |
| `PUT /admin/incidents/:id/report` | OPERATIONS.edit | `{report (≥20 chars)}` | post-incident report saved |
| `GET /public/status` | none (public) | - | `{ordersPaused, ordersPausedMessage, banner:{message,severity,since}\|null, maintenance}` |

Realtime: `RealtimeService.emitToOps('incident.updated', {id,status,severity})` on every state change;
`emitToRoom('admin:ops', 'incident.state', {...})` whenever the public banner/pause state changes.
Notifications: `notifyOps('incident.opened'|'incident.resolved', {...})`.

## Ops checklists (SOP-03) — `admin/operations/checklists` (`Module.OPERATIONS`)

| Method & path | Permission | Body / query | Response |
|---|---|---|---|
| `GET /admin/operations/checklists/templates` | OPERATIONS.view | - | `{OPEN:[{key,label}], CLOSE:[{key,label}]}` |
| `PUT /admin/operations/checklists/templates/:kind` | OPERATIONS.edit | `kind=open\|close` (path); `{items:[{key,label}]}` | updated templates map |
| `GET /admin/operations/checklists/current` | OPERATIONS.view | `cityId?, date?(YYYY-MM-DD)` | `{date, cityId, open:Checklist(+progress), close:Checklist(+progress,+closeSummary)}` (creates today's checklists on first call) |
| `GET /admin/operations/checklists` | OPERATIONS.view | `PageQueryDto` + `cityId?, kind?, from?, to?, completed?` | `{data:Checklist[+progress], meta}` |
| `GET /admin/operations/checklists/:id` | OPERATIONS.view | - | `Checklist` (+ `closeSummary` for CLOSE) |
| `PATCH /admin/operations/checklists/:id/items/:key` | OPERATIONS.edit | `{done:boolean}` | updated checklist |
| `PATCH /admin/operations/checklists/:id/notes` | OPERATIONS.edit | `{notes}` | updated checklist |
| `POST /admin/operations/checklists/:id/complete` | OPERATIONS.edit | `{force?, notes?}` | completed checklist (409 if items pending and `force` not set) |
| `POST /admin/operations/checklists/:id/reopen` | OPERATIONS.approve | - | reopened checklist |

`closeSummary` (CLOSE checklist only): `{openOrders, lateOrders, cancelledOrders, completedOrders, totalOrders, refundedOrders, incidents:[{id,title,severity,status}]}` for that city-day.

## Ops supply/demand forecast — `admin/operations/supply` (`Module.OPERATIONS`)

| Method & path | Permission | Query | Response |
|---|---|---|---|
| `GET /admin/operations/supply` | OPERATIONS.view | `cityId?` | `{generatedAt, ordersPerDriverHour, zones:[{zoneId,zone,cityId,busyMode,targetDrivers,onlineDrivers,idleDrivers,onTripDrivers,openOrders,unassignedOrders,lateOrders,ordersLastHour,ordersPerDriver,driverGap,status(OK\|SHORT\|CRITICAL\|SURPLUS),alerts:[string],suggestBusyMode,forecast:[{hourStart,expectedOrders,driversNeeded}]}], totals:{onlineDrivers,openOrders,unassignedOrders}, alerts:[{zoneId,zone,status,messages}]}` |

Forecast = average orders in the same weekday/hour over the trailing 4 weeks, projected 3 hours ahead; `driversNeeded = ceil(expectedOrders / ordersPerDriverHour)` (setting `operations.supplyOrdersPerDriverHour`, default 2.5).

## Public — `PublicPlatformController` equivalents

| Method & path | Response |
|---|---|
| `GET /public/cities` | `[{id,name,province,country,timezone,currency,centerLat,centerLng,zones:[{id,name,centerLat,centerLng,polygon,busyMode,serviceHours}]}]` (active cities/zones only) |
| `GET /public/cuisines` | `[{id,name,slug,iconUrl,sortOrder}]` (active only) |
| `GET /public/zones/resolve?lat=&lng=` | `{serviceable, zone:{id,name,cityId,busyMode,serviceHours}\|null, city:{id,name,timezone,currency}\|null, fees:{baseFee,perKmFee,minimumOrder,busyMultiplier}\|null}` |
| `GET /public/status` | see Incidents section above (status banner + orders-paused flag consumed by all apps) |

## Seed (`seedPlatform`, `src/platform/platform.seed.ts`)

Idempotent (looked up by natural key: city/tier name, zone name+cityId, tax class code, cuisine slug), always
runs regardless of `opts.demo` (foundational data):
- Cities: **Mississauga** (active, centre 43.589,-79.6441), **Toronto** (inactive), **Vaughan** (inactive).
- Zones (Mississauga, real neighbourhood centres + a generated rectangle "polygon"): City Centre, Port Credit, Streetsville, Erin Mills, Meadowvale.
- Tax classes: `HST_ON` (13%, default), `ZERO_RATED` (0%).
- Commission tiers: Standard 20/8/12 (default), Premium 18/6/10, Starter 25/10/14.
- 26 cuisines with slugs (see Cuisines section).
- Ops checklist templates + all `orders.*`/`taxes.*`/`operations.*` settings used by this module come from
  `SETTING_DEFINITIONS` in `src/settings/settings.service.ts` and are inserted automatically by
  `SettingsService.onModuleInit()` on every app boot (including the seed run) — no separate seeding needed here.
