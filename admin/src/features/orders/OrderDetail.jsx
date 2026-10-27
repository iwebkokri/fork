import React, { useState } from "react";
import { useParams } from "react-router-dom";
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorState, FormModal, KeyValue, Loading, MapView, MoneyInput, PageHeader, Select, StatusBadge, Tabs, TextArea, TextInput, Timeline,
} from "../../ui";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { ORDER_STATUSES, fmtDateTime, fmtTime, money, timeAgo, titleCase } from "../../lib/format";
import { DeliveryProofTab } from "./DeliveryProof";

const REASONS = [
  ["MISSING_ITEM", "Missing item"], ["WRONG_ITEM", "Wrong item"], ["NEVER_ARRIVED", "Order never arrived"], ["LATE", "Very late delivery"], ["QUALITY", "Food quality"],
  ["RESTAURANT_CANCELLED", "Restaurant cancelled after accept"], ["PAYMENT_ISSUE", "Payment issue"], ["GOODWILL", "Goodwill gesture"], ["DUPLICATE", "Duplicate order"],
].map(([value, label]) => ({ value, label }));
const CHARGED = [{ value: "PLATFORM", label: "Platform" }, { value: "RESTAURANT", label: "Restaurant" }, { value: "DRIVER", label: "Driver" }];

function MoneyRow({ label, value, strong, muted, neg }) {
  return (
    <div className={`d-flex justify-content-between py-6 ${strong ? "fw-bold border-top mt-8 pt-12" : ""} ${muted ? "text-secondary-light text-sm" : ""}`}>
      <span>{label}</span>
      <span>{neg ? `-${money(value)}` : money(value)}</span>
    </div>
  );
}

function ForceStatusModal({ order, onClose, onDone }) {
  const f = useForm({ status: "", reason: "" });
  const { busy, run } = useSubmit();
  const submit = () => run(() => http.patch(`/admin/orders/${order.id}/status`, f.values), { success: "Status updated", onDone: () => { onClose(); onDone(); } });
  return (
    <FormModal open onClose={onClose} title="Force order status" onSubmit={submit} busy={busy} submitText="Update status" disabled={!f.values.status}>
      <p className="text-secondary-light text-sm">Current status: <StatusBadge status={order.status} />. Forcing bypasses the normal state machine and is audited.</p>
      <Select label="New status" required options={ORDER_STATUSES.filter((s) => s !== order.status).map((s) => ({ value: s, label: titleCase(s) }))} {...f.bind("status")} />
      <TextArea label="Reason" rows={2} {...f.bind("reason")} />
    </FormModal>
  );
}

const BEFORE_PICKUP = ["PLACED", "ACCEPTED", "PREPARING", "READY", "DRIVER_ASSIGNED"];
const APPROVAL_CHANNELS = [
  { value: "PHONE", label: "Phone call" },
  { value: "CHAT", label: "Chat / message" },
  { value: "EMAIL", label: "Email" },
  { value: "IN_PERSON", label: "In person" },
];

/**
 * Cancelling: free while FORKSY still holds the order (customer's cancellation window). Once the restaurant has the order, FORKSY can only cancel
 * with the restaurant's approval: either the restaurant answers a request in its portal, or staff record who approved it by phone / chat.
 */
