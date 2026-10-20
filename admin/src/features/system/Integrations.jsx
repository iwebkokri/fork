import React, { useState } from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Loading, PageHeader, Switch, TextInput, useConfirm } from "../../ui";
import { useFetch, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { fmtDateTime } from "../../lib/format";
import { resetMapTiles } from "../../ui/map";

/** Where a key currently comes from, as a small badge. */
function Source({ s }) {
  if (!s?.set) return <Badge tone="neutral">Not set</Badge>;
  return <Badge tone="success">{s.source === "env" ? "Set (environment)" : "Set"}</Badge>;
}

/** Secret field: never shows the value, only ********last4. Blank = keep, "Remove" = clear. */
function SecretField({ label, hint, view, value, onChange, onClear, cleared, disabled, placeholder, name }) {
  return (
    <div className="mb-16">
      <div className="d-flex justify-content-between align-items-center mb-1 gap-2">
        <label className="form-label fw-semibold text-sm mb-0" htmlFor={`f-${name}`}>{label}</label>
        <div className="d-flex align-items-center gap-2">
          {cleared ? <Badge tone="warning">Will be removed</Badge> : <Source s={view} />}
          {view?.set && !disabled && !cleared && (
            <button type="button" className="btn btn-link btn-sm text-danger-600 p-0" onClick={onClear} data-testid={`clear-${name}`}>Remove</button>
          )}
        </div>
      </div>
      <input
        id={`f-${name}`}
        data-testid={`field-${name}`}
        className="form-control radius-8 font-monospace"
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        disabled={disabled || cleared}
        value={value}
        placeholder={view?.set ? `${view.masked}  (leave blank to keep)` : placeholder}
        onChange={(e) => onChange(e.target.value.trim())}
      />
      {hint && <div className="form-text text-xs">{hint}</div>}
    </div>
  );
}

function CopyButton({ text, label = "Copy", testId }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement("textarea");
      t.value = text;
      document.body.appendChild(t);
      t.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(t);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1800);
  };
  return <Button variant="light" icon={done ? "solar:check-circle-outline" : "solar:copy-outline"} onClick={copy} data-testid={testId}>{done ? "Copied" : label}</Button>;
}

function Row({ ok, children }) {
  return (
    <li className="d-flex gap-2 align-items-start mb-1 text-sm">
      <span className={ok === false ? "text-danger-600" : ok === true ? "text-success-600" : "text-warning-600"}>{ok === false ? "✕" : ok === true ? "✓" : "!"}</span>
      <span>{children}</span>
    </li>
  );
}

function StripeTest({ r }) {
  if (!r) return null;
  const w = r.webhook;
  return (
    <div className={`alert ${r.ok ? (r.warnings?.length ? "alert-warning" : "alert-success") : "alert-danger"} radius-8 mt-16 mb-0`} role="status" data-testid="stripe-test-result">
      <div className="fw-semibold mb-1">{r.ok ? "Connection works" : "Connection failed"} <span className="text-xs fw-normal">({fmtDateTime(r.checkedAt)})</span></div>
      {!r.ok && <div data-testid="test-reason">{r.reason}</div>}
      {r.ok && (
        <ul className="list-unstyled mb-0 mt-2">
          <Row ok>Mode: <b>{r.livemode ? "LIVE" : "TEST"}</b>{r.accountId ? <> · account <code>{r.accountId}</code></> : null}{r.country ? ` · ${r.country}` : ""}</Row>
          <Row ok={!!r.chargesEnabled}>Charges {r.chargesEnabled ? "enabled" : "not enabled"}</Row>
          <Row ok={!!r.payoutsEnabled}>Payouts {r.payoutsEnabled ? "enabled" : "not enabled"}</Row>
          <Row ok={r.connect?.enabled}>Connect {r.connect?.enabled ? "enabled" : `not enabled${r.connect?.reason ? ": " + r.connect.reason : ""}`}</Row>
          {w && (w.checked === false ? <Row>Webhook could not be checked: {w.reason}</Row> : w.registered ? <Row ok={w.status === "enabled" && !w.missingEvents?.length}>Webhook endpoint registered ({w.status}){w.missingEvents?.length ? `; missing events: ${w.missingEvents.join(", ")}` : ""}</Row> : <Row ok={false}>{w.reason}</Row>)}
          <Row ok={r.publishableKeyMatches === null ? undefined : r.publishableKeyMatches}>Publishable key {r.publishableKeyMatches === null ? "not set" : r.publishableKeyMatches ? "matches the secret key mode" : "is from a different mode"}</Row>
          <Row ok={r.webhookSecretSet}>Webhook signing secret {r.webhookSecretSet ? "set" : "missing"}</Row>
        </ul>
      )}
    </div>
  );
}

