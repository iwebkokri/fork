import React, { useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, FormModal, IconButton, Loading, NumberInput, PageHeader, Select, Switch, Tabs, TextArea, TextInput, useConfirm } from "../../ui";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { http } from "../../lib/api";
import { fmtDateTime, titleCase } from "../../lib/format";

/** choices for `select` settings (the API does not expose them) */
const SELECT_OPTIONS = {
  "general.defaultLanguage": ["en", "fr"],
  "general.distanceUnit": ["km", "mi"],
  "notifications.emailProvider": ["smtp", "sendgrid", "ses"],
  "notifications.pushProvider": ["fcm", "apns"],
  "notifications.smsProvider": ["twilio"],
  "orders.freeCancelUntil": ["PLACED", "ACCEPTED", "PREPARING"],
  "payments.provider": ["stripe"],
};

function JsonField({ s, value, onChange, disabled }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [err, setErr] = useState(null);
  useEffect(() => {
    // reset when the saved value is reloaded
    setText(JSON.stringify(value ?? null, null, 2));
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.updatedAt]);
  return (
    <div className="mb-16">
      <label className="form-label fw-semibold text-sm">{s.label}</label>
      <textarea
        className={`form-control radius-8 font-monospace text-sm ${err ? "is-invalid" : ""}`}
        rows={Math.min(14, text.split("\n").length + 1)}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value), false);
            setErr(null);
          } catch {
            setErr("Invalid JSON");
            onChange(undefined, true);
          }
        }}
      />
      {err && <div className="invalid-feedback d-block">{err}</div>}
    </div>
  );
}

function SettingInput({ s, value, onChange, disabled }) {
  const common = { label: s.label, hint: s.description || s.key, disabled };
  switch (s.inputType) {
    case "boolean":
      return <Switch label={s.label} hint={s.key} checked={!!value} onChange={onChange} disabled={disabled} />;
    case "number":
      return <NumberInput {...common} value={value} onChange={(x) => onChange(x === "" || x === null ? null : Number(x))} />;
    case "textarea":
      return <TextArea {...common} value={value ?? ""} onChange={onChange} />;
    case "password":
      return <TextInput {...common} type="password" autoComplete="new-password" placeholder={s.isSecret ? "Secret - leave blank to keep the current value" : ""} value={value ?? ""} onChange={onChange} />;
    case "json":
      return <JsonField s={s} value={value} onChange={onChange} disabled={disabled} />;
    case "select": {
      const opts = SELECT_OPTIONS[s.key];
      if (opts) return <Select {...common} allowEmpty={false} options={opts.includes(value) ? opts : [...opts, value].filter(Boolean)} value={value ?? ""} onChange={onChange} />;
      return <TextInput {...common} value={value ?? ""} onChange={onChange} />;
    }
    default:
      return <TextInput {...common} value={value ?? ""} onChange={onChange} />;
  }
}

