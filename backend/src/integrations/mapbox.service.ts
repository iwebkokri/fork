import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { KeySource } from './stripe-client.service';
import { AutocompleteResult, GeoAddress, GeoSuggestion, RetrieveResult, ReverseResult, RouteResult, TestOutcome, TileConfig } from './maps.types';

export type { GeoAddress, GeoSuggestion } from './maps.types';

export interface MapboxConfig {
  token: string;
  tokenSource: KeySource;
  publicToken: string;
  /** "username/style_id" of the map style drawn in the browser, e.g. mapbox/streets-v12 */
  style: string;
  country: string;
  bbox: string;
  proximity: string;
}

export const MAPBOX_STYLE_RE = /^[A-Za-z0-9_-]{1,40}\/[A-Za-z0-9_-]{1,60}$/;
export const DEFAULT_MAPBOX_STYLE = 'mapbox/streets-v12';

/**
 * "username/style_id" from whatever the owner copies out of Mapbox: `mapbox://styles/user/id` (the "Style URL" of Mapbox Studio), `https://api.mapbox.com/styles/v1/user/id?access_token=...`,
 * the Studio address `https://studio.mapbox.com/styles/user/id/edit/...`, or `user/id` itself (the query string, which may carry a token, is dropped). Anything else comes back
 * unchanged, so MAPBOX_STYLE_RE still refuses it.
 */