function StripeCard({ s, reload, canChange }) {
  const [f, setF] = useState({ secretKey: "", publishableKey: "", webhookSecret: "" });
  const [clear, setClear] = useState({});
  const [connect, setConnect] = useState(null);
  const [test, setTest] = useState(null);
  const { busy, run } = useSubmit();
  const [testing, setTesting] = useState(false);
  const confirm = useConfirm();
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const connectVal = connect === null ? s.connectEnabled : connect;
  const changed = f.secretKey || f.publishableKey || f.webhookSecret || Object.values(clear).some(Boolean) || connect !== null;

  const save = async () => {
    const body = {};
    for (const k of ["secretKey", "publishableKey", "webhookSecret"]) {
      if (clear[k]) body[k] = "";
      else if (f[k]) body[k] = f[k];
    }
    if (connect !== null) body.connectEnabled = connect;
    const willBeLive = /^(sk|rk)_live_/.test(f.secretKey);
    if (willBeLive) {
      const { confirmed } = await confirm({ title: "Switch to LIVE keys?", text: "Customers will be charged real money. Make sure the publishable key and webhook secret are the LIVE ones too.", confirmText: "Use live keys", danger: true });
      if (!confirmed) return;
    }
    run(() => http.put("/admin/integrations/stripe", body), {
      success: "Stripe settings saved",
      onDone: () => { setF({ secretKey: "", publishableKey: "", webhookSecret: "" }); setClear({}); setConnect(null); setTest(null); reload(); },
    });
  };
  const runTest = async () => {
    setTesting(true);
    try { setTest(await http.post("/admin/integrations/stripe/test")); } catch (e) { setTest({ ok: false, reason: e?.response?.data?.message || e.message, checkedAt: new Date().toISOString() }); } finally { setTesting(false); }
  };

  return (
    <Card
      title="Stripe"
      subtitle="Card payments (on-page), refunds and driver / restaurant payouts (Connect)"
      actions={<div className="d-flex gap-2">
        <Button variant="light" icon="solar:plug-circle-outline" loading={testing} onClick={runTest} data-testid="stripe-test">Test connection</Button>
        {canChange && <Button loading={busy} disabled={!changed} onClick={save} data-testid="stripe-save">Save</Button>}
      </div>}
    >
      {s.warnings?.map((w, i) => <div key={i} className="alert alert-warning radius-8 py-8 text-sm" data-testid="stripe-warning">{w}</div>)}
      {!canChange && <div className="alert alert-info radius-8 py-8 text-sm">Only a Super Admin can change integration keys.</div>}
      <SecretField name="secretKey" label="Secret key" view={s.keys.secretKey} value={f.secretKey} onChange={set("secretKey")} cleared={clear.secretKey} onClear={() => setClear((c) => ({ ...c, secretKey: true }))} disabled={!canChange} placeholder="sk_test_... or rk_test_..." hint="Dashboard > Developers > API keys. Encrypted at rest, never shown again." />
      <div className="mb-16">
        <div className="d-flex justify-content-between align-items-center mb-1">
          <label className="form-label fw-semibold text-sm mb-0" htmlFor="f-pk">Publishable key</label>
          <span className="d-flex align-items-center gap-2">
            {clear.publishableKey ? <Badge tone="warning">Will be removed</Badge> : <Source s={s.keys.publishableKey} />}
            {s.keys.publishableKey?.source === "settings" && canChange && !clear.publishableKey && <button type="button" className="btn btn-link btn-sm text-danger-600 p-0" onClick={() => setClear((c) => ({ ...c, publishableKey: true }))} data-testid="clear-publishableKey">Remove</button>}
          </span>
        </div>
        <input id="f-pk" data-testid="field-publishableKey" className="form-control radius-8 font-monospace" disabled={!canChange || clear.publishableKey} value={f.publishableKey} placeholder={s.keys.publishableKey?.value || "pk_test_..."} onChange={(e) => set("publishableKey")(e.target.value.trim())} spellCheck={false} />
        <div className="form-text text-xs">Not a secret: it is shown to the browser to load the card form. {s.keys.publishableKey?.value ? <>Current: <code>{s.keys.publishableKey.value}</code></> : null}</div>
      </div>
      <SecretField name="webhookSecret" label="Webhook signing secret" view={s.keys.webhookSecret} value={f.webhookSecret} onChange={set("webhookSecret")} cleared={clear.webhookSecret} onClear={() => setClear((c) => ({ ...c, webhookSecret: true }))} disabled={!canChange} placeholder="whsec_..." hint="Shown by Stripe after you add the endpoint below." />
      <div className="row">
        <div className="col-md-4"><Switch label="Stripe Connect payouts" hint="Drivers and restaurants are paid through Stripe Connect" checked={!!connectVal} onChange={(v) => setConnect(v)} disabled={!canChange} /></div>
        <div className="col-md-4"><TextInput label="Currency" value="CAD" disabled onChange={() => {}} /></div>
        <div className="col-md-4"><TextInput label="Platform country" value={s.platformCountry} disabled onChange={() => {}} /></div>
      </div>
      <StripeTest r={test || s.lastTest} />
    </Card>
  );
}

