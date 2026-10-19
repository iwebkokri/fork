import React from "react";
import { FULFILMENT_OPTIONS } from "../lib/fulfilment";
import { Ri } from "./ui";

/**
 * Delivery / Pickup switch. The chosen side shows its icon and its title, the other side only its icon (its title is the tooltip and the screen reader name).
 * `unavailable`: { pickup: true } greys a side out (it cannot be chosen); `testIdPrefix` gives the buttons their test ids (`${prefix}-delivery`, `${prefix}-pickup`);
 * `onBrand` is the look on the orange banner.
 */
export default function FulfilmentToggle({ value, onChange, unavailable = {}, testIdPrefix = "fulfilment", onBrand = false, label = "Delivery or pickup" }) {
  return (
    <div className={`sf-toggle ${onBrand ? "sf-toggle-brand" : ""}`} role="radiogroup" aria-label={label} data-testid={`${testIdPrefix}-toggle`}>
      {FULFILMENT_OPTIONS.map((o) => {
        const on = value === o.value;
        const off = !!unavailable[o.value];
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={off ? `${o.label} (not available)` : o.label}
            title={off ? `${o.label} (not available)` : o.label}
            className={on ? "on" : ""}
            disabled={off}
            onClick={() => !on && onChange(o.value)}
            data-testid={`${testIdPrefix}-${o.value}`}
          >
            <Ri name={o.icon} />
            {on && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