export function normalizeMapboxStyle<T>(raw: T): T | string {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  const m = /^(?:mapbox:\/\/styles\/|https:\/\/(?:api|studio)\.mapbox\.com\/styles\/(?:v1\/)?)([A-Za-z0-9_-]{1,40})\/([A-Za-z0-9_-]{1,60})(?:[/?#.].*)?$/i.exec(s);
  return m ? `${m[1]}/${m[2]}` : s;
}

export const MAPBOX_TOKEN_RE = /^(sk|pk)\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
export const MAPBOX_PUBLIC_TOKEN_RE = /^pk\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
export const BBOX_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?,-?\d{1,2}(\.\d+)?$/;
export const PROXIMITY_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,2}(\.\d+)?$/;
export const COUNTRY_RE = /^[a-z]{2}(,[a-z]{2}){0,9}$/;

const TTL_MS = 60 * 60 * 1000;
const MAX_CACHE = 2000;

/**
 * Address search through Mapbox (Search Box API: suggest -> retrieve, plus reverse). The browser NEVER sees the Mapbox token:
 * the web / mobile apps call FORKSY's own /public/geocode/* routes, this service calls Mapbox.
 * Without a token every method answers { enabled:false } so clients fall back to manual entry / demo areas.
 * MAPBOX_API_BASE points it at a fake server (development / tests only, ignored in production).
 * Besides address search it answers the two other Mapbox jobs of MapsService: driving routes (Directions API, server token) and the map tile
 * URL for browsers (Styles API, PUBLIC pk. token only).
 */
@Injectable()
export class MapboxService {
  private readonly logger = new Logger('Mapbox');
  private cache = new Map<string, { at: number; value: any }>();

  constructor(private settings: SettingsService) {}

  config(): MapboxConfig {
    const s = this.settings.get<string>('integrations.mapbox.accessToken', '');
    const env = (process.env.MAPBOX_ACCESS_TOKEN ?? '').trim();
    const token = (typeof s === 'string' && s.trim()) || env;
    const pub = (this.settings.get<string>('integrations.mapbox.publicToken', '') || process.env.MAPBOX_PUBLIC_TOKEN || '').trim();
    return {
      token,
      tokenSource: typeof s === 'string' && s.trim() ? 'settings' : env ? 'env' : 'none',
      publicToken: pub,
      style: normalizeMapboxStyle((this.settings.get<string>('integrations.mapbox.style', DEFAULT_MAPBOX_STYLE) || DEFAULT_MAPBOX_STYLE) as string),
      country: String(this.settings.get<string>('integrations.mapbox.country', 'ca') || 'ca').toLowerCase(),
      bbox: String(this.settings.get<string>('integrations.mapbox.bbox', '') ?? '').trim(),
      proximity: String(this.settings.get<string>('integrations.mapbox.proximity', '') ?? '').trim(),
    };
  }

  get enabled(): boolean {
    return !!this.config().token;
  }

  private base(): string {
    const raw = (process.env.MAPBOX_API_BASE ?? '').trim().replace(/\/+$/, '');
    if (raw && process.env.NODE_ENV !== 'production') return raw;
    return 'https://api.mapbox.com';
  }

  private cached<T>(key: string): T | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  private remember(key: string, value: any) {
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: Date.now(), value });
  }

  clearCache() {
    this.cache.clear();
  }

  /** GET against Mapbox. The token travels only server -> Mapbox. */
  private async call(path: string, params: Record<string, string | number | undefined>): Promise<any> {
    const cfg = this.config();
    const url = new URL(this.base() + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    url.searchParams.set('access_token', cfg.token);
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    } catch (e: any) {
      this.logger.warn(`Mapbox request failed: ${e?.name ?? 'error'}`);
      throw new BadGatewayException('Address search is unavailable right now');
    }
    if (res.status === 401 || res.status === 403) throw new BadGatewayException('MAPBOX_AUTH');
    if (res.status === 429) throw new BadGatewayException('Address search is busy, please try again in a moment');
    if (!res.ok) {
      this.logger.warn(`Mapbox answered HTTP ${res.status}`);
      throw new BadGatewayException('Address search is unavailable right now');
    }
    return res.json();
  }

  private searchParams(proximity?: string) {
    const cfg = this.config();
    return {
      country: cfg.country || 'ca',
      bbox: cfg.bbox || undefined,
      proximity: proximity || cfg.proximity || undefined,
      language: 'en',
    };
  }

  // ------------------------------------------------------------------ public operations
  async autocomplete(q: string, opts: { proximity?: string; sessionToken: string }): Promise<AutocompleteResult> {
    if (!this.enabled) return { enabled: false, suggestions: [] };
    const key = `s|${q.toLowerCase()}|${opts.proximity ?? ''}`;
    const hit = this.cached<GeoSuggestion[]>(key);
    if (hit) return { enabled: true, suggestions: hit };
    try {
      const j = await this.call('/search/searchbox/v1/suggest', { q, session_token: opts.sessionToken, limit: 6, types: 'address', ...this.searchParams(opts.proximity) });
      const out: GeoSuggestion[] = (j?.suggestions ?? [])
        .filter((s: any) => s?.mapbox_id && (s.feature_type === 'address' || !s.feature_type))
        .slice(0, 6)
        .map((s: any) => ({
          id: String(s.mapbox_id),
          line1: String(s.name ?? s.address ?? ''),
          secondary: String(s.place_formatted ?? ''),
          label: String(s.full_address ?? [s.name, s.place_formatted].filter(Boolean).join(', ')),
        }));
      this.remember(key, out);
      return { enabled: true, suggestions: out };
    } catch (e: any) {
      return this.softFail(e);
    }
  }

  async retrieve(id: string, sessionToken: string): Promise<RetrieveResult> {
    if (!this.enabled) return { enabled: false };
    const key = `r|${id}`;
    const hit = this.cached<GeoAddress>(key);
    if (hit) return { enabled: true, address: hit };
    try {
      const j = await this.call(`/search/searchbox/v1/retrieve/${encodeURIComponent(id)}`, { session_token: sessionToken, language: 'en' });
      const addr = this.toAddress(j?.features?.[0]);
      if (!addr) throw new BadRequestException('That address could not be located');
      this.remember(key, addr);
      return { enabled: true, address: addr };
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      return this.softFail(e);
    }
  }

  async reverse(lat: number, lng: number): Promise<ReverseResult> {
    if (!this.enabled) return { enabled: false };
    const key = `v|${lat.toFixed(5)},${lng.toFixed(5)}`;
    const hit = this.cached<GeoAddress | null>(key);
    if (hit !== undefined) return { enabled: true, address: hit };
    try {
      const j = await this.call('/search/searchbox/v1/reverse', { longitude: lng, latitude: lat, limit: 1, types: 'address', country: this.config().country || 'ca', language: 'en' });
      const addr = this.toAddress(j?.features?.[0]) ?? null;
      this.remember(key, addr);
      return { enabled: true, address: addr };
    } catch (e: any) {
      return this.softFail(e);
    }
  }

  /** Driving distance and time between two points (Mapbox Directions API, no live traffic, so the same trip always answers the same). Throws when Mapbox cannot answer. */
  async route(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<RouteResult> {
    if (!this.enabled) throw new BadGatewayException('MAPBOX_OFF');
    const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
    const j = await this.call(`/directions/v5/mapbox/driving/${coords}`, { overview: 'false', alternatives: 'false', steps: 'false' });
    const r = j?.routes?.[0];
    const m = Number(r?.distance);
    const s = Number(r?.duration);
    if (!Number.isFinite(m) || !Number.isFinite(s) || m < 0) throw new BadGatewayException('Mapbox found no route');
    return { km: m / 1000, minutes: Math.max(1, Math.round(s / 60)), source: 'mapbox' };
  }

  /** Map tiles for browsers: needs the PUBLIC (pk.) token; null when there is none (the caller falls back to the OpenStreetMap tiles). */
  tileConfig(): TileConfig | null {
    const c = this.config();
    if (!c.publicToken || !MAPBOX_PUBLIC_TOKEN_RE.test(c.publicToken)) return null;
    const style = MAPBOX_STYLE_RE.test(c.style) ? c.style : DEFAULT_MAPBOX_STYLE;
    return {
      provider: 'mapbox',
      url: `${this.base()}/styles/v1/${style}/tiles/256/{z}/{x}/{y}{r}?access_token=${c.publicToken}`,
      attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      tileSize: 256,
      maxZoom: 20,
    };
  }

  private softFail(e: any): any {
    if (e instanceof BadGatewayException && e.message === 'MAPBOX_AUTH') {
      this.logger.error('Mapbox rejected the access token (invalid, revoked or missing the Search scope) - address search is off until it is fixed');
      return { enabled: false, error: 'Address search is not available', suggestions: [] };
    }
    return { enabled: true, error: e?.message ?? 'Address search is unavailable right now', suggestions: [] };
  }

  /** Mapbox Search Box feature -> FORKSY address. */
  toAddress(f: any): GeoAddress | null {
    if (!f) return null;
    const c = f.geometry?.coordinates;
    const p = f.properties ?? {};
    const lng = Array.isArray(c) ? Number(c[0]) : Number(p.coordinates?.longitude);
    const lat = Array.isArray(c) ? Number(c[1]) : Number(p.coordinates?.latitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const ctx = p.context ?? {};
    const line1 = String(ctx.address?.name ?? ([ctx.address?.address_number, ctx.address?.street_name].filter(Boolean).join(' ') || p.name || p.address || ''));
    const region = ctx.region?.region_code ?? ctx.region?.region_code_full?.split('-').pop() ?? ctx.region?.name ?? '';
    return {
      line1: line1.slice(0, 200),
      city: String(ctx.place?.name ?? ctx.locality?.name ?? ctx.district?.name ?? '').slice(0, 80),
      province: String(region).slice(0, 40),
      postalCode: String(ctx.postcode?.name ?? '').toUpperCase().slice(0, 12),
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      label: String(p.full_address ?? [line1, ctx.place?.name, region].filter(Boolean).join(', ')).slice(0, 300),
    };
  }

  // ------------------------------------------------------------------ admin "Test connection"
  /** Can the public (pk.) token draw the configured style? Asks for the first map tile, as the maps of the admin screens do. Never returns the token. */
  private async tileCheck(): Promise<{ ok: boolean; style: string; reason?: string }> {
    const c = this.config();
    const style = MAPBOX_STYLE_RE.test(c.style) ? c.style : DEFAULT_MAPBOX_STYLE;
    if (!c.publicToken || !MAPBOX_PUBLIC_TOKEN_RE.test(c.publicToken)) return { ok: false, style, reason: 'No public (pk.) token is set: the maps on the admin screens use OpenStreetMap' };
    try {
      const res = await fetch(`${this.base()}/styles/v1/${style}/tiles/256/0/0/0?access_token=${c.publicToken}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return { ok: true, style };
      if (res.status === 404) return { ok: false, style, reason: `Mapbox has no style "${style}": copy the Style URL from Mapbox Studio (Share) and paste it into Map style` };
      if (res.status === 401 || res.status === 403) return { ok: false, style, reason: `The public token cannot draw the style "${style}": use a token of the Mapbox account that owns the style (it needs the styles:tiles and styles:read scopes) or share the style` };
      return { ok: false, style, reason: `Mapbox answered HTTP ${res.status} for the style "${style}"` };
    } catch {
      return { ok: false, style, reason: 'Mapbox could not be reached to check the map style' };
    }
  }

  /** One forward geocode request. Never returns the token. */
  async test(): Promise<TestOutcome & { country: string; bbox: string; tokenKind: string }> {
    const cfg = this.config();
    const tokenKind = cfg.token.startsWith('sk.') ? 'secret (sk.)' : cfg.token.startsWith('pk.') ? 'public (pk.)' : cfg.token ? 'unknown' : 'none';
    const base = { country: cfg.country, bbox: cfg.bbox, tokenKind };
    if (!cfg.token) return { ok: false, reason: 'No Mapbox access token is configured', ...base };
    const t0 = Date.now();
    try {
      const j = await this.call('/search/searchbox/v1/suggest', { q: '1 City Centre Dr Mississauga', session_token: 'forksy-connection-test', limit: 1, types: 'address', ...this.searchParams() });
      const n = (j?.suggestions ?? []).length;
      if (!n) return { ok: false, reason: 'Mapbox answered but found no address for the test search (check the country / bounding box settings)', latencyMs: Date.now() - t0, ...base };
      // routing uses another scope of the token (Directions): report it separately, it does not fail the address search test
      let routing: { ok: boolean; km?: number; minutes?: number; reason?: string };
      try {
        const r = await this.route({ lat: 43.5931, lng: -79.6413 }, { lat: 43.6114, lng: -79.6296 });
        routing = { ok: true, km: Math.round(r.km * 100) / 100, minutes: r.minutes };
      } catch (e: any) {
        routing = { ok: false, reason: e?.message === 'MAPBOX_AUTH' ? 'The token cannot use the Directions API (road distance and time fall back to the estimate)' : String(e?.message ?? 'Directions request failed') };
      }
      return { ok: true, sample: String(j.suggestions[0].full_address ?? j.suggestions[0].name ?? ''), latencyMs: Date.now() - t0, routing, tiles: await this.tileCheck(), ...base };
    } catch (e: any) {
      const reason = e?.message === 'MAPBOX_AUTH' ? 'Mapbox rejected the access token (invalid, expired, or it lacks the Search scope)' : String(e?.message ?? 'Mapbox request failed');
      return { ok: false, reason, latencyMs: Date.now() - t0, ...base };
    }
  }
}
