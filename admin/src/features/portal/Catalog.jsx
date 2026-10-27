import React, { useEffect, useState } from "react";
import { Icon } from "@iconify/react/offline";
import { toast } from "react-toastify";
import { Badge, Button, Card, DataTable, FilterSelect, FormModal, IconButton, ListToolbar, TextArea, useConfirm } from "../../ui";
import { usePagedList } from "../../lib/hooks";
import { fmtDateTime, money } from "../../lib/format";
import { useAction, useApi } from "./shared";
import { usePortal } from "./context";
import { PhotoThumb } from "./ItemPhotos";

/**
 * The catalog of a grocery / convenience / specialty store (docs/store-types.md): a paged, searchable product list (a supermarket has thousands of products),
 * stock counted right in the table, a stock count by SKU / barcode. Restaurants keep the menu screen; the same product editor serves both.
 */

export const STOCK_BADGE = {
  UNTRACKED: { tone: "neutral", label: "Not tracked" },
  IN_STOCK: { tone: "success", label: "In stock" },
  LOW: { tone: "warning", label: "Low" },
  OUT: { tone: "danger", label: "Sold out" },
};

const TEMP_ICON = { CHILLED: { icon: "solar:snowflake-outline", label: "Chilled" }, FROZEN: { icon: "solar:temperature-outline", label: "Frozen" } };

/** "$2.18 / kg" for a product sold by weight, "$5.49" for the others */
export const priceText = (it) => (it.sellBy === "WEIGHT" ? `${money(it.price)} / ${String(it.weightUnit || "KG").toLowerCase()}` : money(it.price));

/** the stock of one product, edited in place: type a number and press Enter (or leave the field) */
function StockCell({ item, canCount, onSaved }) {
  const api = useApi();
  const { run } = useAction();
  const shown = item.trackStock && item.stockQty != null ? String(Number(item.stockQty)) : "";
  const [v, setV] = useState(shown);
  useEffect(() => setV(shown), [shown]);
  const unit = item.sellBy === "WEIGHT" ? String(item.weightUnit || "KG").toLowerCase() : "";
  const save = async () => {
    if (v === shown || v === "") return setV(shown);
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Enter a number of 0 or more");
      return setV(shown);
    }
    const r = await run(`stock-${item.id}`, async () => {
      const res = await api.post("/restaurant/menu/stock", { updates: [{ itemId: item.id, stockQty: n }] });
      if (res.errors?.length) throw new Error(res.errors[0].error);
      return res;
    }, `${item.name}: stock ${n}${unit ? " " + unit : ""}`);
    if (r.ok) onSaved();
    else setV(shown);
  };
  if (!canCount) return <span>{item.trackStock ? `${Number(item.stockQty ?? 0)} ${unit}` : "—"}</span>;
  return (
    <div className="d-inline-flex align-items-center gap-1">
      <input
        type="number"
        min="0"
        step={item.sellBy === "WEIGHT" ? "0.1" : "1"}
        className="form-control form-control-sm radius-8 text-end"
        style={{ width: 84 }}
        value={v}
        placeholder="—"
        aria-label={`Stock of ${item.name}`}
        data-testid={`stock-${item.sku || item.id}`}
        onChange={(e) => setV(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      {unit && <span className="text-secondary-light text-xs">{unit}</span>}
    </div>
  );
}

/** Count stock for many products at once: one product per line, "SKU or barcode, quantity" (a leading + or - means received / written off instead of a new level). */
function CountStockModal({ open, onClose, onDone }) {
  const api = useApi();
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (open) {
      setText("");
      setResult(null);
    }
  }, [open]);
  if (!open) return null;
  const parse = () =>
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [code, qty] = line.split(/[,;\t]/).map((s) => s.trim());
        const delta = /^[+-]/.test(qty || "");
        const n = Number(qty);
        return { code, n, delta, bad: !code || !Number.isFinite(n) || (!delta && n < 0) };
      });
  const rows = parse();
  const submit = async () => {
    const good = rows.filter((r) => !r.bad);
    const updates = good.map((r) => ({ ...(/^\d{6,14}$/.test(r.code) ? { barcode: r.code } : { sku: r.code }), ...(r.delta ? { delta: r.n } : { stockQty: r.n }) }));
    const r = await run("count", () => api.post("/restaurant/menu/stock", { updates }));
    if (r.ok) {
      setResult(r.data);
      onDone();
    }
  };
  return (
    <FormModal open onClose={onClose} title="Count stock" onSubmit={result ? onClose : submit} busy={!!busy} submitText={result ? "Close" : `Update ${rows.filter((r) => !r.bad).length} product(s)`} disabled={!result && !rows.some((r) => !r.bad)} size="lg">
      {!result ? (
        <>
          <p className="text-secondary-light text-sm">
            One product per line: its <strong>SKU or barcode</strong>, a comma, then the quantity on the shelf. Start the quantity with <code>+</code> or <code>-</code> for stock received or written off
            (<code>FB-D-001,+24</code>) instead of a new level (<code>FB-D-001,40</code>). A product that was not tracked starts being tracked. Weighed products are counted in their weight unit (kg or lb).
          </p>
          <TextArea label="Products" rows={9} value={text} onChange={setText} placeholder={"FB-D-001,40\n0603830000125,+24\nFB-P-001,12.5"} />
          {rows.some((r) => r.bad) && <div className="text-danger-600 text-sm">Lines that cannot be read are skipped: {rows.filter((r) => r.bad).map((r) => r.code || "(empty)").join(", ")}</div>}
        </>
      ) : (
        <div data-testid="count-result">
          <div className="alert alert-success radius-8">
            <strong>{result.updated}</strong> product(s) updated, {result.unchanged} unchanged.
          </div>
          {result.notFound?.length > 0 && <div className="alert alert-warning radius-8">Not found in this store: {result.notFound.map((n) => n.key).join(", ")}</div>}
          {result.errors?.length > 0 && <div className="alert alert-danger radius-8">{result.errors.map((e) => `line ${e.row}: ${e.error}`).join(" · ")}</div>}
        </div>
      )}
    </FormModal>
  );
}