function CancelModal({ order, onClose, onDone }) {
  const needsApproval = !!order.kitchenReleaseAt && !!order.kitchenReleasedAt && BEFORE_PICKUP.includes(order.status);
  const req = order.meta?.cancelRequest;
  const approved = req?.status === "APPROVED";
  const f = useForm({ reason: req?.reason || "", contactName: "", channel: "PHONE", note: "" });
  const [mode, setMode] = useState(approved ? "cancel" : "request");
  const { busy, run } = useSubmit();
  const v = f.values;
  const done = (msg) => ({ success: msg, onDone: () => { onClose(); onDone(); } });
  const submit = () => {
    if (!needsApproval || mode === "cancel") return run(() => http.post(`/admin/orders/${order.id}/cancel`, { reason: v.reason }), done("Order cancelled"));
    if (mode === "record") return run(() => http.post(`/admin/orders/${order.id}/cancel`, { reason: v.reason, restaurantApproval: { contactName: v.contactName.trim(), channel: v.channel, note: v.note || undefined } }), done("Order cancelled"));
    return run(() => http.post(`/admin/orders/${order.id}/cancel-request`, { reason: v.reason }), done("Request sent to the restaurant"));
  };
  const waiting = needsApproval && mode === "request" && req?.status === "PENDING";
  const ready = String(v.reason).trim().length >= 3 && (mode !== "record" || v.contactName.trim().length >= 2) && !waiting;
  return (
    <FormModal
      open
      onClose={onClose}
      title={`Cancel ${order.code}`}
      onSubmit={submit}
      busy={busy}
      submitText={needsApproval && mode === "request" ? "Send request to the restaurant" : "Cancel order"}
      submitVariant={needsApproval && mode === "request" ? "primary" : "danger"}
      disabled={!ready}
    >
      {!needsApproval ? (
        <div className="alert alert-success radius-8 py-8 text-sm">{order.kitchenReleaseAt && !order.kitchenReleasedAt ? "This order is still held by FORKSY (the customer's cancellation window), so the restaurant has not received it. No approval is needed." : "No restaurant approval is needed for this order."}</div>
      ) : (
        <>
          <div className="alert alert-warning radius-8 py-8 text-sm">The restaurant already has this order, so FORKSY can only cancel it with the <strong>restaurant's approval</strong>.</div>
          {req && (
            <div className={`alert ${req.status === "APPROVED" ? "alert-success" : req.status === "DECLINED" ? "alert-danger" : "alert-info"} radius-8 py-8 text-sm`}>
              Cancellation request: <strong>{titleCase(req.status)}</strong>
              {req.respondedBy?.name ? ` by ${req.respondedBy.name}` : ""}
              {req.note ? ` - "${req.note}"` : ""}
              {req.status === "PENDING" ? " (waiting for the restaurant to answer in its portal)" : ""}
            </div>
          )}
          {!approved && (
            <Select
              label="How do you get the approval?"
              allowEmpty={false}
              value={mode}
              onChange={setMode}
              options={[
                { value: "request", label: "Ask the restaurant to approve (they answer in their portal)" },
                { value: "record", label: "The restaurant already approved (phone / chat) - record it" },
              ]}
            />
          )}
        </>
      )}
      <TextArea label="Reason" required rows={3} hint="Shared with the customer and restaurant." {...f.bind("reason")} />
      {needsApproval && mode === "record" && !approved && (
        <div className="row">
          <TextInput col={6} label="Who at the restaurant approved?" required {...f.bind("contactName")} />
          <Select col={6} label="How" allowEmpty={false} options={APPROVAL_CHANNELS} {...f.bind("channel")} />
          <TextInput label="Note (optional)" {...f.bind("note")} />
        </div>
      )}
    </FormModal>
  );
}

/** Staff waive the driver's wait-time charge: the restaurant is made whole and FORKSY absorbs it; the driver keeps the pay. */
function WaiveWaitModal({ order, onClose, onDone }) {
  const f = useForm({ reason: "" });
  const { busy, run } = useSubmit();
  const submit = () => run(() => http.post(`/admin/orders/${order.id}/wait-fee/waive`, { reason: f.values.reason }), { success: "Wait charge waived", onDone: () => { onClose(); onDone(); } });
  return (
    <FormModal open onClose={onClose} title={`Waive the driver wait charge on ${order.code}`} onSubmit={submit} busy={busy} submitText="Waive charge" disabled={String(f.values.reason).trim().length < 3}>
      <div className="alert alert-info radius-8 py-8 text-sm">The restaurant is credited {money(order.driverWaitFee)} back. The driver keeps the wait-time pay and FORKSY absorbs the cost.</div>
      <TextArea label="Reason" required rows={3} {...f.bind("reason")} />
    </FormModal>
  );
}

