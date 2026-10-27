import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import PushBanner from "../components/PushBanner";
import { ErrorBox, Loading, Notice, Ri, Spinner, Stars, useSfConfirm, useToast } from "../components/ui";
import { fmtDateTime, fmtTime } from "../lib/fmt";
import { basketText, isWeighed, statusWords, unitOf, weightText } from "../lib/retail";
import { errorMessage, errorStatus, money, sfHttp } from "../lib/sfApi";
import { useSfAuth } from "../lib/SfAuth";
import { sfRealtime } from "../lib/sfRealtime";

const FINAL = ["DELIVERED", "COLLECTED", "CANCELLED", "REJECTED"];
/** order room events that mean "something changed": the page re-reads the tracking right away */
const LIVE_EVENTS = ["order.status", "order.driver_arrived", "order.eta", "order.released", "order.driver_assigned", "order.driver_unassigned", "order.item_removed", "order.item_picked"];
const POLL_MS = 5000;
const POLL_LIVE_MS = 30000;
const DELIVERY_STEPS = [
  { key: "PLACED", label: "Order placed", auto: "We sent it to the restaurant" },
  { key: "ACCEPTED", label: "Restaurant accepted", auto: "Accepted automatically" },
  { key: "PREPARING", label: "Preparing your food", auto: "The kitchen has started" },
  { key: "READY", label: "Ready", auto: "Your order is packed" },
  { key: "DRIVER_ASSIGNED", label: "Driver assigned", auto: "A driver is on the way to the restaurant" },
  { key: "PICKED_UP", label: "Picked up", auto: "Your driver has your order" },
  { key: "ON_THE_WAY", label: "On the way", auto: "Heading to you" },
  { key: "DELIVERED", label: "Delivered", auto: "Enjoy your meal" },
];
const PICKUP_STEPS = [
  { key: "PLACED", label: "Order placed", auto: "We sent it to the restaurant" },
  { key: "ACCEPTED", label: "Restaurant accepted", auto: "Accepted automatically" },
  { key: "PREPARING", label: "Preparing your food", auto: "The kitchen has started" },
  { key: "READY", label: "Ready for pickup", auto: "Come and get it" },
  { key: "COLLECTED", label: "Collected", auto: "Enjoy your meal" },
];

/** What the steps say for a grocery order (the same states, other words: the store picks and packs instead of cooking). */
const RETAIL_STEP_WORDS = {
  PLACED: { label: "Order placed", auto: "We sent it to the store" },
  ACCEPTED: { label: "Order confirmed", auto: "The store confirmed your order" },
  PREPARING: { label: "Picking your items", auto: "The store is picking your order" },
  READY: { label: "Packed and ready" },
  DRIVER_ASSIGNED: { auto: "A driver is on the way to the store" },
  DELIVERED: { auto: "Enjoy" },
  COLLECTED: { auto: "Enjoy" },
};

const RANK = { PLACED: 0, ACCEPTED: 1, PREPARING: 2, READY: 3, PICKED_UP: 5, ON_THE_WAY: 6, DELIVERED: 7, COLLECTED: 7 };

/** Step list with done / current flags, from the status, the timeline (every transition is an event) and the driver. */
export function stepStates(t) {
  const steps = (t.fulfilment === "PICKUP" ? PICKUP_STEPS : DELIVERY_STEPS).map((s) => (t.retail && RETAIL_STEP_WORDS[s.key] ? { ...s, ...RETAIL_STEP_WORDS[s.key] } : s));
  const seen = new Set((t.timeline || []).map((e) => e.toStatus).filter(Boolean));
  seen.add(t.status);
  if (t.driver) seen.add("DRIVER_ASSIGNED");
  const maxRank = Math.max(-1, ...[...seen].map((k) => (RANK[k] !== undefined ? RANK[k] : -1)));
  const times = {};
  (t.timeline || []).forEach((e) => {
    if (e.toStatus && !times[e.toStatus]) times[e.toStatus] = e.createdAt;
  });
  const final = FINAL.includes(t.status);
  return steps.map((s) => {
    const rank = s.key === "DRIVER_ASSIGNED" ? 4 : RANK[s.key];
    const implied = s.key === "DRIVER_ASSIGNED" ? maxRank >= 5 : maxRank > rank;
    const done = seen.has(s.key) || implied;
    return { ...s, done, current: s.key === t.status && !final, at: times[s.key] || null };
  });
}

