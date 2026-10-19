import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import AddressSearch from "../components/AddressSearch";
import { CartLines, RetailCartNotes } from "../components/CartPanel";
import FulfilmentToggle from "../components/FulfilmentToggle";
import PaymentSection from "../components/PaymentSection";
import { Dialog, ErrorBox, Loading, Notice, Ri, Spinner, useToast } from "../components/ui";
import { getFulfilment } from "../lib/fulfilment";
import { addressSearchEnabled } from "../lib/geocode";
import { DEMO_LOCATIONS, setLocation, useSfLocation } from "../lib/location";
import { basketText } from "../lib/retail";
import { SF_KEYS, errorCode, errorMessage, money, sfHttp, sfStore } from "../lib/sfApi";
import { useSfAuth } from "../lib/SfAuth";
import { useSfCart } from "../lib/SfCart";

const ACCESS_CODE_RE = /^[A-Za-z0-9 #*\-_./]{1,40}$/;
const TIP_PRESETS = [0, 10, 15, 20];

function Section({ n, title, children, hint }) {
  return (
    <section className="sf-card sf-pad sf-section">
      <h2 className="sf-h3">
        <span className="sf-step">{n}</span> {title}
      </h2>
      {hint && <p className="sf-small sf-muted">{hint}</p>}
      {children}
    </section>
  );
}

/** "Add a delivery address" dialog. With address search (the maps provider through the FORKSY API) the street, city, postal code and map position are filled from a suggestion; without it the demo areas are the fallback. */
function AddressDialog({ open, onClose, onSaved }) {
  const loc = useSfLocation();
  const first = DEMO_LOCATIONS.find((l) => loc && l.lat === loc.lat && l.lng === loc.lng) || DEMO_LOCATIONS[0];
  const [f, setF] = useState({ label: "Home", line1: "", line2: "", city: first.city, province: first.province || "ON", postalCode: first.postalCode, lat: String(first.lat), lng: String(first.lng) });
  const [demo, setDemo] = useState(first.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState(null); // null = still checking, true / false = address search on / off
  const [picked, setPicked] = useState(null);
  useEffect(() => {
    addressSearchEnabled().then(setSearch).catch(() => setSearch(false));
  }, []);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const onFound = (a) => {
    setPicked(a);
    setDemo("");
    setF((cur) => ({ ...cur, line1: a.line1 || cur.line1, city: a.city || cur.city, province: a.province || cur.province, postalCode: a.postalCode || cur.postalCode, lat: String(a.lat), lng: String(a.lng) }));
  };
  const pickDemo = (label) => {
    setDemo(label);
    const d = DEMO_LOCATIONS.find((l) => l.label === label);
    if (d) setF((cur) => ({ ...cur, city: d.city, province: d.province || "ON", postalCode: d.postalCode, lat: String(d.lat), lng: String(d.lng) }));
  };
  const save = async (e) => {
    e.preventDefault();
    const lat = Number(f.lat);
    const lng = Number(f.lng);
    if (search === true && !picked) return setError("Search for your address and choose one of the suggestions, so we know where to deliver.");
    if (!f.line1.trim()) return setError("Enter the street address.");
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return setError("Coordinates are not valid.");
    setBusy(true);
    setError("");
    try {
      const a = await sfHttp.post("/customer/addresses", { label: f.label.trim() || undefined, line1: f.line1.trim(), line2: f.line2.trim() || undefined, city: f.city.trim(), province: f.province || "ON", postalCode: f.postalCode.trim().toUpperCase(), lat, lng });
      onSaved(a);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add a delivery address">
      <form onSubmit={save} id="sf-addr-form">
        {search === true && (
          <>
            <AddressSearch onPick={onFound} proximity={loc ? `${loc.lng},${loc.lat}` : undefined} />
            {picked && <Notice tone="success" icon="map-pin-2-line" className="mb-2"><span data-testid="addr-found">Found: {picked.label}</span></Notice>}
          </>
        )}
        {search === false && (
          <Notice tone="warn" icon="map-pin-2-line">
            Address search is not connected yet, so the map position of your address comes from the area you pick below (<b>demo coordinates, approximate</b>). Delivery distance and fees are calculated from that point.
          </Notice>
        )}
        {search === false && (
          <div className="sf-field mt-2">
            <label className="sf-label" htmlFor="ad-demo">Use these demo coordinates</label>
            <select id="ad-demo" className="sf-input" value={demo} onChange={(e) => pickDemo(e.target.value)} data-testid="addr-demo">
              {DEMO_LOCATIONS.map((l) => (
                <option key={l.label}>{l.label}</option>
              ))}
              <option value="">Enter coordinates myself</option>
            </select>
          </div>
        )}
        <div className="sf-two">
          <div className="sf-field">
            <label className="sf-label" htmlFor="ad-label">Label</label>
            <input id="ad-label" className="sf-input" value={f.label} onChange={set("label")} maxLength={40} />
          </div>
          <div className="sf-field">
            <label className="sf-label" htmlFor="ad-postal">Postal code</label>
            <input id="ad-postal" className="sf-input" value={f.postalCode} onChange={set("postalCode")} required maxLength={12} data-testid="addr-postal" />
          </div>
        </div>
        <div className="sf-field">
          <label className="sf-label" htmlFor="ad-line1">Street address</label>
          <input id="ad-line1" className="sf-input" value={f.line1} onChange={set("line1")} placeholder="123 Main Street" required maxLength={200} autoComplete="address-line1" data-testid="addr-line1" />
        </div>
        <div className="sf-two">
          <div className="sf-field">
            <label className="sf-label" htmlFor="ad-line2">Unit / floor (optional)</label>
            <input id="ad-line2" className="sf-input" value={f.line2} onChange={set("line2")} maxLength={100} autoComplete="address-line2" />
          </div>
          <div className="sf-field">
            <label className="sf-label" htmlFor="ad-city">City</label>
            <input id="ad-city" className="sf-input" value={f.city} onChange={set("city")} required maxLength={80} data-testid="addr-city" />
          </div>
        </div>
        {search === false && demo === "" && (
          <div className="sf-two">
            <div className="sf-field">
              <label className="sf-label" htmlFor="ad-lat">Latitude</label>
              <input id="ad-lat" className="sf-input" inputMode="decimal" value={f.lat} onChange={set("lat")} required />
            </div>
            <div className="sf-field">
              <label className="sf-label" htmlFor="ad-lng">Longitude</label>
              <input id="ad-lng" className="sf-input" inputMode="decimal" value={f.lng} onChange={set("lng")} required />
            </div>
          </div>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <button type="submit" className="sf-btn sf-btn-primary sf-btn-block mt-2" disabled={busy} data-testid="addr-save">
          {busy ? <Spinner size={16} /> : null} Save address
        </button>
      </form>
    </Dialog>
  );
}

export default function Checkout() {
  const { user, loading: authLoading } = useSfAuth();
  const { cart, ready, busy: cartBusy, setQuantity, setSubstitution, setPromo, afterOrder, refresh } = useSfCart();
  const navigate = useNavigate();
  const toast = useToast();
  const loc = useSfLocation();

  const [opts, setOpts] = useState(null); // GET /public/delivery-options
  const [addresses, setAddresses] = useState(null);
  const [addrId, setAddrId] = useState("");
  const [addrOpen, setAddrOpen] = useState(false);
  const [wallet, setWallet] = useState(0);
  const [mode, setMode] = useState(""); // DELIVERY | PICKUP
  const [method, setMethod] = useState("HAND_TO_ME");
  const [usePin, setUsePin] = useState(true);
  const [driverNote, setDriverNote] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [kitchenNote, setKitchenNote] = useState("");
  const [tipPct, setTipPct] = useState(15); // number = percent, "custom"
  const [tipCustom, setTipCustom] = useState("");
  const [promoText, setPromoText] = useState("");
  const [promoMsg, setPromoMsg] = useState(null);
  const [useWallet, setUseWallet] = useState(false);
  const [quote, setQuote] = useState(null);
  const [quoteErr, setQuoteErr] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placeErr, setPlaceErr] = useState("");
  const [ageOk, setAgeOk] = useState(false); // "I am at least 19 and I will show ID" (age-restricted products in the basket)
  const [payState, setPayState] = useState({ provider: null, stripeReady: false, loading: true, error: "" });
  const payRef = useRef(null);
  const placeLock = useRef(false);
  const seq = useRef(0);
  const noteInit = useRef(false);

  const rest = cart.restaurant;
  const restId = rest?.id;

  // ---- one-time loads
  useEffect(() => {
    if (!user) return;
    sfHttp.get("/public/delivery-options", undefined, { noAuth: true }).then(setOpts).catch(() => setOpts(null));
    sfHttp.get("/customer/addresses").then((a) => setAddresses(Array.isArray(a) ? a : a?.data || [])).catch(() => setAddresses([]));
    sfHttp.get("/customer/wallet").then((w) => setWallet(Number(w?.balance ?? w?.wallet?.balance ?? 0) || 0)).catch(() => {});
  }, [user]);

  // ---- default fulfilment, prefilled kitchen note (handoff) and promo
  useEffect(() => {
    if (!rest || mode) return;
    // starts with what the customer chose on the home page (delivery or pickup) when this place offers it
    const wantsPickup = getFulfilment() === "pickup";
    setMode(wantsPickup && rest.pickupAvailable ? "PICKUP" : rest.deliveryAvailable ? "DELIVERY" : rest.pickupAvailable ? "PICKUP" : "");
  }, [rest, mode]);
  useEffect(() => {
    if (!restId || noteInit.current) return;
    noteInit.current = true;
    const h = sfStore.getJson(SF_KEYS.orderNote, "session", null);
    if (h?.note && (!h.restaurantId || h.restaurantId === restId)) setKitchenNote(String(h.note).slice(0, 1000));
    else {
      const d = sfStore.getJson(`${SF_KEYS.orderNote}.${restId}`, "local", null);
      if (d?.note) setKitchenNote(String(d.note).slice(0, 1000));
    }
  }, [restId]);
  useEffect(() => {
    if (!restId || !noteInit.current) return;
    sfStore.setJson(`${SF_KEYS.orderNote}.${restId}`, { note: kitchenNote }, "local");
  }, [kitchenNote, restId]);
  useEffect(() => {
    if (cart.promoCode) setPromoText(cart.promoCode);
  }, [cart.promoCode]);

  // ---- default address: the one matching the chosen area, else the default, else the first
  useEffect(() => {
    if (!addresses || addrId) return;
    const withGeo = addresses.filter((a) => a.lat != null && a.lng != null);
    const byLoc = loc && withGeo.find((a) => a.lat === loc.lat && a.lng === loc.lng);
    const pick = byLoc || withGeo.find((a) => a.isDefault) || withGeo[0];
    if (pick) selectAddress(pick);
  }, [addresses]); // eslint-disable-line react-hooks/exhaustive-deps

  function selectAddress(a) {
    setAddrId(a.id);
    if (a.dropoffMethod) setMethod(a.dropoffMethod);
    if (a.usePin === false || a.usePin === true) setUsePin(a.usePin);
    if (a.dropoffNotes) setDriverNote(String(a.dropoffNotes).slice(0, 300));
    if (Number.isFinite(a.lat) && Number.isFinite(a.lng)) setLocation({ label: `${a.label || a.line1}, ${a.city}`, lat: a.lat, lng: a.lng });
  }

  const delivery = mode === "DELIVERY";
  const needsAge = !!cart.requiresIdCheck;
  const minAge = cart.minAge || 19;
  // age-restricted products are handed over in person: what the customer picked, except "leave at my door" (a saved address default may say so)
  const handOver = method === "LEAVE_AT_DOOR" ? "HAND_TO_ME" : method;
  const subtotal = cart.subtotal;
  const tip = !delivery ? 0 : tipPct === "custom" ? Math.max(0, Math.min(500, Math.round(Number(tipCustom || 0) * 100) / 100)) : Math.round(subtotal * (Number(tipPct) / 100) * 100) / 100;
  const codeBad = accessCode.trim() !== "" && !ACCESS_CODE_RE.test(accessCode.trim());

  // ---- quote (debounced, latest wins)
  const addrOk = !delivery || !!addrId;
  useEffect(() => {
    if (!user || !ready || !restId || !mode || !addrOk) {
      setQuote(null);
      return undefined;
    }
    const my = ++seq.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        // the quote prices an age-restricted basket before the box is ticked too (it says ageConfirmationRequired); paying and ordering need the box
        const body = { type: mode, tip: delivery ? tip : undefined, useWallet: useWallet || undefined, ageConfirmed: needsAge && ageOk ? true : undefined, ...(delivery ? { addressId: addrId, ...(needsAge ? { dropoffMethod: handOver } : {}) } : {}) };
        const q = await sfHttp.post("/customer/checkout/quote", body);
        if (my !== seq.current) return;
        setQuote(q);
        setQuoteErr("");
      } catch (e) {
        if (my !== seq.current) return;
        setQuote(null);
        setQuoteErr(errorMessage(e));
      } finally {
        if (my === seq.current) setQuoting(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [user, ready, restId, mode, addrId, addrOk, delivery, tip, useWallet, needsAge, ageOk, handOver, cart.promoCode, cart.subtotal, cart.itemCount]);

  const applyPromo = async () => {
    const code = promoText.trim().toUpperCase();
    setPromoMsg(null);
    const c = await setPromo(code || null);
    if (c) setPromoMsg(code ? { tone: "info", text: `Code ${code} added. See the discount in your totals.` } : { tone: "info", text: "Code removed." });
  };

  // the same fields as the quote: the server prices the cart again to create the payment (the amount is never taken from this page)
  const quoteBody = useMemo(() => ({ type: mode, tip: delivery ? tip : undefined, useWallet: useWallet || undefined, ageConfirmed: needsAge && ageOk ? true : undefined, ...(delivery ? { addressId: addrId, ...(needsAge ? { dropoffMethod: handOver } : {}) } : {}) }), [mode, delivery, tip, useWallet, addrId, needsAge, ageOk, handOver]);
  const cardAmount = quote ? Math.round((Number(quote.total) - Number(quote.walletUsed || 0)) * 100) / 100 : 0;
  const onPayState = useCallback((s) => setPayState(s), []);

  const rule = useMemo(() => (opts?.methods || []).find((m) => m.value === method), [opts, method]);
  const leave = method === "LEAVE_AT_DOOR";
  // age-restricted products are handed over in person (the driver checks ID): "leave at my door" is not offered, and a saved address that prefers it is switched
  useEffect(() => {
    if (needsAge && method === "LEAVE_AT_DOOR") setMethod("HAND_TO_ME");
  }, [needsAge, method]);

  const blockers = [];
  if (!rest) blockers.push("Your cart is empty.");
  if (rest && rest.isOpen === false) blockers.push(`${rest.name} is closed right now.`);
  if (rest && !cart.valid) blockers.push(cart.lines.some((l) => l.problem === "INSUFFICIENT_STOCK") ? "Some items are low in stock. Lower the quantity or remove them to continue." : "Some items in your cart are not available. Remove them to continue.");
  if (rest && !cart.meetsMinimum) blockers.push(`Minimum order is ${money(rest.minimumOrder)}.`);
  if (rest && !mode) blockers.push("This place is not taking pickup or delivery orders right now.");
  if (delivery && !addrId) blockers.push("Choose or add a delivery address.");
  if (delivery && codeBad) blockers.push("The access code has characters that are not allowed.");
  if (needsAge && !ageOk) blockers.push(`Confirm that you are at least ${minAge} to place this order.`);
  if (quoteErr && !(delivery && addrId)) blockers.push(quoteErr);
  const payBlocked = payState.provider === "none" || (cardAmount > 0.009 && payState.provider === "stripe" && !!payState.error && !payState.stripeReady);
  const canPlace = blockers.length === 0 && !quoteErr && !!quote && !quoting && !placing && !cartBusy && !payBlocked && payState.provider !== null;

  const place = async () => {
    if (!canPlace || placeLock.current) return; // double-click protection: one attempt at a time
    placeLock.current = true;
    setPlacing(true);
    setPlaceErr("");
    try {
      // 1. pay: confirm the PaymentIntent with Stripe (card, Apple Pay / Google Pay, 3-D Secure). No card needed when wallet credit covers the order.
      const paid = await payRef.current.pay();
      const body = {
        type: mode,
        paymentMethod: paid.none ? "WALLET" : "CARD",
        ...(paid.intentId ? { paymentIntentId: paid.intentId } : {}),
        ...(paid.mock ? { paymentToken: "pm_mock" } : {}),
        tip: delivery ? tip : undefined,
        useWallet: useWallet || undefined,
        customerNotes: kitchenNote.trim() || undefined,
        ageConfirmed: needsAge ? true : undefined,
        ...(delivery
          ? {
              addressId: addrId,
              dropoffMethod: method,
              ...(leave ? {} : { usePin }),
              dropoffNotes: driverNote.trim() || undefined,
              accessCode: accessCode.trim() || undefined,
            }
          : {}),
      };
      const order = await sfHttp.post("/customer/orders", body);
      sfStore.del(SF_KEYS.orderNote);
      sfStore.del(`${SF_KEYS.orderNote}.${restId}`, "local");
      await afterOrder();
      navigate(`/order/track/${order.id}`, { replace: true });
    } catch (e) {
      const code = e?.code || errorCode(e);
      if (code === "PAYMENT_QUOTE_CHANGED" || code === "PAYMENT_INTENT_CANCELED" || code === "PAYMENT_INTENT_USED" || code === "PAYMENT_REFUNDED" || code === "ORDER_NOT_PLACED_REFUNDED") {
        // the price moved, or the payment was already given back to the card (the server says so in its message): a fresh payment is prepared
        setPlaceErr(errorMessage(e));
        payRef.current?.reset?.();
        setQuote(null);
        seq.current += 1;
      } else setPlaceErr(e?.code && !errorCode(e) ? e.message : errorMessage(e));
      refresh().catch(() => {});
    } finally {
      placeLock.current = false;
      setPlacing(false);
    }
  };

  if (authLoading) return <div className="sf-container"><Loading /></div>;
  if (!user) return <Navigate to="/order/login?next=/order/checkout" replace />;
  if (!ready) return <div className="sf-container"><Loading text="Loading your cart..." /></div>;

  if (!rest || cart.lines.length === 0) {
    return (
      <div className="sf-container sf-narrow">
        <div className="sf-center py-5" data-testid="empty-cart">
          <Ri name="shopping-basket-2-line" className="sf-bigicon" />
          <h1 className="sf-h2 mt-2">Your cart is empty</h1>
          <p className="sf-muted">Pick a restaurant and add something tasty.</p>
          <Link to="/order" className="sf-btn sf-btn-primary">Browse restaurants</Link>
        </div>
      </div>
    );
  }

  const q = quote;
  return (
    <div className="sf-container sf-checkout">
      <h1 className="sf-h1">Checkout</h1>
      <div className="sf-co-layout">
        <div className="sf-co-main">
          <Section n={1} title={`Your order from ${rest.name}`}>
            <CartLines cart={cart} busy={cartBusy} setQuantity={setQuantity} setSubstitution={setSubstitution} />
            {cart.issues.filter((i) => i.code !== "BELOW_MINIMUM").map((i, n) => (
              <Notice key={n} tone="warn" className="mt-2">{i.message}</Notice>
            ))}
            <RetailCartNotes cart={cart} pickup={mode === "PICKUP"} />
            <Link to={`/order/r/${encodeURIComponent(rest.slug)}`} className="sf-btn sf-btn-link">
              <Ri name="add-line" /> Add more items
            </Link>
          </Section>

          <Section n={2} title="Delivery or pickup">
            <FulfilmentToggle value={delivery ? "delivery" : mode === "PICKUP" ? "pickup" : ""} testIdPrefix="mode" unavailable={{ delivery: !rest.deliveryAvailable, pickup: !rest.pickupAvailable }} onChange={(v) => setMode(v === "pickup" ? "PICKUP" : "DELIVERY")} />
            {!rest.deliveryAvailable && rest.pickupAvailable && <p className="sf-small sf-muted mt-2 mb-0">{rest.serviceMode === "PICKUP_ONLY" ? `${rest.name} is pickup only right now.` : "Delivery is not available right now."}</p>}
            {mode === "PICKUP" && <p className="sf-small sf-muted mt-2 mb-0">You collect the order at the store. You get a pickup code after you place it.</p>}
          </Section>

          {delivery && (
            <>
              <Section n={3} title="Delivery address">
                {!addresses ? (
                  <Loading text="Loading addresses..." />
                ) : (
                  <>
                    {addresses.length > 0 && (
                      <div className="sf-list" role="radiogroup" aria-label="Saved addresses">
                        {addresses.map((a) => {
                          const noGeo = a.lat == null || a.lng == null;
                          return (
                            <button key={a.id} type="button" role="radio" aria-checked={addrId === a.id} disabled={noGeo} className={`sf-listbtn ${addrId === a.id ? "on" : ""}`} onClick={() => selectAddress(a)} data-testid="address-option">
                              <Ri name={addrId === a.id ? "radio-button-line" : "checkbox-blank-circle-line"} />
                              <span>
                                <b>{a.label || "Address"}</b> - {a.line1}{a.line2 ? `, ${a.line2}` : ""}, {a.city} {a.postalCode}
                                {noGeo && <span className="sf-small sf-danger"> (no map position, edit it first)</span>}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <button type="button" className="sf-btn sf-btn-light mt-2" onClick={() => setAddrOpen(true)} data-testid="add-address">
                      <Ri name="add-line" /> Add a new address
                    </button>
                    {quoteErr && addrId && (
                      <Notice tone="danger" className="mt-2" icon="map-pin-range-line">
                        <span data-testid="address-error">{quoteErr}</span>
                        {rest.pickupAvailable && <div className="sf-small mt-1">Pick another address, or switch to Pickup above.</div>}
                      </Notice>
                    )}
                  </>
                )}
              </Section>

              <Section n={4} title="Delivery instructions" hint="These go to your driver only. Notes for the kitchen are separate, below.">
                <div className="sf-methods" role="radiogroup" aria-label="How should we hand over your order?">
                  {(opts?.methods || [{ value: "HAND_TO_ME", label: "Hand it to me" }, { value: "MEET_OUTSIDE", label: "Meet outside" }, { value: "LEAVE_AT_DOOR", label: "Leave at my door" }])
                    .filter((m) => !(needsAge && m.value === "LEAVE_AT_DOOR"))
                    .map((m) => (
                      <button key={m.value} type="button" role="radio" aria-checked={method === m.value} className={`sf-method ${method === m.value ? "on" : ""}`} onClick={() => setMethod(m.value)} data-testid={`method-${m.value}`}>
                        <b>{m.label}</b>
                        {m.description && <span className="sf-small sf-muted">{m.description}</span>}
                      </button>
                    ))}
                </div>
                {needsAge && (
                  <p className="sf-small sf-muted mt-2 mb-0" data-testid="no-leave-note">
                    <Ri name="id-card-line" /> Your order has age-restricted items, so the driver hands it to you and checks your ID. Leaving it at the door is not available.
                  </p>
                )}
                {rule?.proof?.summary && <p className="sf-small sf-muted mt-2">{rule.proof.summary}</p>}

                <div className={`sf-switchrow ${leave ? "is-off" : ""}`}>
                  <label className="sf-switch">
                    <input type="checkbox" role="switch" checked={leave ? false : usePin} disabled={leave} onChange={(e) => setUsePin(e.target.checked)} data-testid="pin-switch" />
                    <span className="sf-switch-ui" />
                    <span>
                      <b>Use a private delivery PIN</b>
                      <span className="sf-small sf-muted d-block">
                        {leave ? "Leave-at-door orders never use a PIN: the driver takes a photo of the order at your door instead." : usePin ? opts?.pinChoice?.on || "You get a private 4-digit PIN and tell it to the driver when you receive the order." : opts?.pinChoice?.off || "No PIN. The driver must take a photo of your order at the delivery location and upload it as proof."}
                      </span>
                    </span>
                  </label>
                </div>

                <div className="sf-field mt-3">
                  <label className="sf-label" htmlFor="co-driver">Note for your driver (optional)</label>
                  <textarea id="co-driver" className="sf-input" rows={2} maxLength={300} value={driverNote} onChange={(e) => setDriverNote(e.target.value)} placeholder="Unit 5, use the side door..." data-testid="driver-note" />
                  <div className="sf-chips-sm">
                    {(opts?.suggestedInstructions || []).slice(0, 6).map((s) => (
                      <button key={s} type="button" className="sf-chip sf-chip-sm" onClick={() => setDriverNote((cur) => (cur ? `${cur}. ${s}` : s).slice(0, 300))}>
                        {s}
                      </button>
                    ))}
                  </div>
                  <div className="sf-small sf-muted text-end">{driverNote.length}/300</div>
                </div>
                <div className="sf-field">
                  <label className="sf-label" htmlFor="co-code">Gate / buzzer code (optional)</label>
                  <input id="co-code" className={`sf-input ${codeBad ? "has-error" : ""}`} value={accessCode} onChange={(e) => setAccessCode(e.target.value)} maxLength={40} autoComplete="off" data-testid="access-code" />
                  <div className="sf-small sf-muted">Stored encrypted. Only your driver sees it, only after pickup.</div>
                  {codeBad && <div className="sf-error">Letters, digits, space and # * - _ . / only.</div>}
                </div>
              </Section>
            </>
          )}

          <Section n={delivery ? 5 : 3} title={rest.retail ? "Note for the store" : "Note for the restaurant"} hint={rest.retail ? "Anything the person picking your order should know." : "Allergies, preferences, anything the kitchen should know."}>
            <textarea className="sf-input" rows={3} maxLength={1000} value={kitchenNote} onChange={(e) => setKitchenNote(e.target.value)} aria-label={rest.retail ? "Note for the store" : "Note for the restaurant"} data-testid="kitchen-note" />
            <div className="sf-small sf-muted text-end">{kitchenNote.length}/1000</div>
          </Section>

          {delivery && (
            <Section n={6} title="Tip your driver">
              <div className="sf-chips-sm" role="radiogroup" aria-label="Tip">
                {TIP_PRESETS.map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={tipPct === p} className={`sf-chip ${tipPct === p ? "on" : ""}`} onClick={() => setTipPct(p)}>
                    {p === 0 ? "No tip" : `${p}% - ${money(subtotal * (p / 100))}`}
                  </button>
                ))}
                <button type="button" role="radio" aria-checked={tipPct === "custom"} className={`sf-chip ${tipPct === "custom" ? "on" : ""}`} onClick={() => setTipPct("custom")}>
                  Other
                </button>
              </div>
              {tipPct === "custom" && (
                <div className="sf-field mt-2" style={{ maxWidth: 180 }}>
                  <label className="sf-label" htmlFor="co-tip">Tip amount ($)</label>
                  <input id="co-tip" className="sf-input" inputMode="decimal" value={tipCustom} onChange={(e) => setTipCustom(e.target.value.replace(/[^0-9.]/g, ""))} />
                </div>
              )}
            </Section>
          )}

          <Section n={delivery ? 7 : 4} title="Promo code and wallet">
            <div className="sf-inline">
              <input className="sf-input" value={promoText} onChange={(e) => setPromoText(e.target.value.toUpperCase())} placeholder="Promo code" maxLength={40} aria-label="Promo code" data-testid="promo-input" />
              <button type="button" className="sf-btn sf-btn-light" onClick={applyPromo} disabled={cartBusy} data-testid="promo-apply">
                {promoText.trim() ? "Apply" : cart.promoCode ? "Remove" : "Apply"}
              </button>
            </div>
            {promoMsg && <p className={`sf-small mt-1 mb-0 ${promoMsg.tone === "danger" ? "sf-danger" : "sf-muted"}`}>{promoMsg.text}</p>}
            {q?.promotion && <p className="sf-small sf-ok mt-1 mb-0">Applied: {q.promotion.name || q.promotion.code || "promotion"}</p>}
            {wallet > 0 && (
              <label className="sf-check mt-3">
                <input type="checkbox" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} data-testid="wallet-toggle" /> Use my FORKSY wallet credit ({money(wallet)} available)
              </label>
            )}
          </Section>

          <Section n={delivery ? 8 : 5} title="Payment">
            <PaymentSection ref={payRef} quoteBody={quoteBody} quoteReady={!!quote && !quoting && !quoteErr && blockers.length === 0} cardAmount={cardAmount} onState={onPayState} />
          </Section>
        </div>

        <aside className="sf-co-side">
          <div className="sf-card sf-pad sf-sticky">
            <h2 className="sf-h3">Order summary</h2>
            {quoting && !q && <Loading text="Calculating..." />}
            {q && (
              <dl className="sf-totals" data-testid="totals">
                <div><dt>Subtotal</dt><dd>{money(q.subtotal)}</dd></div>
                {delivery && <div><dt>Delivery fee</dt><dd>{money(q.deliveryFee)}</dd></div>}
                {q.serviceFee > 0 && <div><dt>Service fee</dt><dd>{money(q.serviceFee)}</dd></div>}
                {q.smallOrderFee > 0 && <div><dt>Small order fee</dt><dd>{money(q.smallOrderFee)}</dd></div>}
                <div><dt>Tax (HST)</dt><dd>{money(q.taxAmount)}</dd></div>
                {delivery && <div><dt>Tip</dt><dd>{money(q.tip)}</dd></div>}
                {q.discountTotal > 0 && <div className="sf-ok"><dt>Discount</dt><dd>-{money(q.discountTotal)}</dd></div>}
                {q.walletUsed > 0 && <div className="sf-ok"><dt>Wallet credit</dt><dd>-{money(q.walletUsed)}</dd></div>}
                <div className="sf-total"><dt>Total</dt><dd data-testid="total">{money(q.total)}</dd></div>
              </dl>
            )}
            {q?.etaMinutes != null && <p className="sf-small sf-muted">{delivery ? "Estimated delivery" : "Ready for pickup in about"} {q.etaMinutes} min</p>}
            {q?.basket?.lines > 0 && rest.retail && (
              <p className="sf-small sf-muted" data-testid="basket-summary">
                <Ri name="shopping-basket-2-line" /> {basketText(q.basket)}
                {q.basket.chilled + q.basket.frozen > 0 ? ". Includes chilled or frozen items, kept cold for you." : ""}
              </p>
            )}
            {(q?.warnings || []).map((w, i) => (
              <Notice key={i} tone="warn">{typeof w === "string" ? w : w.message}</Notice>
            ))}
            {needsAge && (
              <label className="sf-check sf-agebox mt-2">
                <input type="checkbox" checked={ageOk} onChange={(e) => setAgeOk(e.target.checked)} aria-required="true" data-testid="age-confirm" />
                <span>I am at least {minAge} years old and I will show ID {delivery ? "on delivery" : "when I collect it"}</span>
              </label>
            )}
            {blockers.map((b, i) => (
              <Notice key={i} tone="warn" className="mt-2">{b}</Notice>
            ))}
            {placeErr && <ErrorBox message={placeErr} />}
            <button type="button" className="sf-btn sf-btn-primary sf-btn-block sf-btn-lg mt-2" disabled={!canPlace} onClick={place} data-testid="place-order">
              {placing ? <Spinner size={18} /> : null} {placing ? "Processing payment..." : cardAmount > 0.009 && payState.provider === "stripe" ? `Pay ${money(cardAmount)} and place order` : `Place order${q ? ` - ${money(q.total)}` : ""}`}
            </button>
            <p className="sf-small sf-muted mt-2 mb-0">
              {payState.provider === "mock" ? "Test payment only. " : ""}
              {cardAmount > 0.009 && payState.provider === "stripe" ? `Your card is charged when you place the order. If the ${rest.retail ? "store" : "restaurant"} cannot take it, the full amount is refunded. ` : ""}
              You can follow your order live after you place it.
            </p>
          </div>
        </aside>
      </div>

      <AddressDialog
        open={addrOpen}
        onClose={() => setAddrOpen(false)}
        onSaved={(a) => {
          setAddresses((cur) => [...(cur || []), a]);
          selectAddress(a);
          toast("Address saved", "success");
        }}
      />
    </div>
  );
}
