import React, { useState } from "react";
import { http } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useFetch, useForm, useSubmit } from "../../lib/hooks";
import { money } from "../../lib/format";
import { AddressFinder, Badge, BoolBadge, Button, Card, FormModal, FormRow, IconButton, MapView, NumberInput, PolygonEditor, Select, Switch, TextInput } from "../../ui";
import { CrudPage, numOrNull, useCityOptions } from "./crud";

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
];
const defaultHours = () => Object.fromEntries(DAYS.map(([k]) => [k, { open: "09:00", close: "22:00", closed: false }]));

function ServiceHours({ value, onChange }) {
  const custom = value && Object.keys(value).length > 0;
  return (
    <div className="mb-16">
      <Switch label="Restrict service hours" hint="Off = the zone serves 24/7." checked={custom} onChange={(on) => onChange(on ? defaultHours() : {})} className="mb-8" />
      {custom &&
        DAYS.map(([k, label]) => {
          const d = value[k] || { open: "09:00", close: "22:00", closed: true };
          const set = (patch) => onChange({ ...value, [k]: { ...d, ...patch } });
          return (
            <div key={k} className="d-flex align-items-center gap-2 mb-8">
              <span className="text-sm" style={{ width: 80 }}>
                {label}
              </span>
              <input type="time" className="form-control form-control-sm radius-8 w-auto" disabled={d.closed} value={d.open || ""} onChange={(e) => set({ open: e.target.value })} />
              <span className="text-secondary-light">to</span>
              <input type="time" className="form-control form-control-sm radius-8 w-auto" disabled={d.closed} value={d.close || ""} onChange={(e) => set({ close: e.target.value })} />
              <div className="form-check mb-0 ms-2">
                <input className="form-check-input" type="checkbox" checked={!!d.closed} onChange={(e) => set({ closed: e.target.checked })} />
                <label className="form-check-label text-sm">Closed</label>
              </div>
            </div>
          );
        })}
    </div>
  );
}

function BusyModal({ zone, onClose, onDone }) {
  const { busy, run } = useSubmit();
  const f = useForm({ multiplier: zone.busyMultiplier > 1 ? zone.busyMultiplier : 1.3, radiusKm: zone.busyRadiusKm ?? "", reason: "" });
  const submit = (enabled) =>
    run(
      () =>
        http.post(`/admin/zones/${zone.id}/busy-mode`, {
          enabled,
          ...(enabled ? { multiplier: Number(f.values.multiplier), radiusKm: f.values.radiusKm === "" ? undefined : Number(f.values.radiusKm) } : {}),
          reason: f.values.reason || undefined,
        }),
      {
        success: enabled ? "Busy mode enabled" : "Busy mode disabled",
        onDone: () => {
          onDone();
          onClose();
        },
      }
    );
  return (
    <FormModal
      open
      onClose={onClose}
      title={`Busy mode: ${zone.name}`}
      busy={busy}
      submitText={zone.busyMode ? "Update" : "Enable busy mode"}
      submitVariant="warning"
      onSubmit={() => submit(true)}
    >
      <p className="text-secondary-light text-sm">Busy mode raises the delivery fee multiplier and can shrink the delivery radius to protect service levels.</p>
      <FormRow>
        <NumberInput col={6} label="Fee multiplier" min={1} max={5} step="0.05" suffix="x" {...f.bind("multiplier")} />
        <NumberInput col={6} label="Reduced radius" min={0} suffix="km" hint="Optional" {...f.bind("radiusKm")} />
      </FormRow>
      <TextInput label="Reason" {...f.bind("reason")} />
      {zone.busyMode && (
        <Button variant="outline-danger" loading={busy} onClick={() => submit(false)}>
          Turn busy mode off
        </Button>
      )}
    </FormModal>
  );
}