function RefundModal({ order, onClose, onDone }) {
  const f = useForm({ amount: order.total, chargedTo: "PLATFORM", refundTo: "ORIGINAL_PAYMENT", reasonCode: "", notes: "" });
  const { busy, run } = useSubmit();
  const v = f.values;
  const submit = () => run(() => http.post(`/admin/orders/${order.id}/refund`, { amount: Number(v.amount), chargedTo: v.chargedTo, refundTo: v.refundTo, reasonCode: v.reasonCode, notes: v.notes || undefined }), { success: "Refund issued", onDone: () => { onClose(); onDone(); } });
  return (
    <FormModal open onClose={onClose} title={`Refund ${order.code}`} onSubmit={submit} busy={busy} submitText="Issue refund" disabled={!(Number(v.amount) > 0) || !v.reasonCode}>
      <MoneyInput label="Amount" required hint={`Order total ${money(order.total)}. Amounts over your refund limit are rejected.`} {...f.bind("amount")} />
      <Select label="Charged to" required allowEmpty={false} options={CHARGED} {...f.bind("chargedTo")} />
      <Select label="Refund to" required allowEmpty={false} hint="The payment method the customer used, or their Forky wallet (they can spend it on any order)." options={[{ value: "ORIGINAL_PAYMENT", label: "Original payment method" }, { value: "WALLET", label: "Forky wallet" }]} {...f.bind("refundTo")} />
      <Select label="Reason" required options={REASONS} {...f.bind("reasonCode")} />
      <TextArea label="Notes" rows={2} {...f.bind("notes")} />
    </FormModal>
  );
}

function ReassignModal({ order, onClose, onDone }) {
  const drivers = useFetch("/admin/drivers", { status: "ACTIVE", limit: 100 });
  const f = useForm({ driverId: "", reason: "" });
  const { busy, run } = useSubmit();
  const opts = (drivers.data?.data || []).filter((d) => d.id !== order.driverId).map((d) => ({ value: d.id, label: `${d.name}${d.isOnline ? (d.onTrip ? " (on trip)" : " (online)") : " (offline)"}` }));
  const submit = () => run(() => http.post(`/admin/orders/${order.id}/reassign-driver`, { driverId: f.values.driverId, reason: f.values.reason || undefined }), { success: "Driver reassigned", onDone: () => { onClose(); onDone(); } });
  return (
    <FormModal open onClose={onClose} title="Reassign driver" onSubmit={submit} busy={busy} submitText="Reassign" disabled={!f.values.driverId}>
      {drivers.error && <ErrorState error={drivers.error} />}
      <Select label="New driver" required placeholder={drivers.loading ? "Loading drivers…" : "Select a driver"} options={opts} {...f.bind("driverId")} />
      <TextArea label="Reason" rows={2} {...f.bind("reason")} />
    </FormModal>
  );
}

/** Buzzer / gate code: never in the page payload. Shown only after an explicit, audit-logged "Reveal" (needs orders:view, only after pickup). */
function AccessCode({ order, tracking }) {
  const [code, setCode] = useState(null);
  const { busy, run } = useSubmit();
  const set = tracking?.dropoff?.accessCodeSet;
  const pickedUp = !!order.pickedUpAt || ["PICKED_UP", "ON_THE_WAY", "DELIVERED"].includes(order.status);
  if (!set) return <span className="text-secondary-light">None{order.accessCodePurgedAt ? " (purged after delivery)" : ""}</span>;
  if (code !== null) return <code>{code || "(empty)"}</code>;
  if (!pickedUp) return <span className="text-secondary-light">Set - available once the driver has picked up</span>;
  return <Button size="sm" variant="light" loading={busy} onClick={() => run(() => http.post(`/admin/orders/${order.id}/access-code/reveal`), { onDone: (r) => setCode(r?.accessCode ?? "") })}>Reveal (audit-logged)</Button>;
}

