import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureFlag, Setting } from '../database/entities';
import { defaultMatrix } from '../notifications/events';
import { seal, unseal } from '../common/secretbox';
import { HEALTH_SETTING_DEFINITIONS } from '../system-health/health-settings';
import { VERIFICATION_SETTING_DEFINITIONS, VERIFICATION_SETTING_GROUP } from '../verification/verification-policy';

/** Every configurable platform setting with its default. Seeded on boot (existing values are never overwritten). */
export const SETTING_DEFINITIONS: any[] = [
  // ---- general ----
  { key: 'general.platformName', group: 'general', label: 'Platform name', value: 'FORKSY', inputType: 'text', isPublic: true },
  { key: 'general.supportEmail', group: 'general', label: 'Support email', value: 'support@forksy.ca', inputType: 'text', isPublic: true },
  { key: 'general.supportPhone', group: 'general', label: 'Support phone', value: '+1-800-555-0100', inputType: 'text', isPublic: true },
  { key: 'general.defaultLanguage', group: 'general', label: 'Default language', value: 'en', inputType: 'select', isPublic: true },
  { key: 'general.supportedLanguages', group: 'languages', label: 'Supported languages', value: ['en', 'fr'], inputType: 'json', isPublic: true },
  { key: 'general.currency', group: 'general', label: 'Currency', value: 'CAD', inputType: 'text', isPublic: true },
  { key: 'general.distanceUnit', group: 'general', label: 'Distance unit', value: 'km', inputType: 'select', isPublic: true },
  { key: 'general.maintenanceMode', group: 'general', label: 'Maintenance mode (blocks apps)', value: false, inputType: 'boolean', isPublic: true },
  { key: 'general.maintenanceMessage', group: 'general', label: 'Maintenance message', value: 'We will be back shortly.', inputType: 'textarea', isPublic: true },
  { key: 'general.statusBanner', group: 'general', label: 'Status banner text (shown in all apps)', value: '', inputType: 'text', isPublic: true },
  { key: 'general.forksyHstNumber', group: 'taxes', label: 'FORKSY HST registration number', value: '', inputType: 'text' },
  { key: 'general.legalName', group: 'general', label: 'Legal entity name', value: 'FORKSY Inc.', inputType: 'text' },
  // ---- orders ----
  { key: 'orders.autoRejectSeconds', group: 'orders', label: 'Auto-reject un-actioned orders after (sec)', value: 180, inputType: 'number' },
  { key: 'orders.newOrdersPaused', group: 'orders', label: 'New orders paused (set by SOP-10 incident)', value: false, inputType: 'boolean', isPublic: true },
  { key: 'orders.newOrdersPausedMessage', group: 'orders', label: 'Message shown while new orders are paused', value: '', inputType: 'text', isPublic: true },
  { key: 'operations.supplyOrdersPerDriverHour', group: 'dispatch', label: 'Supply forecast: orders one driver can serve per hour', value: 2.5, inputType: 'number' },
  {
    key: 'operations.checklistTemplates', group: 'dispatch', label: 'SOP-03 open/close checklist templates', inputType: 'json',
    value: {
      OPEN: [
        { key: 'system_health', label: 'Check system health (API, database, realtime)' },
        { key: 'payment_gateway', label: 'Check payment gateway status' },
        { key: 'supply_forecast', label: 'Review driver supply forecast per zone' },
        { key: 'supply_alerts', label: 'Send supply alerts / boosts to zones predicted short' },
        { key: 'restaurant_tablets', label: 'Call restaurants whose tablets are not online at opening' },
      ],
      CLOSE: [
        { key: 'no_open_orders', label: 'Confirm there are no open orders' },
        { key: 'review_late_orders', label: 'Review late orders' },
        { key: 'review_cancelled_refunded', label: 'Review cancelled and refunded orders' },
        { key: 'log_incidents', label: 'Log incidents' },
        { key: 'handover_notes', label: 'Write handover notes for the next shift' },
      ],
    },
  },
  { key: 'orders.customerCancelGraceSeconds', group: 'orders', label: 'Customers can cancel within this many seconds of placing an order (0 = never); after that only staff can cancel', value: 120, inputType: 'number' },
  { key: 'orders.waitFee.enabled', group: 'orders', label: 'Driver wait-time pay: when a driver waits at the restaurant longer than the grace period after the promised ready time, pay the driver per minute and deduct it from the restaurant payout', value: true, inputType: 'boolean' },
  { key: 'orders.waitFee.graceMinutes', group: 'orders', label: 'Driver wait-time pay: free minutes the driver waits after the promised ready time (or after arriving, if later)', value: 5, inputType: 'number' },
  { key: 'orders.waitFee.perMinute', group: 'orders', label: 'Driver wait-time pay: amount ($) per started minute beyond the grace period', value: 0.5, inputType: 'number' },
  { key: 'orders.waitFee.maxPerOrder', group: 'orders', label: 'Driver wait-time pay: maximum per order ($)', value: 10, inputType: 'number' },
  { key: 'orders.freeCancelUntil', group: 'orders', label: 'Customers cancel free until status', value: 'ACCEPTED', inputType: 'select' },
  { key: 'orders.cancellationFeeMaxPctOfFood', group: 'orders', label: 'Max late-cancellation fee (% of food cost)', value: 100, inputType: 'number' },
  { key: 'orders.tipEditableMinutes', group: 'orders', label: 'Tip editable after delivery (min)', value: 60, inputType: 'number', isPublic: true },
  { key: 'orders.tipPresets', group: 'orders', label: 'Tip presets (%)', value: [10, 15, 20], inputType: 'json', isPublic: true },
  { key: 'orders.maxScheduleDays', group: 'orders', label: 'Max days ahead for scheduled orders', value: 3, inputType: 'number', isPublic: true },
  { key: 'orders.limitCustomersToZones', group: 'orders', label: 'Limit customer delivery to delivery zones and to each store\'s delivery radius. OFF (default): customers can order from any store and pay the delivery fee by distance (zones and radii still decide where drivers work). ON: addresses outside a zone or beyond the store\'s radius are refused', value: false, inputType: 'boolean' },
  { key: 'orders.maxDeliveryDistanceKm', group: 'orders', label: 'Longest delivery distance a customer may order (km) when zones are not enforced; 0 = no limit. A safety net so a typo in the address cannot create a 3,000 km delivery', value: 100, inputType: 'number' },
  { key: 'orders.quotedEtaBufferMin', group: 'orders', label: 'ETA buffer added to quotes (min)', value: 5, inputType: 'number' },
  { key: 'orders.partialApprovalMinutes', group: 'orders', label: 'Auto-approve item removal if customer silent (min)', value: 10, inputType: 'number' },
  { key: 'orders.driverCancelCompensation', group: 'orders', label: 'Driver compensation when order cancelled after assignment ($)', value: 3, inputType: 'number' },
  { key: 'orders.lateEtaExtensionMin', group: 'orders', label: 'ETA extension applied when an order is late (min)', value: 10, inputType: 'number' },
  { key: 'orders.reliabilityPenaltyPerCancel', group: 'orders', label: 'Restaurant reliability points lost per post-accept cancellation', value: 5, inputType: 'number' },
  { key: 'orders.chatWindowMinutes', group: 'orders', label: 'Order chat stays open after completion (min)', value: 60, inputType: 'number' },
  { key: 'orders.maxTip', group: 'orders', label: 'Maximum tip ($)', value: 200, inputType: 'number', isPublic: true },
  // ---- dispatch ----
  { key: 'automation.orders.autoAccept', group: 'automation', label: 'Automation: accept new orders automatically (a restaurant can override this)', value: true, inputType: 'boolean' },
  { key: 'automation.orders.autoAccept.maxActive', group: 'automation', label: 'Automation: stop auto-accepting when the kitchen already has this many accepted / preparing orders (0 = no limit); the restaurant then accepts manually', value: 12, inputType: 'number' },
  { key: 'automation.orders.autoStartPrep', group: 'automation', label: 'Automation: start preparing (kitchen ticket) as soon as an order is accepted; scheduled orders start in time (a restaurant can override this)', value: true, inputType: 'boolean' },
  { key: 'automation.orders.autoReady', group: 'automation', label: 'Automation: mark the order READY when its prep time has elapsed, which starts the driver search (a restaurant can override this; the kitchen can still mark it ready earlier or extend the time)', value: true, inputType: 'boolean' },
  { key: 'automation.orders.autoReady.graceSec', group: 'automation', label: 'Automation: wait this many seconds after the prep time before auto-marking ready', value: 0, inputType: 'number' },
  { key: 'automation.prep.freeSlots', group: 'automation', label: 'Prep estimate: orders in the kitchen before extra minutes are added', value: 3, inputType: 'number' },
  { key: 'automation.prep.minutesPerExtraOrder', group: 'automation', label: 'Prep estimate: extra minutes per order beyond the free slots (0 = off)', value: 1, inputType: 'number' },
  { key: 'automation.prep.maxExtraMinutes', group: 'automation', label: 'Prep estimate: maximum extra minutes added for kitchen load', value: 15, inputType: 'number' },
  { key: 'automation.scheduled.driveMinutes', group: 'automation', label: 'Scheduled orders: minutes before the scheduled time the food should be ready (drive time)', value: 20, inputType: 'number' },
  { key: 'automation.driver.autoArrive', group: 'automation', label: 'Automation: mark the driver as arrived (restaurant / customer) from GPS', value: true, inputType: 'boolean' },
  { key: 'automation.driver.autoArriveMeters', group: 'automation', label: 'Automation: arrival radius in metres', value: 80, inputType: 'number' },
  { key: 'dispatch.preReadyMinutes', group: 'dispatch', label: 'Start searching for a driver this many minutes BEFORE the food is due (ready 3:20 pm and 5 min => the search starts at 3:15 pm). 0 = only when the kitchen marks the order ready', value: 5, inputType: 'number' },
  { key: 'dispatch.stacking.enabled', group: 'dispatch', label: 'En-route stacking: a driver already delivering an order can be offered a second order whose pickup is near that drop-off (when free drivers are busy or limited). Never more than 2 orders per driver', value: true, inputType: 'boolean' },
  { key: 'dispatch.stacking.maxOrdersPerDriver', group: 'dispatch', label: 'En-route stacking: maximum orders one driver may carry at the same time (hard limit 2)', value: 2, inputType: 'number' },
  { key: 'dispatch.stacking.maxPickupFromDropKm', group: 'dispatch', label: 'En-route stacking: the new restaurant must be within this many km of the first order drop-off', value: 3, inputType: 'number' },
  { key: 'dispatch.stacking.maxLateMin', group: 'dispatch', label: 'En-route stacking: skip the driver if they would reach the new restaurant more than this many minutes after the food is ready', value: 10, inputType: 'number' },
  { key: 'dispatch.autoAssign', group: 'dispatch', label: 'Auto-assign drivers', value: true, inputType: 'boolean' },
  { key: 'commission.default.deliveryPct', group: 'commission', label: 'Commission % on delivery orders (a FORKSY driver delivers) when the store has no override and no tier', value: 20, inputType: 'number' },
  { key: 'commission.default.pickupPct', group: 'commission', label: 'Commission % on pickup orders (the customer collects in store) when the store has no override and no tier', value: 8, inputType: 'number' },
  { key: 'commission.default.ownDriverPct', group: 'commission', label: "Commission % on orders delivered by the store's own courier when the store has no override and no tier", value: 12, inputType: 'number' },
  { key: 'dispatch.radiusRingsKm', group: 'dispatch', label: 'Driver search rings (km), nearest first: the search starts in the first ring and widens to the next when no driver takes the order', value: [2, 5, 10, 20, 30], inputType: 'json' },
  { key: 'dispatch.extraPerKm', group: 'dispatch', label: 'Extra driver pay ($ per km) when the driver is not nearby: charged for each km of the pickup distance beyond the free distance', value: 0.18, inputType: 'number' },
  { key: 'dispatch.extraFreeKm', group: 'dispatch', label: 'Pickup distance (km) with no extra driver pay (the nearby zone)', value: 2, inputType: 'number' },
  { key: 'dispatch.readyMatchWindowMin', group: 'dispatch', label: 'Driver should arrive ≤ N min before food is ready', value: 2, inputType: 'number' },
  { key: 'dispatch.weights', group: 'dispatch', label: 'Scoring weights', value: { distance: 0.3, readyMatch: 0.2, vehicleFit: 0.08, load: 0.08, performance: 0.06, fairness: 0.08, acceptance: 0.2 }, inputType: 'json' },
  { key: 'dispatch.startOn', group: 'dispatch', label: 'Start the driver search when the order is READY (kitchen confirmed) or ACCEPTED (old behaviour with ready-time matching)', value: 'READY', inputType: 'select' },
  { key: 'dispatch.locationFreshSec', group: 'dispatch', label: 'Driver GPS must be fresher than N sec to be offered an order', value: 120, inputType: 'number' },
  { key: 'dispatch.acceptance.windowDays', group: 'dispatch', label: 'Acceptance score: rolling window (days)', value: 14, inputType: 'number' },
  { key: 'dispatch.acceptance.countExpiredAsDecline', group: 'dispatch', label: 'Acceptance score: an ignored (expired) offer counts as not accepted', value: true, inputType: 'boolean' },
  { key: 'dispatch.acceptance.minOffers', group: 'dispatch', label: 'Acceptance score: offers needed before the raw rate is fully trusted (below it blends with the neutral prior)', value: 5, inputType: 'number' },
  { key: 'dispatch.acceptance.priorRate', group: 'dispatch', label: 'Acceptance score: neutral prior rate for new drivers (%)', value: 90, inputType: 'number' },
  { key: 'dispatch.acceptance.lowThreshold', group: 'dispatch', label: 'Acceptance score: below this rate (%) the ranking factor is halved (soft penalty, never a hard block)', value: 50, inputType: 'number' },
  { key: 'dispatch.batching.enabled', group: 'dispatch', label: 'Order batching (phase 2)', value: false, inputType: 'boolean' },
  { key: 'dispatch.bikeMaxDistanceKm', group: 'dispatch', label: 'Bikes excluded above (km)', value: 4, inputType: 'number' },
  { key: 'dispatch.bikeMaxSubtotal', group: 'dispatch', label: 'Bikes excluded above order subtotal ($)', value: 80, inputType: 'number' },
  { key: 'dispatch.driverMissingAlertMin', group: 'dispatch', label: 'Driver stationary alert (min)', value: 10, inputType: 'number' },
  { key: 'dispatch.assumedPickupEtaMin', group: 'dispatch', label: 'Assumed driver pickup ETA before any candidate is known, for ready-time matching (min)', value: 8, inputType: 'number' },
  { key: 'dispatch.escalatedRetrySec', group: 'dispatch', label: 'Retry interval while an order is escalated to the dispatcher (sec)', value: 45, inputType: 'number' },
  // ---- payments ----
  { key: 'payments.provider', group: 'payments', label: 'Payment provider', value: 'stripe', inputType: 'select' },
  { key: 'payments.applePayEnabled', group: 'payments', label: 'Apple Pay', value: true, inputType: 'boolean', isPublic: true },
  { key: 'payments.googlePayEnabled', group: 'payments', label: 'Google Pay', value: true, inputType: 'boolean', isPublic: true },
  { key: 'payments.walletEnabled', group: 'payments', label: 'FORKSY wallet / credits', value: true, inputType: 'boolean', isPublic: true },
  { key: 'payments.giftCardsEnabled', group: 'payments', label: 'Gift cards', value: true, inputType: 'boolean', isPublic: true },
  { key: 'payments.instantPayoutFeePct', group: 'payments', label: 'Instant cash-out fee (%)', value: 1.5, inputType: 'number' },
  { key: 'payments.instantPayoutFeeMin', group: 'payments', label: 'Instant cash-out min fee ($)', value: 0.5, inputType: 'number' },
  { key: 'payments.payoutWeekday', group: 'payments', label: 'Payout day (0=Sun..6=Sat)', value: 3, inputType: 'number' },
  { key: 'payments.reconciliationToleranceCad', group: 'payments', label: 'Reconciliation gap tolerance ($)', value: 1, inputType: 'number' },
  { key: 'payments.topUpMin', group: 'payments', label: 'Wallet top-up: minimum amount ($)', value: 5, inputType: 'number', isPublic: true },
  { key: 'payments.topUpMax', group: 'payments', label: 'Wallet top-up: maximum amount ($)', value: 500, inputType: 'number', isPublic: true },
  { key: 'payments.abandonedIntentMinutes', group: 'payments', label: 'Cancel payment attempts (PaymentIntents) that were never paid and never became an order after this many minutes', value: 60, inputType: 'number' },
  { key: 'payments.paidWithoutOrderMinutes', group: 'payments', label: 'Refund a card payment that went through but never became an order (the customer paid and left) after this many minutes', value: 10, inputType: 'number' },
  { key: 'payments.dailyPayoutsEnabled', group: 'payments', label: 'Pay DAILY-schedule restaurants automatically every day', value: true, inputType: 'boolean' },
  // ---- integrations (edited in Admin > System > Integrations; secrets are encrypted at rest and never returned by any API) ----
  { key: 'integrations.stripe.secretKey', group: 'integrations', label: 'Stripe secret key (sk_test_ / sk_live_ / rk_)', value: '', inputType: 'password', isSecret: true },
  { key: 'integrations.stripe.publishableKey', group: 'integrations', label: 'Stripe publishable key (pk_test_ / pk_live_)', value: '', inputType: 'text' },
  { key: 'integrations.stripe.webhookSecret', group: 'integrations', label: 'Stripe webhook signing secret (whsec_)', value: '', inputType: 'password', isSecret: true },
  { key: 'integrations.stripe.connectEnabled', group: 'integrations', label: 'Stripe Connect payouts enabled (drivers and restaurants are paid through Stripe Connect)', value: true, inputType: 'boolean' },
  { key: 'integrations.stripe.currency', group: 'integrations', label: 'Stripe currency', value: 'cad', inputType: 'text' },
  { key: 'integrations.stripe.platformCountry', group: 'integrations', label: 'Stripe platform country (connected accounts are created in this country)', value: 'CA', inputType: 'text' },
  { key: 'integrations.mapbox.accessToken', group: 'integrations', label: 'Mapbox server access token (sk. or pk.; used by the API only)', value: '', inputType: 'password', isSecret: true },
  { key: 'integrations.mapbox.publicToken', group: 'integrations', label: 'Mapbox public token (pk.; optional, for future browser maps)', value: '', inputType: 'text' },
  { key: 'integrations.mapbox.style', group: 'integrations', label: 'Mapbox map style drawn on the admin screens ("username/style_id")', value: 'mapbox/streets-v12', inputType: 'text' },
  { key: 'integrations.google.apiKey', group: 'integrations', label: 'Google Maps server API key (address search, routes, map session; used by the API only)', value: '', inputType: 'password', isSecret: true },
  { key: 'integrations.google.browserKey', group: 'integrations', label: 'Google Maps browser key (restricted to the website addresses; only used in the map tile URL)', value: '', inputType: 'text' },
  { key: 'integrations.maps.provider', group: 'integrations', label: 'Maps provider in use (mapbox or google): address search, road distances and map tiles', value: 'mapbox', inputType: 'select' },
  { key: 'integrations.maps.routingEnabled', group: 'integrations', label: 'Use real road distances and drive times from the maps provider for deliveries (off = the built-in estimate)', value: false, inputType: 'boolean' },
  { key: 'integrations.mapbox.country', group: 'integrations', label: 'Mapbox address search: country (ISO 3166 alpha-2, comma separated)', value: 'ca', inputType: 'text' },
  { key: 'integrations.mapbox.bbox', group: 'integrations', label: 'Mapbox address search: bounding box "minLng,minLat,maxLng,maxLat" (Greater Toronto Area); empty = whole country', value: '-80.35,43.35,-78.9,44.2', inputType: 'text' },
  { key: 'integrations.mapbox.proximity', group: 'integrations', label: 'Mapbox address search: default proximity "lng,lat" (Mississauga)', value: '-79.6441,43.589', inputType: 'text' },
  // ---- maps ----
  { key: 'maps.driverLocationIntervalSec', group: 'maps', label: 'Driver location refresh (sec)', value: 5, inputType: 'number', isPublic: true },
  // ---- notifications ----
  { key: 'notifications.smsProvider', group: 'notifications', label: 'SMS provider', value: 'twilio', inputType: 'select' },
  { key: 'notifications.emailProvider', group: 'notifications', label: 'Email provider', value: 'sendgrid', inputType: 'select' },
  { key: 'notifications.pushProvider', group: 'notifications', label: 'Push provider', value: 'fcm', inputType: 'select' },
  { key: 'notifications.twilioAccountSid', group: 'notifications', label: 'Twilio account SID', value: '', inputType: 'text', isSecret: true },
  { key: 'notifications.twilioAuthToken', group: 'notifications', label: 'Twilio auth token', value: '', inputType: 'password', isSecret: true },
  { key: 'notifications.twilioFrom', group: 'notifications', label: 'Twilio from number', value: '', inputType: 'text' },
  { key: 'notifications.sendgridApiKey', group: 'notifications', label: 'SendGrid API key', value: '', inputType: 'password', isSecret: true },
  { key: 'notifications.emailFrom', group: 'notifications', label: 'From email', value: 'no-reply@forksy.ca', inputType: 'text' },
  // SMTP fields: used when the email provider is "smtp" (any mail server: Google Workspace, Microsoft 365, Zoho, Brevo, Mailgun...) or "ses" (Amazon SES: host email-smtp.<region>.amazonaws.com + the SMTP credentials from the SES console)
  { key: 'notifications.smtp.host', group: 'notifications', label: 'SMTP server (host name, for example smtp.gmail.com)', value: '', inputType: 'text' },
  { key: 'notifications.smtp.port', group: 'notifications', label: 'SMTP port (587 with STARTTLS, 465 with SSL/TLS)', value: 587, inputType: 'number' },
  { key: 'notifications.smtp.secure', group: 'notifications', label: 'SMTP: use SSL/TLS from the first byte (port 465). Off = STARTTLS (port 587)', value: false, inputType: 'boolean' },
  { key: 'notifications.smtp.user', group: 'notifications', label: 'SMTP username', value: '', inputType: 'text', isSecret: true },
  { key: 'notifications.smtp.password', group: 'notifications', label: 'SMTP password (or app password)', value: '', inputType: 'password', isSecret: true },
  // push: platform kill switches, VAPID (generated once on first boot, stored encrypted) and FCM HTTP v1 (docs/notifications.md)
  { key: 'notifications.push.enabled', group: 'notifications', label: 'Push notifications: master switch for the whole platform (browser + native)', value: true, inputType: 'boolean' },
  { key: 'notifications.push.webEnabled', group: 'notifications', label: 'Push notifications: browser push (Web Push / VAPID)', value: true, inputType: 'boolean' },
  { key: 'notifications.push.fcmEnabled', group: 'notifications', label: 'Push notifications: native apps (FCM)', value: true, inputType: 'boolean' },
  { key: 'notifications.vapid.keys', group: 'notifications', label: 'Web Push (VAPID) key pair - generated automatically on first boot and stored encrypted; replacing it logs every browser out of push (env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY win)', value: '', inputType: 'password', isSecret: true },
  { key: 'notifications.vapid.publicKey', group: 'notifications', label: 'Web Push (VAPID) public key (information only)', value: '', inputType: 'text' },
  { key: 'notifications.vapid.subject', group: 'notifications', label: 'Web Push (VAPID) contact: mailto:you@example.com or https://your.site', value: 'mailto:support@forksy.ca', inputType: 'text' },
  { key: 'notifications.fcm.serviceAccountJson', group: 'notifications', label: 'FCM HTTP v1 service-account JSON (Firebase console > Service accounts); env FCM_SERVICE_ACCOUNT_JSON wins', value: '', inputType: 'textarea', isSecret: true },
  { key: 'notifications.retention.inAppDays', group: 'notifications', label: 'Delete READ in-app notifications after N days (unread ones after 365)', value: 90, inputType: 'number' },
  { key: 'notifications.retention.deliveryDays', group: 'notifications', label: 'Delete push / SMS / e-mail delivery log rows after N days', value: 30, inputType: 'number' },
  { key: 'notifications.templateSeedVersion', group: 'notifications', label: 'Internal: notification templates seeded up to this version (do not change)', value: 0, inputType: 'number' },
  {
    key: 'notifications.matrix', group: 'notifications', label: 'Notification matrix (event -> audience -> channels). Defaults come from the event registry; edit in System > Notification Matrix', inputType: 'json',
    value: defaultMatrix(),
  },
  // ---- taxes ----
  { key: 'taxes.defaultTaxClass', group: 'taxes', label: 'Default tax class code', value: 'HST_ON', inputType: 'text' },
  { key: 'taxes.taxOnFees', group: 'taxes', label: 'Apply HST to delivery / service / small-order fees', value: true, inputType: 'boolean' },
  { key: 'taxes.taxOnDeliveryFee', group: 'taxes', label: 'Apply HST to delivery fee', value: true, inputType: 'boolean' },
  // ---- security ----
  { key: 'security.enforce2faStaff', group: 'security', label: 'Require 2FA for staff', value: true, inputType: 'boolean' },
  { key: 'security.enforce2faRestaurantOwner', group: 'security', label: 'Require 2FA for restaurant owners', value: true, inputType: 'boolean' },
  { key: 'security.sessionTimeoutMin', group: 'security', label: 'Admin session idle timeout (min)', value: 60, inputType: 'number' },
  { key: 'security.passwordMinLength', group: 'security', label: 'Min password length', value: 10, inputType: 'number' },
  { key: 'security.ipAllowlist', group: 'security', label: 'Admin IP allow-list (empty = any)', value: [], inputType: 'json' },
  { key: 'security.refundFrequencyLimit30d', group: 'security', label: 'Refunds per account per 30 days before flag', value: 4, inputType: 'number' },
  // ---- support ----
  { key: 'support.tier1RefundLimit', group: 'support', label: 'Tier 1 refund limit ($)', value: 50, inputType: 'number' },
  { key: 'support.autoCreditMaxMissingItem', group: 'support', label: 'Self-serve instant credit: max missing item ($)', value: 15, inputType: 'number' },
  { key: 'support.slaFirstResponseMin', group: 'support', label: 'SLA first response (min)', value: 15, inputType: 'number' },
  { key: 'support.slaResolutionHours', group: 'support', label: 'SLA resolution (hours)', value: 24, inputType: 'number' },
  { key: 'support.lateCreditAmount', group: 'support', label: 'Standard credit when > 30 min late ($)', value: 5, inputType: 'number' },
  { key: 'support.veryLateMinutes', group: 'support', label: 'Very late = minutes past ETA', value: 30, inputType: 'number' },
  { key: 'support.autoCreditMaxFoodQuality', group: 'support', label: 'Self-serve instant credit: max food-quality credit ($)', value: 8, inputType: 'number' },
  { key: 'support.reviewLowRatingThreshold', group: 'support', label: 'SOP-08 detector: propose review below avg rating', value: 4.2, inputType: 'number' },
  { key: 'support.reviewMinRatings', group: 'support', label: 'SOP-08 detector: min ratings before low-rating trigger', value: 10, inputType: 'number' },
  { key: 'support.reviewCancellationThreshold', group: 'support', label: 'SOP-08 detector: cancellations before trigger', value: 5, inputType: 'number' },
  { key: 'support.reviewDetectorEnabled', group: 'support', label: 'SOP-08 auto-detector enabled', value: true, inputType: 'boolean' },
  // ---- ratings (docs/ratings.md) ----
  { key: 'ratings.windowDays', group: 'ratings', label: 'Customers can rate an order for N days after delivery', value: 7, inputType: 'number', isPublic: true },
  { key: 'ratings.editWindowHours', group: 'ratings', label: 'A customer can edit their review once, within N hours of posting it', value: 24, inputType: 'number', isPublic: true },
  { key: 'ratings.commentMaxLength', group: 'ratings', label: 'Maximum review comment length (characters)', value: 500, inputType: 'number', isPublic: true },
  { key: 'ratings.requireReasonTag', group: 'ratings', label: 'Require at least one reason tag when a rating is at or below the threshold', value: true, inputType: 'boolean', isPublic: true },
  { key: 'ratings.lowRatingMax', group: 'ratings', label: 'A rating at or below this many stars needs a reason tag', value: 2, inputType: 'number', isPublic: true },
  { key: 'ratings.minCountToShow', group: 'ratings', label: 'Show a numeric rating only after N reviews (otherwise "New")', value: 5, inputType: 'number', isPublic: true },
  { key: 'ratings.priorWeight', group: 'ratings', label: 'Bayesian smoothing: weight of the prior, in "virtual reviews" (higher = steadier)', value: 10, inputType: 'number' },
  { key: 'ratings.restaurant.priorMean', group: 'ratings', label: 'Bayesian smoothing: restaurant prior mean (stars)', value: 4.3, inputType: 'number' },
  { key: 'ratings.driver.priorMean', group: 'ratings', label: 'Bayesian smoothing: driver prior mean (stars)', value: 4.7, inputType: 'number' },
  { key: 'ratings.rollingDays', group: 'ratings', label: 'Rolling window used for the displayed/ranking rating (days)', value: 90, inputType: 'number' },
  { key: 'ratings.fraud.enabled', group: 'ratings', label: 'Automatic review-fraud flagging enabled (flagged reviews are excluded from aggregates until staff restore them)', value: true, inputType: 'boolean' },
  { key: 'ratings.fraud.burstCount', group: 'ratings', label: 'Review bomb: N or more 1-star reviews on one target ...', value: 3, inputType: 'number' },
  { key: 'ratings.fraud.burstWindowHours', group: 'ratings', label: 'Review bomb: ... within N hours ...', value: 24, inputType: 'number' },
  { key: 'ratings.fraud.newAccountDays', group: 'ratings', label: 'Review bomb: ... from accounts younger than N days', value: 14, inputType: 'number' },
  { key: 'ratings.fraud.duplicateMinLength', group: 'ratings', label: 'Duplicate text: ignore comments shorter than N characters', value: 15, inputType: 'number' },
  { key: 'ratings.fraud.duplicateCount', group: 'ratings', label: 'Duplicate text: flag when the same text appears N times in 30 days', value: 2, inputType: 'number' },
  { key: 'ratings.promptDelayMinutes', group: 'ratings', label: 'Send the customer a rating prompt N minutes after delivery', value: 10, inputType: 'number' },
  { key: 'ratings.reminderDelayHours', group: 'ratings', label: 'Send one reminder N hours after delivery if still unrated', value: 24, inputType: 'number' },
  { key: 'ratings.partnerPromptDelayMinutes', group: 'ratings', label: 'Prompt the driver / restaurant to rate the customer N minutes after delivery', value: 5, inputType: 'number' },
  { key: 'ratings.partnerWindowDays', group: 'ratings', label: 'Drivers and restaurants can rate a customer for N days after delivery', value: 3, inputType: 'number' },
  { key: 'ratings.driver.warnBelow', group: 'ratings', label: 'Driver coaching: notify when the rolling 30-day rating falls below', value: 4.5, inputType: 'number' },
  { key: 'ratings.driver.reviewBelow', group: 'ratings', label: 'Driver: propose an SOP-08 performance review when the rolling 30-day rating falls below', value: 4.2, inputType: 'number' },
  { key: 'ratings.driver.minRatings', group: 'ratings', label: 'Driver alerts need at least N ratings in the 30-day window', value: 20, inputType: 'number' },
  { key: 'ratings.restaurant.warnBelow', group: 'ratings', label: 'Restaurant: notify owner and ops when the rolling 30-day rating falls below', value: 4.0, inputType: 'number' },
  { key: 'ratings.restaurant.minRatings', group: 'ratings', label: 'Restaurant alerts need at least N ratings in the 30-day window', value: 20, inputType: 'number' },
  { key: 'ratings.restaurant.discoveryPenalty', group: 'ratings', label: 'Discovery: de-prioritise restaurants in WARN state when sorting by rating / popularity (0 = off, e.g. 0.9 = score x 0.9)', value: 0, inputType: 'number' },
  { key: 'ratings.restaurant.maxReportsPer30d', group: 'ratings', label: 'A restaurant can report at most N reviews as abusive per 30 days', value: 10, inputType: 'number' },
  { key: 'ratings.customer.priorMean', group: 'ratings', label: 'Customer ratings: prior mean (stars)', value: 4.5, inputType: 'number' },
  { key: 'ratings.customer.priorWeight', group: 'ratings', label: 'Customer ratings: prior weight (virtual ratings)', value: 3, inputType: 'number' },
  { key: 'ratings.customer.lowRatingMax', group: 'ratings', label: 'Customer ratings: a rating at or below this counts as low', value: 2, inputType: 'number' },
  { key: 'ratings.customer.lowCountFlag', group: 'ratings', label: 'Customer ratings: flag the profile after N low ratings in 30 days', value: 3, inputType: 'number' },
  // ---- support: live chat ----
  { key: 'support.chat.enabled', group: 'support', label: 'Live chat enabled', value: true, inputType: 'boolean', isPublic: true },
  { key: 'support.chat.hours', group: 'support', label: 'Live chat hours ({timezone, days:[0-6 Sun..Sat], start:"HH:mm", end:"HH:mm" or "24:00"})', value: { timezone: 'America/Toronto', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }, inputType: 'json', isPublic: true },
  { key: 'support.chat.maxConcurrentPerAgent', group: 'support', label: 'Live chat: max concurrent chats per agent', value: 4, inputType: 'number' },
  { key: 'support.chat.autoCloseIdleMinutes', group: 'support', label: 'Live chat: auto-close after idle (min)', value: 15, inputType: 'number' },
  { key: 'support.chat.queueTimeoutMinutes', group: 'support', label: 'Live chat: queue timeout before converting to a ticket (min)', value: 10, inputType: 'number' },
  { key: 'support.chat.autoAssign', group: 'support', label: 'Live chat: auto-assign waiting chats to the least-loaded online agent', value: true, inputType: 'boolean' },
  { key: 'support.chat.estimatedHandleMinutes', group: 'support', label: 'Live chat: assumed minutes per chat (wait estimate)', value: 5, inputType: 'number' },
  { key: 'support.chat.noAgentGraceSec', group: 'support', label: 'Live chat: convert waiting chats to tickets after no agent is available for (sec)', value: 30, inputType: 'number' },
  { key: 'support.chat.waitingDisconnectSec', group: 'support', label: 'Live chat: convert a waiting chat to a ticket when the requester is gone for (sec)', value: 90, inputType: 'number' },
  { key: 'support.chat.presenceTimeoutSec', group: 'support', label: 'Live chat: agent goes offline after no heartbeat (sec)', value: 120, inputType: 'number' },
  // ---- driver ----
  { key: 'finance.requireDualControl', group: 'payments', label: 'Dual control: the person who approves a payout batch cannot release it, and over-limit adjustments need a Super Admin (default ON in production)', value: process.env.NODE_ENV === 'production', inputType: 'boolean' },
  { key: 'finance.maxManualAdjustment', group: 'payments', label: 'Largest manual ledger / payout adjustment a Finance Manager may post ($); above this a Super Admin is required', value: 500, inputType: 'number' },
  // ---- delivery proof & instructions (docs/proof-of-delivery.md). Replaces the old driver.deliveryGeofenceKm. ----
  { key: 'restaurants.menuAccessMigrated', group: 'restaurants', label: 'Internal: existing restaurants were granted menu editing once (do not change)', value: false, inputType: 'boolean' },
  { key: 'delivery.proof.geofenceMeters', group: 'delivery', label: 'Delivery geofence (m): the driver and the proof photo must be within this distance of the drop-off address to complete a delivery', value: 100, inputType: 'number' },
  { key: 'delivery.proof.photoAlways', group: 'delivery', label: 'Require a delivery photo on EVERY delivery (off = photo only for contactless orders and for customers who turn the PIN off)', value: false, inputType: 'boolean' },
  { key: 'delivery.proof.requireGeofence', group: 'delivery', label: 'Enforce the delivery geofence (outside it the delivery is rejected, including on the exception path)', value: true, inputType: 'boolean' },
  { key: 'delivery.proof.photoMaxAgeMinutes', group: 'delivery', label: 'A proof photo must have been captured within this many minutes of submitting the delivery', value: 10, inputType: 'number' },
  { key: 'delivery.proof.retentionDays', group: 'delivery', label: 'Proof photo FILES are deleted after this many days (evidence record kept) unless the order has an open / recent dispute', value: 90, inputType: 'number' },
  { key: 'delivery.proof.gpsMismatchMeters', group: 'delivery', label: "Flag GPS_MISMATCH when the claimed delivery location is farther than this from the driver's last server-side GPS fix (m)", value: 300, inputType: 'number' },
  { key: 'delivery.proof.serverGpsMaxAgeSec', group: 'delivery', label: 'A server-side GPS fix older than this is treated as unavailable for the cross-check (sec)', value: 300, inputType: 'number' },
  { key: 'delivery.accessCodeRetentionDays', group: 'delivery', label: 'Buzzer / gate access codes are blanked from the order this many days after delivery', value: 7, inputType: 'number' },
  { key: 'support.falseClaimFlagThreshold', group: 'support', label: 'Flag a customer for review after this many rejected "never arrived" claims (UPHELD_DELIVERED); never auto-banned', value: 2, inputType: 'number' },
  { key: 'support.deliveryDisputeStrikeThreshold', group: 'support', label: 'SOP-08 detector: propose a driver review after this many delivery-dispute strikes in 30 days', value: 3, inputType: 'number' },
  { key: 'driver.trainingPassMark', group: 'driver', label: 'Training pass mark (%)', value: 80, inputType: 'number' },
  { key: 'driver.welcomeBoostAmount', group: 'driver', label: 'First-week boost ($/trip)', value: 2, inputType: 'number' },
  { key: 'driver.docExpiryReminderDays', group: 'driver', label: 'Document expiry reminders (days before)', value: [30, 14, 7, 1], inputType: 'json' },
  { key: 'driver.deactivationResponseDays', group: 'driver', label: 'Deactivation notice response period (days)', value: 7, inputType: 'number' },
  { key: 'driver.gpsCheckEnabled', group: 'driver', label: 'Enforce GPS proximity for status steps', value: true, inputType: 'boolean' },
  { key: 'driver.gpsToleranceMeters', group: 'driver', label: 'GPS tolerance for arrived/pickup/delivered (m)', value: 300, inputType: 'number' },
  { key: 'driver.firstWeekDays', group: 'driver', label: 'First-week boost duration (days)', value: 7, inputType: 'number' },
  { key: 'driver.offerTimeoutSec', group: 'driver', label: 'Offer accept window (sec)', value: 30, inputType: 'number', isPublic: true },
  { key: 'driver.requiredDocuments', group: 'driver', label: 'Required documents', value: ['LICENCE', 'VEHICLE_REGISTRATION', 'INSURANCE', 'PHOTO', 'WORK_ELIGIBILITY'], inputType: 'json' },
  // ---- restaurant ----
  { key: 'restaurant.requiredDocuments', group: 'restaurant', label: 'Required documents', value: ['BUSINESS_LICENCE', 'HEALTH_CERTIFICATE', 'VOID_CHEQUE'], inputType: 'json' },
  { key: 'restaurant.defaultPrepTimeMin', group: 'restaurant', label: 'Default prep time (min)', value: 20, inputType: 'number' },
  // ---- store types: groceries, convenience, specialty food (docs/store-types.md) ----
  { key: 'restaurant.requiredDocumentsByType', group: 'restaurant', label: 'Required documents per store type: a JSON object such as {"GROCERY": ["BUSINESS_LICENCE", "FOOD_PREMISES_PERMIT", "VOID_CHEQUE"]}. A type without an entry uses the built-in list for it (restaurants: business licence, health certificate, void cheque; retail: business licence, food premises permit, void cheque)', value: {}, inputType: 'json' },
  { key: 'restaurant.ageRestricted.enabled', group: 'restaurant', label: 'Allow age-restricted products (alcohol, tobacco) to be sold: the customer confirms their age at checkout and ID is checked at hand-over', value: true, inputType: 'boolean' },
  { key: 'restaurant.ageRestricted.requireLicence', group: 'restaurant', label: 'A store may only list age-restricted products once it has an APPROVED liquor or tobacco licence document', value: true, inputType: 'boolean' },
  { key: 'orders.retail.prepBaseMinutes', group: 'orders', label: 'Grocery / retail picking time: minutes every order needs, plus the minutes per unit below (never below the prep time set for the store)', value: 10, inputType: 'number' },
  { key: 'orders.retail.prepSecondsPerUnit', group: 'orders', label: 'Grocery / retail picking time: seconds per unit picked', value: 20, inputType: 'number' },
  { key: 'orders.retail.prepMaxMinutes', group: 'orders', label: 'Grocery / retail picking time: longest estimate a customer is quoted (min)', value: 90, inputType: 'number' },
  { key: 'restaurant.selfServePromosNeedApproval', group: 'restaurant', label: 'Restaurant promos need ops approval', value: false, inputType: 'boolean' },
  { key: 'restaurant.docExpiryReminderDays', group: 'restaurant', label: 'Document expiry reminders (days before)', value: [30, 14, 7, 1], inputType: 'json' },
  // ---- marketing ----
  { key: 'marketing.referralReferrerReward', group: 'marketing', label: 'Referral: reward for referrer ($)', value: 10, inputType: 'number' },
  { key: 'marketing.referralRefereeReward', group: 'marketing', label: 'Referral: reward for new customer ($)', value: 10, inputType: 'number' },
  { key: 'marketing.referralEnabled', group: 'marketing', label: 'Referral programme enabled', value: true, inputType: 'boolean', isPublic: true },
  { key: 'marketing.referralMinSubtotal', group: 'marketing', label: 'Referral: min first-order subtotal ($)', value: 0, inputType: 'number' },
  { key: 'marketing.loyaltyEnabled', group: 'marketing', label: 'Loyalty points (phase 2)', value: false, inputType: 'boolean', isPublic: true },
  { key: 'marketing.pointsPerDollar', group: 'marketing', label: 'Loyalty: points per $', value: 1, inputType: 'number' },
  // ---- customers ----
  { key: 'customers.walletAdjustApprovalThreshold', group: 'customers', label: 'Wallet adjustments above ($) need customers:approve', value: 100, inputType: 'number' },
  { key: 'customers.guestCheckoutEnabled', group: 'customers', label: 'Allow guest checkout on web', value: true, inputType: 'boolean', isPublic: true },
  // ---- compliance ----
  { key: 'compliance.dataRequestDays', group: 'compliance', label: 'PIPEDA data request response window (days)', value: 30, inputType: 'number' },
  { key: 'compliance.auditRetentionYears', group: 'compliance', label: 'Audit log retention (years)', value: 7, inputType: 'number' },
  { key: 'compliance.requireMarketingConsent', group: 'compliance', label: 'CASL: marketing needs opt-in', value: true, inputType: 'boolean' },
  // ---- ordering assistant (docs/assistant.md) ----
  { key: 'assistant.enabled', group: 'assistant', label: 'Ordering assistant (bot): master switch for the FORKSY website bot and every restaurant bot', value: true, inputType: 'boolean', isPublic: true },
  { key: 'assistant.embed.enabled', group: 'assistant', label: 'Ordering assistant: allow restaurants to embed the bot on their own websites', value: true, inputType: 'boolean' },
  { key: 'assistant.maxMessagesPerSession', group: 'assistant', label: 'Ordering assistant: maximum messages in one chat session', value: 200, inputType: 'number' },
  { key: 'assistant.sessionTtlHours', group: 'assistant', label: 'Ordering assistant: a chat session (and its cart) expires after this many hours of inactivity', value: 24, inputType: 'number' },
  { key: 'assistant.handoffTtlMinutes', group: 'assistant', label: 'Ordering assistant: how long the one-time checkout hand-off link to the FORKSY website stays valid (min)', value: 30, inputType: 'number' },
  // the central bot of the FORKSY website (edited in Admin > Assistant > Central bot; values are re-validated whenever they are read)
  { key: 'assistant.central.enabled', group: 'assistant', label: 'Central assistant (FORKSY website bot) enabled', value: true, inputType: 'boolean' },
  { key: 'assistant.central.name', group: 'assistant', label: 'Central assistant: name (max 40)', value: 'FORKSY Assistant', inputType: 'text' },
  { key: 'assistant.central.greeting', group: 'assistant', label: 'Central assistant: greeting (max 200)', value: "Hi! I'm the FORKSY assistant. Tell me what you're craving and I'll find a restaurant, or say \"order from <restaurant>\".", inputType: 'textarea' },
  { key: 'assistant.central.color', group: 'assistant', label: 'Central assistant: accent colour (#RRGGBB, empty = default)', value: '', inputType: 'text' },
  { key: 'assistant.central.logoUrl', group: 'assistant', label: 'Central assistant: logo (an upload from POST /uploads; empty = none)', value: '', inputType: 'text' },
  { key: 'assistant.central.faqs', group: 'assistant', label: 'Central assistant: FAQs about FORKSY itself ([{q, a}], max 20)', value: [], inputType: 'json' },
  // ---- bot training tool (docs/assistant-training.md)
  { key: 'assistant.training.requireApproval', group: 'assistant', label: 'Bot training: a restaurant publish needs FORKSY approval first (staff can always publish directly)', value: false, inputType: 'boolean' },
  { key: 'assistant.training.holdPhrases', group: 'assistant', label: 'Bot training: phrases that hold an entry for FORKSY review (allergen-safety guarantees, medical claims); built-in patterns always apply too', value: ["100% safe","100 percent safe","completely safe","totally safe","guaranteed nut free","guaranteed gluten free","guaranteed dairy free","guaranteed allergen free","no allergens","allergen free","allergy safe","safe for celiacs","safe for coeliacs","safe for people with allergies","safe for diabetics","no cross contamination","no cross-contamination","cure for","clinically proven","doctor approved"], inputType: 'json' },
  { key: 'assistant.training.blockPhrases', group: 'assistant', label: 'Bot training: phrases that are refused outright (profanity / abuse); built-in patterns always apply too', value: ["fuck","shit","bitch","asshole","bastard","cunt","dickhead","slut","whore","retard","faggot","nigger","nigga"], inputType: 'json' },
  { key: 'assistant.central.chips', group: 'assistant', label: 'Central assistant: starter chips ([{label, query}], max 6; empty = built-in defaults)', value: [], inputType: 'json' },
  // ---- System Health page thresholds (docs/system-health.md)
  ...HEALTH_SETTING_DEFINITIONS,
  // ---- registration and verification policy (docs/verification.md; Super Admin only, edited on System > Verification)
  ...VERIFICATION_SETTING_DEFINITIONS,
];

