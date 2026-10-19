# Customer website (storefront)

The FORKSY customer website: browse restaurants and stores, build a cart, check out, follow the order live. It also hosts the **centralized ordering assistant** (chat bubble) and is the landing page of the **checkout hand-off** from the assistant that merchants embed on their own websites.

It lives inside the existing React app (`admin/`), under **`/order`**, with its own layout (no admin sidebar), its own login session and its own HTTP client. Code: `admin/src/features/storefront/`, mounted by one line in `admin/src/App.js` (`<Route path="/order/*">`, lazy loaded: the admin console and the restaurant portal do not download it).

| URL (dev) | What |
|---|---|
| http://localhost:3000/order | Home: search, filters (open now, delivery, pickup, cuisine), restaurants and stores |
| /order/r/:slug | Restaurant page and menu, item dialog (modifiers, notes), cart |
| /order/login | Sign in / Create account (`?next=/order/checkout`, `?tab=register`) |
| /order/handoff?token=... | Landing page of the assistant checkout hand-off (see below) |
| /order/checkout | Review, delivery or pickup, address, delivery instructions, notes, tip, promo, wallet, payment (Stripe Payment Element), place order |
| /order/track/:id | Live order tracking, delivery PIN, proof photo, cancel, rating |
| /order/orders | My orders |
| /order/wallet | Wallet balance, top-up (Stripe), gift cards (redeem / buy), saved cards (add / default / remove) |
| /order/payouts/return | Public landing page after the Stripe payout-account onboarding (drivers; the driver app will deep-link later) |
| /order/notifications | Notification inbox (All / Unread, categories, load more, mark read, delete) |
| /order/account | Account summary and **notification settings** (push on this device, channels per category, quiet hours, devices) |

## Screens and the API they use

| Screen | API |
|---|---|
| Home | `GET /public/home`, `GET /public/search` (`q`, `openNow`, `fulfilment=pickup\|delivery`, `cuisine`, `lat`, `lng`, `page`) |
| Restaurant | `GET /public/restaurants/:slug` (`lat`, `lng`): service mode (`CLOSED` / `PICKUP_ONLY` / `PICKUP_AND_DELIVERY`), hours, minimum order, prep time, menu, modifier groups. Closed restaurants and sold-out items are shown but cannot be added |
| Cart (guest) | local only, see "Cart" |
| Cart (signed in) | `GET /customer/cart`, `POST /customer/cart/items` (409 `CART_RESTAURANT_CONFLICT` -> "Start a new cart?" -> retry with `replaceCart`), `PATCH`/`DELETE /customer/cart/items/:lineId`, `POST /customer/cart/replace`, `POST /customer/cart/promo`, `DELETE /customer/cart` |
| Account | `POST /auth/login` (`app: "customer"`), `POST /auth/customer/register`, `POST /auth/otp/request` + `/auth/otp/verify` (phone code; new numbers create the account), `GET /auth/me`, `POST /auth/refresh`, `POST /auth/logout` |
| Checkout | `GET /customer/addresses`, `POST /customer/addresses`, `GET /public/delivery-options`, `GET /customer/wallet`, `POST /customer/checkout/quote`, `POST /customer/orders` |
| Tracking | `GET /orders/:id/tracking` (every 5 s), `GET /orders/:id/proof/photo` (as a blob, with the bearer token), `POST /customer/orders/:id/cancel`, `GET/POST /customer/orders/:id/review`, `GET /public/rating-options` |
| My orders | `GET /customer/orders` |
| Assistant | `GET /public/assistant/config`, `POST /public/assistant/chat`, `POST /public/assistant/handoff`, `POST /customer/assistant/import-handoff` (contract in `lib/assistantApi.js`) |

