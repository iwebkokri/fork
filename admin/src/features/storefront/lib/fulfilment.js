import { useSyncExternalStore } from "react";
import { SF_KEYS, sfStore } from "./sfApi";

/**
 * Delivery or pickup: what the customer wants, kept in the browser (like the "Deliver to" area). The home page lists the places that offer it and the checkout starts with it.
 * Values are the ones of the home page filter: "delivery" (the default) and "pickup".
 */
export const FULFILMENT_OPTIONS = [
  { value: "delivery", label: "Delivery", icon: "e-bike-2-line" },
  { value: "pickup", label: "Pickup", icon: "walk-line" },
];

const clean = (v) => (v === "pickup" ? "pickup" : "delivery");
const listeners = new Set();
let snapshot = clean(sfStore.get(SF_KEYS.fulfilment, "local"));

export const getFulfilment = () => snapshot;
export function setFulfilment(value) {
  snapshot = clean(value);
  if (snapshot === "pickup") sfStore.set(SF_KEYS.fulfilment, snapshot, "local");
  else sfStore.del(SF_KEYS.fulfilment, "local");
  listeners.forEach((l) => l());
}
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const useSfFulfilment = () => useSyncExternalStore(subscribe, getFulfilment);