const MAPBOX_EMPTY = { accessToken: "", publicToken: "", style: null, country: null, bbox: null, proximity: null };

function MapboxCard({ m, reload, canChange, active }) {
  const [f, setF] = useState(MAPBOX_EMPTY);
  const [clear, setClear] = useState({});
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const { busy, run } = useSubmit();
  const val = (k) => (f[k] === null ? m[k] ?? "" : f[k]);
  const changed = f.accessToken || f.publicToken || f.style !== null || f.country !== null || f.bbox !== null || f.proximity !== null || Object.values(clear).some(Boolean);

  const save = () => {
    const body = {};
    for (const k of ["accessToken", "publicToken"]) {
      if (clear[k]) body[k] = "";
      else if (f[k]) body[k] = f[k];
    }
    for (const k of ["style", "country", "bbox", "proximity"]) if (f[k] !== null) body[k] = f[k];
    // a new key or style is checked against Mapbox right after saving, so a wrong one shows up at once (removing a key is not "checked")
    const verify = !!(f.accessToken || f.publicToken || f.style);
    run(() => http.put("/admin/integrations/mapbox", body), { success: "Mapbox settings saved", onDone: () => { setF(MAPBOX_EMPTY); setClear({}); setTest(null); reload(); if (verify) runTest(); } });
  };
  const runTest = async () => {
    setTesting(true);
    try { setTest(await http.post("/admin/integrations/mapbox/test")); } catch (e) { setTest({ ok: false, reason: e?.response?.data?.message || e.message, checkedAt: new Date().toISOString() }); } finally { setTesting(false); }
  };
  const r = test || m.lastTest;
  return (
    <Card
      title="Mapbox"
      subtitle="Address search, road distances and the maps of the admin screens"
      actions={<div className="d-flex gap-2">
        <Button variant="light" icon="solar:plug-circle-outline" loading={testing} onClick={runTest} data-testid="mapbox-test">Test connection</Button>
        {canChange && <Button loading={busy} disabled={!changed} onClick={save} data-testid="mapbox-save">Save</Button>}
      </div>}
    >
      {active && <div className="alert alert-success radius-8 py-8 text-sm" data-testid="mapbox-active">Mapbox is the maps provider in use.</div>}
      {m.warnings?.map((w, i) => <div key={i} className="alert alert-warning radius-8 py-8 text-sm">{w}</div>)}
      <SecretField name="accessToken" label="Access token (server)" view={m.keys.accessToken} value={f.accessToken} onChange={(v) => setF((x) => ({ ...x, accessToken: v }))} cleared={clear.accessToken} onClear={() => setClear((c) => ({ ...c, accessToken: true }))} disabled={!canChange} placeholder="sk.... (Search + Directions scopes) or pk...." hint="Used by the FORKSY API only (address search and road distances). Browsers never receive it. To replace it, type the new token and Save: it is used at once, no restart." />
      <SecretField name="publicToken" label="Public token (for the maps)" view={m.keys.publicToken} value={f.publicToken} onChange={(v) => setF((x) => ({ ...x, publicToken: v }))} cleared={clear.publicToken} onClear={() => setClear((c) => ({ ...c, publicToken: true }))} disabled={!canChange} placeholder="pk...." hint="Loads the map tiles in the admin screens. In Mapbox, restrict it to your website addresses. Without it the maps use OpenStreetMap. To replace it, type the new token and Save." />
      <div className="row">
        <div className="col-12"><TextInput label="Map style" data-testid="mapbox-style" value={val("style")} onChange={(v) => setF((x) => ({ ...x, style: v }))} disabled={!canChange} hint="username/style_id (mapbox/streets-v12) or the Style URL of Mapbox Studio (mapbox://styles/username/style_id)" /></div>
        <div className="col-md-4"><TextInput label="Search country" value={val("country")} onChange={(v) => setF((x) => ({ ...x, country: v }))} disabled={!canChange} hint="e.g. ca (both providers use this search area)" /></div>
        <div className="col-md-8"><TextInput label="Bounding box" value={val("bbox")} onChange={(v) => setF((x) => ({ ...x, bbox: v }))} disabled={!canChange} hint="minLng,minLat,maxLng,maxLat (Greater Toronto Area)" /></div>
        <div className="col-12"><TextInput label="Default proximity (Mississauga)" value={val("proximity")} onChange={(v) => setF((x) => ({ ...x, proximity: v }))} disabled={!canChange} hint="lng,lat: results nearer to this point rank first" /></div>
      </div>
      {r && (
        <div className={`alert ${r.ok ? (r.tiles && !r.tiles.ok ? "alert-warning" : "alert-success") : "alert-danger"} radius-8 mb-0`} role="status" data-testid="mapbox-test-result">
          <div className="fw-semibold">{r.ok ? "Address search works" : "Address search failed"} <span className="text-xs fw-normal">({fmtDateTime(r.checkedAt)})</span></div>
          {r.ok ? <div className="text-sm">Found: {r.sample} <span className="text-secondary-light">({r.latencyMs} ms, {r.tokenKind} token)</span></div> : <div className="text-sm" data-testid="test-reason">{r.reason}</div>}
          {r.ok && r.routing && <div className="text-sm" data-testid="mapbox-test-routing">{r.routing.ok ? `Road distances work (${r.routing.km} km, ${r.routing.minutes} min for the test trip)` : `Road distances: ${r.routing.reason}`}</div>}
          {r.ok && r.tiles && <div className="text-sm" data-testid="mapbox-test-tiles">{r.tiles.ok ? `Map style works (${r.tiles.style})` : `Map style: ${r.tiles.reason}`}</div>}
        </div>
      )}
    </Card>
  );
}

