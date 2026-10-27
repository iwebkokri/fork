import React, { useEffect, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { errorMessage, http } from "../../lib/api";
import { toast } from "react-toastify";
import { useFetch, useForm, usePagedList, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { fmtDate, fmtDateTime, money, pct, timeAgo, titleCase } from "../../lib/format";
import {
  AddressFinder, BoolBadge, Badge, Button, Card, EmptyState, ErrorState, FormModal, FormRow, KeyValue, LocationPicker, Loading, Modal, NumberInput, PercentInput, Progress,
  Select, StatCard, StatusBadge, Switch, TextArea, TextInput, useConfirm,
} from "../../ui";
import { DAYS, STORE_TYPES, StoreTypeBadge, assetUrl, listOf, restaurantPost, useLookups } from "./shared";
import ReviewsTable from "./ReviewsTable";
import RestaurantRatingSummary from "../ratings/RestaurantRatingSummary";

const api = (r, p = "") => `/admin/restaurants/${r.id}${p}`;

// ------------------------------------------------------------------ overview
export function OverviewTab({ r, reload }) {
  const { can } = useAuth();
  const [edit, setEdit] = useState(false);
  const { data: stats } = useFetch(api(r, "/stats"), { days: 30 });
  const form = useForm({});
  const { busy, run } = useSubmit();

  const openEdit = () => {
    form.reset({
      name: r.name, storeType: r.storeType || "RESTAURANT", phone: r.phone || "", email: r.email || "", website: r.website || "", description: r.description || "", minimumOrder: r.minimumOrder, prepTimeMin: r.prepTimeMin,
      isFeatured: !!r.isFeatured, reliabilityScore: r.reliabilityScore,
    });
    setEdit(true);
  };
  const save = () => {
    const v = form.values;
    run(() => http.patch(api(r), { ...v, minimumOrder: v.minimumOrder === "" ? undefined : v.minimumOrder, prepTimeMin: v.prepTimeMin === "" ? undefined : v.prepTimeMin, reliabilityScore: v.reliabilityScore === "" ? undefined : v.reliabilityScore }), {
      success: "Restaurant updated",
      onDone: () => {
        setEdit(false);
        reload();
      },
    });
  };

  const fulfil = [
    r.deliveryEnabled && "Delivery",
    r.pickupEnabled && "Pickup",
    r.ownDeliveryEnabled && "Own drivers",
    r.scheduledEnabled && "Scheduled",
    r.dineInEnabled && "Dine-in",
  ].filter(Boolean);

  return (
    <>
      <div className="row gy-3 mb-24">
        <div className="col-xl-3 col-sm-6"><StatCard label="Orders (30 days)" value={stats?.orders ?? "—"} icon="solar:bag-3-outline" hint={stats ? `${stats.completed} completed` : undefined} /></div>
        <div className="col-xl-3 col-sm-6"><StatCard label="Sales (30 days)" value={stats ? money(stats.sales) : "—"} icon="solar:wallet-money-outline" tone="success" hint={stats ? `AOV ${money(stats.avgOrderValue)}` : undefined} /></div>
        <div className="col-xl-3 col-sm-6"><StatCard label="Rating" value={r.ratingCount ? Number(r.rating).toFixed(2) : "—"} icon="solar:star-outline" tone="warning" hint={`${r.ratingCount} reviews`} /></div>
        <div className="col-xl-3 col-sm-6"><StatCard label="Reliability" value={r.reliabilityScore != null ? Math.round(r.reliabilityScore) : "—"} icon="solar:shield-check-outline" tone="purple" /></div>
      </div>
      <div className="row gy-4">
        <div className="col-lg-7">
          <Card title="Profile" actions={can("restaurants", "edit") && <Button variant="light" icon="solar:pen-outline" onClick={openEdit}>Edit</Button>}>
            <KeyValue
              items={[
                { label: "Kind of store", value: <StoreTypeBadge type={r.storeType} /> },
                { label: "Phone", value: r.phone },
                { label: "Email", value: r.email },
                { label: "Website", value: r.website },
                { label: "HST number", value: r.hstNumber },
                { label: "Address", value: [r.addressLine1, r.addressLine2, r.city, r.province, r.postalCode].filter(Boolean).join(", ") },
                { label: "Zone", value: r.zone?.name },
                { label: "Cuisines", value: (r.cuisines || []).map((c) => c.name).join(", ") },
                { label: "Price level", value: "$".repeat(r.priceLevel || 1) },
                { label: "Payout schedule", value: titleCase(r.payoutSchedule) },
                { label: "Went live", value: fmtDate(r.wentLiveAt) },
                { label: "Featured", value: <BoolBadge value={r.isFeatured} /> },
                { label: "Tablet", value: r.tabletActivated ? "Activated" : r.tabletCode ? `Code ${r.tabletCode}` : "Not issued" },
              ]}
            />
            {r.description && <p className="text-secondary-light mt-16 mb-0">{r.description}</p>}
          </Card>
        </div>
        <div className="col-lg-5">
          <Card title="Fulfilment">
            <KeyValue
              cols={1}
              items={[
                { label: "Channels", value: fulfil.length ? fulfil.map((f) => <Badge key={f} tone="primary" className="me-2">{f}</Badge>) : "None enabled" },
                { label: "Prep time", value: `${r.prepTimeMin} min delivery · ${r.pickupPrepTimeMin} min pickup` },
                { label: "Delivery radius", value: `${r.deliveryRadiusKm} km` },
                { label: "Minimum order", value: money(r.minimumOrder) },
                { label: "Auto-reject after", value: `${r.autoRejectSeconds}s` },
                { label: "Busy mode", value: r.busyExtraPrepMin ? `+${r.busyExtraPrepMin} min` : "Off" },
                { label: "Kitchen display", value: <BoolBadge value={r.kdsEnabled} yes="Enabled" no="Disabled" /> },
              ]}
            />
          </Card>
        </div>
      </div>
      <FormModal open={edit} onClose={() => setEdit(false)} title="Edit restaurant" onSubmit={save} busy={busy}>
        <FormRow>
          <TextInput col={12} label="Name" {...form.bind("name")} />
          <Select col={12} label="Kind of store" allowEmpty={false} hint="Changes how the catalog and orders work, the documents asked for and the commission tier used when the location has none of its own." options={STORE_TYPES.map((t) => ({ value: t.value, label: t.label }))} {...form.bind("storeType")} />
          <TextInput col={6} label="Phone" {...form.bind("phone")} />
          <TextInput col={6} label="Email" {...form.bind("email")} />
          <TextInput col={12} label="Website" {...form.bind("website")} />
          <TextArea col={12} label="Description" {...form.bind("description")} />
          <NumberInput col={4} label="Minimum order" prefix="$" {...form.bind("minimumOrder")} />
          <NumberInput col={4} label="Prep time (min)" {...form.bind("prepTimeMin")} />
          <NumberInput col={4} label="Reliability (0-100)" min={0} max={100} {...form.bind("reliabilityScore")} />
          <Switch label="Featured" checked={form.values.isFeatured} onChange={(x) => form.set("isFeatured", x)} />
        </FormRow>
      </FormModal>
    </>
  );
}

// ------------------------------------------------------------------ hours
export function HoursTab({ r, reload }) {
  const { can } = useAuth();
  const canEdit = can("restaurants", "edit");
  const { busy, run } = useSubmit();
  const mk = () => DAYS.map((_, d) => r.hours?.find((h) => h.dayOfWeek === d) || { dayOfWeek: d, openTime: "09:00", closeTime: "21:00", closed: true });
  const [rows, setRows] = useState(mk);
  useEffect(() => setRows(mk()), [r.hours]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (i, patch) => setRows((x) => x.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const closures = useFetch(api(r, "/closures"));
  const [cl, setCl] = useState(null);
  const confirm = useConfirm();

  const save = () =>
    run(() => http.patch(api(r, "/hours"), { hours: rows.map(({ dayOfWeek, openTime, closeTime, closed }) => ({ dayOfWeek, openTime, closeTime, closed: !!closed })) }), { success: "Hours saved", onDone: reload });
  const addClosure = () =>
    run(() => http.post(api(r, "/closures"), { startDate: cl.startDate, endDate: cl.endDate || cl.startDate, closed: true, reason: cl.reason || undefined }), {
      success: "Closure added",
      onDone: () => {
        setCl(null);
        closures.reload();
      },
    });
  const delClosure = async (c) => {
    const x = await confirm({ title: "Remove this closure?", danger: true, confirmText: "Remove" });
    if (x.confirmed) run(() => http.del(api(r, `/closures/${c.id}`)), { success: "Closure removed", onDone: closures.reload });
  };

  return (
    <div className="row gy-4">
      <div className="col-lg-7">
        <Card title="Weekly opening hours" actions={canEdit && <Button loading={busy} onClick={save}>Save hours</Button>}>
          <table className="table mb-0 align-middle">
            <tbody>
              {rows.map((h, i) => (
                <tr key={h.dayOfWeek}>
                  <td className="fw-medium" style={{ width: 120 }}>{DAYS[h.dayOfWeek]}</td>
                  <td style={{ width: 110 }}>
                    <div className="form-check form-switch">
                      <input className="form-check-input" type="checkbox" disabled={!canEdit} checked={!h.closed} onChange={(e) => set(i, { closed: !e.target.checked })} />
                    </div>
                  </td>
                  <td>
                    {h.closed ? (
                      <span className="text-secondary-light">Closed</span>
                    ) : (
                      <div className="d-flex align-items-center gap-2">
                        <input type="time" className="form-control form-control-sm radius-8 w-auto" disabled={!canEdit} value={h.openTime || ""} onChange={(e) => set(i, { openTime: e.target.value })} />
                        <span>to</span>
                        <input type="time" className="form-control form-control-sm radius-8 w-auto" disabled={!canEdit} value={h.closeTime || ""} onChange={(e) => set(i, { closeTime: e.target.value })} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
      <div className="col-lg-5">
        <Card title="Closures & holidays" actions={canEdit && <Button variant="light" onClick={() => setCl({ startDate: "", endDate: "", reason: "" })}>+ Add</Button>}>
          {closures.loading && !closures.data ? (
            <Loading minHeight={80} />
          ) : closures.error ? (
            <ErrorState error={closures.error} onRetry={closures.reload} />
          ) : listOf(closures.data).length === 0 ? (
            <EmptyState title="No closures scheduled" />
          ) : (
            <ul className="list-unstyled mb-0">
              {listOf(closures.data).map((c) => (
                <li key={c.id} className="d-flex justify-content-between align-items-center py-8 border-bottom">
                  <div>
                    <div className="fw-medium">{fmtDate(c.startDate)}{c.endDate !== c.startDate ? ` – ${fmtDate(c.endDate)}` : ""}</div>
                    <div className="text-secondary-light text-sm">{c.reason || (c.closed ? "Closed" : `${c.openTime}-${c.closeTime}`)}</div>
                  </div>
                  {canEdit && <Button variant="link" className="text-danger-600" onClick={() => delClosure(c)}>Remove</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <FormModal open={!!cl} onClose={() => setCl(null)} title="Add closure" onSubmit={addClosure} busy={busy} disabled={!cl?.startDate}>
        <FormRow>
          <div className="col-md-6 mb-16"><label className="form-label fw-semibold text-sm">From</label><input type="date" className="form-control radius-8" value={cl?.startDate || ""} onChange={(e) => setCl({ ...cl, startDate: e.target.value })} /></div>
          <div className="col-md-6 mb-16"><label className="form-label fw-semibold text-sm">To (optional)</label><input type="date" className="form-control radius-8" value={cl?.endDate || ""} onChange={(e) => setCl({ ...cl, endDate: e.target.value })} /></div>
          <TextInput col={12} label="Reason" value={cl?.reason} onChange={(x) => setCl({ ...cl, reason: x })} />
        </FormRow>
      </FormModal>
    </div>
  );
}

// ------------------------------------------------------------------ menu (read-only) + CSV import / export (admin team only)
function saveCsv(csv, filename) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Import a menu / catalog from a CSV file. "Check file" validates and changes nothing; "Replace" wipes the existing menu first. */
function MenuImportModal({ r, open, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState("merge");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState(null);
  const [result, setResult] = useState(null);
  const confirm = useConfirm();
  useEffect(() => {
    if (open) {
      setFile(null);
      setMode("merge");
      setProblems(null);
      setResult(null);
    }
  }, [open]);
  if (!open) return null;
  const send = async (dryRun) => {
    setBusy(true);
    setProblems(null);
    setResult(null);
    try {
      const csv = await file.text();
      const res = await http.post(api(r, "/menu/import"), { csv, mode, dryRun });
      setResult({ ...res, dryRun });
      if (!dryRun) onDone();
    } catch (e) {
      const d = e?.response?.data;
      setProblems(Array.isArray(d?.details) && d.details.length ? d.details.map((x) => (typeof x === "string" ? x : `row ${x.row}: ${x.error}`)) : [errorMessage(e)]);
    } finally {
      setBusy(false);
    }
  };
  const importNow = async () => {
    if (mode === "replace") {
      const x = await confirm({ title: "Replace the whole menu?", message: `Every category, item and modifier group of ${r.name} is deleted first, then the file is imported. Export the current menu before you do this.`, confirmText: "Replace menu", danger: true });
      if (!x.confirmed) return;
    }
    send(false);
  };
  return (
    <FormModal open onClose={onClose} title={`Import menu - ${r.name}`} onSubmit={result && !result.dryRun ? onClose : importNow} busy={busy} submitText={result && !result.dryRun ? "Close" : mode === "replace" ? "Replace menu" : "Import"} disabled={!(result && !result.dryRun) && !file} size="lg">
      {result && !result.dryRun ? (
        <div className="alert alert-success radius-8" data-testid="import-result">Imported: <strong>{result.created}</strong> new, <strong>{result.updated}</strong> updated.</div>
      ) : (
        <>
          <p className="text-secondary-light text-sm">
            Use the template or an export of this store to get the columns (category, name, price, sizes and options in <code>modifier_groups</code>, <code>spice_level</code>, <code>length_cm</code>, <code>width_cm</code>, <code>height_cm</code>, <code>allergens</code>, <code>may_contain</code>, <code>nutrition</code>, stock, age limit...).
            Items are matched by <strong>SKU</strong>, otherwise category + name. In <em>merge</em> only the columns that are in the file and filled in change anything. A file with a mistake is refused as a whole.
          </p>
          <input type="file" accept=".csv,text/csv" className="form-control radius-8 mb-16" onChange={(e) => { setFile(e.target.files?.[0] || null); setResult(null); setProblems(null); }} data-testid="import-file" />
          <Select label="Mode" allowEmpty={false} value={mode} onChange={setMode} options={[{ value: "merge", label: "Merge: add new items and update matching ones" }, { value: "replace", label: "Replace: delete the whole menu first" }]} />
          <Button variant="outline" disabled={!file || busy} onClick={() => send(true)}>Check file</Button>
          {result?.dryRun && <div className="alert alert-info radius-8 mt-16 mb-0" data-testid="import-check">The file is valid: {result.total} row(s) ready to import.</div>}
          {problems && (
            <div className="alert alert-danger radius-8 mt-16 mb-0" data-testid="import-errors">
              <div className="fw-semibold mb-4">Nothing was imported:</div>
              <ul className="mb-0 ps-3">{problems.slice(0, 15).map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
        </>
      )}
    </FormModal>
  );
}

export function MenuTab({ r }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useFetch(api(r, "/menu"));
  const [imp, setImp] = useState(false);
  const download = async (path, name) => {
    try {
      const res = await http.get(path);
      saveCsv(res.csv, name);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const slug = (r.slug || r.name || "menu").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const toolbar = (
    <div className="d-flex flex-wrap gap-2 mb-16" data-testid="menu-csv-tools">
      <Button variant="outline" icon="solar:download-minimalistic-outline" onClick={() => download(api(r, "/menu/export"), `${slug}-menu.csv`)}>Export CSV</Button>
      <Button variant="outline" icon="solar:file-text-outline" onClick={() => download("/admin/restaurants/menu/template", "menu-template.csv")}>Download template</Button>
      {can("restaurants", "edit") && <Button icon="solar:upload-minimalistic-outline" onClick={() => setImp(true)}>Import CSV</Button>}
      <MenuImportModal r={r} open={imp} onClose={() => setImp(false)} onDone={reload} />
    </div>
  );
  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const cats = data?.categories || [];
  const uncategorized = data?.uncategorized || [];
  const counts = data?.counts;
  if (!cats.length && !uncategorized.length) return <>{toolbar}<EmptyState icon="solar:chef-hat-outline" title="No menu yet" text="The restaurant has not added any menu items. Import a CSV file to add one." /></>;
  const table = (items) => (
    <div className="table-responsive">
      <table className="table bordered-table sm-table mb-0 align-middle">
        <thead>
          <tr><th>Item</th><th>Price</th><th>Pickup</th><th>Tax</th><th>Station</th><th>Tags</th><th>Status</th></tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td>
                <div className="fw-medium">{i.name} {i.isPopular && <Icon icon="solar:fire-bold" className="text-warning-main" />}</div>
                {i.description && <div className="text-secondary-light text-xs">{i.description}</div>}
              </td>
              <td>{money(i.price)}</td>
              <td>{money(i.pickupPrice)}</td>
              <td>{i.taxClassCode}</td>
              <td>{i.stationName || "—"}</td>
              <td>{[i.spiceLevel && i.spiceLevel !== "NONE" ? `spice: ${i.spiceLevel.toLowerCase().replace("_", " ")}` : null, ...(i.dietaryTags || []), ...(i.allergens || []).map((a) => `⚠ ${a}`), ...(i.mayContain || []).map((a) => `may contain ${a}`)].filter(Boolean).join(", ") || "—"}</td>
              <td>{!i.active ? <Badge>Inactive</Badge> : i.available ? <Badge tone="success">Available</Badge> : <Badge tone="warning">86'd</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      {toolbar}
      {counts && (
        <div className="text-secondary-light text-sm mb-16">
          {Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(" · ")}
        </div>
      )}
      {cats.map((c) => (
        <div key={c.id} className="mb-24">
          <h6 className="text-md fw-semibold mb-12">{c.name} {!c.active && <Badge>Hidden</Badge>} <span className="text-secondary-light fw-normal text-sm">({(c.items || []).length})</span></h6>
          {(c.items || []).length ? table(c.items) : <div className="text-secondary-light text-sm">No items</div>}
        </div>
      ))}
      {uncategorized.length > 0 && (
        <div className="mb-24">
          <h6 className="text-md fw-semibold mb-12">Uncategorized</h6>
          {table(uncategorized)}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ members
export function MembersTab({ r }) {
  const { can } = useAuth();
  const canEdit = can("restaurants", "edit");
  const { data, loading, error, reload } = useFetch(api(r, "/members"));
  const confirm = useConfirm();
  const { busy, run } = useSubmit();
  const [add, setAdd] = useState(false);
  const [pw, setPw] = useState(null);
  const form = useForm({ firstName: "", lastName: "", email: "", phone: "", role: "CASHIER" });

  const create = () => {
    const v = form.values;
    run(() => http.post(api(r, "/members"), { ...v, phone: v.phone || undefined, restaurantId: v.role === "OWNER" ? undefined : r.id }), {
      success: "Member added",
      onDone: (res) => {
        setAdd(false);
        form.reset({ firstName: "", lastName: "", email: "", phone: "", role: "CASHIER" });
        if (res?.temporaryPassword) setPw(res.temporaryPassword);
        reload();
      },
    });
  };
  const reset = async (m) => {
    const x = await confirm({ title: `Reset password for ${m.firstName}?`, confirmText: "Reset" });
    if (x.confirmed) run(() => restaurantPost(r.id, `members/${m.id}/reset-password`), { onDone: (res) => setPw(res?.temporaryPassword) });
  };
  const deactivate = async (m) => {
    const x = await confirm({ title: `Deactivate ${m.firstName} ${m.lastName}?`, danger: true, confirmText: "Deactivate" });
    if (x.confirmed) run(() => http.del(api(r, `/members/${m.id}`)), { success: "Member deactivated", onDone: reload });
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const rows = listOf(data);
  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-16">
        <span className="text-secondary-light text-sm">{rows.length} member(s) with access to this location</span>
        {can("restaurants", "create") && <Button onClick={() => setAdd(true)}>+ Add member</Button>}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No members" />
      ) : (
        <div className="table-responsive">
          <table className="table bordered-table mb-0 align-middle">
            <thead><tr><th>Name</th><th>Role</th><th>Location</th><th>Status</th><th>Last login</th><th /></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td><div className="fw-medium">{m.firstName} {m.lastName}</div><div className="text-secondary-light text-xs">{m.email}{m.phone ? ` · ${m.phone}` : ""}</div></td>
                  <td><Badge tone="primary">{titleCase(m.role)}</Badge></td>
                  <td>{m.restaurantName}</td>
                  <td><StatusBadge status={m.active ? "ACTIVE" : "DEACTIVATED"} /></td>
                  <td>{m.lastLoginAt ? timeAgo(m.lastLoginAt) : "Never"}</td>
                  <td className="text-end">
                    {canEdit && m.active && (
                      <div className="d-flex gap-2 justify-content-end">
                        <Button variant="light" onClick={() => reset(m)}>Reset password</Button>
                        <Button variant="outline-danger" onClick={() => deactivate(m)}>Deactivate</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <FormModal open={add} onClose={() => setAdd(false)} title="Add member" onSubmit={create} busy={busy} disabled={!form.values.firstName || !form.values.lastName || !form.values.email}>
        <FormRow>
          <TextInput col={6} label="First name" required {...form.bind("firstName")} />
          <TextInput col={6} label="Last name" required {...form.bind("lastName")} />
          <TextInput col={6} label="Email" type="email" required {...form.bind("email")} />
          <TextInput col={6} label="Phone" {...form.bind("phone")} />
          <Select col={12} label="Role" allowEmpty={false} options={["OWNER", "LOCATION_MANAGER", "CASHIER", "KITCHEN"]} {...form.bind("role")} />
        </FormRow>
      </FormModal>
      <Modal open={!!pw} onClose={() => setPw(null)} title="Temporary password" footer={<Button onClick={() => setPw(null)}>Done</Button>}>
        <p>Share this password securely. It is shown only once.</p>
        <div className="p-12 radius-8 bg-neutral-200 fw-semibold font-monospace user-select-all">{pw}</div>
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------ documents / onboarding
export function DocumentsTab({ r, reload }) {
  const { can } = useAuth();
  const canApprove = can("restaurants", "approve");
  const confirm = useConfirm();
  const { busy, run } = useSubmit();
  const docs = useFetch(api(r, "/documents"));
  const checklist = useFetch(api(r, "/documents/checklist"));
  const [agree, setAgree] = useState(null);
  const refresh = () => {
    docs.reload();
    checklist.reload();
    reload();
  };

  const approve = async (d) => {
    const x = await confirm({ title: `Approve ${titleCase(d.type)}?`, confirmText: "Approve", prompt: { label: "Expiry date (optional)", type: "date", defaultValue: d.expiresAt ? String(d.expiresAt).slice(0, 10) : "" } });
    if (x.confirmed) run(() => restaurantPost(r.id, `documents/${d.id}/approve`, x.value ? { expiresAt: x.value } : {}), { success: "Document approved", onDone: refresh });
  };
  const reject = async (d) => {
    const x = await confirm({ title: `Reject ${titleCase(d.type)}?`, danger: true, confirmText: "Reject", prompt: { label: "Reason (sent to the owner)", type: "textarea", required: true } });
    if (x.confirmed) run(() => restaurantPost(r.id, `documents/${d.id}/reject`, { reason: x.value }), { success: "Document rejected", onDone: refresh });
  };
  const approveReview = () => run(() => restaurantPost(r.id, "docs-review/approve"), { success: "Documents approved, restaurant moved to menu setup", onDone: refresh });
  const signAgreement = () =>
    run(() => restaurantPost(r.id, "agreement", { signedBy: agree.signedBy, notes: agree.notes || undefined }), {
      success: "Agreement recorded",
      onDone: () => {
        setAgree(null);
        refresh();
      },
    });

  if ((docs.loading && !docs.data) || (checklist.loading && !checklist.data)) return <Loading />;
  if (docs.error) return <ErrorState error={docs.error} onRetry={docs.reload} />;
  const cl = checklist.data;
  const rows = listOf(docs.data);
  const today = new Date();

  return (
    <>
      {cl && (
        <Card className="mb-24" title="Required documents" subtitle={`${cl.approved} of ${cl.total} approved`} actions={
          <>
            {can("restaurants", "edit") && <Button variant="light" onClick={() => setAgree({ signedBy: "", notes: "" })}>Record signed agreement</Button>}
            {canApprove && ["APPLIED", "DOCS_REVIEW"].includes(r.status) && (
              <Button variant="success" loading={busy} disabled={!cl.allApproved} onClick={approveReview} title={cl.allApproved ? "" : "All required documents must be approved first"}>
                Complete documents review
              </Button>
            )}
          </>
        }>
          <Progress value={cl.approved} max={cl.total || 1} tone="success" />
          <div className="row gy-2 mt-12">
            {cl.items.map((i) => (
              <div className="col-md-4" key={i.type}>
                <div className="d-flex justify-content-between align-items-center border radius-8 px-12 py-8">
                  <span className="fw-medium text-sm">{titleCase(i.type)}{i.required ? " *" : ""}</span>
                  <StatusBadge status={i.status || "PENDING"} label={i.status ? undefined : "Missing"} tone={i.status ? undefined : "neutral"} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card title="Uploaded documents" noPadding>
        {rows.length === 0 ? (
          <EmptyState icon="solar:document-add-outline" title="No documents uploaded yet" text="The owner uploads documents from the restaurant portal." />
        ) : (
          <div className="table-responsive">
            <table className="table bordered-table mb-0 align-middle">
              <thead><tr><th>Type</th><th>File</th><th>Status</th><th>Expires</th><th>Uploaded</th><th /></tr></thead>
              <tbody>
                {rows.map((d) => {
                  const exp = d.expiresAt ? new Date(d.expiresAt) : null;
                  const soon = exp && (exp - today) / 86400000 < 30;
                  return (
                    <tr key={d.id}>
                      <td className="fw-medium">{titleCase(d.type)}</td>
                      <td><a href={assetUrl(d.fileUrl)} target="_blank" rel="noopener noreferrer" className="text-primary-600">{d.fileName || "View file"}</a></td>
                      <td><StatusBadge status={d.status} />{d.rejectReason && <div className="text-danger-600 text-xs mt-1">{d.rejectReason}</div>}</td>
                      <td>{exp ? <span className={soon ? "text-danger-600 fw-medium" : ""}>{fmtDate(d.expiresAt)}{soon ? (exp < today ? " (expired)" : " (soon)") : ""}</span> : "—"}</td>
                      <td>{fmtDate(d.createdAt)}</td>
                      <td className="text-end">
                        {canApprove && (
                          <div className="d-flex gap-2 justify-content-end">
                            {d.status !== "APPROVED" && <Button variant="success" onClick={() => approve(d)}>Approve</Button>}
                            {d.status !== "REJECTED" && <Button variant="outline-danger" onClick={() => reject(d)}>Reject</Button>}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <FormModal open={!!agree} onClose={() => setAgree(null)} title="Record signed agreement" onSubmit={signAgreement} busy={busy} disabled={!agree?.signedBy}>
        <TextInput label="Signed by" required value={agree?.signedBy} onChange={(x) => setAgree({ ...agree, signedBy: x })} />
        <TextArea label="Notes" value={agree?.notes} onChange={(x) => setAgree({ ...agree, notes: x })} />
      </FormModal>
    </>
  );
}

// ------------------------------------------------------------------ commission
export function CommissionTab({ r, reload }) {
  const { can } = useAuth();
  const { tiers } = useLookups();
  const { busy, run } = useSubmit();
  const init = () => ({ commissionTierId: r.commissionTierId || "", deliveryCommissionPct: r.deliveryCommissionPct ?? "", pickupCommissionPct: r.pickupCommissionPct ?? "", ownDriverCommissionPct: r.ownDriverCommissionPct ?? "" });
  const form = useForm(init());
  useEffect(() => form.reset(init()), [r]); // eslint-disable-line react-hooks/exhaustive-deps
  const v = form.values;
  const tier = tiers.find((t) => t.id === v.commissionTierId) || r.commissionTier;
  const nn = (x) => (x === "" || x === undefined ? null : Number(x));
  const eff = (o, base) => (o === "" || o == null ? base : o);

  const save = () =>
    run(() => http.patch(api(r, "/commission"), { commissionTierId: v.commissionTierId || null, deliveryCommissionPct: nn(v.deliveryCommissionPct), pickupCommissionPct: nn(v.pickupCommissionPct), ownDriverCommissionPct: nn(v.ownDriverCommissionPct) }), {
      success: "Commission updated",
      onDone: reload,
    });
  const canEdit = can("restaurants", "edit");

  return (
    <div className="row gy-4">
      <div className="col-lg-6">
        <Card title="Commission tier & overrides" actions={canEdit && <Button loading={busy} onClick={save}>Save</Button>}>
          <Select label="Commission tier" placeholder="No tier" disabled={!canEdit} options={tiers.map((t) => ({ value: t.id, label: `${t.name}${t.isDefault ? " (default)" : ""}` }))} {...form.bind("commissionTierId")} />
          <div className="text-sm fw-semibold mb-8">Per-restaurant overrides</div>
          <div className="text-secondary-light text-xs mb-12">Leave empty to use the tier rate.</div>
          <FormRow>
            <PercentInput col={4} label="Delivery" disabled={!canEdit} max={100} {...form.bind("deliveryCommissionPct")} />
            <PercentInput col={4} label="Pickup" disabled={!canEdit} max={100} {...form.bind("pickupCommissionPct")} />
            <PercentInput col={4} label="Own drivers" disabled={!canEdit} max={100} {...form.bind("ownDriverCommissionPct")} />
          </FormRow>
        </Card>
      </div>
      <div className="col-lg-6">
        <Card title="Effective rates">
          <table className="table mb-0">
            <thead><tr><th>Order type</th><th>Tier rate</th><th>Override</th><th>Effective</th></tr></thead>
            <tbody>
              {[
                ["Delivery", tier?.deliveryPct, v.deliveryCommissionPct],
                ["Pickup", tier?.pickupPct, v.pickupCommissionPct],
                ["Own drivers", tier?.ownDriverPct, v.ownDriverCommissionPct],
              ].map(([l, base, o]) => (
                <tr key={l}>
                  <td>{l}</td>
                  <td>{base != null ? pct(base, 0) : "—"}</td>
                  <td>{o === "" || o == null ? "—" : pct(o)}</td>
                  <td className="fw-semibold">{eff(o, base) != null ? pct(eff(o, base)) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!tier && <div className="text-warning-main text-sm mt-12">No tier assigned: go-live checks will fail until a tier is set.</div>}
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ location / geo-pin
export function LocationTab({ r, reload }) {
  const { can } = useAuth();
  const { zones, cities } = useLookups();
  const { busy, run } = useSubmit();
  const [geo, setGeo] = useState({ lat: r.lat, lng: r.lng });
  const form = useForm({ addressLine1: r.addressLine1 || "", city: r.city || "", postalCode: r.postalCode || "", zoneId: "" });
  const canEdit = can("restaurants", "edit");

  const save = () => {
    const v = form.values;
    run(() => http.patch(api(r, "/location"), { lat: geo.lat, lng: geo.lng, addressLine1: v.addressLine1 || undefined, city: v.city || undefined, postalCode: v.postalCode || undefined, zoneId: v.zoneId || undefined }), { success: "Location updated", onDone: reload });
  };
  const hasPin = geo?.lat != null && geo?.lng != null;
  return (
    <div className="row gy-4">
      <div className="col-lg-7">
        <Card title="Geo-pin" subtitle={canEdit ? "Find the address, or click the map / drag the pin to adjust" : undefined}>
          {canEdit && <AddressFinder proximity={hasPin ? `${geo.lng},${geo.lat}` : undefined} onPick={(a) => { setGeo({ lat: a.lat, lng: a.lng }); form.setValues((x) => ({ ...x, addressLine1: a.line1 || x.addressLine1, city: a.city || x.city, postalCode: a.postalCode || x.postalCode })); }} />}
          {hasPin ? (
            canEdit ? (
              <LocationPicker value={geo} onChange={setGeo} height={380} />
            ) : (
              <LocationPicker value={geo} height={380} />
            )
          ) : (
            <EmptyState title="No coordinates yet" text="Set a pin to allow zone resolution and delivery routing." action={canEdit && <Button onClick={() => setGeo({ lat: 43.589, lng: -79.6441 })}>Place pin</Button>} />
          )}
          {hasPin && <div className="text-secondary-light text-sm mt-8">{Number(geo.lat).toFixed(5)}, {Number(geo.lng).toFixed(5)}</div>}
        </Card>
      </div>
      <div className="col-lg-5">
        <Card title="Address & zone" actions={canEdit && <Button loading={busy} disabled={!hasPin} onClick={save}>Save location</Button>}>
          <TextInput label="Address" disabled={!canEdit} {...form.bind("addressLine1")} />
          <FormRow>
            <TextInput col={6} label="City" disabled={!canEdit} {...form.bind("city")} />
            <TextInput col={6} label="Postal code" disabled={!canEdit} {...form.bind("postalCode")} />
          </FormRow>
          <Select label="Zone" disabled={!canEdit} placeholder="Auto-detect from pin" options={zones.map((z) => ({ value: z.id, label: `${z.name}${cities.length > 1 ? ` (${z.city?.name || ""})` : ""}` }))} {...form.bind("zoneId")} hint={`Current zone: ${r.zone?.name || "none"}`} />
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ performance
export function PerformanceTab({ r }) {
  const [days, setDays] = useState(30);
  const { data: s, loading, error, reload } = useFetch(api(r, "/stats"), { days });
  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-16">
        <span className="text-secondary-light text-sm">{s ? `${fmtDate(s.period.from)} – ${fmtDate(s.period.to)}` : ""}</span>
        <select className="form-select form-select-sm w-auto radius-8" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 30, 90, 180].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>
      {error && <ErrorState error={error} onRetry={reload} />}
      {loading && !s ? (
        <Loading />
      ) : s ? (
        <>
          <div className="row gy-3 mb-24">
            <div className="col-xl-3 col-sm-6"><StatCard label="Orders" value={s.orders} icon="solar:bag-3-outline" hint={`${s.completed} completed`} /></div>
            <div className="col-xl-3 col-sm-6"><StatCard label="Sales" value={money(s.sales)} icon="solar:wallet-money-outline" tone="success" hint={`AOV ${money(s.avgOrderValue)}`} /></div>
            <div className="col-xl-3 col-sm-6"><StatCard label="Avg prep time" value={s.avgPrepMinutes != null ? `${s.avgPrepMinutes} min` : "—"} icon="solar:clock-circle-outline" tone="warning" hint={`Accepts in ${s.avgAcceptSeconds ?? "—"}s`} /></div>
            <div className="col-xl-3 col-sm-6"><StatCard label="Avg rating" value={s.avgRating ?? "—"} icon="solar:star-outline" tone="purple" hint={`${s.ratingCount} reviews`} /></div>
          </div>
          <div className="row gy-4">
            <div className="col-lg-6">
              <Card title="Service quality">
                <div className="d-flex flex-column gap-3">
                  <Progress label="Acceptance rate" value={s.acceptanceRate} tone="success" />
                  <Progress label="Prep-time accuracy" value={s.prepAccuracy} tone="info" />
                  <Progress label="Reliability score" value={s.reliabilityScore} tone="primary" />
                </div>
              </Card>
            </div>
            <div className="col-lg-6">
              <Card title="Problems">
                <KeyValue
                  items={[
                    { label: "Rejected by restaurant", value: s.rejected },
                    { label: "Cancelled", value: `${s.cancelled} (${pct(s.cancellationRate)})` },
                    { label: "Cancelled after accept", value: s.cancelledAfterAccept },
                    { label: "Error rate", value: `${pct(s.errorRate)} (${s.errorOrders} orders)` },
                  ]}
                />
              </Card>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------------ reviews
export function ReviewsTab({ r }) {
  // The admin reviews endpoint is preferred; when it is unavailable fall back to the restaurant's public reviews (still moderatable by id).
  const [mode, setMode] = useState(null);
  useEffect(() => {
    let live = true;
    http.get("/admin/restaurants/reviews", { restaurantId: r.id, limit: 1 }).then(
      () => live && setMode("admin"),
      () => live && setMode("public")
    );
    return () => {
      live = false;
    };
  }, [r.id]);
  if (!mode) return <Loading />;
  return <ReviewsList r={r} mode={mode} />;
}

function ReviewsList({ r, mode }) {
  const admin = mode === "admin";
  const list = usePagedList(admin ? "/admin/restaurants/reviews" : `/public/restaurants/${r.slug}/reviews`, { filters: admin ? { restaurantId: r.id, status: "", maxRating: "" } : {} });
  const summary = useFetch(admin ? `/admin/ratings/restaurants/${r.id}/summary` : null);
  return (
    <>
      {admin && <RestaurantRatingSummary state={summary} staff />}
      <ReviewsTable list={list} simple={!admin} />
    </>
  );
}