export const FEATURE_FLAG_DEFINITIONS = [
  { key: 'group_orders', enabled: false, description: 'Group order links (phase 2)' },
  { key: 'forksy_plus', enabled: false, description: 'FORKSY+ subscription (phase 2)' },
  { key: 'loyalty_points', enabled: false, description: 'Loyalty points (phase 2)' },
  { key: 'order_batching', enabled: false, description: 'Driver order batching (phase 2)' },
  { key: 'dine_in_qr', enabled: false, description: 'Dine-in QR ordering (phase 3)' },
  { key: 'sponsored_listings', enabled: false, description: 'Sponsored listings / ads' },
  { key: 'pos_integrations', enabled: false, description: 'POS integrations (Square, Toast, Clover)' },
  { key: 'scheduled_driver_shifts', enabled: true, description: 'Scheduled driver shifts in busy zones' },
  { key: 'guest_checkout_web', enabled: true, description: 'Guest checkout on web' },
  { key: 'alcohol_delivery', enabled: false, description: 'Alcohol delivery (needs AGCO licensing)' },
  { key: 'instant_payouts', enabled: true, description: 'Instant cash-out for drivers' },
  { key: 'auto_refund_rules', enabled: true, description: 'Self-serve automatic refund/credit rules' },
];

/** Legacy settings that moved into the "integrations" group (value is carried over once, then the old row is deleted). */
const MOVED_KEYS: Record<string, string> = {
  'payments.stripe.secretKey': 'integrations.stripe.secretKey',
  'payments.stripe.publishableKey': 'integrations.stripe.publishableKey',
  'payments.stripe.webhookSecret': 'integrations.stripe.webhookSecret',
  'maps.mapboxToken': 'integrations.mapbox.accessToken',
  'maps.googleApiKey': 'integrations.google.apiKey',
};
/** Settings that no longer exist (cash payments were removed: every payment goes through Stripe). */
const REMOVED_KEYS = ['orders.acceptCashPayments'];

