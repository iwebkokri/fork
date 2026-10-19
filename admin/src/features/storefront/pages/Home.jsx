import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import FulfilmentToggle from "../components/FulfilmentToggle";
import PushBanner from "../components/PushBanner";
import RestaurantCard from "../components/RestaurantCard";
import { ErrorBox, Loading, Ri, Spinner } from "../components/ui";
import { setFulfilment, useSfFulfilment } from "../lib/fulfilment";
import { locParams, useSfLocation } from "../lib/location";
import { errorMessage, sfHttp } from "../lib/sfApi";

const LIMIT = 18;
const TYPE_ICON = { RESTAURANT: "restaurant-2-line", CAFE: "cup-line", BAKERY: "cake-3-line", GROCERY: "shopping-basket-2-line", CONVENIENCE: "store-3-line", SPECIALTY: "leaf-line" };

export default function Home({ openAssistant }) {
  const loc = useSfLocation();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const openNow = params.get("open") === "1";
  // delivery or pickup: the switch under the title (kept in the browser); a link with ?f=pickup or ?f=delivery wins
  const savedFulfilment = useSfFulfilment();
  const fulfilment = ["delivery", "pickup"].includes(params.get("f")) ? params.get("f") : savedFulfilment;
  const cuisine = params.get("c") || "";
  // kind of store: one type (t=GROCERY) or a whole group (v=RETAIL | FOOD); neither = every store
  const storeType = /^[A-Z_]{3,20}$/.test(params.get("t") || "") ? params.get("t") : "";
  const vertical = !storeType && ["FOOD", "RETAIL"].includes(params.get("v")) ? params.get("v") : "";
  const [text, setText] = useState(q);
  const [home, setHome] = useState(null);
  const [types, setTypes] = useState(null); // GET /public/store-types: { data: [{ type, pluralLabel, count }], verticals }
  const [res, setRes] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const seq = useRef(0);

  const set = useCallback(
    (patch) => {
      const next = new URLSearchParams(params);
      Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  // debounce the search box into the URL
  useEffect(() => {
    if (text === q) return undefined;
    const t = setTimeout(() => set({ q: text.trim() }), 350);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    sfHttp.get("/public/home", { ...locParams(loc), storeType: storeType || undefined, vertical: vertical || undefined }, { noAuth: true }).then((h) => live && setHome(h)).catch(() => {});
    return () => {
      live = false;
    };
  }, [loc, storeType, vertical]);

  // the kinds of store around (the tiles); not tied to the filter, so the row stays put while you switch
  useEffect(() => {
    let live = true;
    sfHttp.get("/public/store-types", locParams(loc), { noAuth: true }).then((t) => live && setTypes(t)).catch(() => live && setTypes(null));
    return () => {
      live = false;
    };
  }, [loc]);

  const load = useCallback(
    async (pg, append) => {
      const my = ++seq.current;
      append ? setMore(true) : setLoading(true);
      setError("");
      try {
        const r = await sfHttp.get(
          "/public/search",
          { q, openNow: openNow ? "true" : undefined, fulfilment: fulfilment || undefined, cuisine: cuisine || undefined, storeType: storeType || undefined, vertical: vertical || undefined, page: pg, limit: LIMIT, ...locParams(loc) },
          { noAuth: true }
        );
        if (my !== seq.current) return;
        setRes((cur) => (append && cur ? { ...r, restaurants: [...cur.restaurants, ...r.restaurants] } : r));
        setPage(pg);
      } catch (e) {
        if (my === seq.current) setError(errorMessage(e));
      } finally {
        if (my === seq.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [q, openNow, fulfilment, cuisine, storeType, vertical, loc]
  );
  useEffect(() => {
    load(1, false);
  }, [load]);

  const list = res?.restaurants || [];
  const total = res?.meta?.total ?? list.length;
  const promos = home?.promotions || [];
  const cuisines = (home?.cuisines || []).filter((c) => c.restaurantCount > 0);
  // store-type tiles: only kinds that exist around you; with a single kind there is nothing to switch between
  const typeTiles = (types?.data || []).filter((t) => t.count > 0);
  const vertTile = vertical ? (types?.verticals || []).find((v) => v.vertical === vertical) : null;
  const activeType = typeTiles.find((t) => t.type === storeType);
  // "Groceries and shops": a row of shops above the list, only on the unfiltered home page and when food places exist as well
  const retailRow = !storeType && !vertical && !q && !openNow && fulfilment === "delivery" && !cuisine ? home?.sections?.retail || [] : [];
  const showRetailRow = retailRow.length > 0 && (home?.sections?.food || []).length > 0;
  const heading = q ? `Results for "${q}"` : activeType ? `${activeType.pluralLabel} near you` : vertTile ? `${vertTile.label} near you` : "Restaurants and stores near you";

  return (
    <div className="sf-container">
      <section className="sf-hero">
        <h1>Food and groceries from local places, delivered.</h1>
        <p>Restaurants, cafes, grocery and convenience stores near you.</p>
        <div className="sf-hero-mode">
          <FulfilmentToggle value={fulfilment} onBrand testIdPrefix="filter" onChange={(v) => { setFulfilment(v); set({ f: "" }); }} />
        </div>
        <form className="sf-search" role="search" onSubmit={(e) => { e.preventDefault(); set({ q: text.trim() }); }}>
          <Ri name="search-line" />
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search stores, dishes or products" aria-label="Search" data-testid="search-input" maxLength={80} />
          <button type="submit" className="sf-btn sf-btn-primary">
            Search
          </button>
        </form>
        {openAssistant && (
          <button type="button" className="sf-btn sf-btn-light sf-hero-bot" onClick={openAssistant}>
            <Ri name="chat-smile-3-line" /> Not sure what to order? Ask our assistant
          </button>
        )}
      </section>

      <PushBanner />

      {typeTiles.length > 1 && (
        <div className="sf-types" role="group" aria-label="Kind of store" data-testid="store-types">
          <button type="button" className={`sf-type ${!storeType && !vertical ? "on" : ""}`} aria-pressed={!storeType && !vertical} onClick={() => set({ t: "", v: "" })} data-testid="type-all">
            <Ri name="apps-2-line" />
            <b>All</b>
          </button>
          {vertTile && (
            <button type="button" className="sf-type on" aria-pressed="true" data-testid={`vertical-${vertTile.vertical}`}>
              <Ri name={vertical === "RETAIL" ? "shopping-basket-2-line" : "restaurant-2-line"} />
              <b>{vertTile.label}</b>
              <span className="sf-small">{vertTile.count}</span>
            </button>
          )}
          {typeTiles.map((t) => (
            <button key={t.type} type="button" className={`sf-type ${storeType === t.type ? "on" : ""}`} aria-pressed={storeType === t.type} onClick={() => set({ t: t.type, v: "" })} data-testid={`type-${t.type}`}>
              <Ri name={TYPE_ICON[t.type] || "store-2-line"} />
              <b>{t.pluralLabel}</b>
              <span className="sf-small">{t.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="sf-filters" role="group" aria-label="Filters">
        <button type="button" className={`sf-chip ${openNow ? "on" : ""}`} aria-pressed={openNow} onClick={() => set({ open: openNow ? "" : "1" })} data-testid="filter-open">
          <Ri name="door-open-line" /> Open now
        </button>
        {cuisines.slice(0, 12).map((c) => (
          <button key={c.id} type="button" className={`sf-chip ${cuisine === c.slug ? "on" : ""}`} aria-pressed={cuisine === c.slug} onClick={() => set({ c: cuisine === c.slug ? "" : c.slug })}>
            {c.name}
          </button>
        ))}
      </div>

      {promos.length > 0 && !q && (
        <div className="sf-promos" aria-label="Offers">
          {promos.slice(0, 4).map((p) => (
            <div key={p.id} className="sf-promo">
              <b>{p.label || p.name}</b>
              <span className="sf-small">{p.description}</span>
              {p.code && <code>{p.code}</code>}
            </div>
          ))}
        </div>
      )}

      {showRetailRow && (
        <section aria-label="Groceries and shops" data-testid="retail-row">
          <div className="sf-row-between">
            <h2 className="sf-h2">Groceries and shops</h2>
            <button type="button" className="sf-btn sf-btn-link" onClick={() => set({ v: "RETAIL" })} data-testid="retail-see-all">
              See all
            </button>
          </div>
          <div className="sf-strip">
            {retailRow.slice(0, 6).map((r) => (
              <div key={r.id} className="sf-strip-item">
                <RestaurantCard r={r} />
              </div>
            ))}
          </div>
        </section>
      )}

      <h2 className="sf-h2" data-testid="home-heading">
        {heading}
        {res && <span className="sf-muted sf-small ms-2">{total} found</span>}
      </h2>
      {!loc && <p className="sf-small sf-muted">Tip: choose your area at the top to see who delivers to you.</p>}

      {error && <ErrorBox message={error} onRetry={() => load(1, false)} />}
      {loading && !res && <Loading text="Finding places..." />}
      {res && list.length === 0 && !loading && (
        <div className="sf-center sf-muted py-5">
          <Ri name="emotion-sad-line" className="sf-bigicon" />
          <p className="mt-2">Nothing matches. Try removing a filter.</p>
          <button type="button" className="sf-btn sf-btn-light" onClick={() => { setText(""); setParams({}, { replace: true }); }}>
            Clear filters
          </button>
        </div>
      )}
      <div className={`sf-grid ${loading && res ? "is-busy" : ""}`} data-testid="restaurant-list">
        {list.map((r) => (
          <RestaurantCard key={r.id} r={r} />
        ))}
      </div>
      {res && list.length < total && (
        <div className="sf-center mt-3 mb-4">
          <button type="button" className="sf-btn sf-btn-light" disabled={more} onClick={() => load(page + 1, true)}>
            {more ? <Spinner size={16} /> : null} Show more
          </button>
        </div>
      )}
    </div>
  );
}
