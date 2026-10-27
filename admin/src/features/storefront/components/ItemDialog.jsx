import React, { useMemo, useState } from "react";
import { SUBSTITUTION_CHOICES, ageNotice, coldChain, isWeighed, perUnitPrice, stepPriceOf, stepText, stockBadge, weightText } from "../lib/retail";
import { money } from "../lib/sfApi";
import { Dialog, Notice, Pic, Ri, Spinner } from "./ui";
import { QtyStepper } from "./CartPanel";
import PhotoGallery from "./PhotoGallery";

/** Minimum / maximum picks for a modifier group. */
export const groupLimits = (g) => ({ min: g.required ? Math.max(1, g.minSelect || 0) : g.minSelect || 0, max: g.maxSelect > 0 ? g.maxSelect : Infinity });

export const hasRequiredChoices = (item) => (item.modifierGroups || []).some((g) => groupLimits(g).min > 0);

export const itemDisabled = (item, restaurantClosed) => restaurantClosed || item.available === false;

const SPICE_TEXT = { MILD: "mild", MEDIUM: "medium", HOT: "hot", EXTRA_HOT: "extra hot" };
const NUTRITION_TEXT = { fatG: "Fat", satFatG: "Saturated fat", carbsG: "Carbs", sugarG: "Sugar", fibreG: "Fibre", proteinG: "Protein", sodiumMg: "Sodium" };

/** size, ingredients, nutrition, origin and storage of an item, when the store filled them in */
function ItemFacts({ item }) {
  const d = item.dimensions;
  const size = d ? [d.lengthCm, d.widthCm, d.heightCm].filter((v) => v != null).join(" x ") : "";
  const nutrition = Object.entries(item.nutrition || {}).filter(([k]) => NUTRITION_TEXT[k]);
  if (!size && !item.ingredients && !nutrition.length && !item.countryOfOrigin && !item.storage) return null;
  return (
    <div className="sf-small sf-muted mt-2" data-testid="item-facts">
      {size && <div>Size: {size} cm</div>}
      {item.ingredients && <div>Ingredients: {item.ingredients}</div>}
      {nutrition.length > 0 && <div>{item.servingSize ? `Per ${item.servingSize}: ` : "Nutrition: "}{nutrition.map(([k, v]) => `${NUTRITION_TEXT[k]} ${v}${k === "sodiumMg" ? " mg" : " g"}`).join(", ")}</div>}
      {item.countryOfOrigin && <div>Origin: {item.countryOfOrigin}</div>}
      {item.storage && <div>Storage: {item.storage}</div>}
    </div>
  );
}

function initialSelection(item) {
  const sel = {};
  for (const g of item.modifierGroups || []) {
    const { max } = groupLimits(g);
    const defaults = g.options.filter((o) => o.isDefault && o.available !== false).slice(0, Number.isFinite(max) ? max : 99);
    sel[g.id] = defaults.map((o) => o.id);
  }
  return sel;
}

/**
 * retail: the item is a grocery product (adds the "if it is not available" choice); maxPerLine: the store's per-line limit;
 * inCart: how many of this product the cart already holds (the product's limit counts them).
 * A product sold by weight is ordered in steps (0.5 kg): the stepper shows the weight and the button the price of the line.
 */