/** Seal a secret before it is stored (AES-256-GCM, see common/secretbox.ts). Empty stays empty. */
export function sealSecret(value: any): any {
  return typeof value === 'string' && value !== '' ? seal(value) : value;
}

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger('Settings');
  private cache = new Map<string, any>();
  private loadedAt = 0;

  constructor(
    @InjectRepository(Setting) private repo: Repository<Setting>,
    @InjectRepository(FeatureFlag) private flags: Repository<FeatureFlag>,
  ) {}

  async onModuleInit() {
    await this.ensureDefaults();
    await this.reload();
  }

  /** Insert missing defaults without touching admin-edited values. */
  async ensureDefaults() {
    // one-off: the old driver.deliveryGeofenceKm (km, 0 = off) is replaced by delivery.proof.geofenceMeters / requireGeofence
    const legacy = await this.repo.findOne({ where: { key: 'driver.deliveryGeofenceKm' } });
    if (legacy) {
      const km = Number(legacy.value);
      if (km > 0 && !(await this.repo.exist({ where: { key: 'delivery.proof.geofenceMeters' } }))) {
        await this.repo.insert([{ key: 'delivery.proof.geofenceMeters', group: 'delivery', label: 'Delivery geofence (m)', value: Math.round(km * 1000), inputType: 'number' } as any]);
      }
      await this.repo.delete({ key: 'driver.deliveryGeofenceKm' });
    }
    // one-off: the geofence default moved from 150 m to 100 m; an untouched 150 follows it, a custom value stays
    await this.repo.createQueryBuilder().update().set({ value: 100 as any }).where("key = :k AND value::text = '150'", { k: 'delivery.proof.geofenceMeters' }).execute().catch(() => undefined);
    const existing = new Set((await this.repo.find({ select: ['key'] })).map((s) => s.key));
    const missing = SETTING_DEFINITIONS.filter((d) => !existing.has(d.key));
    if (missing.length) await this.repo.insert(missing);
    // one-off: carry legacy Stripe / Mapbox values into the integrations group, drop the removed rows
    for (const [oldKey, newKey] of Object.entries(MOVED_KEYS)) {
      const old = await this.repo.findOne({ where: { key: oldKey } });
      if (!old) continue;
      const target = await this.repo.findOne({ where: { key: newKey } });
      const has = (v: any) => typeof v === 'string' && v !== '';
      if (target && !has(target.value) && has(old.value)) {
        target.value = target.isSecret ? (old.value.startsWith('enc1:') ? old.value : seal(old.value)) : old.value;
        await this.repo.save(target);
      }
      await this.repo.delete({ key: oldKey });
    }
    // one-off: the maps provider moved into the integrations group (Mapbox is the default now). An old row only keeps Google when a Google key was really configured.
    const oldProvider = await this.repo.findOne({ where: { key: 'maps.provider' } });
    if (oldProvider) {
      const googleKey = await this.repo.findOne({ where: { key: 'integrations.google.apiKey' } });
      const hasGoogle = typeof googleKey?.value === 'string' && googleKey.value !== '';
      const target = await this.repo.findOne({ where: { key: 'integrations.maps.provider' } });
      if (target && oldProvider.value === 'google' && hasGoogle) {
        target.value = 'google';
        await this.repo.save(target);
      }
      await this.repo.delete({ key: 'maps.provider' });
    }
    for (const k of REMOVED_KEYS) await this.repo.delete({ key: k });
    // one-off: secrets used to be stored in clear text. Seal every secret that still is.
    const secrets = await this.repo.find({ where: { isSecret: true } });
    for (const r of secrets) {
      if (typeof r.value === 'string' && r.value !== '' && !r.value.startsWith('enc1:')) {
        r.value = seal(r.value);
        await this.repo.save(r);
      }
    }
    const existingFlags = new Set((await this.flags.find({ select: ['key'] })).map((f) => f.key));
    const missingFlags = FEATURE_FLAG_DEFINITIONS.filter((d) => !existingFlags.has(d.key));
    if (missingFlags.length) await this.flags.insert(missingFlags);
  }

  async reload() {
    const all = await this.repo.find();
    this.cache = new Map(all.map((s) => [s.key, s.isSecret ? this.open(s) : s.value]));
    this.loadedAt = Date.now();
  }

  /** Secrets are sealed at rest; the in-memory cache (used by every sync get()) holds the plaintext. */
  private open(s: Setting): any {
    if (typeof s.value !== 'string' || !s.value.startsWith('enc1:')) return s.value;
    try {
      return unseal(s.value);
    } catch {
      this.logger.error(`Secret setting "${s.key}" cannot be decrypted (was DATA_ENCRYPTION_KEY changed?) - treated as not configured`);
      return '';
    }
  }

  /** Sync read from cache (refreshed on every write and every 60 s). */
  get<T = any>(key: string, fallback?: T): T {
    if (Date.now() - this.loadedAt > 60_000) this.reload().catch(() => undefined);
    return (this.cache.has(key) ? this.cache.get(key) : fallback) as T;
  }

  async set(key: string, value: any) {
    let s = await this.repo.findOne({ where: { key } });
    if (!s) s = this.repo.create({ key, group: key.split('.')[0] });
    s.value = s.isSecret ? sealSecret(value) : value;
    await this.repo.save(s);
    this.cache.set(key, value);
    return s;
  }

  async isFeatureEnabled(key: string, cityId?: string): Promise<boolean> {
    const f = await this.flags.findOne({ where: { key } });
    if (!f || !f.enabled) return false;
    if (f.cityIds?.length && cityId && !f.cityIds.includes(cityId)) return false;
    return true;
  }

  async list(group?: string) {
    const rows = await this.repo.find({ where: group ? { group } : {}, order: { group: 'ASC', key: 'ASC' } });
    // the "integrations" and "verification" groups are edited on their own pages (validation, super admin only); they are not listed here
    return rows.filter((r) => r.group !== 'integrations' && r.group !== VERIFICATION_SETTING_GROUP).map((r) => this.mask(r));
  }

  mask(r: Setting) {
    if (!r.isSecret) return r;
    const has = r.value !== null && r.value !== undefined && r.value !== '';
    return { ...r, value: has ? '********' : '', hasValue: has };
  }

  /** Values flagged isPublic - safe to expose to mobile apps. */
  async publicConfig() {
    const rows = await this.repo.find({ where: { isPublic: true, isSecret: false } }); // a secret can never be public
    const out: Record<string, any> = {};
    for (const r of rows) out[r.key] = r.value;
    const flags = await this.flags.find();
    return { settings: out, featureFlags: Object.fromEntries(flags.map((f) => [f.key, f.enabled])) };
  }
}