/** Which maps provider is in use (Mapbox or Google) and whether deliveries use real road distances. Takes effect at once. */
function MapsProviderCard({ m, reload, canChange }) {
  const confirm = useConfirm();
  const { busy, run } = useSubmit();
  const name = (p) => (p === "google" ? "Google" : "Mapbox");
  const choose = async (p) => {
    if (p === m.provider) return;
    if (!(await confirm({ title: `Switch the maps to ${name(p)}?`, message: "Address search, road distances and the maps of the admin screens use the new provider from now on. The keys of the other provider stay saved, so you can switch back at any time.", confirmText: `Use ${name(p)}` }))) return;
    run(() => http.put("/admin/integrations/maps", { provider: p }), { success: `Maps now use ${name(p)}`, onDone: reload });
  };
  const setRoad = (v) => run(() => http.put("/admin/integrations/maps", { roadDistances: v }), { success: v ? "Real road distances are on" : "Road distances use the built-in estimate", onDone: reload });
  return (
    <Card title="Maps provider" subtitle="Switch between Mapbox and Google at any time">
      <div className="d-flex gap-2 mb-16" role="radiogroup" aria-label="Maps provider" data-testid="maps-provider">
        {["mapbox", "google"].map((p) => (
          <button key={p} type="button" role="radio" aria-checked={m.provider === p} disabled={!canChange || busy} onClick={() => choose(p)} className={`btn radius-8 flex-fill ${m.provider === p ? "btn-primary-600" : "btn-outline-neutral-300 text-primary-light"}`} data-testid={`maps-provider-${p}`}>
            {name(p)}{m.provider === p ? " (in use)" : ""}
          </button>
        ))}
      </div>
      <ul className="list-unstyled text-sm mb-16" data-testid="maps-summary">
        <li className="d-flex justify-content-between"><span className="text-secondary-light">Address search</span><span>{m.addressSearch ? "On" : "Off (customers type the address)"}</span></li>
        <li className="d-flex justify-content-between"><span className="text-secondary-light">Maps on the admin screens</span><span>{m.tiles === "osm" ? "OpenStreetMap" : name(m.tiles)}</span></li>
        <li className="d-flex justify-content-between"><span className="text-secondary-light">Delivery distances and times</span><span>{m.roadDistancesActive ? "Real roads" : "Built-in estimate"}</span></li>
      </ul>
      <Switch label="Use real road distances and drive times" hint="Delivery fees and ETAs follow the road route from the provider instead of the built-in estimate (straight line x 1.3). Off by default: switching it on can change delivery fees." checked={!!m.roadDistances} onChange={setRoad} disabled={!canChange || busy} />
      {m.roadDistances && !m.roadDistancesActive && <div className="alert alert-warning radius-8 py-8 text-sm mt-8">The switch is on, but the provider has no key yet: the estimate is still used.</div>}
      {m.warnings?.map((w, i) => <div key={i} className="alert alert-warning radius-8 py-8 text-sm mt-8">{w}</div>)}
      {!canChange && <div className="text-xs text-secondary-light mt-8">Only a Super Admin can change the maps provider.</div>}
    </Card>
  );
}