function ProofPhoto({ orderId, url }) {
  const [src, setSrc] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    let revoked = false;
    let obj = "";
    sfHttp
      .blob(`/orders/${orderId}/proof/photo`)
      .then((b) => {
        if (revoked) return;
        obj = URL.createObjectURL(b);
        setSrc(obj);
      })
      .catch((e) => !revoked && setErr(errorStatus(e) === 410 ? "The photo was deleted after the retention period." : "The photo could not be loaded."));
    return () => {
      revoked = true;
      if (obj) URL.revokeObjectURL(obj);
    };
  }, [orderId, url]);
  if (err) return <p className="sf-small sf-muted">{err}</p>;
  if (!src) return <Spinner />;
  return <img src={src} alt="Your order at the delivery location, as taken by the driver" className="sf-proof" data-testid="proof-photo" />;
}

function ReviewBox({ orderId }) {
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [tags, setTags] = useState(null);
  const [rr, setRr] = useState(0);
  const [dr, setDr] = useState(0);
  const [rt, setRt] = useState([]);
  const [dt, setDt] = useState([]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    sfHttp.get(`/customer/orders/${orderId}/review`).then(setInfo).catch(() => setInfo(null));
    sfHttp.get("/public/rating-options", undefined, { noAuth: true }).then(setTags).catch(() => setTags(null));
  }, [orderId]);

  if (!info || (!info.canReview && !info.review)) return null;
  if (info.review || sent) {
    return (
      <div className="sf-card sf-pad mt-3" data-testid="review-done">
        <h2 className="sf-h3">Thanks for rating your order</h2>
        <Stars value={info.review?.restaurantRating || rr} size={22} label="Your rating" />
      </div>
    );
  }
  const flip = (list, set, code) => set(list.includes(code) ? list.filter((c) => c !== code) : [...list, code].slice(0, 6));
  const tagSet = (side, stars) => (stars ? (stars >= 4 ? tags?.[side]?.positive : tags?.[side]?.negative) || [] : []);
  const submit = async () => {
    if (!rr && !(info.rateDriver && dr)) return setError("Choose a star rating first.");
    setBusy(true);
    setError("");
    try {
      await sfHttp.post(`/customer/orders/${orderId}/review`, {
        restaurantRating: rr || undefined,
        driverRating: info.rateDriver && dr ? dr : undefined,
        restaurantTags: rt.length ? rt : undefined,
        driverTags: info.rateDriver && dt.length ? dt : undefined,
        comment: comment.trim() || undefined,
      });
      setSent(true);
      toast("Thanks for your feedback", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sf-card sf-pad mt-3" data-testid="review-box">
      <h2 className="sf-h3">How was your order?</h2>
      <p className="sf-small sf-muted mb-1">{info.order?.restaurant?.name}</p>
      <Stars value={rr} onChange={setRr} label="Restaurant rating" />
      <div className="sf-chips-sm mt-2">
        {tagSet("restaurant", rr).map((t) => (
          <button key={t.code} type="button" className={`sf-chip sf-chip-sm ${rt.includes(t.code) ? "on" : ""}`} aria-pressed={rt.includes(t.code)} onClick={() => flip(rt, setRt, t.code)}>
            {t.label}
          </button>
        ))}
      </div>
      {info.rateDriver && (
        <>
          <p className="sf-small sf-muted mb-1 mt-3">Your driver{info.order?.driver?.firstName ? ` ${info.order.driver.firstName}` : ""}</p>
          <Stars value={dr} onChange={setDr} label="Driver rating" />
          <div className="sf-chips-sm mt-2">
            {tagSet("driver", dr).map((t) => (
              <button key={t.code} type="button" className={`sf-chip sf-chip-sm ${dt.includes(t.code) ? "on" : ""}`} aria-pressed={dt.includes(t.code)} onClick={() => flip(dt, setDt, t.code)}>
                {t.label}
              </button>
            ))}
          </div>
        </>
      )}
      <textarea className="sf-input mt-3" rows={2} maxLength={500} placeholder="Add a comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
      {error && <Notice tone="danger" className="mt-2">{error}</Notice>}
      <button type="button" className="sf-btn sf-btn-primary mt-2" onClick={submit} disabled={busy} data-testid="review-submit">
        {busy ? <Spinner size={16} /> : null} Send rating
      </button>
    </div>
  );
}

/** Cancel button with a live countdown of the grace window (the server enforces it). */
function CancelBox({ until, onCancel, cancelling }) {
  const [asking, setAsking] = useState(false);
  const left = () => (until ? Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000)) : null);
  const [secs, setSecs] = useState(left);
  useEffect(() => {
    setSecs(left());
    const timer = setInterval(() => setSecs(left()), 1000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  return (
    <>
      {!asking ? (
        <button type="button" className="sf-btn sf-btn-danger-outline sf-btn-block" onClick={() => setAsking(true)} disabled={cancelling || secs === 0} data-testid="cancel-order">
          {cancelling ? <Spinner size={16} /> : null} Cancel order{secs != null ? ` (${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} left)` : ""}
        </button>
      ) : (
        <div data-testid="cancel-choice">
          <p className="sf-small mb-2"><b>Where should your refund go?</b></p>
          <button type="button" className="sf-btn sf-btn-danger-outline sf-btn-block mb-2" onClick={() => onCancel("ORIGINAL_PAYMENT")} disabled={cancelling || secs === 0} data-testid="cancel-refund-card">Cancel and refund to my card</button>
          <button type="button" className="sf-btn sf-btn-danger-outline sf-btn-block mb-2" onClick={() => onCancel("WALLET")} disabled={cancelling || secs === 0} data-testid="cancel-refund-wallet">Cancel and refund to my Forky wallet</button>
          <button type="button" className="sf-btn sf-btn-light sf-btn-block" onClick={() => setAsking(false)}>Keep order</button>
        </div>
      )}
      <p className="sf-small sf-muted mt-2">Your order is held by FORKSY for a moment and is sent to the restaurant when the countdown ends. Until then you can cancel for free. After that it can no longer be cancelled here - please contact support.</p>
    </>
  );
}

const PICK_TAG = { PICKED: ["ok", "Found"], REPLACED: ["warn", "Replaced"], PENDING: ["", "To pick"], OUT_OF_STOCK: ["danger", "Out of stock"] };

/** Grocery orders: how far the store is with picking, each product with what happened to it, and what was taken out and refunded. */
function PickingPanel({ t }) {
  const p = t.picking;
  const items = (t.items || []).filter((i) => !i.removed);
  const removed = t.removedItems || (t.items || []).filter((i) => i.removed).map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, reason: i.removedReason, pickStatus: i.pickStatus, refunded: Number(i.adjustmentRefund || 0) }));
  const done = p.picked + p.replaced + p.outOfStock;
  return (
    <div className="sf-card sf-pad mt-3" data-testid="picking-panel">
      <h2 className="sf-h3">Picking</h2>
      <div className="sf-pickbar" role="progressbar" aria-label="Items picked" aria-valuemin={0} aria-valuemax={p.lines} aria-valuenow={done}>
        <span style={{ width: `${p.lines ? Math.round((done / p.lines) * 100) : 0}%` }} />
      </div>
      <p className="sf-small sf-muted mb-2" data-testid="picking-progress">
        {done} of {p.lines} {p.lines === 1 ? "product" : "products"} done
      </p>
      <dl className="sf-pickcounts" data-testid="picking-counts">
        <div data-k="picked"><dt>Found</dt><dd>{p.picked}</dd></div>
        <div data-k="replaced"><dt>Replaced</dt><dd>{p.replaced}</dd></div>
        <div data-k="outOfStock"><dt>Out of stock</dt><dd>{p.outOfStock}</dd></div>
        <div data-k="pending"><dt>Still to pick</dt><dd>{p.pending}</dd></div>
      </dl>
      <ul className="sf-cartlines mt-2" data-testid="picking-items">
        {items.map((i) => {
          const [tone, text] = PICK_TAG[i.pickStatus] || PICK_TAG.PENDING;
          const weighed = isWeighed(i);
          return (
            <li key={i.id} data-pick={i.pickStatus}>
              <div className="sf-cartline-main">
                <div className="sf-cartline-name">
                  {weighed ? `${weightText(i, i.quantity)} ` : `${i.quantity} x `}
                  {i.name} <span className={`sf-tag ${tone ? `sf-tag-${tone}` : ""} ms-1`}>{text}</span>
                </div>
                {i.pickStatus === "REPLACED" && i.replacement && (
                  <div className="sf-small" data-testid="replaced-with">
                    Replaced with <b>{i.replacement.name}</b>
                    {i.replacement.packSize ? ` (${i.replacement.packSize})` : ""}. You pay the lower of the two prices.
                  </div>
                )}
                {weighed && (
                  <div className="sf-small sf-muted" data-testid="weighed">
                    {i.actualWeight != null ? `Weighed: ${+Number(i.actualWeight).toFixed(3)} ${unitOf(i)}` : `About ${weightText(i, i.quantity)}, weighed when it is picked`}
                  </div>
                )}
                {Number(i.adjustmentRefund) > 0 && <div className="sf-small sf-ok">{money(i.adjustmentRefund)} refunded to you</div>}
                {i.substitution === "REFUND" && i.pickStatus === "PENDING" && <div className="sf-small sf-muted">If it is not available: refund</div>}
              </div>
              <b>{money(i.lineTotal)}</b>
            </li>
          );
        })}
      </ul>
      {removed.length > 0 && (
        <div className="mt-3" data-testid="removed-items">
          <h3 className="sf-h3">Not in your order</h3>
          <ul className="sf-cartlines">
            {removed.map((r) => {
              const tag = r.pickStatus === "OUT_OF_STOCK" ? "Out of stock" : "Removed";
              return (
                <li key={r.id} className="sf-bad">
                  <div className="sf-cartline-main">
                    <div className="sf-cartline-name">
                      {r.quantity} x {r.name} <span className="sf-tag sf-tag-danger ms-1">{tag}</span>
                    </div>
                    {r.reason && r.reason.trim().toLowerCase() !== tag.toLowerCase() && <div className="sf-small sf-muted">{r.reason}</div>}
                  </div>
                  {Number(r.refunded) > 0 ? <b className="sf-ok">{money(r.refunded)} refunded</b> : <span className="sf-small sf-muted">Refund on its way</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** "Age-restricted items: ID will be checked at your door" and what came of the check. */
function IdCheckNotice({ idCheck, pickup }) {
  if (!idCheck?.required) return null;
  const age = idCheck.minAge || 19;
  if (idCheck.result === "CHECKED") return <Notice tone="success" icon="id-card-line"><span data-testid="id-check">Age-restricted items: ID was checked ({age}+).</span></Notice>;
  if (idCheck.result === "REFUSED") return <Notice tone="warn" icon="id-card-line"><span data-testid="id-check">Age-restricted items: ID was not shown, so they were not handed over and are refunded.</span></Notice>;
  return (
    <Notice tone="info" icon="id-card-line">
      <span data-testid="id-check">Age-restricted items: ID will be checked at {pickup ? "the counter" : "your door"} ({age}+).</span>
    </Notice>
  );
}

export default function Track() {
  const { id } = useParams();
  const { user, loading: authLoading } = useSfAuth();
  const confirm = useSfConfirm();
  const toast = useToast();
  const [t, setT] = useState(null);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [updated, setUpdated] = useState(null);
  const [live, setLive] = useState(false);
  const timer = useRef(null);
  const finalSeen = useRef(0);

  const load = useCallback(async () => {
    try {
      const data = await sfHttp.get(`/orders/${id}/tracking`);
      setT(data);
      setError(null);
      setUpdated(new Date());
      return data;
    } catch (e) {
      setError({ status: errorStatus(e), message: errorMessage(e) });
      return null;
    }
  }, [id]);

  // Polling is the fallback and always runs: every 5 s (once the order is final a slow refresh: the proof photo / refunds can still appear).
  // While the realtime socket is connected the order room tells us when something changed (re-read at once) and polling relaxes to 30 s.
  useEffect(() => {
    if (!user) return undefined;
    let stop = false;
    let gen = 0;
    let connected = false;
    const loop = async () => {
      const my = ++gen;
      clearTimeout(timer.current);
      const data = await load();
      if (stop || my !== gen) return; // a newer loop (event / reconnect) took over
      const done = data && FINAL.includes(data.status);
      if (done) finalSeen.current += 1;
      // the store picks a grocery order line by line and the order room does not announce each pick: keep reading often until everything is picked
      const picking = !done && !!data?.retail && (data?.picking?.pending || 0) > 0;
      timer.current = setTimeout(loop, done ? (finalSeen.current > 3 ? 60000 : 15000) : connected && !picking ? POLL_LIVE_MS : POLL_MS);
    };
    loop();

    const sock = sfRealtime.get();
    const join = () => {
      connected = true;
      setLive(true);
      sock.emit("order.subscribe", { orderId: id });
      loop(); // catch up on anything missed while disconnected
    };
    const leave = () => {
      connected = false;
      setLive(false);
      loop(); // back to the 5 s fallback at once
    };
    let debounce = null;
    const changed = (p) => {
      if (!p || p.orderId !== id) return;
      clearTimeout(debounce); // a status change and a new ETA usually arrive together
      debounce = setTimeout(loop, 150);
    };
    if (sock) {
      sock.on("connect", join);
      sock.on("disconnect", leave);
      LIVE_EVENTS.forEach((e) => sock.on(e, changed));
      if (sock.connected) {
        connected = true;
        setLive(true);
        sock.emit("order.subscribe", { orderId: id });
      }
    }
    return () => {
      stop = true;
      clearTimeout(timer.current);
      clearTimeout(debounce);
      if (sock) {
        sock.off("connect", join);
        sock.off("disconnect", leave);
        LIVE_EVENTS.forEach((e) => sock.off(e, changed));
        if (sock.connected) sock.emit("order.unsubscribe", { orderId: id });
      }
      setLive(false);
    };
  }, [user, load, id]);

  if (authLoading) return <div className="sf-container"><Loading /></div>;
  if (!user) return <Navigate to={`/order/login?next=${encodeURIComponent(`/order/track/${id}`)}`} replace />;
  if (!t && !error) return <div className="sf-container"><Loading text="Loading your order..." /></div>;
  if (!t && error) {
    return (
      <div className="sf-container sf-narrow">
        {error.status === 404 || error.status === 403 ? (
          <div className="sf-center py-5">
            <Ri name="file-search-line" className="sf-bigicon" />
            <h1 className="sf-h2 mt-2">We could not find that order</h1>
            <Link to="/order/orders" className="sf-btn sf-btn-primary">My orders</Link>
          </div>
        ) : (
          <ErrorBox message={error.message} onRetry={load} />
        )}
      </div>
    );
  }

  const pickup = t.fulfilment === "PICKUP";
  const steps = stepStates(t);
  const cancelled = t.status === "CANCELLED" || t.status === "REJECTED";
  const delivered = t.status === "DELIVERED" || t.status === "COLLECTED";
  const active = !FINAL.includes(t.status);
  const showPicking = !!t.retail && !!t.picking && !cancelled;
  // the API decides: a short grace period after placing, whatever the kitchen automation has done meanwhile
  const canCancel = t.canCancel === true;
  const dropoff = t.dropoff || {};
  const cancelOrder = async (refundTo) => {
    const toWallet = refundTo === "WALLET";
    if (!(await confirm({ title: "Cancel this order?", message: `You are still inside the cancellation window. Your payment is refunded in full ${toWallet ? "to your Forky wallet, ready to use on your next order" : "to the card you paid with"}.`, confirmText: "Cancel order", cancelText: "Keep order", danger: true }))) return;
    setCancelling(true);
    try {
      await sfHttp.post(`/customer/orders/${id}/cancel`, { reason: "Cancelled by customer on the website", refundTo });
      toast("Order cancelled", "success");
      await load();
    } catch (e) {
      toast(errorMessage(e), "danger");
      await load();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="sf-container sf-narrow" data-testid="track-page">
      <p className="sf-small mb-1">
        <Link to="/order/orders">&larr; My orders</Link>
      </p>
      <div className="sf-row-between">
        <h1 className="sf-h1 mb-0">Order {t.code}</h1>
        <span className={`sf-tag sf-tag-${cancelled ? "danger" : delivered ? "ok" : "warn"}`} data-testid="order-status">
          {statusWords(t)}
        </span>
      </div>
      <p className="sf-muted">
        {t.restaurant?.name}
        {t.restaurant?.address ? ` - ${t.restaurant.address}` : ""}
      </p>

      {active && <PushBanner />}

      {cancelled && (
        <Notice tone="danger">This order was {t.status === "REJECTED" ? `declined by the ${t.retail ? "store" : "restaurant"}` : "cancelled"}. Your payment is refunded to your card automatically; it can take 5-10 business days to show on your statement.</Notice>
      )}
      {active && !cancelled && (
        <div className="sf-eta">
          <Ri name="time-line" />
          <div>
            {pickup ? (t.estimatedReadyAt ? <>Ready for pickup around <b>{fmtTime(t.estimatedReadyAt)}</b></> : "Preparing your order") : t.estimatedDeliveryAt ? <>Estimated delivery <b data-testid="eta">{fmtTime(t.estimatedDeliveryAt)}</b></> : "Estimating..."}
            {t.isLate && <span className="sf-tag sf-tag-warn ms-2">Running late</span>}
          </div>
        </div>
      )}

      {!cancelled && (
        <ol className="sf-stepper" data-testid="stepper" aria-label="Order progress">
          {steps.map((s) => (
            <li key={s.key} className={`${s.done ? "done" : ""} ${s.current ? "current" : ""}`} data-step={s.key} data-done={s.done ? "1" : "0"} aria-current={s.current ? "step" : undefined}>
              <span className="sf-dot">{s.done ? <Ri name="check-line" /> : null}</span>
              <div>
                <b>{s.label}</b>
                <div className="sf-small sf-muted">{s.done ? s.auto : "Waiting"}{s.at ? ` - ${fmtTime(s.at)}` : ""}</div>
              </div>
            </li>
          ))}
        </ol>
      )}

      {!cancelled && <IdCheckNotice idCheck={t.idCheck} pickup={pickup} />}

      {pickup && active && !cancelled && t.pickupCode && (
        <div className="sf-codebox" data-testid="pickup-code">
          <span className="sf-small">Your pickup code</span>
          <b>{t.pickupCode}</b>
          <span className="sf-small">Show this at the counter</span>
        </div>
      )}
      {!pickup && !cancelled && dropoff.method === "LEAVE_AT_DOOR" && !delivered && (
        <Notice tone="info" icon="camera-line">Contactless: your driver leaves the order at your door and takes a photo as proof. No PIN is needed.</Notice>
      )}
      {!pickup && !cancelled && t.deliveryPin && dropoff.usePin !== false && dropoff.method !== "LEAVE_AT_DOOR" && !delivered && (
        <div className="sf-codebox" data-testid="delivery-pin">
          <span className="sf-small">Your delivery PIN</span>
          <b>{t.deliveryPin}</b>
          <span className="sf-small">Tell this PIN to your driver when you receive your order. Do not share it before.</span>
        </div>
      )}
      {!pickup && !cancelled && dropoff.usePin === false && dropoff.method !== "LEAVE_AT_DOOR" && !delivered && (
        <Notice tone="info" icon="shield-check-line">PIN is off: your driver will hand the order to you, or leave it and photograph it as proof.</Notice>
      )}

      {t.driver && !delivered && !cancelled && (
        <div className="sf-card sf-pad mt-3" data-testid="driver-card">
          <h2 className="sf-h3">Your driver</h2>
          <p className="mb-0">
            <Ri name="user-3-line" /> <b>{t.driver.name}</b>
            {t.driver.vehicleType ? ` - ${String(t.driver.vehicleType).toLowerCase()}` : ""}
            {t.driver.vehicleColor || t.driver.licensePlate ? ` (${[t.driver.vehicleColor, t.driver.licensePlate].filter(Boolean).join(", ")})` : ""}
          </p>
        </div>
      )}

      {delivered && t.deliveryProof && (
        <div className="sf-card sf-pad mt-3" data-testid="proof">
          <h2 className="sf-h3">Proof of delivery</h2>
          <p className="sf-small sf-muted">
            {t.deliveryProof.proofType === "PIN" ? "Delivered with your PIN." : t.deliveryProof.proofType === "HANDED_OVER" ? "Handed to you by the driver." : "The driver photographed your order at the delivery location."}
            {t.deliveryProof.deliveredAt ? ` Delivered ${fmtDateTime(t.deliveryProof.deliveredAt)}.` : ""}
          </p>
          {t.deliveryProof.photoUrl && <ProofPhoto orderId={id} url={t.deliveryProof.photoUrl} />}
        </div>
      )}

      {delivered && <ReviewBox orderId={id} />}

      {showPicking && <PickingPanel t={t} />}

      <div className="sf-card sf-pad mt-3">
        <h2 className="sf-h3">{showPicking ? "Order total" : "Your items"}</h2>
        {!showPicking && (
          <ul className="sf-cartlines">
            {(t.items || []).map((i) => (
              <li key={i.id} className={i.removed ? "sf-bad" : ""}>
                <div className="sf-cartline-main">
                  <div className="sf-cartline-name">
                    {isWeighed(i) ? `${weightText(i, i.quantity)} ` : `${i.quantity} x `}
                    {i.name} {i.removed && <span className="sf-tag sf-tag-danger ms-1">Removed</span>}
                  </div>
                  {(i.modifiers || []).length > 0 && <div className="sf-small sf-muted">{i.modifiers.map((m) => m.name || m.optionName).filter(Boolean).join(", ")}</div>}
                </div>
                <b>{money(i.lineTotal)}</b>
              </li>
            ))}
          </ul>
        )}
        {t.retail && t.basket?.lines > 0 && <p className="sf-small sf-muted mb-1">{basketText(t.basket)}</p>}
        <div className="sf-row-between mt-2">
          <span>Total (incl. tax and fees)</span>
          <b>{money(t.total)}</b>
        </div>
        {t.kitchenNotes && <p className="sf-small sf-muted mt-2 mb-0">Your note: {t.kitchenNotes}</p>}
        {!pickup && t.deliveryAddress && (
          <p className="sf-small sf-muted mt-1 mb-0">
            Delivering to {t.deliveryAddress.line1}, {t.deliveryAddress.city}
          </p>
        )}
      </div>

      {active && (
        <div className="mt-3">
          {canCancel ? (
            <CancelBox until={t.cancelUntil} onCancel={cancelOrder} cancelling={cancelling} />
          ) : (
            <p className="sf-small sf-muted">The cancellation window for this order has closed. Need help? Contact FORKSY support.</p>
          )}
        </div>
      )}
      <p className="sf-small sf-muted mt-3">
        {active ? <><Spinner size={10} /> {live ? "Live: updates appear as they happen." : "Live: updates every 5 seconds."}</> : null} {updated ? `Last updated ${fmtTime(updated.toISOString())}.` : ""}
      </p>
    </div>
  );
}