export default function Zones() {
  const { can } = useAuth();
  const { options: cityOptions } = useCityOptions();
  const { data: all } = useFetch("/admin/zones", { limit: 100 });
  const [busyZone, setBusyZone] = useState(null);
  const [finderCenter, setFinderCenter] = useState(null);
  const allZones = all?.data ?? [];

  return (
    <CrudPage
      title="Zones"
      subtitle="Delivery zones drawn on the map, with fee overrides, service hours and busy mode."
      path="/admin/zones"
      module="zones"
      itemName="zone"
      modalSize="xl"
      initial={() => ({
        cityId: cityOptions[0]?.value || "",
        name: "",
        active: true,
        driversOpen: false,
        polygon: [],
        deliveryRadiusKm: "",
        maxDeliveryRadiusKm: "",
        baseFee: "",
        perKmFee: "",
        minimumOrder: "",
        targetDrivers: 20,
        driverCapacity: "",
        serviceHours: {},
      })}
      toForm={(z) => ({
        cityId: z.cityId,
        name: z.name,
        active: z.active,
        driversOpen: !!z.driversOpen,
        polygon: z.polygon || [],
        deliveryRadiusKm: z.deliveryRadiusKm ?? "",
        maxDeliveryRadiusKm: z.maxDeliveryRadiusKm ?? "",
        baseFee: z.baseFee ?? "",
        perKmFee: z.perKmFee ?? "",
        minimumOrder: z.minimumOrder ?? "",
        targetDrivers: z.targetDrivers ?? 0,
        driverCapacity: z.driverCapacity ?? "",
        serviceHours: z.serviceHours || {},
      })}
      searchPlaceholder="Search zones…"
      filterDefs={[
        { name: "cityId", placeholder: "All cities", options: cityOptions },
        { name: "busy", placeholder: "Any demand", options: [{ value: "true", label: "Busy mode on" }, { value: "false", label: "Normal" }] },
        { name: "active", placeholder: "All statuses", options: [{ value: "true", label: "Active" }, { value: "false", label: "Inactive" }] },
      ]}
      canDelete={(r) => !r.restaurantCount}
      columns={[
        {
          key: "name",
          title: "Zone",
          render: (r) => (
            <div>
              <div className="fw-semibold">{r.name}</div>
              <div className="text-secondary-light text-xs">{r.city?.name}</div>
            </div>
          ),
        },
        { key: "restaurantCount", title: "Restaurants" },
        { key: "fees", title: "Delivery fee", render: (r) => `${money(r.effective?.baseFee)} + ${money(r.effective?.perKmFee)}/km` },
        { key: "minimumOrder", title: "Min. order", render: (r) => money(r.effective?.minimumOrder) },
        { key: "radius", title: "Radius", render: (r) => (r.effective?.radiusKm != null ? `${r.effective.radiusKm} km` : "—") },
        { key: "targetDrivers", title: "Target drivers" },
        {
          key: "driverCount",
          title: "Drivers",
          render: (r) => (
            <span>
              {r.driverCount ?? 0}
              {r.driverCapacity != null ? ` / ${r.driverCapacity}` : ""}
              {r.driverCapacity != null && (r.driverCount ?? 0) >= r.driverCapacity ? <Badge tone="warning" className="ms-8">Full</Badge> : null}
              {r.waitlistCount > 0 ? <Badge tone="info" className="ms-8">{r.waitlistCount} waiting</Badge> : null}
            </span>
          ),
        },
        {
          key: "busyMode",
          title: "Busy mode",
          render: (r) => (r.busyMode ? <Badge tone="warning">Busy x{r.busyMultiplier}</Badge> : <span className="text-secondary-light">Normal</span>),
        },
        { key: "driversOpen", title: "Drivers", render: (r) => <BoolBadge value={!!r.driversOpen} yes="Open to join" no="Closed" /> },
        { key: "active", title: "Status", render: (r) => <BoolBadge value={r.active} yes="Active" no="Inactive" /> },
      ]}
      headerExtra={({ list }) => (
        <Card title="Zone map" className="mb-24" subtitle={`${allZones.length} zone(s)`}>
          <MapView
            height={320}
            polygons={(list.rows.length ? list.rows : allZones)
              .filter((z) => z.polygon?.length >= 3)
              .map((z) => ({ id: z.id, points: z.polygon, label: z.name, color: z.busyMode ? "#eab308" : z.active ? "#ff6917" : "#94a3b8" }))}
          />
        </Card>
      )}
      rowActions={(row) =>
        can("zones", "edit") && <IconButton icon="solar:bolt-outline" title="Busy mode" tone={row.busyMode ? "warning" : "neutral"} onClick={() => setBusyZone(row)} />
      }
      loadRow={(row) => http.get(`/admin/zones/${row.id}`)}
      toPayload={(v) => ({
        cityId: v.cityId,
        name: v.name,
        active: !!v.active,
        driversOpen: !!v.driversOpen,
        ...(v.polygon?.length >= 3
          ? {
              polygon: v.polygon,
              centerLat: Number((v.polygon.reduce((s, p) => s + p[0], 0) / v.polygon.length).toFixed(5)),
              centerLng: Number((v.polygon.reduce((s, p) => s + p[1], 0) / v.polygon.length).toFixed(5)),
            }
          : {}),
        deliveryRadiusKm: numOrNull(v.deliveryRadiusKm),
        maxDeliveryRadiusKm: numOrNull(v.maxDeliveryRadiusKm),
        baseFee: numOrNull(v.baseFee),
        perKmFee: numOrNull(v.perKmFee),
        minimumOrder: numOrNull(v.minimumOrder),
        targetDrivers: v.targetDrivers === "" ? undefined : Number(v.targetDrivers),
        // empty = no limit; a higher limit invites the couriers waiting for this zone
        driverCapacity: v.driverCapacity === "" || v.driverCapacity == null ? null : Number(v.driverCapacity),
        serviceHours: v.serviceHours || {},
      })}
      renderForm={({ f, row }) => (
        <div className="row">
          <div className="col-lg-7 mb-16">
            <AddressFinder label="Find address (centres the map)" onPick={(a) => setFinderCenter([a.lat, a.lng])} />
            <label className="form-label fw-semibold text-primary-light text-sm mb-8">Zone boundary</label>
            <PolygonEditor
              value={f.values.polygon}
              onChange={(p) => f.set("polygon", p)}
              height={440}
              center={finderCenter || undefined}
              others={allZones.filter((z) => z.id !== row?.id && z.polygon?.length >= 3).map((z) => ({ id: z.id, points: z.polygon, label: z.name }))}
            />
          </div>
          <div className="col-lg-5">
            <FormRow>
              <TextInput col={12} label="Name" required {...f.bind("name")} />
              <Select col={12} label="City" required allowEmpty={false} options={cityOptions} {...f.bind("cityId")} />
            </FormRow>
            <h6 className="text-md mb-12">Fees (leave blank to inherit from city)</h6>
            <FormRow>
              <NumberInput col={6} label="Base fee" prefix="$" min={0} {...f.bind("baseFee")} />
              <NumberInput col={6} label="Per-km fee" prefix="$" min={0} {...f.bind("perKmFee")} />
              <NumberInput col={6} label="Minimum order" prefix="$" min={0} {...f.bind("minimumOrder")} />
              <NumberInput col={6} label="Target drivers" step="1" min={0} {...f.bind("targetDrivers")} />
              <NumberInput col={6} label="Driver limit" step="1" min={0} hint="Empty = no limit. When the zone is full, new sign-ups wait on a waiting list; raising this invites them." {...f.bind("driverCapacity")} />
              <NumberInput col={6} label="Delivery radius" suffix="km" min={0} {...f.bind("deliveryRadiusKm")} />
              <NumberInput col={6} label="Max radius" suffix="km" min={0} {...f.bind("maxDeliveryRadiusKm")} />
            </FormRow>
            <Switch label="Active" {...f.bindCheck("active")} />
            <Switch label="Open for drivers to join (shown on the driver app's map, up to 4 zones per driver)" {...f.bindCheck("driversOpen")} />
            <h6 className="text-md mb-12">Service hours</h6>
            <ServiceHours value={f.values.serviceHours} onChange={(h) => f.set("serviceHours", h)} />
          </div>
        </div>
      )}
    >
      {({ list }) => busyZone && <BusyModal zone={busyZone} onClose={() => setBusyZone(null)} onDone={list.reload} />}
    </CrudPage>
  );
}
