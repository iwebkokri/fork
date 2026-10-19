import { useSyncExternalStore } from "react";
import { SF_KEYS, sfStore } from "./sfApi";

/**
 * "Deliver to" location used to rank restaurants and decide which can deliver to you (the API takes lat/lng).
 * There is NO geocoding provider connected yet (no Google Maps key), so a street address cannot be turned into
 * coordinates automatically: customers pick one of these demo locations (one per delivery zone of Mississauga, Brampton, Edmonton and Winnipeg, approximate) or,
 * when signed in, one of their saved addresses. `province` is the one of the city (default ON).
 */
export const DEMO_LOCATIONS = [
  { label: "Square One area, Mississauga", city: "Mississauga", postalCode: "L5B 2C9", lat: 43.5933, lng: -79.6419 },
  { label: "Erin Mills, Mississauga", city: "Mississauga", postalCode: "L5L 1A1", lat: 43.56, lng: -79.7 },
  { label: "Port Credit, Mississauga", city: "Mississauga", postalCode: "L5G 1A1", lat: 43.5535, lng: -79.5851 },
  { label: "Meadowvale, Mississauga", city: "Mississauga", postalCode: "L5N 7T1", lat: 43.5929, lng: -79.7564 },
  { label: "Downtown Brampton", city: "Brampton", postalCode: "L6Y 1N2", lat: 43.6858, lng: -79.7599 },
  { label: "Springdale, Brampton", city: "Brampton", postalCode: "L6R 3J7", lat: 43.7315, lng: -79.7624 },
  { label: "Bramalea, Brampton", city: "Brampton", postalCode: "L6T 3R4", lat: 43.7176, lng: -79.7217 },
  { label: "Streetsville, Mississauga", city: "Mississauga", postalCode: "L5M 1X1", lat: 43.5779, lng: -79.7156 },
  { label: "Heart Lake, Brampton", city: "Brampton", postalCode: "L6Z 1A1", lat: 43.75, lng: -79.82 },
  { label: "Downtown Edmonton", city: "Edmonton", province: "AB", postalCode: "T5J 1N5", lat: 53.5444, lng: -113.4909 },
  { label: "West Edmonton", city: "Edmonton", province: "AB", postalCode: "T5T 4M2", lat: 53.5225, lng: -113.6242 },
  { label: "Millwoods, Edmonton", city: "Edmonton", province: "AB", postalCode: "T6L 6Y8", lat: 53.463, lng: -113.42 },
  { label: "Downtown Winnipeg", city: "Winnipeg", province: "MB", postalCode: "R3C 1A5", lat: 49.8951, lng: -97.1384 },
  { label: "Fort Garry, Winnipeg", city: "Winnipeg", province: "MB", postalCode: "R3T 2N2", lat: 49.811, lng: -97.15 },
  { label: "Transcona, Winnipeg", city: "Winnipeg", province: "MB", postalCode: "R2C 0A1", lat: 49.887, lng: -96.966 },
];

const listeners = new Set();
let snapshot = null;

function read() {
  const v = sfStore.getJson(SF_KEYS.location, "local", null);
  return v && Number.isFinite(v.lat) && Number.isFinite(v.lng) ? v : null;
}
snapshot = read();

export function getLocation() {
  return snapshot;
}
export function setLocation(loc) {
  snapshot = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) ? { label: String(loc.label || "").slice(0, 120), lat: loc.lat, lng: loc.lng } : null;
  if (snapshot) sfStore.setJson(SF_KEYS.location, snapshot, "local");
  else sfStore.del(SF_KEYS.location, "local");
  listeners.forEach((l) => l());
}
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const useSfLocation = () => useSyncExternalStore(subscribe, getLocation);

/** query params for discovery calls */
export const locParams = (loc) => (loc ? { lat: loc.lat, lng: loc.lng } : {});