function Items({ items }) {
  if (!items?.length) return <EmptyState icon="solar:bag-3-outline" title="No line items recorded" />;
  return (
    <div className="table-responsive">
      <table className="table bordered-table sm-table mb-0 align-middle">
        <thead><tr><th>Item</th><th className="text-center">Qty</th><th className="text-end">Unit</th><th className="text-end">Total</th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} style={i.removed ? { opacity: 0.55, textDecoration: "line-through" } : undefined}>
              <td>
                <div className="fw-medium">{i.name}</div>
                {i.modifiers?.length > 0 && <div className="text-secondary-light text-xs">{i.modifiers.map((m) => m.name).join(", ")}</div>}
                {i.notes && <div className="text-secondary-light text-xs">Note: {i.notes}</div>}
                {i.removed && <Badge tone="danger">Removed{i.removedReason ? `: ${i.removedReason}` : ""}</Badge>}
              </td>
              <td className="text-center">{i.quantity}</td>
              <td className="text-end">{money(i.unitPrice)}</td>
              <td className="text-end">{money(i.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Payments({ order }) {
  const { can } = useAuth();
  const allowed = can("finance", "view");
  const ledger = useFetch(allowed ? "/admin/finance/ledger" : null, { orderId: order.id, limit: 50 });
  const gateway = useFetch(allowed ? `/admin/orders/${order.id}/payments` : null);
  const g = gateway.data;
  const cols = [
    { key: "createdAt", title: "When", render: (r) => fmtDateTime(r.createdAt) },
    { key: "type", title: "Type", render: (r) => <StatusBadge status={r.type} tone="info" /> },
    { key: "partyName", title: "Party", render: (r) => (r.partyName ? `${r.partyName} (${titleCase(r.partyType)})` : titleCase(r.partyType)) },
    { key: "description", title: "Description" },
    { key: "amount", title: "Amount", align: "right", render: (r) => <span className={Number(r.amount) < 0 ? "text-danger-main" : ""}>{money(r.amount)}</span> },
  ];
  return (
    <div className="row gy-4">
      <div className="col-lg-5">
        <Card title="Payment">
          <KeyValue cols={1} items={[
            { label: "Method", value: titleCase(order.paymentMethod) },
            { label: "Status", value: <StatusBadge status={order.paymentStatus} /> },
            { label: "Payment intent", value: <code className="text-xs">{order.paymentIntentId || "-"}</code> },
            { label: "Wallet used", value: money(order.walletUsed) },
            { label: "Promo", value: order.promoCode ? `${order.promoCode} (-${money(order.discountTotal)})` : "None" },
            { label: "Charged total", value: money(order.total) },
          ]} />
        </Card>
        {g && (g.payments.length > 0 || g.dispute) && (
          <Card title="Gateway payments" subtitle={g.provider === "stripe" ? "Stripe" : g.provider === "mock" ? "Development mock" : ""} className="mt-24" actions={g.dashboardUrl && <a className="btn btn-sm btn-outline-neutral-300 radius-8" href={g.dashboardUrl} target="_blank" rel="noopener noreferrer">Open in Stripe</a>}>
            {g.dispute && <div className="alert alert-danger radius-8 py-8 text-sm" data-testid="order-dispute">Card dispute {g.dispute.id}: {g.dispute.status} ({g.dispute.reason}), {money(g.dispute.amount)}</div>}
            {g.paymentAlert && <div className="alert alert-warning radius-8 py-8 text-sm">{g.paymentAlert.reason}</div>}
            <ul className="list-unstyled mb-0" data-testid="gateway-payments">
              {g.payments.map((p) => (
                <li key={p.id} className="d-flex justify-content-between gap-2 py-6 text-sm border-bottom">
                  <span><b>{titleCase(p.kind)}</b> <code className="text-xs">{p.externalId || "-"}</code></span>
                  <span>{money(p.amount)} <StatusBadge status={p.status} /></span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <div className="col-lg-7">
        <Card title="Ledger entries" subtitle="Sales, fees, tips and refunds posted for this order" noPadding>
          {!allowed ? (
            <EmptyState title="Ledger not available" text="Your role does not include finance access." />
          ) : (
            <DataTable columns={cols} rows={ledger.data?.data || []} loading={ledger.loading} error={ledger.error} dense emptyTitle="No ledger entries yet" />
          )}
        </Card>
      </div>
    </div>
  );
}

function Tracking({ order, tracking }) {
  const r = tracking.restaurant;
  const d = tracking.driver;
  const a = order.deliveryAddress;
  const markers = [];
  if (r?.lat != null) markers.push({ id: "r", lat: r.lat, lng: r.lng, color: "#ff6917", glyph: "R", title: `Restaurant: ${r.name}` });
  if (a?.lat != null) markers.push({ id: "c", lat: a.lat, lng: a.lng, color: "#22c55e", glyph: "C", title: `Drop-off: ${a.line1}` });
  if (d?.lat != null) markers.push({ id: "d", lat: d.lat, lng: d.lng, color: "#487fff", kind: "dot", title: `Driver: ${d.name}` });
  const lines = r?.lat != null && a?.lat != null ? [{ id: "route", points: [[r.lat, r.lng], [a.lat, a.lng]], dashed: true }] : [];
  return (
    <div className="row gy-4">
      <div className="col-lg-8">{markers.length ? <MapView markers={markers} lines={lines} height={420} /> : <EmptyState icon="solar:map-point-outline" title="No location data" />}</div>
      <div className="col-lg-4">
        <Card title="Live tracking">
          <KeyValue cols={1} items={[
            order.type === "DELIVERY" && {
              label: "Driver wait-time charge",
              value: Number(order.driverWaitFee) > 0 ? (
                <span>
                  {money(order.driverWaitFee)} for {order.driverWaitMinutes} min waiting at the restaurant (paid to the driver, deducted from the restaurant){order.meta?.waitFee?.waived && <Badge tone="info" className="ms-2">Waived</Badge>}
                </span>
              ) : order.pickedUpAt ? "None" : "-",
            },
            { label: "Driver", value: d ? `${d.name} · ${titleCase(d.vehicleType)}${d.vehicleColor ? ` (${d.vehicleColor})` : ""}` : "Not assigned" },
            { label: "Pickup code", value: tracking.pickupCode },
            { label: "Delivery PIN", value: tracking.deliveryPin },
            { label: "Estimated ready", value: fmtTime(tracking.estimatedReadyAt) },
            { label: "Estimated delivery", value: fmtTime(tracking.estimatedDeliveryAt) },
            { label: "Distance", value: order.distanceKm != null ? `${order.distanceKm} km` : "-" },
          ]} />
        </Card>
      </div>
    </div>
  );
}

function Messages({ id }) {
  const m = useFetch(`/orders/${id}/messages`);
  if (m.loading) return <Loading />;
  if (m.error) return <ErrorState error={m.error} onRetry={m.reload} />;
  const rows = Array.isArray(m.data) ? m.data : m.data?.data || [];
  if (!rows.length) return <EmptyState icon="solar:chat-round-dots-outline" title="No messages on this order" />;
  return (
    <div className="d-flex flex-column gap-12">
      {rows.map((x) => (
        <div key={x.id} className="p-12 radius-8 bg-neutral-100">
          <div className="d-flex justify-content-between text-xs text-secondary-light mb-4">
            <span>{titleCase(x.senderType)} to {titleCase(x.recipientType)}</span>
            <span>{fmtDateTime(x.createdAt)}</span>
          </div>
          <div>{x.body}</div>
        </div>
      ))}
    </div>
  );
}

export default function OrderDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const detail = useFetch(`/admin/orders/${id}`, undefined, { refreshMs: 20000 });
  const tracking = useFetch(`/orders/${id}/tracking`, undefined, { refreshMs: 20000 });
  const order = detail.data?.order;
  const customer = useFetch(order ? `/admin/customers/${order.customerId}` : null);
  const [modal, setModal] = useState(null);
  const close = () => setModal(null);
  const reload = () => { detail.reload(); tracking.reload(); };

  if (detail.loading && !order) return <Loading minHeight={400} />;
  if (detail.error && !order) return (<><PageHeader title="Order" back="/orders" /><ErrorState error={detail.error} onRetry={detail.reload} /></>);
  if (!order) return null;

  const t = tracking.data || {};
  const timeline = detail.data.timeline || [];
  const closed = ["DELIVERED", "COLLECTED", "CANCELLED", "REJECTED"].includes(order.status);
  const cust = customer.data;
  const canEdit = can("orders", "edit");

  const actions = (
    <>
      {canEdit && <Button variant="light" icon="solar:refresh-circle-outline" onClick={() => setModal("status")}>Force status</Button>}
      {canEdit && order.type === "DELIVERY" && <Button variant="light" icon="solar:user-rounded-outline" onClick={() => setModal("reassign")}>Reassign driver</Button>}
      {can("orders", "approve") && <Button variant="warning" icon="solar:wallet-money-outline" onClick={() => setModal("refund")}>Refund</Button>}
      {can("orders", "approve") && Number(order.driverWaitFee) > 0 && !order.meta?.waitFee?.waived && <Button variant="light" icon="solar:clock-circle-outline" onClick={() => setModal("waive")}>Waive wait charge</Button>}
      {canEdit && !closed && <Button variant="danger" icon="solar:close-circle-outline" onClick={() => setModal("cancel")}>Cancel order</Button>}
    </>
  );

  const addr = order.deliveryAddress;
  const overview = (
    <div className="row gy-4">
      <div className="col-lg-8">
        <Card title="Items" noPadding className="mb-24"><Items items={order.items} /></Card>
        <Card title="Order details">
          <KeyValue cols={3} items={[
            { label: "Type", value: titleCase(order.type) },
            { label: "Fulfilment", value: titleCase(order.fulfilment) },
            { label: "Source", value: titleCase(order.source) },
            { label: "Placed", value: fmtDateTime(order.createdAt) },
            { label: "Sent to the restaurant", value: !order.kitchenReleaseAt ? "At placement" : order.kitchenReleasedAt ? fmtDateTime(order.kitchenReleasedAt) : <Badge tone="info">Held for the customer's cancellation window until {fmtTime(order.kitchenReleaseAt)}</Badge> },
            { label: "Scheduled for", value: order.isScheduled ? fmtDateTime(order.scheduledFor) : "ASAP" },
            { label: "Delivered", value: fmtDateTime(order.deliveredAt) },
            { label: "Delivery address", value: addr ? `${addr.line1}, ${addr.city} ${addr.postalCode || ""}` : "-" },
            { label: "Handoff method", value: <Badge tone={order.dropoffMethod === "LEAVE_AT_DOOR" ? "info" : "neutral"}>{titleCase(order.dropoffMethod || "HAND_TO_ME")}</Badge> },
            { label: "Delivery PIN", value: order.fulfilment === "PICKUP" ? "-" : order.requiresPin ? "Yes" : order.dropoffMethod === "LEAVE_AT_DOOR" ? "No (contactless, photo)" : order.usePin === false ? <Badge tone="warning">Customer turned PIN off - photo required</Badge> : "No" },
            { label: "Delivery instructions (driver)", value: order.dropoffNotes || "None" },
            { label: "Access code", value: <AccessCode order={order} tracking={t} /> },
            { label: "Kitchen notes (restaurant)", value: order.customerNotes },
            { label: "Allergy flag", value: order.hasAllergyFlag ? <Badge tone="warning">Allergy noted</Badge> : "No" },
            { label: "Escalation level", value: order.escalationLevel },
            order.cancelReason && { label: "Cancel reason", value: `${order.cancelReason} (${titleCase(order.cancelledBy)})` },
            order.rejectReason && { label: "Reject reason", value: order.rejectReason },
          ]} />
        </Card>
      </div>
      <div className="col-lg-4">
        <Card title="Parties" className="mb-24">
          <KeyValue cols={1} items={[
            { label: "Customer", value: cust ? `${[cust.firstName, cust.lastName].filter(Boolean).join(" ")} · ${cust.email || cust.phone}` : customer.loading ? "Loading…" : order.customerId.slice(0, 8) },
            { label: "Restaurant", value: t.restaurant?.name },
            { label: "Restaurant address", value: t.restaurant?.address },
            { label: "Driver", value: t.driver ? t.driver.name : order.driverId ? order.driverId.slice(0, 8) : <Badge tone={order.unassignedFlag ? "danger" : "neutral"}>Unassigned</Badge> },
          ]} />
        </Card>
        <Card title="Money breakdown">
          <MoneyRow label="Subtotal" value={order.subtotal} />
          <MoneyRow label="Delivery fee" value={order.deliveryFee} />
          <MoneyRow label="Service fee" value={order.serviceFee} />
          {Number(order.smallOrderFee) > 0 && <MoneyRow label="Small order fee" value={order.smallOrderFee} />}
          <MoneyRow label="Tax" value={order.taxAmount} />
          <MoneyRow label="Tip" value={order.tip} />
          {Number(order.discountTotal) > 0 && <MoneyRow label={`Discount${order.promoCode ? ` (${order.promoCode})` : ""}`} value={order.discountTotal} neg />}
          <MoneyRow label="Total" value={order.total} strong />
          <div className="mt-16 pt-12 border-top">
            <div className="text-secondary-light text-xs mb-4 text-uppercase">Platform economics</div>
            <MoneyRow label={`Commission (${order.commissionPct}%)`} value={order.commissionAmount} muted />
            <MoneyRow label="Restaurant payout" value={order.restaurantPayout} muted />
            <MoneyRow label="Driver pay" value={order.driverPay} muted />
            {Number(order.driverBoost) > 0 && <MoneyRow label="Driver boost" value={order.driverBoost} muted />}
          </div>
        </Card>
      </div>
    </div>
  );

  const tl = (
    <Card title="Timeline" subtitle={`${timeline.length} events`}>
      <Timeline
        items={timeline.map((e) => ({
          title: e.type === "STATUS_CHANGE" ? `${e.fromStatus ? `${titleCase(e.fromStatus)} → ` : ""}${titleCase(e.toStatus)}` : titleCase(e.type),
          text: [`by ${titleCase(e.actorType)}`, e.note].filter(Boolean).join(" · "),
          at: `${fmtDateTime(e.createdAt)} (${timeAgo(e.createdAt)})`,
          tone: e.toStatus === "CANCELLED" || e.toStatus === "REJECTED" ? "danger" : e.toStatus === "DELIVERED" ? "success" : e.type === "STATUS_CHANGE" ? undefined : "warning",
        }))}
      />
    </Card>
  );

  return (
    <>
      <PageHeader
        back="/orders"
        title={<span className="d-flex align-items-center gap-2 flex-wrap">{order.code} <StatusBadge status={order.status} />{order.isLate && <Badge tone="danger">Late</Badge>}{order.unassignedFlag && <Badge tone="warning">Unassigned</Badge>}</span>}
        subtitle={`${t.restaurant?.name || "Order"} · ${money(order.total)} · placed ${fmtDateTime(order.createdAt)}`}
        actions={actions}
      />
      <Tabs
        tabs={[
          { key: "overview", label: "Overview", content: overview },
          { key: "timeline", label: "Timeline", badge: timeline.length, content: tl },
          { key: "payments", label: "Payments", content: <Payments order={order} /> },
          ...(order.type === "DELIVERY" ? [{ key: "proof", label: "Delivery proof", content: <DeliveryProofTab orderId={id} status={order.status} /> }] : []),
          { key: "tracking", label: "Map & tracking", content: tracking.error ? <ErrorState error={tracking.error} onRetry={tracking.reload} /> : tracking.loading && !tracking.data ? <Loading /> : <Tracking order={order} tracking={t} /> },
          { key: "messages", label: "Messages", content: <Messages id={id} /> },
        ]}
      />
      {modal === "status" && <ForceStatusModal order={order} onClose={close} onDone={reload} />}
      {modal === "cancel" && <CancelModal order={order} onClose={close} onDone={reload} />}
      {modal === "refund" && <RefundModal order={order} onClose={close} onDone={reload} />}
      {modal === "waive" && <WaiveWaitModal order={order} onClose={close} onDone={reload} />}
      {modal === "reassign" && <ReassignModal order={order} onClose={close} onDone={reload} />}
    </>
  );
}