const GOOGLE_EMPTY = { apiKey: "", browserKey: "" };

function GoogleCard({ g, reload, canChange, active }) {
  const [f, setF] = useState(GOOGLE_EMPTY);
  const [clear, setClear] = useState({});
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const { busy, run } = useSubmit();
  const changed = f.apiKey || f.browserKey || Object.values(clear).some(Boolean);
  const save = () => {
    const body = {};
    for (const k of ["apiKey", "browserKey"]) {
      if (clear[k]) body[k] = "";
      else if (f[k]) body[k] = f[k];
    }
    run(() => http.put("/admin/integrations/google", body), { success: "Google Maps keys saved", onDone: () => { setF(GOOGLE_EMPTY); setClear({}); setTest(null); reload(); } });
  };
  const runTest = async () => {
    setTesting(true);
    try { setTest(await http.post("/admin/integrations/google/test")); } catch (e) { setTest({ ok: false, reason: e?.response?.data?.message || e.message, checkedAt: new Date().toISOString() }); } finally { setTesting(false); }
  };
  const r = test || g.lastTest;
  return (
    <Card
      title="Google Maps"
      subtitle="Kept ready: switch to it any time above"
      actions={<div className="d-flex gap-2">
        <Button variant="light" icon="solar:plug-circle-outline" loading={testing} onClick={runTest} data-testid="google-test">Test connection</Button>
        {canChange && <Button loading={busy} disabled={!changed} onClick={save} data-testid="google-save">Save</Button>}
      </div>}
    >
      {active && <div className="alert alert-success radius-8 py-8 text-sm" data-testid="google-active">Google is the maps provider in use.</div>}
      {g.warnings?.map((w, i) => <div key={i} className="alert alert-warning radius-8 py-8 text-sm">{w}</div>)}
      <SecretField name="googleApiKey" label="Server API key" view={g.keys.apiKey} value={f.apiKey} onChange={(v) => setF((x) => ({ ...x, apiKey: v }))} cleared={clear.apiKey} onClear={() => setClear((c) => ({ ...c, apiKey: true }))} disabled={!canChange} placeholder="AIza..." hint="Used by the FORKSY API only: address search (Places API New + Geocoding API), road distances (Routes API) and the map session (Map Tiles API). Browsers never receive it." />
      <SecretField name="googleBrowserKey" label="Browser key (for the maps)" view={g.keys.browserKey} value={f.browserKey} onChange={(v) => setF((x) => ({ ...x, browserKey: v }))} cleared={clear.browserKey} onClear={() => setClear((c) => ({ ...c, browserKey: true }))} disabled={!canChange} placeholder="AIza..." hint="A separate key that is restricted to your website addresses in the Google console and enabled for the Map Tiles API only. Without it the maps use OpenStreetMap." />
      <div className="text-xs text-secondary-light mb-12">The search country, bounding box and default proximity are the ones on the Mapbox card: both providers search the same area.</div>
      {r && (
        <div className={`alert ${r.ok ? "alert-success" : "alert-danger"} radius-8 mb-0`} role="status" data-testid="google-test-result">
          <div className="fw-semibold">{r.ok ? "Address search works" : "Address search failed"} <span className="text-xs fw-normal">({fmtDateTime(r.checkedAt)})</span></div>
          {r.ok ? <div className="text-sm">Found: {r.sample} <span className="text-secondary-light">({r.latencyMs} ms)</span></div> : <div className="text-sm" data-testid="google-test-reason">{r.reason}</div>}
          {r.ok && r.routing && <div className="text-sm">{r.routing.ok ? `Road distances work (${r.routing.km} km, ${r.routing.minutes} min for the test trip)` : `Road distances: ${r.routing.reason}`}</div>}
          {r.ok && r.tiles && <div className="text-sm">{r.tiles.ok ? "Map tiles work" : `Map tiles: ${r.tiles.reason}`}</div>}
        </div>
      )}
    </Card>
  );
}

