# Integrations page and maps (Mapbox / Google)

## Admin > System > Integrations

One page, one card per integration. Everything is also available from the API (`/admin/integrations`).

| | |
|---|---|
| **Stripe** | secret key, publishable key, webhook signing secret, Stripe Connect on/off, currency (CAD), platform country (CA) |
| **Maps provider** | which provider is in use, **Mapbox (default) or Google**, and the road-distance switch. Switching takes effect at once, needs a confirmation, and the keys of the other provider stay saved |
| **Mapbox** | server access token, public token (for the maps), map style, search country (`ca`), bounding box (Greater Toronto Area), default proximity (Mississauga) |
| **Google Maps** | server API key, browser key (for the maps). The search country / box / proximity are the Mapbox card's: both providers search the same area |
| **Read-only status cards** | Twilio, SendGrid, Firebase Cloud Messaging, Certn: configured / incomplete / not configured (from the existing settings or environment). Certn runs the background checks behind automatic verification: variables and webhook in [verification.md](verification.md#certn-setup) |

* A banner shows the mode: **red "LIVE keys"**, **amber "TEST mode"**, amber "TEST payment (no Stripe keys configured)" when the development mock is on, grey "not configured".
  Mixing a test secret key with a live publishable key (or the reverse) raises a warning.
* **Test connection** (per card) gives a readable pass / fail with the reason and never the key. Stripe: retrieves the balance and the platform account (mode test / live,
  charges and payouts enabled, Connect enabled, whether our webhook endpoint is registered, enabled and subscribed to every event). Mapbox and Google: one address search, one road-distance request and (Google) a map session, each reported separately.
* The **exact webhook URL** (`PUBLIC_URL + /api/v1/webhooks/stripe`) with a copy button, the list of 15 events to subscribe to (copy button) and the recent webhook events with status and a Replay button.

### Rules for the keys

* Stored **encrypted at rest** (AES-256-GCM, `common/secretbox.ts`, key from `DATA_ENCRYPTION_KEY`; JWT secret in development). Every secret setting (Twilio, SendGrid, FCM, Google Maps, Stripe, Mapbox)
  is sealed; secrets that were stored in clear text by older versions are sealed on the first boot.
* **Never returned by any API**: status shows `set / source (settings or env) / ********last4`. The publishable key is public by design and is shown.
* Changing a key needs `settings:edit` **and** a Super Admin (staff get 403). Formats are checked before anything is stored: `sk_test_` / `sk_live_` / `rk_...`, `pk_test_` / `pk_live_`, `whsec_`,
  Mapbox `sk.` / `pk.` tokens and `username/style_id`, Google `AIza...` keys, bounding box, proximity.
* Every change is written to the audit log with the field names only, never a value (`integrations.stripe.update`, `integrations.mapbox.update`, `integrations.google.update`, `integrations.maps.update` with the old and the new provider, and `.test`).
* Keys can also come from the environment (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `MAPBOX_ACCESS_TOKEN`, `MAPBOX_PUBLIC_TOKEN`, `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_BROWSER_KEY`); a **saved value wins** over the environment.
  Sending an empty string removes the saved value (the environment applies again).
* **Keys and styles can be replaced or removed at any time** (System > Integrations, or `PUT /admin/integrations/mapbox`): the change is used by the running API at once (no restart; another API instance picks it up within a minute) and the maps of the admin screens
  draw the new style on the next map. In the Admin Console a new key or style is checked against Mapbox right after saving, so a wrong one shows at once.
* The generic Settings page no longer lists or edits the `integrations` group (the old `payments.stripe.*`, `maps.mapboxToken`, `maps.googleApiKey` and `maps.provider` rows were moved here on first boot; the old `maps.provider` only stays Google when a Google key was really saved, otherwise Mapbox is the provider).

API: `GET /admin/integrations`, `PUT /admin/integrations/stripe`, `PUT /admin/integrations/mapbox`, `PUT /admin/integrations/google`, `PUT /admin/integrations/maps` (`{ provider: mapbox|google, roadDistances: bool }`), `POST /admin/integrations/:name/test` (`stripe` | `mapbox` | `google`), `GET /admin/maps/config` (any signed-in staff: provider + tile URL, public keys only),
`GET /admin/integrations/stripe/events`, `POST /admin/integrations/stripe/events/:id/replay`, `POST /admin/integrations/stripe/sweep-intents`,
public `GET /public/payments/config` (`{provider: stripe|mock|none, publishableKey, mode, addressSearch, ...}`; no secrets).

## Maps: one provider switch, three jobs

A **Super Admin** picks the provider on System > Integrations > Maps provider (default **Mapbox**; the Google configuration stays in place so switching back and forth is one click).
Everything below follows the switch immediately. Whatever the provider cannot do (no key, rejected key, outage) degrades to the old behaviour and never breaks a page or a quote.

| Job | Mapbox | Google | Without a usable key |
|---|---|---|---|
| **Address search** (website, admin forms, restaurant pin of a new business) | Search Box API (suggest, retrieve, reverse), server token | Places API (New) autocomplete + details, Geocoding API for reverse, server key | customers type the address (the storefront keeps its demo areas), the admin says "Address search is not configured" |
| **Road distance and drive time of a delivery** (quote, delivery fee, ETA) | Directions API (driving, no live traffic), server token | Routes API (drive, traffic unaware), server key | the built-in estimate: straight line x 1.3 at 28 km/h |
| **Map tiles of the admin screens** (live map, zones, order and proof maps, heat map) | Styles API raster tiles, **public pk. token** + the map style | Map Tiles API 2D tiles (the server key creates the session), **browser key** | OpenStreetMap tiles (as before) |

Both providers answer in the same shapes, so nothing else in the app knows which one is active (`MapsService`, `backend/src/integrations/maps.service.ts`).
The **search area** (country `ca`, bounding box = Greater Toronto Area, default proximity = Mississauga) is one set of settings (the Mapbox card) used by both: Google receives it as `includedRegionCodes`, `locationRestriction` (or a `locationBias` circle when there is no box).

### Real road distances (off by default)

The switch **"Use real road distances and drive times"** is OFF by default because it can change delivery fees (the fee is a base plus a per-kilometre amount, and the built-in estimate is not the road distance).
When it is on, the quote asks the provider for the route from the restaurant to the address. Rules that keep money consistent:

* An answer is remembered (a real route for a day, per provider and coordinates rounded to ~1 m), so the quote, the payment and the order always see the same distance.
* If the provider cannot answer, the quote uses the estimate and **that fallback is remembered for ten minutes** too, so a hiccup between the payment and the order can never change the price.
* The straight-line delivery radius check, the zone check and the minimum order are unchanged. Switching the provider or the switch clears the remembered answers.
* Dispatch (ranking drivers), discovery (restaurant ETAs in lists) and driver location keep using the estimate: they run for many drivers / restaurants per request and a per-call routing bill makes no sense there.

### Which keys the providers need

* **Mapbox**: an `sk.` server token with the **Search** and **Directions** scopes (a `pk.` token with the Search scope also works), and a **public `pk.` token** for the maps. In Mapbox, restrict the public token to your website addresses. The browser only ever sees the public token and the style.
  A secret token starts with `sk.`; a token that starts with `pk.` is public whatever it is called, and one created with few scopes answers 403 to address search and map tiles.
* **Map style**: `username/style_id` (`mapbox/streets-v12`) or whatever Mapbox Studio gives out: the **Style URL** `mapbox://styles/username/style_id`, the `https://api.mapbox.com/styles/v1/username/style_id` address or the Studio address. All are stored as `username/style_id`
  (a token in a pasted address is dropped). A style of your own account is drawn with a public token of the same account (a private style needs `styles:tiles` and `styles:read`). **Test connection** also draws one tile of the style and says why it cannot (no such style, token not allowed).
* **Google** (Google Cloud console): a **server key** with the Places API (New), Geocoding API, Routes API and Map Tiles API enabled (restrict it by IP to the API server), and a separate **browser key** restricted to your website addresses and to the Map Tiles API. The browser only ever sees the browser key.
* The tile origins `https://api.mapbox.com` and `https://tile.googleapis.com` are allowed in the `img-src` of the Content-Security-Policy (images only; see [security-frontend.md](security-frontend.md)). Address search needs no CSP entry: the browser only calls the FORKSY API.

## Address search routes

| Route | |
|---|---|
| `GET /public/geocode/autocomplete?q=&proximity=lng,lat&sessionToken=` | up to 6 address suggestions in Canada (country, bounding box and proximity from the settings) |
| `GET /public/geocode/retrieve?id=&sessionToken=` | `{ address: { line1, city, province, postalCode, lat, lng, label } }` |
| `GET /public/geocode/reverse?lat=&lng=` | the nearest address (or `null`) |
| `GET /admin/geocode/autocomplete | retrieve | reverse` | the same for the Admin Console (login required) |

Throttle 30 requests / minute / IP (public), strict input validation (3-100 characters, `lng,lat` ranges, session token 8-64 `[A-Za-z0-9-]`, id charset), 1-hour in-memory cache per provider (identical searches reach the provider once).
Without a key (or with a rejected one) every route answers `{ "enabled": false }` and the clients fall back: the storefront keeps its demo areas (with the "approximate area" note), the admin shows
"Address search is not configured".

* Storefront: the "Add a delivery address" dialog and the "Deliver to" dialog get a debounced, keyboard-accessible search (arrow keys, Enter, Escape) that fills street, city, postal code and the map position.
* Admin: **Find address** in Businesses > Add Business, business detail > Location (fills address, city, postal code and moves the pin) and the Zones editor (centres the map). Drivers have no address field.
* `MAPBOX_API_BASE` / `GOOGLE_API_BASE` point the API at fake servers (tests only; the API refuses to start in production when one is set).
* Tests: `backend/test/maps-e2e.mjs` (59 checks against `fakes/fake-mapbox.mjs` and `fakes/fake-google.mjs`), `backend/test/maps.test.ts` (unit, in CI). Neither provider has been called for real: the first run with real keys may show small differences.