Order placement sends exactly the fields of `PlaceOrderDto`: `type` (`DELIVERY`/`PICKUP`), `addressId`, `tip`, `useWallet`, `dropoffMethod`, `usePin`, `dropoffNotes`, `accessCode`, `customerNotes` (the kitchen note), `paymentMethod: "CARD"` (or `"WALLET"` when wallet credit covers everything) and `paymentIntentId` (the PaymentIntent the Payment Element just confirmed; see docs/payments.md). With the development mock (no Stripe key, `ALLOW_MOCK_PAYMENTS=true`) it sends the mock intent id and `paymentToken: "pm_mock"`. Pickup orders send no delivery fields. The promo code is stored on the cart (`/customer/cart/promo`) and applied by the quote and the order.

## Sessions and storage keys

The storefront does **not** use the admin client (`src/lib/api.js`): it has its own axios instance, its own token store and its own logout event (`lib/sfApi.js`, `lib/SfAuth.jsx`). Signing in to `/order` never signs in to `/`, and the other way round. Only CUSTOMER accounts can sign in (`app: "customer"`; admin, restaurant and driver accounts are refused). The admin console wipes every `forksy.*` key on logout; the storefront keys deliberately start with `sf.` so that never touches them.

| Key | Storage | Content |
|---|---|---|
| `sf.access`, `sf.refresh` | sessionStorage (per tab) | customer tokens. The 401 handler refreshes once, then signs out |
| `sf.cart.v1` | localStorage | guest cart (one restaurant) |
| `sf.location` | localStorage | chosen "deliver to" area (label, lat, lng) |
| `sf.orderNote`, `sf.orderNote.<restaurantId>` | session / local | kitchen note prefilled from a hand-off or the assistant; draft kitchen note |
| `sf.handoff`, `sf.handoff.used` | sessionStorage | hand-off state machine; fingerprints (last 8 characters) of tokens already used in this tab |
| `sf.bot.session`, `sf.bot.log`, `sf.bot.scope` | sessionStorage | assistant session id, last 30 messages, which restaurant the conversation belongs to |
| `sf.notice` | sessionStorage | one-shot message for the sign-in page (idle sign-out) |

Idle sign-out: 30 minutes without input signs the customer out (`REACT_APP_IDLE_MINUTES_STOREFRONT`, 0 disables). The guest cart is kept. All storage access is wrapped in try/catch (private windows).

## Cart

* **Guest**: kept in `localStorage`, one restaurant at a time. Adding from another restaurant asks "Start a new cart?". Item prices are the menu prices; the server re-prices everything.
* **Signed in**: the server cart is the source of truth, every change goes through the API (so the assistant, other tabs and other devices see the same cart).
* **On sign-in** a non-empty guest cart replaces the account's server cart (`POST /customer/cart/replace`), then the local copy is dropped. If one line cannot be added (sold out meanwhile) the others are added one by one and a message names the skipped item. While a hand-off is in progress the guest cart is not synced (the hand-off cart wins and the guest cart is discarded on success).
* **Assistant**: signed in, the assistant writes the real server cart and the page re-reads it after each reply. Guest: the assistant's session cart is merged into the guest cart by delta (each assistant line is remembered by its `lineId`, so repeated replies never double count). Starting a new chat or leaving the restaurant keeps the lines as ordinary cart lines.

## The checkout hand-off (assistant -> storefront)