function ModeBanner({ s }) {
  if (s.provider === "mock") {
    return (
      <div className="alert alert-warning radius-8 d-flex align-items-center gap-2" data-testid="mode-banner" data-mode="mock">
        <b>TEST payment (no Stripe keys configured).</b> Mock payments are on for development: no real money moves. Add the Stripe TEST keys below.
      </div>
    );
  }
  if (s.provider === "none") {
    return <div className="alert alert-secondary radius-8" data-testid="mode-banner" data-mode="none"><b>Payments are not configured.</b> Customers cannot pay until the Stripe keys are added below.</div>;
  }
  if (s.mode === "live") {
    return <div className="alert alert-danger radius-8 fw-semibold" data-testid="mode-banner" data-mode="live">LIVE keys. Real cards are charged and real money is paid out.</div>;
  }
  return <div className="alert alert-warning radius-8 fw-semibold" data-testid="mode-banner" data-mode="test">TEST mode. Use Stripe test cards (4242 4242 4242 4242); no real money moves.</div>;
}

function WebhookCard({ s }) {
  const events = s.webhook.events;
  return (
    <Card title="Webhook endpoint" subtitle="Register this in the Stripe dashboard (Developers > Webhooks > Add endpoint)">
      <label className="form-label fw-semibold text-sm">Endpoint URL</label>
      <div className="d-flex gap-2 mb-16 flex-wrap">
        <input className="form-control radius-8 font-monospace flex-grow-1" readOnly value={s.webhook.url} data-testid="webhook-url" style={{ minWidth: 260 }} onFocus={(e) => e.target.select()} />
        <CopyButton text={s.webhook.url} label="Copy URL" testId="copy-webhook-url" />
      </div>
      <div className="d-flex justify-content-between align-items-center mb-1">
        <label className="form-label fw-semibold text-sm mb-0">Events to subscribe to ({events.length})</label>
        <CopyButton text={events.join("\n")} label="Copy events" testId="copy-webhook-events" />
      </div>
      <div className="d-flex flex-wrap gap-2" data-testid="webhook-events">
        {events.map((e) => <code key={e} className="px-8 py-2 radius-4 bg-neutral-100 text-xs">{e}</code>)}
      </div>
      <p className="text-sm text-secondary-light mt-12 mb-0">Connect events (<code>account.updated</code>, <code>payout.*</code>) need the endpoint option <b>"Listen to events on Connected accounts"</b>. Local testing: <code>stripe listen --forward-to localhost:4000/api/v1/webhooks/stripe</code>.</p>
    </Card>
  );
}