export default function CatalogTab({ menu, reload, onEdit, onAdd, onEightySix, canEdit }) {
  const api = useApi();
  const confirm = useConfirm();
  const { restaurantId, role } = usePortal();
  const { run } = useAction();
  const list = usePagedList("/restaurant/menu/items", { limit: 25, sortBy: "name", sortDir: "ASC", filters: { restaurantId, categoryId: "", stock: "" } });
  const [count, setCount] = useState(false);
  const canCount = ["OWNER", "LOCATION_MANAGER", "CASHIER"].includes(role);
  const tot = list.data?.counts || {};
  const refresh = () => {
    list.reload();
    reload();
  };

  useEffect(() => list.setFilter("restaurantId", restaurantId), [restaurantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const restock = async (it) => {
    const r = await run(it.id, () => api.post(`/restaurant/menu/items/${it.id}/restock`), `${it.name} back in stock`);
    if (r.ok) refresh();
  };
  const del = async (it) => {
    const cf = await confirm({ title: `Delete ${it.name}?`, message: "This removes the product from your catalog.", danger: true, confirmText: "Delete" });
    if (!cf.confirmed) return;
    const r = await run(it.id, () => api.del(`/restaurant/menu/items/${it.id}`), "Product deleted");
    if (r.ok) refresh();
  };
  const edit = async (it) => {
    // the list rows have no option groups: load the whole product so saving never drops them
    const r = await run(`load-${it.id}`, () => api.get(`/restaurant/menu/items/${it.id}`));
    if (r.ok) onEdit(r.data);
  };

  const columns = [
    {
      key: "name",
      title: "Product",
      sortable: true,
      render: (it) => (
        <div className="d-flex align-items-center gap-3">
          <PhotoThumb item={it} />
          <div>
          <div className="fw-semibold">
            {it.name}
            {it.minAge > 0 && <Badge tone="danger" className="ms-2">{it.minAge}+</Badge>}
            {TEMP_ICON[it.temperature] && (
              <span className="ms-2 text-info-600" title={TEMP_ICON[it.temperature].label}>
                <Icon icon={TEMP_ICON[it.temperature].icon} />
              </span>
            )}
          </div>
          <div className="text-secondary-light text-xs">{[it.brand, it.packSize].filter(Boolean).join(" · ") || "—"}</div>
          {(it.sku || it.barcode) && <div className="text-secondary-light text-xs font-monospace">{[it.sku, it.barcode].filter(Boolean).join(" · ")}</div>}
          </div>
        </div>
      ),
    },
    { key: "categoryName", title: "Department", render: (it) => it.categoryName || <span className="text-secondary-light">—</span> },
    {
      key: "price",
      title: "Price",
      sortable: true,
      render: (it) => (
        <div className="text-end">
          <div>{priceText(it)}</div>
          {it.sellBy === "WEIGHT" && <div className="text-secondary-light text-xs">orders in {Number(it.stepSize)} {String(it.weightUnit).toLowerCase()} steps</div>}
        </div>
      ),
    },
    { key: "stock", title: "Stock", sortable: true, render: (it) => <StockCell item={it} canCount={canCount} onSaved={refresh} /> },
    {
      key: "status",
      title: "Status",
      render: (it) => {
        const s = STOCK_BADGE[it.stockState] || STOCK_BADGE.UNTRACKED;
        return (
          <div className="d-flex flex-column gap-1 align-items-start">
            {!it.active ? <Badge tone="neutral">Hidden</Badge> : !it.available ? <Badge tone="danger">86&apos;d{it.restockAt ? ` until ${fmtDateTime(it.restockAt)}` : ""}</Badge> : <Badge tone={s.tone}>{s.label}</Badge>}
            {it.trackStock && it.lowStockThreshold != null && <span className="text-secondary-light text-xs">low at {Number(it.lowStockThreshold)}</span>}
          </div>
        );
      },
    },
    {
      key: "actions",
      title: "",
      render: (it) => (
        <div className="d-inline-flex gap-2 justify-content-end">
          {it.available ? (
            <Button variant="outline-danger" title="Stop selling it for now (until you resume)" onClick={() => onEightySix({ kind: "items", id: it.id, name: it.name })}>
              Pause
            </Button>
          ) : (
            <Button variant="success" onClick={() => restock(it)}>
              Resume
            </Button>
          )}
          {canEdit && (
            <>
              <IconButton icon="solar:pen-outline" title="Edit" tone="primary" onClick={() => edit(it)} />
              <IconButton icon="solar:trash-bin-trash-outline" title="Delete" tone="danger" onClick={() => del(it)} />
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="d-flex flex-wrap gap-2 mb-16" data-testid="catalog-counts">
        <Badge tone="neutral">{tot.total ?? list.meta.total} products</Badge>
        <button type="button" className="btn p-0 border-0" onClick={() => list.setFilter("stock", list.filters.stock === "low" ? "" : "low")}>
          <Badge tone="warning">{tot.lowStock ?? 0} low</Badge>
        </button>
        <button type="button" className="btn p-0 border-0" onClick={() => list.setFilter("stock", list.filters.stock === "out" ? "" : "out")}>
          <Badge tone="danger">{tot.outOfStock ?? 0} sold out</Badge>
        </button>
        <Badge tone="info">{tot.tracked ?? 0} counted</Badge>
      </div>
      <Card>
        <ListToolbar
          list={list}
          placeholder="Search name, brand, SKU, barcode…"
          filters={
            <>
              <FilterSelect value={list.filters.categoryId} onChange={(v) => list.setFilter("categoryId", v)} options={[...menu.categories.map((x) => ({ value: x.id, label: x.name })), { value: "none", label: "No department" }]} placeholder="All departments" />
              <FilterSelect
                value={list.filters.stock}
                onChange={(v) => list.setFilter("stock", v)}
                options={[
                  { value: "out", label: "Sold out" },
                  { value: "low", label: "Low stock" },
                  { value: "in", label: "Can be ordered" },
                  { value: "tracked", label: "Stock counted" },
                  { value: "untracked", label: "Stock not counted" },
                ]}
                placeholder="Any stock"
              />
            </>
          }
          actions={
            <>
              {canCount && (
                <Button variant="outline" icon="solar:clipboard-check-outline" onClick={() => setCount(true)}>
                  Count stock
                </Button>
              )}
              {canEdit && (
                <Button icon="solar:add-circle-outline" onClick={onAdd}>
                  Add product
                </Button>
              )}
            </>
          }
        />
        <DataTable columns={columns} {...list.tableProps} error={list.error} onRetry={list.reload} dense emptyTitle="No products match" emptyText="Change the search or the filters, or add a product." />
      </Card>
      <CountStockModal open={count} onClose={() => setCount(false)} onDone={refresh} />
    </>
  );
}