function SettingsTab({ canEdit }) {
  const { data, loading, error, reload } = useFetch("/admin/settings");
  const [edits, setEdits] = useState({});
  const [bad, setBad] = useState({});
  const [group, setGroup] = useState(null);
  const { busy, run } = useSubmit();

  const rows = data?.data || [];
  const groups = data?.groups || [];
  const active = group || groups[0];
  const inGroup = useMemo(() => rows.filter((r) => r.group === active), [rows, active]);
  const dirtyKeys = Object.keys(edits);
  const dirtyIn = (g) => dirtyKeys.filter((k) => rows.find((r) => r.key === k)?.group === g).length;
  const hasBad = Object.values(bad).some(Boolean);

  const set = (s) => (val, invalid) => {
    setBad((b) => ({ ...b, [s.key]: !!invalid }));
    if (invalid) return;
    // secrets: blank means unchanged
    if (s.isSecret && (val === "" || val == null)) {
      setEdits((e) => {
        const { [s.key]: _drop, ...rest } = e;
        return rest;
      });
      return;
    }
    setEdits((e) => {
      if (JSON.stringify(val) === JSON.stringify(s.value)) {
        const { [s.key]: _drop, ...rest } = e;
        return rest;
      }
      return { ...e, [s.key]: val };
    });
  };

  const save = () =>
    run(() => http.put("/admin/settings", { values: edits }), {
      success: `${dirtyKeys.length} setting${dirtyKeys.length > 1 ? "s" : ""} saved`,
      onDone: () => {
        setEdits({});
        setBad({});
        reload();
      },
    });

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!groups.length) return <EmptyState title="No settings defined" />;

  return (
    <div className="row gy-4">
      <div className="col-lg-3">
        <Card noPadding>
          <div className="list-group list-group-flush radius-8">
            {groups.map((g) => (
              <button key={g} type="button" className={`list-group-item list-group-item-action d-flex justify-content-between align-items-center ${g === active ? "bg-primary-600 text-white border-primary-600" : ""}`} onClick={() => setGroup(g)}>
                {titleCase(g)}
                {dirtyIn(g) > 0 && <Badge tone="warning">{dirtyIn(g)}</Badge>}
              </button>
            ))}
          </div>
        </Card>
      </div>
      <div className="col-lg-9">
        <Card
          title={titleCase(active)}
          subtitle={`${inGroup.length} settings`}
          actions={
            canEdit && (
              <div className="d-flex gap-2">
                {dirtyKeys.length > 0 && <Button variant="light" onClick={() => { setEdits({}); setBad({}); reload(); }}>Discard</Button>}
                <Button loading={busy} disabled={!dirtyKeys.length || hasBad} onClick={save}>
                  Save {dirtyKeys.length ? `(${dirtyKeys.length})` : "changes"}
                </Button>
              </div>
            )
          }
        >
          <div className="row">
            {inGroup.map((s) => {
              const wide = ["json", "textarea"].includes(s.inputType);
              const value = s.key in edits ? edits[s.key] : s.isSecret ? "" : s.value;
              return (
                <div key={s.key} className={wide ? "col-12" : "col-md-6"}>
                  <SettingInput s={s} value={value} onChange={set(s)} disabled={!canEdit} />
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

function FlagsTab({ canEdit, canCreate, canDelete }) {
  const { data, loading, error, reload } = useFetch("/admin/settings/feature-flags");
  const cities = useFetch("/admin/cities", { limit: 100 });
  const confirm = useConfirm();
  const { busy, run } = useSubmit();
  const [editing, setEditing] = useState(null);
  const form = useForm({ key: "", description: "", rolloutPct: 100, enabled: false });
  const cityName = Object.fromEntries((cities.data?.data || []).map((c) => [c.id, c.name]));

  const toggle = (f) => run(() => http.patch(`/admin/settings/feature-flags/${f.id}`, { enabled: !f.enabled }), { success: `${f.key} ${f.enabled ? "disabled" : "enabled"}`, onDone: reload });
  const save = () =>
    run(
      async () => {
        const v = form.values;
        const body = { description: v.description, rolloutPct: Number(v.rolloutPct), enabled: !!v.enabled };
        if (editing === "new") await http.post("/admin/settings/feature-flags", { ...body, key: v.key });
        else await http.patch(`/admin/settings/feature-flags/${editing.id}`, body);
      },
      { success: "Feature flag saved", onDone: () => { setEditing(null); reload(); } }
    );
  const open = (f) => {
    form.reset(f ? { key: f.key, description: f.description || "", rolloutPct: f.rolloutPct, enabled: f.enabled } : { key: "", description: "", rolloutPct: 100, enabled: false });
    setEditing(f || "new");
  };
  const remove = async (f) => {
    const { confirmed } = await confirm({ title: `Delete flag "${f.key}"?`, confirmText: "Delete", danger: true });
    if (confirmed) run(() => http.del(`/admin/settings/feature-flags/${f.id}`), { success: "Flag deleted", onDone: reload });
  };

  const columns = [
    { key: "key", title: "Flag", render: (f) => (<div><div className="fw-semibold font-monospace">{f.key}</div><div className="text-xs text-secondary-light">{f.description}</div></div>) },
    { key: "enabled", title: "Enabled", render: (f) => <Switch className="mb-0" checked={f.enabled} disabled={!canEdit || busy} onChange={() => toggle(f)} /> },
    { key: "rolloutPct", title: "Rollout", render: (f) => `${f.rolloutPct}%` },
    { key: "cityIds", title: "Cities", render: (f) => (f.cityIds?.length ? f.cityIds.map((c) => cityName[c] || c.slice(0, 6)).join(", ") : <span className="text-secondary-light">All</span>) },
    {
      key: "actions",
      title: "",
      align: "right",
      render: (f) => (
        <div className="d-flex gap-1 justify-content-end">
          {canEdit && <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => open(f)} />}
          {canDelete && <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => remove(f)} />}
        </div>
      ),
    },
  ];

  return (
    <Card noPadding title="Feature flags" subtitle="Turn features on gradually, per percentage and city" actions={canCreate && <Button icon="solar:add-circle-outline" onClick={() => open(null)}>New flag</Button>}>
      {error && <ErrorState error={error} onRetry={reload} />}
      <DataTable columns={columns} rows={data?.data || []} loading={loading} emptyTitle="No feature flags" />
      <FormModal open={!!editing} onClose={() => setEditing(null)} title={editing === "new" ? "New feature flag" : `Edit ${editing?.key}`} onSubmit={save} busy={busy} disabled={!form.values.key}>
        <TextInput label="Key" required disabled={editing !== "new"} hint="snake_case identifier used by the apps" {...form.bind("key")} />
        <TextInput label="Description" {...form.bind("description")} />
        <NumberInput label="Rollout percentage" min={0} max={100} suffix="%" {...form.bind("rolloutPct")} />
        <Switch label="Enabled" checked={!!form.values.enabled} onChange={(x) => form.set("enabled", x)} />
      </FormModal>
    </Card>
  );
}

function VersionsTab({ canEdit }) {
  const { data, loading, error, reload } = useFetch("/admin/settings/app-versions");
  const { busy, run } = useSubmit();
  const [editing, setEditing] = useState(false);
  const form = useForm({ app: "customer", platform: "ios", minVersion: "1.0.0", latestVersion: "1.0.0", forceUpdate: false, storeUrl: "", releaseNotes: "" });
  const v = form.values;
  const open = (row) => {
    form.reset(row ? { app: row.app, platform: row.platform, minVersion: row.minVersion, latestVersion: row.latestVersion, forceUpdate: !!row.forceUpdate, storeUrl: row.storeUrl || "", releaseNotes: row.releaseNotes || "" } : { app: "customer", platform: "ios", minVersion: "1.0.0", latestVersion: "1.0.0", forceUpdate: false, storeUrl: "", releaseNotes: "" });
    setEditing(true);
  };
  const save = () =>
    run(() => http.put("/admin/settings/app-versions", { ...v, storeUrl: v.storeUrl || undefined, releaseNotes: v.releaseNotes || undefined }), { success: "App version saved", onDone: () => { setEditing(false); reload(); } });

  const columns = [
    { key: "app", title: "App", render: (r) => titleCase(r.app) },
    { key: "platform", title: "Platform", render: (r) => (r.platform === "ios" ? "iOS" : "Android") },
    { key: "minVersion", title: "Minimum", render: (r) => <span className="font-monospace">{r.minVersion}</span> },
    { key: "latestVersion", title: "Latest", render: (r) => <span className="font-monospace">{r.latestVersion}</span> },
    { key: "forceUpdate", title: "Force update", render: (r) => (r.forceUpdate ? <Badge tone="danger">Forced</Badge> : <Badge tone="neutral">Optional</Badge>) },
    { key: "updatedAt", title: "Updated", render: (r) => fmtDateTime(r.updatedAt) },
    { key: "a", title: "", align: "right", render: (r) => canEdit && <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => open(r)} /> },
  ];

  return (
    <Card noPadding title="App versions" subtitle="Minimum and latest builds per app and platform" actions={canEdit && <Button icon="solar:add-circle-outline" onClick={() => open(null)}>Set version</Button>}>
      {error && <ErrorState error={error} onRetry={reload} />}
      <DataTable columns={columns} rows={data?.data || []} loading={loading} emptyTitle="No versions configured" emptyText="Apps use their built-in defaults until a version is set." />
      <FormModal open={editing} onClose={() => setEditing(false)} title="App version" onSubmit={save} busy={busy} disabled={!v.minVersion || !v.latestVersion}>
        <div className="row">
          <Select col="col-md-6" label="App" allowEmpty={false} options={["customer", "driver", "restaurant"]} {...form.bind("app")} />
          <Select col="col-md-6" label="Platform" allowEmpty={false} options={[{ value: "ios", label: "iOS" }, { value: "android", label: "Android" }]} {...form.bind("platform")} />
          <TextInput col="col-md-6" label="Minimum version" required {...form.bind("minVersion")} />
          <TextInput col="col-md-6" label="Latest version" required {...form.bind("latestVersion")} />
        </div>
        <TextInput label="Store URL" {...form.bind("storeUrl")} />
        <TextArea label="Release notes" rows={2} {...form.bind("releaseNotes")} />
        <Switch label="Force update (block older builds)" checked={!!v.forceUpdate} onChange={(x) => form.set("forceUpdate", x)} />
      </FormModal>
    </Card>
  );
}

export default function Settings() {
  const { can } = useAuth();
  const [tab, setTab] = useState("settings");
  return (
    <>
      <PageHeader title="Platform Settings" subtitle="Global configuration, feature flags and app versions" crumbs={[{ label: "System" }, { label: "Settings" }]} />
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: "settings", label: "Settings", content: null },
          { key: "flags", label: "Feature flags", content: null },
          { key: "versions", label: "App versions", content: null },
        ]}
      />
      {tab === "settings" && <SettingsTab canEdit={can("settings", "edit")} />}
      {tab === "flags" && <FlagsTab canEdit={can("settings", "edit")} canCreate={can("settings", "create")} canDelete={can("settings", "delete")} />}
      {tab === "versions" && <VersionsTab canEdit={can("settings", "edit")} />}
    </>
  );
}