1. A visitor on a merchant site taps **Checkout** in the widget. The widget calls `POST /public/assistant/handoff { sessionId }` and sends the browser to `<WEB_URL>/order/handoff?token=...` (`WEB_URL` in `backend/.env`, see `backend/.env.example`). The same happens on this site when a guest taps Checkout in the assistant.
2. **Handoff screen** (`pages/Handoff.jsx`): on its very first render it reads `?token=`, **removes the query string from the address bar** (`history.replaceState`) and keeps the token only in `sessionStorage` (`sf.handoff`). An optional `&restaurant=<slug>` lets the sign-in screen say "Log in or create an account to continue with your order from *Name*" (the API's own link has no restaurant name; the widget may append it).
3. Not signed in: inline Sign in / Create account (same forms as `/order/login`). Signed in: straight to step 4. A reload at any point keeps the flow.
4. `POST /customer/assistant/import-handoff { token }` is called **once**. The state is persisted before the call (`pending` -> `importing` -> `done` | `failed`), and the token is dropped from storage on success or failure. A reload while `importing` is never replayed (the server may have consumed the token): the server cart is read instead. Only a network failure (no response at all) goes back to `pending` so the customer can retry. Opening a link whose token was already used in the tab shows "already used" without calling the API.
5. Success: "We added N items from *Restaurant*", skipped items with their reasons, the kitchen note, then **Continue to checkout** (automatic after 4 s when nothing was skipped). The note is prefilled in the checkout's "Note for the restaurant" box.
6. Errors (bad, used or expired token: HTTP 400 with a message) show the API's message and a link back to the restaurant (or the restaurant list). The token's lifetime is the platform setting `assistant.handoffTtlMinutes` (30).

## Checkout details

* **Delivery or pickup** follows the restaurant's service mode: pickup-only stores disable Delivery, closed stores block the order, delivery also depends on the address being in range (the quote refuses it with a message shown under the address).
* **Address**: saved addresses or a new one. **There is no geocoding provider connected** (no map key): an address gets its coordinates from a list of demo areas, one per delivery zone of Mississauga, Brampton, Edmonton and Winnipeg (approximate; the address is saved with the province of the area) or from coordinates typed in by hand. The page says so. The "Deliver to" area in the header drives which restaurants can deliver to you.
* **Delivery instructions**: Hand it to me / Meet outside / Leave at my door, **"Use a private delivery PIN"** switch (default on; disabled for leave-at-door, which always uses a photo), driver note (300), gate code (40, validated like the API), suggestion chips from `GET /public/delivery-options`. See `docs/proof-of-delivery.md`.
* **Payment** is the Stripe Payment Element (cards, Apple Pay / Google Pay, saved cards, "Save this card", 3-D Secure) when the Stripe keys are configured; the intent is created / updated by `POST /customer/payments/intent` as the quote changes, "Pay $x and place order" confirms it on the page (no redirect) and then places the order. A 409 `PAYMENT_QUOTE_CHANGED` re-creates the intent. Without keys and with `ALLOW_MOCK_PAYMENTS=true` the page shows the amber "TEST payment (no Stripe keys configured)" notice as before; with neither, "Card payments are not available right now". Verified in a browser against a fake Stripe API: the real Stripe.js loads but rejects the fake publishable key, so the card form itself needs the owner's TEST keys. Address search (Mapbox through the API) fills the address dialog; the demo areas remain the fallback when it is off.
* Tip presets (None, 10, 15, 20 % of the subtotal, or any amount up to $500), promo code, wallet credit toggle (shown when the wallet has a balance).

## Stores and groceries

The website sells from every kind of store (restaurant, cafe, bakery, grocery, convenience, specialty; see `docs/store-types.md`). Everything is driven by `storeType` and the catalog fields of the API; there is no separate shop site.

* **Home**: a row of kind-of-store tiles from `GET /public/store-types` (only kinds that exist around the chosen area, hidden when there is a single kind). A tile filters home and search (`?t=GROCERY` or the group `?v=RETAIL|FOOD`, sent as `storeType` / `vertical`). The unfiltered page adds a "Groceries and shops" row when food places exist as well.
* **Store page**: a store of a retail type shows a catalog instead of a menu: department navigation, a search box (product, brand or barcode) and an "In stock only" chip, products paged with "Load more" (`GET /public/stores/:slug/catalog`), the store type badge and the picking time. Restaurants keep the menu.
* **Products**: cards show pack size, brand, price per kg or lb for weighed products, "Only N left" / "Sold out", and a cold-chain mark for chilled and frozen goods. A weighed product is ordered in weight steps (the stepper reads "0.5 kg" or "1 lb", the button shows the price of the line). The dialog also asks what to do when the product is not available: **replace it with the best match** or **refund it** (`substitution`), the same choice is on every cart line. Quantities stop at what the shelf holds and at the per-order limit.
* **Age-restricted products** show the age ("You must be 19 to order this. ID is checked at your door"). At checkout the totals are shown right away; the customer ticks "I am at least 19 and I will show ID" before paying (the payment is not prepared before). "Leave at my door" is not offered for these baskets and a saved address that prefers it is switched to "Hand it to me"; for pickup the notice says the ID is checked at the counter.
* **Tracking** words the steps for the store ("Order confirmed", "Picking your items", "Packed and ready"), lists every product with its pick status (To pick, Found, Replaced with ..., Out of stock with its refund), shows the weighed amount once it is weighed, and the ID check result. It refreshes on `order.item_picked` as well as the other live events. **My orders** shows the store name and the same wording.
* **Photos**: the item window shows the featured photo and the gallery of the item (`imageUrl`, `galleryUrls`): previous / next buttons, the arrow keys, small pictures to jump to one and a counter ("2 / 4"); a single photo is shown as before, without controls.
* The checkout summary adds the basket line ("3 products, about 2 kg weighed. Includes chilled or frozen items, kept cold for you.").

## Tracking

Polls `GET /orders/:id/tracking` every 5 seconds (every 15 s once the order is final, then every 60 s). The stepper shows the automatic steps: placed, accepted, preparing, ready, driver assigned, picked up, on the way, delivered (pickup: placed, accepted, preparing, ready, collected), with times. Shows the **delivery PIN** while it is relevant, the pickup code for pickup orders, the driver card, the **proof-of-delivery photo** (fetched with the bearer token and shown as a `blob:` URL, never as a bare `<img src>` to the API), a **cancel** button and a rating form after delivery. While the customer's own Socket.IO connection is up (see "Notifications") the page joins the order room (`order.subscribe`), re-reads the tracking at once on `order.status` / `order.driver_arrived` / `order.eta` / `order.released` (and driver assigned / item removed) and relaxes polling to 30 s; without a socket it polls every 5 s as before.

Customers can only cancel while the order is `PLACED` or `ACCEPTED` (API rule). Because orders are accepted and started automatically within a second, in practice the button is only visible for restaurants that accept manually. Afterwards the page tells the customer to contact support.

## The assistant (`components/AssistantChat.jsx`)

Floating bubble + chat panel on every page except sign-in and the hand-off screen. On a restaurant page it is scoped to that restaurant (`restaurantSlug`); elsewhere it is the central assistant (the chosen "deliver to" area is sent as `lat`/`lng` for "near me"). The bubble is hidden when `GET /public/assistant/config` fails or says `enabled: false`. It renders reply text as plain text (React text nodes), item cards with **Add** (sends the `add:<menuItemId>` quick reply), restaurant cards (links to `/order/r/:slug`), chips (sent back as `quick`; the API requires a non-empty `message`, so the chip label is sent with it), a cart summary and **Checkout** (signed in: `/order/checkout`; guest: `POST /public/assistant/handoff` then `/order/handoff?token=...`, only same-site urls are followed). The customer's bearer token is sent when signed in so the assistant writes the real cart.

## Notifications (bell, inbox, push)

Built on the shared client in `admin/src/lib/notify` (store, push controller, service worker `/sw.js`, scope `/`). `lib/SfNotify.jsx` mounts `<NotifyProvider app="customer" enabled={!!user}>` around the shell: it only runs while a customer is signed in, but stays in the tree so signing in or out never remounts the pages.

* **Own socket**: `lib/sfRealtime.js` (`createRealtime` with the `sf.access` token). It is closed on sign-out, on a forced sign-out and when the session ends. Track.jsx uses the same connection.
* **Header bell** (`components/NotifyBell.jsx`): unread badge, `aria-label` with the count, a polite live region, dropdown with the 6 latest (click = deep link + read), Mark all read, See all, "Turn on notifications" when push is available and off; Esc / outside click closes it; on `/order/notifications` the bell is a plain link.
* **Toasts** (`lib/SfNotify.jsx`): shown only while the page is visible and focused (otherwise the service worker shows the OS notification, never both); `role="status"`, auto-dismiss after 7 s (paused on hover / focus), click opens the link.
* **Inbox** `/order/notifications`, **settings** `/order/account#notifications`. Preferences use `GET/PUT /notifications/preferences`; promotions e-mail / SMS are the CASL marketing consents (opt-in, off by default) and stay in sync with `/customer/profile/consents`. In-app is locked on for orders, delivery, payments and support.
* **Push is never requested automatically.** The only code path that calls `Notification.requestPermission()` is a click on "Turn on notifications" (bell, banner on home / tracking / inbox, or the account page). "Not now" hides the banner for 14 days.
* **Sign-out** (`SfAuth.logout`, also the idle sign-out): `teardownActivePush()` first (the browser is unsubscribed on the server and in the browser), then the socket is closed, then `POST /auth/logout`. The opt-in is remembered per customer, so the next sign-in of the same customer re-subscribes silently.
* Deep links from notifications are restricted to `/order...` paths (`lib/notifyFmt.js`).

## Security notes

* No inline scripts, no `eval`, no `dangerouslySetInnerHTML`; all API text is rendered as React text. Image urls go through `safeImgUrl` (`lib/safe.js`), colours through `safeColor`, redirects through a same-site `/order` allow-list.
* The CSP in `admin/public/index.html` is unchanged: the storefront only talks to the API origin already allowed in `REACT_APP_CSP_CONNECT`, loads fonts and icons from the app itself (Remix icon font, no CDN) and shows remote images only from `REACT_APP_CSP_IMG`.
* `admin/test/xss-smoke.mjs` now also sweeps the storefront (with and without the CSP) and the assistant panel with payload-filled replies.

## What is mocked, missing or limited

* Payments: test token only. No real card form.
* Geocoding: none; demo areas and typed coordinates (see above).
* Scheduled orders (`scheduledFor`), gift card redemption, saved cards, favourites, address editing and changing delivery instructions after ordering are not in the website yet (the API supports them).
* Two-factor sign-in is not supported on the website (customers do not have it).
* Tracking is polling only; no map and no driver position.
* Proof-of-delivery photo and rating form are verified against mocked responses only (a real delivery needs a driver and GPS).
* The restaurant name on the hand-off sign-in screen needs `&restaurant=<slug>` on the link; otherwise it says "your order".

## Tests

Playwright scripts used for acceptance are kept out of the repo (scratch folder); the repository test is `node admin/test/xss-smoke.mjs` (set `PLAYWRIGHT_DIR`), which includes the storefront. Manual path: browse, add an item with a modifier, reload (guest cart persists), create an account, check out, place the order, watch the tracking page move past PLACED, cancel it in the admin (`POST /admin/orders/:id/cancel`).

## Deploying the storefront separately later

The storefront is self-contained: the folder `admin/src/features/storefront/` imports only `errorMessage`, `clean`, `API_URL`, `WS_URL` from `src/lib/api.js` and `safeImgUrl`, `safeColor` from `src/lib/safe.js`. To ship it as its own site:

1. Copy the folder and those two small helpers into a new React app (or a new CRA entry) that renders `<Storefront />` at `/` and use `BrowserRouter basename="/order"` (or change the `/order` prefixes). Copy the Remix icon font css, Inter font css and `forksy-logo.svg` from `admin/public/assets`.
2. Set `REACT_APP_API_URL`, a strict CSP like `admin/public/index.html` (`connect-src` = the API origin, `img-src` = API origin + image CDN) and the clickjacking headers (`docs/security-frontend.md`).
3. Backend: add the storefront origin to `CORS_ORIGINS` and set `WEB_URL` to it (the assistant builds `${WEB_URL}/order/handoff?token=...`; keep the `/order` path or change it in `assistant.service.ts`).
4. Remove the `/order/*` route from the admin app so the console no longer ships it.
Until then the admin console and the storefront can be served from the same host; keep the admin routes behind your normal access controls.