function EventsCard({ canReplay }) {
  const [status, setStatus] = useState("");
  const { data, loading, error, reload } = useFetch("/admin/integrations/stripe/events", { limit: 25, status: status || undefined });
  const { busy, run } = useSubmit();
  const columns = [
    { key: "createdAt", title: "Received", render: (e) => fmtDateTime(e.createdAt) },
    { key: "type", title: "Event", render: (e) => <code className="text-xs">{e.type}</code> },
    { key: "status", title: "Status", render: (e) => <Badge tone={e.status === "PROCESSED" ? "success" : e.status === "FAILED" ? "danger" : "neutral"}>{e.status}</Badge> },
    { key: "objectId", title: "Object", render: (e) => <code className="text-xs">{e.objectId || "-"}</code> },
    { key: "error", title: "Error", render: (e) => (e.error ? <span className="text-danger-600 text-xs">{e.error}</span> : "") },
    { key: "a", title: "", align: "right", render: (e) => canReplay && <Button variant="light" disabled={busy} onClick={() => run(() => http.post(`/admin/integrations/stripe/events/${e.id}/replay`), { success: "Event replayed", onDone: reload })} data-testid="replay">Replay</Button> },
  ];
  return (
    <Card noPadding title="Recent webhook events" subtitle={data?.meta ? `${data.meta.failed} failed` : ""} actions={<div className="d-flex gap-2 align-items-center"><select className="form-select form-select-sm radius-8" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status"><option value="">All</option><option value="FAILED">Failed</option><option value="PROCESSED">Processed</option><option value="IGNORED">Ignored</option></select><Button variant="light" onClick={reload}>Refresh</Button></div>}>
      {error && <ErrorState error={error} onRetry={reload} />}
      <DataTable columns={columns} rows={data?.data || []} loading={loading} dense emptyTitle="No webhook events yet" emptyText="They appear here as soon as Stripe calls the endpoint." />
    </Card>
  );
}

function OtherCards({ others }) {
  const items = Object.entries(others || {});
  return (
    <div className="row gy-3" data-testid="other-integrations">
      {items.map(([key, o]) => (
        <div key={key} className="col-md-6 col-xl-4">
          <div className="card radius-8 h-100 shadow-none border">
            <div className="card-body p-16">
              <div className="d-flex justify-content-between align-items-center mb-8">
                <h6 className="mb-0">{o.label}</h6>
                <Badge tone={o.configured ? "success" : o.partial ? "warning" : "neutral"}>{o.configured ? "Configured" : o.partial ? "Incomplete" : "Not configured"}</Badge>
              </div>
              <ul className="list-unstyled mb-0 text-sm">
                {o.parts.map((p) => <li key={p.name} className="d-flex justify-content-between"><span className="text-secondary-light">{p.name}</span><span>{p.set ? `set (${p.source})` : "-"}</span></li>)}
              </ul>
              {!o.configured && <div className="text-xs text-secondary-light mt-8">Until it is set the built-in development stand-in is used.</div>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Integrations() {
  const { isSuper, can } = useAuth();
  const { data, loading, error, reload } = useFetch("/admin/integrations");
  // a change to the maps provider or its keys changes the tiles the admin maps draw: forget the cached tile settings
  const reloadMaps = () => {
    resetMapTiles();
    reload();
  };
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <EmptyState title="No data" />;
  return (
    <>
      <PageHeader title="Integrations" subtitle="API keys for payments, maps and messaging. Secrets are encrypted and never shown again." crumbs={[{ label: "System" }, { label: "Integrations" }]} />
      <ModeBanner s={data.stripe} />
      <div className="row gy-4">
        <div className="col-xl-7"><StripeCard s={data.stripe} reload={reload} canChange={isSuper && can("settings", "edit")} /></div>
        <div className="col-xl-5"><MapsProviderCard m={data.maps} reload={reloadMaps} canChange={isSuper && can("settings", "edit")} /></div>
        <div className="col-12"><WebhookCard s={data.stripe} /></div>
        <div className="col-12"><EventsCard canReplay={isSuper} /></div>
        <div className="col-12"><h6 className="mb-0">Maps providers</h6></div>
        <div className="col-xl-6"><MapboxCard m={data.mapbox} reload={reloadMaps} canChange={isSuper && can("settings", "edit")} active={data.maps.provider === "mapbox"} /></div>
        <div className="col-xl-6"><GoogleCard g={data.google} reload={reloadMaps} canChange={isSuper && can("settings", "edit")} active={data.maps.provider === "google"} /></div>
        <div className="col-12"><h6 className="mb-12">Other services</h6><OtherCards others={data.others} /></div>
      </div>
    </>
  );
}
