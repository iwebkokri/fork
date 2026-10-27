import React, { useMemo, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { Badge, BoolBadge, Button, Card, EmptyState, FormModal, IconButton, MultiCheck, NumberInput, MoneyInput, Select, Switch, TagsInput, Tabs, TextArea, TextInput, useConfirm } from "../../ui";
import { fmtDateTime, money } from "../../lib/format";
import { Async, PortalPage, useAction, useApi, usePortalFetch, useRealtimeReload } from "./shared";
import { usePortal } from "./context";
import CatalogTab from "./Catalog";
import ItemPhotos, { PhotoThumb } from "./ItemPhotos";

// ------------------------------------------------------------------ 86 / restock
function EightySixModal({ target, onClose, onDone }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [mode, setMode] = useState("day");
  const [hours, setHours] = useState(2);
  if (!target) return null;
  const submit = async () => {
    const body = mode === "hours" ? { hours: Number(hours) || 1 } : mode === "manual" ? { untilTomorrow: false } : {};
    const r = await run("86", () => api.post(`/restaurant/menu/${target.kind}/${target.id}/86`, body), `${target.name} marked out of stock`);
    if (r.ok) onDone();
  };
  return (
    <FormModal open onClose={onClose} title={`86 "${target.name}"`} onSubmit={submit} busy={!!busy} submitText="Mark out of stock" submitVariant="danger" size="sm">
      <Select
        label="Out of stock"
        allowEmpty={false}
        value={mode}
        onChange={setMode}
        options={[
          { value: "day", label: "Rest of the day (back tomorrow 4 am)" },
          { value: "hours", label: "For a number of hours" },
          { value: "manual", label: "Until I restock it" },
        ]}
      />
      {mode === "hours" && <NumberInput label="Hours" value={hours} onChange={setHours} min={1} max={72} />}
    </FormModal>
  );
}

// ------------------------------------------------------------------ item editor
const MIN_AGE_OPTIONS = [
  { value: 0, label: "No age limit" },
  { value: 18, label: "18+" },
  { value: 19, label: "19+ (alcohol and tobacco in Ontario)" },
  { value: 21, label: "21+" },
];
const TEMP_OPTIONS = [
  { value: "AMBIENT", label: "Room temperature" },
  { value: "CHILLED", label: "Chilled" },
  { value: "FROZEN", label: "Frozen" },
];
const TAX_OPTIONS = [
  { value: "HST_ON", label: "Standard (HST 13%)" },
  { value: "ZERO_RATED", label: "Zero-rated (basic groceries)" },
];

const catalogDefaults = (item) => ({
  sku: item?.sku || "",
  barcode: item?.barcode || "",
  brand: item?.brand || "",
  packSize: item?.packSize || "",
  sellBy: item?.sellBy || "UNIT",
  weightUnit: item?.weightUnit || "KG",
  stepSize: item?.sellBy === "WEIGHT" ? Number(item.stepSize) : 0.5,
  trackStock: !!item?.trackStock,
  stockQty: item?.trackStock && item?.stockQty != null ? Number(item.stockQty) : "",
  lowStockThreshold: item?.lowStockThreshold != null ? Number(item.lowStockThreshold) : "",
  maxPerOrder: item?.maxPerOrder ?? "",
  minAge: item?.minAge || 0,
  temperature: item?.temperature || "AMBIENT",
  taxClassCode: item?.taxClassCode || "HST_ON",
  ...detailDefaults(item),
});

const SPICE_OPTIONS = [
  { value: "NONE", label: "Not spicy" },
  { value: "MILD", label: "Mild" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HOT", label: "Hot" },
  { value: "EXTRA_HOT", label: "Extra hot" },
];
const ALLERGEN_SUGGESTIONS = ["peanuts", "tree nuts", "milk", "eggs", "fish", "crustaceans", "molluscs", "wheat", "gluten", "soy", "sesame", "mustard", "sulphites", "celery"];
const DIET_SUGGESTIONS = ["vegetarian", "vegan", "halal", "kosher", "gluten-free", "dairy-free", "nut-free", "organic", "keto", "low-sodium"];
const NUTRITION = [
  ["fatG", "Fat (g)"],
  ["satFatG", "Saturated fat (g)"],
  ["carbsG", "Carbs (g)"],
  ["sugarG", "Sugar (g)"],
  ["fibreG", "Fibre (g)"],
  ["proteinG", "Protein (g)"],
  ["sodiumMg", "Sodium (mg)"],
];
const num = (v) => (v === null || v === undefined ? "" : Number(v));
/** menu details: spice level, size, ingredients, may-contain allergens, nutrition, origin, storage */
const detailDefaults = (item) => ({
  spiceLevel: item?.spiceLevel || "",
  lengthCm: num(item?.lengthCm),
  widthCm: num(item?.widthCm),
  heightCm: num(item?.heightCm),
  ingredients: item?.ingredients || "",
  mayContain: item?.mayContain || [],
  servingSize: item?.servingSize || "",
  calories: num(item?.calories),
  countryOfOrigin: item?.countryOfOrigin || "",
  storage: item?.storage || "",
  nutrition: Object.fromEntries(NUTRITION.map(([k]) => [k, num(item?.nutrition?.[k])])),
});
const hasDetails = (item) => !!(item && (item.spiceLevel || item.lengthCm != null || item.widthCm != null || item.heightCm != null || item.ingredients || item.mayContain?.length || item.nutrition || item.servingSize || item.calories || item.countryOfOrigin || item.storage));

/** Add / edit a dish or a product. The catalog part (SKU, barcode, weight, stock, age limit, temperature) is always there for grocery-type stores and one click away for the others. */
function ItemModal({ item, menu, open, onClose, onSaved, defaultCategoryId }) {
  const api = useApi();
  const { busy, run } = useAction();
  const { location } = usePortal();
  const retail = !!location?.retail;
  const [f, setF] = useState(null);
  const [showCatalog, setShowCatalog] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  React.useEffect(() => {
    if (!open) return;
    setShowDetails(hasDetails(item));
    setShowCatalog(retail || !!(item && (item.sku || item.barcode || item.trackStock || item.minAge > 0 || item.sellBy === "WEIGHT")));
    setF({
      ...(item
        ? {
            name: item.name,
            description: item.description || "",
            imageUrl: item.imageUrl || null,
            galleryUrls: item.galleryUrls || [],
            categoryId: item.categoryId || "",
            price: item.price,
            pickupPrice: item.pickupPrice ?? "",
            stationId: item.stationId || "",
            prepTimeMin: item.prepTimeMin ?? "",
            allergens: item.allergens || [],
            dietaryTags: item.dietaryTags || [],
            isPopular: !!item.isPopular,
            active: item.active !== false,
            groupIds: (item.modifierGroups || []).map((g) => g.id),
          }
        : { name: "", description: "", imageUrl: null, galleryUrls: [], categoryId: defaultCategoryId || menu.categories[0]?.id || "", price: "", pickupPrice: "", stationId: "", prepTimeMin: "", allergens: [], dietaryTags: [], isPopular: false, active: true, groupIds: [] }),
      ...catalogDefaults(item),
    });
  }, [open, item, menu, defaultCategoryId, retail]);
  if (!open || !f) return null;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const weighed = f.sellBy === "WEIGHT";
  const unit = String(f.weightUnit || "KG").toLowerCase();
  const numOrNull = (v) => (v === "" || v === null || v === undefined ? null : Number(v));
  const submit = async () => {
    if (!f.name.trim() || f.price === "") return;
    const body = {
      name: f.name.trim(),
      description: f.description || null,
      imageUrl: f.imageUrl || null,
      galleryUrls: f.galleryUrls || [],
      categoryId: f.categoryId || null,
      price: Number(f.price),
      pickupPrice: f.pickupPrice === "" ? null : Number(f.pickupPrice),
      allergens: f.allergens,
      dietaryTags: f.dietaryTags,
      spiceLevel: f.spiceLevel || null,
      lengthCm: numOrNull(f.lengthCm),
      widthCm: numOrNull(f.widthCm),
      heightCm: numOrNull(f.heightCm),
      ingredients: f.ingredients.trim() || null,
      mayContain: f.mayContain,
      servingSize: f.servingSize.trim() || null,
      calories: numOrNull(f.calories),
      countryOfOrigin: f.countryOfOrigin.trim() || null,
      storage: f.storage.trim() || null,
      nutrition: Object.fromEntries(NUTRITION.map(([k]) => [k, numOrNull(f.nutrition[k])]).filter(([, v]) => v !== null)),
      isPopular: f.isPopular,
      active: f.active,
      groupIds: f.groupIds,
      ...(retail ? {} : { stationId: f.stationId || null, prepTimeMin: f.prepTimeMin === "" ? null : Number(f.prepTimeMin) }),
      ...(showCatalog
        ? {
            sku: f.sku.trim() || null,
            barcode: f.barcode.trim() || null,
            brand: f.brand.trim() || null,
            packSize: f.packSize.trim() || null,
            sellBy: f.sellBy,
            weightUnit: f.weightUnit,
            ...(weighed ? { stepSize: Number(f.stepSize) } : {}),
            trackStock: f.trackStock,
            ...(f.trackStock ? { stockQty: Number(f.stockQty) } : {}),
            lowStockThreshold: numOrNull(f.lowStockThreshold),
            maxPerOrder: numOrNull(f.maxPerOrder),
            minAge: Number(f.minAge) || 0,
            temperature: f.temperature,
            ...(retail ? { taxClassCode: f.taxClassCode } : {}),
          }
        : {}),
    };
    const noun = retail ? "Product" : "Item";
    const r = await run("save", () => (item ? api.patch(`/restaurant/menu/items/${item.id}`, body) : api.post("/restaurant/menu/items", body)), item ? `${noun} saved` : `${noun} created`);
    if (r.ok) onSaved();
  };
  return (
    <FormModal open onClose={onClose} title={item ? `Edit ${item.name}` : retail ? "New product" : "New item"} onSubmit={submit} busy={!!busy} size="lg" disabled={!f.name.trim() || f.price === ""}>
      <div className="row">
        <TextInput col={8} label="Name" required value={f.name} onChange={set("name")} />
        <Select col={4} label={retail ? "Department" : "Category"} value={f.categoryId} onChange={set("categoryId")} options={menu.categories.map((c) => ({ value: c.id, label: c.name }))} placeholder="Uncategorised" />
        <TextArea label="Description" value={f.description} onChange={set("description")} rows={2} />
        <div className="col-12">
          <ItemPhotos value={{ imageUrl: f.imageUrl, galleryUrls: f.galleryUrls }} onChange={(p) => setF((x) => ({ ...x, imageUrl: p.imageUrl, galleryUrls: p.galleryUrls }))} />
        </div>
        <MoneyInput col={4} label={weighed && showCatalog ? `Price per ${unit}` : "Delivery price"} required value={f.price} onChange={set("price")} />
        <MoneyInput col={4} label="Pickup price" hint="Leave empty to use the delivery price" value={f.pickupPrice} onChange={set("pickupPrice")} />
        {!retail && <NumberInput col={4} label="Prep time (min)" hint="Empty = store default" value={f.prepTimeMin} onChange={set("prepTimeMin")} min={0} />}
        {!retail && <Select col={6} label="Kitchen station" value={f.stationId} onChange={set("stationId")} options={menu.stations.map((s) => ({ value: s.id, label: s.name }))} placeholder="None" />}
        <div className={`${retail ? "col-md-4 pt-28" : "col-md-6 pt-28"} d-flex gap-4`}>
          <Switch label="Active" checked={f.active} onChange={set("active")} className="mb-0" />
          <Switch label="Popular" checked={f.isPopular} onChange={set("isPopular")} className="mb-0" />
        </div>
        <TagsInput col={6} label="Allergens" value={f.allergens} onChange={set("allergens")} className="mt-16" suggestions={ALLERGEN_SUGGESTIONS} hint="What the item contains" />
        <TagsInput col={6} label="Dietary tags" value={f.dietaryTags} onChange={set("dietaryTags")} className="mt-16" suggestions={DIET_SUGGESTIONS} />
      </div>
      {!showDetails ? (
        <button type="button" className="btn btn-link px-0 d-block" onClick={() => setShowDetails(true)} data-testid="show-details">
          Spice level, size, ingredients, nutrition…
        </button>
      ) : (
        <div className="border-top pt-16 mt-8" data-testid="detail-fields">
          <div className="fw-semibold mb-12">Item details</div>
          <div className="row">
            <Select col={4} label="Spice level" value={f.spiceLevel} onChange={set("spiceLevel")} options={SPICE_OPTIONS} placeholder="Not stated" />
            <TagsInput col={8} label="May contain (cross-contact)" value={f.mayContain} onChange={set("mayContain")} suggestions={ALLERGEN_SUGGESTIONS} hint="Allergens that may be present without being an ingredient" />
            <NumberInput col={4} label="Length (cm)" value={f.lengthCm} onChange={set("lengthCm")} min={0} step={0.5} />
            <NumberInput col={4} label="Width (cm)" value={f.widthCm} onChange={set("widthCm")} min={0} step={0.5} />
            <NumberInput col={4} label="Height (cm)" value={f.heightCm} onChange={set("heightCm")} min={0} step={0.5} />
            <TextArea label="Ingredients" value={f.ingredients} onChange={set("ingredients")} rows={2} />
            <TextInput col={6} label="Serving size" hint='What the calories and nutrition refer to, for example "1 slice (120 g)"' value={f.servingSize} onChange={set("servingSize")} />
            <NumberInput col={6} label="Calories per serving" value={f.calories} onChange={set("calories")} min={0} />
            {NUTRITION.map(([k, label]) => (
              <NumberInput key={k} col={3} label={label} value={f.nutrition[k]} onChange={(v) => setF((x) => ({ ...x, nutrition: { ...x.nutrition, [k]: v } }))} min={0} step={0.1} />
            ))}
            <TextInput col={6} label="Country of origin" value={f.countryOfOrigin} onChange={set("countryOfOrigin")} />
            <TextInput col={6} label="Storage" hint='For example "Keep refrigerated, eat within 3 days"' value={f.storage} onChange={set("storage")} />
          </div>
        </div>
      )}
      {menu.modifierGroups.length > 0 && <MultiCheck label="Modifier groups" cols={2} options={menu.modifierGroups.map((g) => ({ value: g.id, label: g.name }))} value={f.groupIds} onChange={set("groupIds")} />}
      {!showCatalog ? (
        <button type="button" className="btn btn-link px-0" onClick={() => setShowCatalog(true)} data-testid="show-catalog">
          Stock, weight, age limit and product codes…
        </button>
      ) : (
        <div className="border-top pt-16 mt-8" data-testid="catalog-fields">
          <div className="fw-semibold mb-12">Product details</div>
          <div className="row">
            <TextInput col={4} label="SKU" hint="Your own product code, unique in the store" value={f.sku} onChange={set("sku")} />
            <TextInput col={4} label="Barcode" hint="UPC / EAN, 6 to 14 digits" value={f.barcode} onChange={set("barcode")} />
            <TextInput col={4} label="Brand" value={f.brand} onChange={set("brand")} />
            <TextInput col={4} label="Pack size" hint='For example "500 g" or "12 x 355 ml"' value={f.packSize} onChange={set("packSize")} />
            <Select col={4} label="Sold" allowEmpty={false} value={f.sellBy} onChange={set("sellBy")} options={[{ value: "UNIT", label: "By the piece" }, { value: "WEIGHT", label: "By weight (weighed when picked)" }]} />
            {weighed && <Select col={2} label="Weight unit" allowEmpty={false} value={f.weightUnit} onChange={set("weightUnit")} options={[{ value: "KG", label: "kg" }, { value: "LB", label: "lb" }]} />}
            {weighed && <NumberInput col={2} label={`Step (${unit})`} hint={`Customers order in steps: 0.5 = half a ${unit}`} value={f.stepSize} onChange={set("stepSize")} min={0.05} step={0.05} />}
            <div className="col-md-4 pt-28">
              <Switch label="Count the stock" checked={f.trackStock} onChange={set("trackStock")} className="mb-0" />
            </div>
            {f.trackStock && <NumberInput col={4} label={`On the shelf${weighed ? ` (${unit})` : ""}`} value={f.stockQty} onChange={set("stockQty")} min={0} step={weighed ? 0.1 : 1} />}
            {f.trackStock && <NumberInput col={4} label="Low stock alert at" hint="You are told when an order takes it down to this" value={f.lowStockThreshold} onChange={set("lowStockThreshold")} min={0} />}
            <NumberInput col={4} label="Most per order" hint="Empty = no limit" value={f.maxPerOrder} onChange={set("maxPerOrder")} min={1} />
            <Select col={4} label="Age limit" allowEmpty={false} hint="Customers confirm their age; the driver checks ID at the door. Needs your liquor / tobacco licence uploaded." value={f.minAge} onChange={(v) => set("minAge")(Number(v))} options={MIN_AGE_OPTIONS} />
            <Select col={4} label="Keep" allowEmpty={false} value={f.temperature} onChange={set("temperature")} options={TEMP_OPTIONS} />
            {retail && <Select col={4} label="Tax" allowEmpty={false} hint="Basic groceries are zero-rated; snacks, drinks and household goods are not" value={f.taxClassCode} onChange={set("taxClassCode")} options={TAX_OPTIONS} />}
          </div>
        </div>
      )}
    </FormModal>
  );
}

// ------------------------------------------------------------------ items tab
function ItemsTab({ menu, reload }) {
  const api = useApi();
  const confirm = useConfirm();
  const { isManager: mgr } = usePortal();
  const isManager = mgr && menu.access?.canEdit !== false;
  const { run } = useAction();
  const [edit, setEdit] = useState(null);
  const [eighty, setEighty] = useState(null);
  const [q, setQ] = useState("");
  const match = (i) => !q || i.name.toLowerCase().includes(q.toLowerCase());

  const restock = async (kind, it) => {
    const r = await run(it.id, () => api.post(`/restaurant/menu/${kind}/${it.id}/restock`), `${it.name} back in stock`);
    if (r.ok) reload();
  };
  const del = async (it) => {
    const c = await confirm({ title: `Delete ${it.name}?`, message: "This removes the item from your menu.", danger: true, confirmText: "Delete" });
    if (!c.confirmed) return;
    const r = await run(it.id, () => api.del(`/restaurant/menu/items/${it.id}`), "Item deleted");
    if (r.ok) reload();
  };

  const groups = [...menu.categories, ...(menu.uncategorized.length ? [{ id: "_none", name: "Uncategorised", items: menu.uncategorized }] : [])];
  return (
    <>
      <div className="d-flex flex-wrap justify-content-between gap-3 mb-20">
        <form className="navbar-search" onSubmit={(e) => e.preventDefault()}>
          <input type="text" className="bg-base h-40-px w-auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items…" />
          <Icon icon="ion:search-outline" className="icon" />
        </form>
        {isManager && (
          <Button icon="solar:add-circle-outline" onClick={() => setEdit({ item: null })}>
            Add item
          </Button>
        )}
      </div>
      {groups.length === 0 && <EmptyState title="No menu yet" text="Create a category, then add your first item." />}
      {groups.map((c) => {
        const items = (c.items || []).filter(match);
        if (q && !items.length) return null;
        return (
          <Card key={c.id} title={c.name} subtitle={`${items.length} item${items.length === 1 ? "" : "s"}${c.active === false ? " · hidden" : ""}`} className="mb-20" noPadding>
            <div className="table-responsive">
              <table className="table bordered-table sm-table mb-0 align-middle">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-end">Delivery</th>
                    <th className="text-end">Pickup</th>
                    <th>Station</th>
                    <th>Status</th>
                    <th className="text-end">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={6} className="text-center text-secondary-light py-20">
                        No items
                      </td>
                    </tr>
                  )}
                  {items.map((it) => (
                    <tr key={it.id}>
                      <td>
                        <div className="d-flex align-items-center gap-3">
                          <PhotoThumb item={it} />
                          <div>
                            <div className="fw-semibold">{it.name}</div>
                            {it.description && <div className="text-secondary-light text-xs text-truncate" style={{ maxWidth: 320 }}>{it.description}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="text-end">{money(it.price)}</td>
                      <td className="text-end">{it.pickupPrice != null && Number(it.pickupPrice) !== Number(it.price) ? money(it.pickupPrice) : <span className="text-secondary-light">same</span>}</td>
                      <td>{it.stationName || "—"}</td>
                      <td>
                        {!it.active ? <Badge tone="neutral">Hidden</Badge> : it.available ? <Badge tone="success">In stock</Badge> : <Badge tone="danger">86&apos;d{it.restockAt ? ` until ${fmtDateTime(it.restockAt)}` : ""}</Badge>}
                      </td>
                      <td className="text-end">
                        <div className="d-inline-flex gap-2">
                          {it.available ? (
                            <Button variant="outline-danger" onClick={() => setEighty({ kind: "items", id: it.id, name: it.name })}>
                              86
                            </Button>
                          ) : (
                            <Button variant="success" onClick={() => restock("items", it)}>
                              Restock
                            </Button>
                          )}
                          {isManager && (
                            <>
                              <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => setEdit({ item: it })} />
                              <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => del(it)} />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
      <ItemModal
        open={!!edit}
        item={edit?.item}
        menu={menu}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          reload();
        }}
      />
      <EightySixModal
        target={eighty}
        onClose={() => setEighty(null)}
        onDone={() => {
          setEighty(null);
          reload();
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ products tab of a grocery-type store (paged, see Catalog.jsx)
function RetailItemsTab({ menu, reload }) {
  const { isManager: mgr } = usePortal();
  const canEdit = mgr && menu.access?.canEdit !== false;
  const [edit, setEdit] = useState(null);
  const [eighty, setEighty] = useState(null);
  const [tick, setTick] = useState(0);
  const refreshed = () => {
    setTick((n) => n + 1);
    reload();
  };
  return (
    <>
      <CatalogTab key={tick} menu={menu} reload={reload} canEdit={canEdit} onEdit={(item) => setEdit({ item })} onAdd={() => setEdit({ item: null })} onEightySix={setEighty} />
      <ItemModal
        open={!!edit}
        item={edit?.item}
        menu={menu}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          refreshed();
        }}
      />
      <EightySixModal
        target={eighty}
        onClose={() => setEighty(null)}
        onDone={() => {
          setEighty(null);
          refreshed();
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ categories tab
function CategoryModal({ cat, open, onClose, onSaved }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: "", description: "", active: true });
  React.useEffect(() => {
    if (open) setF(cat ? { name: cat.name, description: cat.description || "", active: cat.active !== false } : { name: "", description: "", active: true });
  }, [open, cat]);
  if (!open) return null;
  const submit = async () => {
    const body = { name: f.name.trim(), description: f.description || null, active: f.active };
    const r = await run("save", () => (cat ? api.patch(`/restaurant/menu/categories/${cat.id}`, body) : api.post("/restaurant/menu/categories", body)), "Category saved");
    if (r.ok) onSaved();
  };
  return (
    <FormModal open onClose={onClose} title={cat ? "Edit category" : "New category"} onSubmit={submit} busy={!!busy} disabled={!f.name.trim()} size="sm">
      <TextInput label="Name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} />
      <TextArea label="Description" rows={2} value={f.description} onChange={(v) => setF({ ...f, description: v })} />
      <Switch label="Visible to customers" checked={f.active} onChange={(v) => setF({ ...f, active: v })} className="mb-0" />
    </FormModal>
  );
}

function CategoriesTab({ menu, reload, retail }) {
  const api = useApi();
  const confirm = useConfirm();
  const { run } = useAction();
  const [edit, setEdit] = useState(null);
  const cats = menu.categories;
  const canEdit = menu.access?.canEdit !== false;
  const move = async (i, dir) => {
    const ids = cats.map((c) => c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const r = await run("mv", () => api.patch("/restaurant/menu/categories/reorder", { ids }));
    if (r.ok) reload();
  };
  const del = async (c) => {
    const others = cats.filter((x) => x.id !== c.id);
    const has = (c.itemCount ?? (c.items || []).length) > 0;
    const res = await confirm({
      title: `Delete ${c.name}?`,
      message: has ? `Its ${c.itemCount ?? c.items.length} ${retail ? "products" : "items"} need a new home.` : undefined,
      danger: true,
      confirmText: "Delete",
      prompt: has ? { label: "Move items to", type: "select", required: true, options: others.map((o) => ({ value: o.id, label: o.name })) } : undefined,
    });
    if (!res.confirmed) return;
    const r = await run(c.id, () => api.del(`/restaurant/menu/categories/${c.id}${has ? `?moveItemsTo=${res.value}` : ""}`), "Category deleted");
    if (r.ok) reload();
  };
  return (
    <>
      {canEdit && (
        <div className="d-flex justify-content-end mb-20">
          <Button icon="solar:add-circle-outline" onClick={() => setEdit({ cat: null })}>
            {retail ? "Add department" : "Add category"}
          </Button>
        </div>
      )}
      <Card noPadding>
        {cats.length === 0 ? (
          <EmptyState title={retail ? "No departments" : "No categories"} text={retail ? "Departments (produce, dairy, frozen...) group your products." : "Categories group your items on the menu."} />
        ) : (
          <ul className="list-unstyled mb-0">
            {cats.map((c, i) => (
              <li key={c.id} className="d-flex align-items-center justify-content-between gap-3 px-20 py-12 border-bottom">
                <div>
                  <div className="fw-semibold">{c.name}</div>
                  <div className="text-secondary-light text-sm">{c.itemCount ?? (c.items || []).length} {retail ? "products" : "items"}</div>
                </div>
                <div className="d-flex align-items-center gap-2">
                  <BoolBadge value={c.active !== false} yes="Visible" no="Hidden" />
                  {canEdit && (
                    <>
                      <IconButton icon="solar:alt-arrow-up-linear" title="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton icon="solar:alt-arrow-down-linear" title="Move down" disabled={i === cats.length - 1} onClick={() => move(i, 1)} />
                      <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => setEdit({ cat: c })} />
                      <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => del(c)} />
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <CategoryModal
        open={!!edit}
        cat={edit?.cat}
        onClose={() => setEdit(null)}
        onSaved={() => {
          setEdit(null);
          reload();
        }}
      />
    </>
  );
}

// ------------------------------------------------------------------ modifier groups tab
function GroupModal({ group, open, onClose, onSaved }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: "", required: false, minSelect: 0, maxSelect: 1, options: [] });
  React.useEffect(() => {
    if (!open) return;
    setF(
      group
        ? { name: group.name, required: !!group.required, minSelect: group.minSelect ?? 0, maxSelect: group.maxSelect ?? 1, options: [] }
        : { name: "", required: false, minSelect: 0, maxSelect: 1, options: [{ name: "", priceDelta: 0 }] }
    );
  }, [open, group]);
  if (!open) return null;
  const setOpt = (i, patch) => setF((x) => ({ ...x, options: x.options.map((o, k) => (k === i ? { ...o, ...patch } : o)) }));
  const submit = async () => {
    const body = { name: f.name.trim(), required: f.required, minSelect: Number(f.minSelect) || 0, maxSelect: Number(f.maxSelect) || 1 };
    if (!group) body.options = f.options.filter((o) => o.name.trim()).map((o) => ({ name: o.name.trim(), priceDelta: Number(o.priceDelta) || 0 }));
    const r = await run("save", () => (group ? api.patch(`/restaurant/menu/groups/${group.id}`, body) : api.post("/restaurant/menu/groups", body)), "Group saved");
    if (r.ok) onSaved();
  };
  return (
    <FormModal open onClose={onClose} title={group ? `Edit ${group.name}` : "New modifier group"} onSubmit={submit} busy={!!busy} disabled={!f.name.trim()}>
      <TextInput label="Group name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="e.g. Size, Toppings" />
      <div className="row align-items-end">
        <div className="col-4">
          <Switch label="Required" checked={f.required} onChange={(v) => setF({ ...f, required: v, minSelect: v ? Math.max(1, f.minSelect) : 0 })} />
        </div>
        <NumberInput col={4} label="Min choices" value={f.minSelect} onChange={(v) => setF({ ...f, minSelect: v })} min={0} />
        <NumberInput col={4} label="Max choices" value={f.maxSelect} onChange={(v) => setF({ ...f, maxSelect: v })} min={1} />
      </div>
      {!group && (
        <>
          <div className="fw-semibold text-sm mb-8">Options</div>
          {f.options.map((o, i) => (
            <div key={i} className="row g-2 mb-8 align-items-center">
              <div className="col-7">
                <input className="form-control radius-8" placeholder="Option name" value={o.name} onChange={(e) => setOpt(i, { name: e.target.value })} />
              </div>
              <div className="col-4">
                <input type="number" step="0.01" className="form-control radius-8" placeholder="+ price" value={o.priceDelta} onChange={(e) => setOpt(i, { priceDelta: e.target.value })} />
              </div>
              <div className="col-1">
                <IconButton icon="solar:close-circle-outline" tone="danger" title="Remove" onClick={() => setF({ ...f, options: f.options.filter((_, k) => k !== i) })} />
              </div>
            </div>
          ))}
          <Button variant="outline" icon="solar:add-circle-outline" onClick={() => setF({ ...f, options: [...f.options, { name: "", priceDelta: 0 }] })}>
            Add option
          </Button>
        </>
      )}
    </FormModal>
  );
}

function OptionModal({ target, onClose, onSaved }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: "", priceDelta: 0, isDefault: false });
  React.useEffect(() => {
    if (target) setF(target.option ? { name: target.option.name, priceDelta: target.option.priceDelta, isDefault: !!target.option.isDefault } : { name: "", priceDelta: 0, isDefault: false });
  }, [target]);
  if (!target) return null;
  const submit = async () => {
    const body = { name: f.name.trim(), priceDelta: Number(f.priceDelta) || 0, isDefault: f.isDefault };
    const r = await run("save", () => (target.option ? api.patch(`/restaurant/menu/options/${target.option.id}`, body) : api.post(`/restaurant/menu/groups/${target.group.id}/options`, body)), "Option saved");
    if (r.ok) onSaved();
  };
  return (
    <FormModal open onClose={onClose} title={target.option ? "Edit option" : `Add option to ${target.group.name}`} onSubmit={submit} busy={!!busy} disabled={!f.name.trim()} size="sm">
      <TextInput label="Name" required value={f.name} onChange={(v) => setF({ ...f, name: v })} />
      <MoneyInput label="Price change" hint="Added to the item price (can be 0)" value={f.priceDelta} onChange={(v) => setF({ ...f, priceDelta: v })} />
      <Switch label="Selected by default" checked={f.isDefault} onChange={(v) => setF({ ...f, isDefault: v })} className="mb-0" />
    </FormModal>
  );
}

function GroupsTab({ menu, reload }) {
  const api = useApi();
  const confirm = useConfirm();
  const { isManager: mgr } = usePortal();
  const isManager = mgr && menu.access?.canEdit !== false;
  const { run } = useAction();
  const [group, setGroup] = useState(null);
  const [opt, setOpt] = useState(null);
  const [eighty, setEighty] = useState(null);
  const done = (set) => () => {
    set(null);
    reload();
  };
  const delGroup = async (g) => {
    const c = await confirm({ title: `Delete ${g.name}?`, message: "It is removed from every item that uses it.", danger: true, confirmText: "Delete" });
    if (!c.confirmed) return;
    const r = await run(g.id, () => api.del(`/restaurant/menu/groups/${g.id}`), "Group deleted");
    if (r.ok) reload();
  };
  const delOpt = async (o) => {
    const r = await run(o.id, () => api.del(`/restaurant/menu/options/${o.id}`), "Option deleted");
    if (r.ok) reload();
  };
  const restock = async (o) => {
    const r = await run(o.id, () => api.post(`/restaurant/menu/options/${o.id}/restock`), `${o.name} back in stock`);
    if (r.ok) reload();
  };
  return (
    <>
      {isManager && (
        <div className="d-flex justify-content-end mb-20">
          <Button icon="solar:add-circle-outline" onClick={() => setGroup({ group: null })}>
            Add modifier group
          </Button>
        </div>
      )}
      {menu.modifierGroups.length === 0 && <EmptyState title="No modifier groups" text="Use groups for sizes, toppings, sides and other choices." />}
      <div className="row g-3">
        {menu.modifierGroups.map((g) => (
          <div key={g.id} className="col-lg-6">
            <Card
              title={g.name}
              subtitle={`${g.required ? "Required" : "Optional"} · choose ${g.minSelect ?? 0}-${g.maxSelect ?? 1}`}
              actions={
                isManager && (
                  <div className="d-flex gap-2">
                    <IconButton icon="solar:add-circle-outline" title="Add option" tone="success" onClick={() => setOpt({ group: g })} />
                    <IconButton icon="solar:pen-outline" title="Edit group" tone="primary" onClick={() => setGroup({ group: g })} />
                    <IconButton icon="solar:trash-bin-trash-outline" title="Delete group" tone="danger" onClick={() => delGroup(g)} />
                  </div>
                )
              }
            >
              <ul className="list-unstyled mb-0">
                {(g.options || []).map((o) => (
                  <li key={o.id} className="d-flex justify-content-between align-items-center gap-2 py-8 border-bottom">
                    <div>
                      <span className="fw-medium">{o.name}</span> {o.isDefault && <Badge tone="info" className="ms-1">Default</Badge>}
                      <div className="text-secondary-light text-xs">{Number(o.priceDelta) ? `+${money(o.priceDelta)}` : "No extra charge"}</div>
                    </div>
                    <div className="d-flex align-items-center gap-2">
                      {!o.available && <Badge tone="danger">86&apos;d</Badge>}
                      {o.available ? (
                        <Button variant="outline-danger" onClick={() => setEighty({ kind: "options", id: o.id, name: o.name })}>
                          86
                        </Button>
                      ) : (
                        <Button variant="success" onClick={() => restock(o)}>
                          Restock
                        </Button>
                      )}
                      {isManager && (
                        <>
                          <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => setOpt({ group: g, option: o })} />
                          <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => delOpt(o)} />
                        </>
                      )}
                    </div>
                  </li>
                ))}
                {(g.options || []).length === 0 && <li className="text-secondary-light text-sm py-8">No options yet</li>}
              </ul>
            </Card>
          </div>
        ))}
      </div>
      <GroupModal open={!!group} group={group?.group} onClose={() => setGroup(null)} onSaved={done(setGroup)} />
      <OptionModal target={opt} onClose={() => setOpt(null)} onSaved={done(setOpt)} />
      <EightySixModal target={eighty} onClose={() => setEighty(null)} onDone={done(setEighty)} />
    </>
  );
}

// ------------------------------------------------------------------ page
/** Shown while FORKSY has not allowed this restaurant to change its own menu. */
function MenuAccessBanner({ access, reload }) {
  const api = useApi();
  const { isManager } = usePortal();
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!access || access.canEdit) return null;
  const waiting = access.status === "REQUESTED";
  const submit = async () => {
    const r = await run("access", () => api.post("/restaurant/menu/access/request", { note: note.trim() || undefined }), "Request sent to FORKSY");
    if (r.ok) {
      setOpen(false);
      setNote("");
      reload();
    }
  };
  return (
    <div className={`alert ${waiting ? "alert-info" : "alert-warning"} radius-8 mb-20 d-flex flex-wrap align-items-center justify-content-between gap-3`}>
      <div>
        <strong>{waiting ? "Waiting for FORKSY approval" : "Menu editing is turned off"}</strong>
        <div className="text-sm">
          {waiting
            ? `You asked to edit your menu${access.requestedAt ? " on " + fmtDateTime(access.requestedAt) : ""}. You can keep marking items out of stock (86) meanwhile.`
            : "Your menu is read-only. You can still mark items out of stock (86) and back in stock. Ask FORKSY to allow you to add, update and remove items."}
          {!waiting && access.decisionNote ? ` FORKSY note: ${access.decisionNote}` : ""}
        </div>
      </div>
      {isManager && !waiting && (
        <Button icon="solar:lock-unlocked-outline" onClick={() => setOpen(true)}>
          Request access
        </Button>
      )}
      <FormModal open={open} onClose={() => setOpen(false)} title="Request menu editing access" onSubmit={submit} busy={!!busy} submitText="Send request" size="sm">
        <TextArea label="Why do you need to edit the menu? (optional)" value={note} onChange={setNote} rows={3} />
        <div className="text-secondary-light text-sm">FORKSY staff will review your request and you will be notified.</div>
      </FormModal>
    </div>
  );
}

export default function Menu() {
  const { isManager, retail } = usePortal();
  // a grocery-type store loads its products page by page: the menu call only brings the structure (departments with their counts)
  const state = usePortalFetch("/restaurant/menu", retail ? { includeInactive: "true", items: "false" } : { includeInactive: "true" });
  const [tab, setTab] = useState("items");
  useRealtimeReload(state.reload, ["menu.access_changed"]);
  const tabs = useMemo(
    () => (menu) => [
      { key: "items", label: retail ? "Products" : "Items", badge: menu.counts?.items, content: retail ? <RetailItemsTab menu={menu} reload={state.reload} /> : <ItemsTab menu={menu} reload={state.reload} /> },
      { key: "categories", label: retail ? "Departments" : "Categories", badge: menu.counts?.categories, hidden: !isManager, content: <CategoriesTab menu={menu} reload={state.reload} retail={retail} /> },
      { key: "groups", label: retail ? "Options" : "Modifier groups", badge: menu.counts?.modifierGroups, content: <GroupsTab menu={menu} reload={state.reload} /> },
    ],
    [isManager, retail, state.reload]
  );
  return (
    <PortalPage
      title={retail ? "Catalog" : "Menu"}
      subtitle={isManager ? undefined : retail ? "Count stock and pause products" : "Mark items out of stock (86) or back in stock"}
    >
      <Async state={state}>
        {(menu) => (
          <>
            <MenuAccessBanner access={menu.access} reload={state.reload} />
            <Tabs tabs={tabs(menu)} active={tab} onChange={setTab} />
          </>
        )}
      </Async>
    </PortalPage>
  );
}