export default function ItemDialog({ item, open, onClose, onAdd, disabledReason, retail = false, maxPerLine = 50, inCart = 0 }) {
  const [sel, setSel] = useState(() => (item ? initialSelection(item) : {}));
  const [notes, setNotes] = useState("");
  const [qty, setQty] = useState(1);
  const [substitution, setSubstitution] = useState("ALLOW");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);

  const errors = useMemo(() => {
    const out = {};
    for (const g of item?.modifierGroups || []) {
      const { min, max } = groupLimits(g);
      const n = (sel[g.id] || []).length;
      if (n < min) out[g.id] = `Choose ${min === 1 ? "1 option" : `at least ${min}`}`;
      else if (n > max) out[g.id] = `Choose at most ${max}`;
    }
    return out;
  }, [item, sel]);

  if (!item) return null;

  const chosen = [];
  let delta = 0;
  for (const g of item.modifierGroups || []) {
    for (const o of g.options) {
      if ((sel[g.id] || []).includes(o.id)) {
        chosen.push({ optionId: o.id, name: o.name, priceDelta: o.priceDelta || 0, groupName: g.name });
        delta += o.priceDelta || 0;
      }
    }
  }
  const weighed = isWeighed(item);
  const stock = stockBadge(item);
  const cold = coldChain(item);
  // price of one unit: one piece, or one step of a weighed product (the product price is per kg / lb)
  const unit = (weighed ? stepPriceOf(item) : Number(item.price)) + delta;
  // what can still be added: the product's limit (stock, per-order limit) and the store's per-line limit, less what is already in the cart
  const room = Math.max(0, Math.min(item.maxQuantity ?? maxPerLine, maxPerLine) - inCart);
  const full = room <= 0 && item.available !== false;
  const blocked = !!disabledReason || item.available === false || full;
  const minAge = item.minAge || 0;

  const toggle = (g, o) => {
    const { max } = groupLimits(g);
    setSel((cur) => {
      const now = cur[g.id] || [];
      if (now.includes(o.id)) return { ...cur, [g.id]: now.filter((x) => x !== o.id) };
      if (max === 1) return { ...cur, [g.id]: [o.id] };
      if (now.length >= max) return cur;
      return { ...cur, [g.id]: [...now, o.id] };
    });
  };

  const submit = async () => {
    setTouched(true);
    if (Object.keys(errors).length || blocked) return;
    setBusy(true);
    const ok = await onAdd({ item, quantity: Math.min(qty, Math.max(1, room)), options: chosen, notes, substitution: retail ? substitution : undefined });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={item.name}
      footer={
        <div className="sf-itemfoot">
          <QtyStepper
            value={qty}
            min={1}
            max={Math.max(1, room)}
            onChange={(q) => setQty(Math.min(Math.max(1, q), Math.max(1, room)))}
            label={item.name}
            display={weighed ? weightText(item, qty) : undefined}
            step={weighed ? stepText(item) : "one"}
            disabled={full}
          />
          <button type="button" className="sf-btn sf-btn-primary flex-grow-1" onClick={submit} disabled={busy || blocked} data-testid="item-add">
            {busy ? <Spinner size={16} /> : null} {full ? "Most allowed is in your cart" : blocked ? disabledReason || (retail && stock ? stock.text : "Not available") : `Add to cart - ${money(unit * qty)}`}
          </button>
        </div>
      }
    >
      <PhotoGallery photos={[item.imageUrl, ...(item.galleryUrls || [])].filter(Boolean)} name={item.name} />
      {(item.brand || (item.packSize && !weighed)) && <p className="sf-muted mb-1" data-testid="item-brand">{[item.brand, !weighed && item.packSize].filter(Boolean).join(" - ")}</p>}
      {weighed && (
        <p className="mb-1" data-testid="item-weight-price">
          <b>{perUnitPrice(item)}</b> <span className="sf-muted">sold in steps of {stepText(item)} ({money(stepPriceOf(item))} each)</span>
        </p>
      )}
      {item.description && <p>{item.description}</p>}
      <div className="sf-tags">
        {stock && (retail || stock.tone === "warn") && <span className={`sf-tag sf-tag-${stock.tone}`}>{stock.text}</span>}
        {cold && (
          <span className="sf-tag sf-tag-cold">
            <Ri name={cold.icon} /> {cold.text}
          </span>
        )}
        {minAge > 0 && <span className="sf-tag sf-tag-warn">{minAge}+</span>}
        {(item.dietaryTags || []).map((t) => (
          <span key={t} className="sf-tag sf-tag-ok">{t}</span>
        ))}
        {(item.allergens || []).length > 0 && <span className="sf-tag sf-tag-warn">Contains: {item.allergens.join(", ")}</span>}
        {(item.mayContain || []).length > 0 && <span className="sf-tag sf-tag-warn">May contain: {item.mayContain.join(", ")}</span>}
        {item.spiceLevel && item.spiceLevel !== "NONE" && <span className="sf-tag" data-testid="item-spice">Spice: {SPICE_TEXT[item.spiceLevel] || item.spiceLevel}</span>}
        {item.calories ? <span className="sf-tag">{item.calories} cal{item.servingSize ? ` per ${item.servingSize}` : ""}</span> : null}
      </div>
      <ItemFacts item={item} />
      {minAge > 0 && (
        <Notice tone="warn" icon="id-card-line">
          <span data-testid="age-notice">{ageNotice(minAge)}</span>
        </Notice>
      )}
      {weighed && <p className="sf-small sf-muted mt-2 mb-0">You are charged for the weight the store measures, up to the amount you choose. If it weighs less you get the difference back.</p>}
      {item.maxPerOrder != null && item.maxPerOrder === item.maxQuantity && <p className="sf-small sf-muted mt-2 mb-0">Limit {item.maxPerOrder} per order.</p>}
      {inCart > 0 && <p className="sf-small sf-muted mt-2 mb-0">{weighed ? `You already have ${weightText(item, inCart)} of this in your cart.` : `You already have ${inCart} of this in your cart.`}</p>}
      {(item.modifierGroups || []).map((g) => {
        const { min, max } = groupLimits(g);
        const err = touched && errors[g.id];
        const single = max === 1;
        return (
          <fieldset key={g.id} className={`sf-group ${err ? "has-error" : ""}`} data-testid="modifier-group">
            <legend>
              {g.name}
              <span className={`sf-tag ${min > 0 ? "sf-tag-danger" : ""} ms-2`}>{min > 0 ? "Required" : "Optional"}</span>
            </legend>
            <div className="sf-small sf-muted mb-1">{single ? "Choose 1" : Number.isFinite(max) ? `Choose ${min > 0 ? `${min} to ` : "up to "}${max}` : min > 0 ? `Choose at least ${min}` : "Choose any"}</div>
            {g.options.map((o) => {
              const on = (sel[g.id] || []).includes(o.id);
              const off = o.available === false || (!on && !single && (sel[g.id] || []).length >= max);
              return (
                <label key={o.id} className={`sf-option ${on ? "on" : ""} ${off ? "off" : ""}`}>
                  <input type={single ? "radio" : "checkbox"} name={g.id} checked={on} disabled={off} onChange={() => toggle(g, o)} />
                  <span className="flex-grow-1">
                    {o.name}
                    {o.available === false && <span className="sf-tag sf-tag-danger ms-2">Unavailable</span>}
                  </span>
                  {o.priceDelta ? <span className="sf-muted">{o.priceDelta > 0 ? "+" : ""}{money(o.priceDelta)}</span> : null}
                </label>
              );
            })}
            {err && (
              <div className="sf-error" role="alert">
                <Ri name="error-warning-line" /> {errors[g.id]}
              </div>
            )}
          </fieldset>
        );
      })}
      {retail && (
        <fieldset className="sf-group" data-testid="substitution">
          <legend>If it is not available</legend>
          {SUBSTITUTION_CHOICES.map((c) => (
            <label key={c.value} className={`sf-option ${substitution === c.value ? "on" : ""}`}>
              <input type="radio" name="substitution" value={c.value} checked={substitution === c.value} onChange={() => setSubstitution(c.value)} data-testid={`substitution-${c.value}`} />
              <span className="flex-grow-1">{c.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      <label className="sf-label mt-3" htmlFor="item-notes">
        Special instructions <span className="sf-muted">(optional)</span>
      </label>
      <textarea id="item-notes" className="sf-input" rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={retail ? "Ripeness, how to cut it, anything the picker should know" : "Allergies, no onions..."} />
      <div className="sf-small sf-muted text-end">{notes.length}/300</div>
    </Dialog>
  );
}
