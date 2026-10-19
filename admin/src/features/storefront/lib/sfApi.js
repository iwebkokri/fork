/**
 * Storefront (customer website) HTTP client.
 *
 * Deliberately NOT the admin client (src/lib/api.js): its own axios instance, its own token store and its own
 * events, so signing in to the storefront never signs in to the Admin Console / Restaurant Portal and the other way
 * round. Tokens live in sessionStorage (per tab) under "sf.*" keys: the admin console uses "forksy.*" keys in
 * localStorage and wipes "forksy.*" on logout, which therefore never touches the storefront session.
 */
import axios from "axios";
import { API_URL, WS_URL, clean, errorMessage } from "../../../lib/api";

export { API_URL, WS_URL, errorMessage };

export const SF_KEYS = {
  access: "sf.access",
  refresh: "sf.refresh",
  lastActive: "sf.lastActive",
  guestCart: "sf.cart.v1",
  location: "sf.location",
  fulfilment: "sf.fulfilment",
  handoff: "sf.handoff",
  orderNote: "sf.orderNote",
  botSession: "sf.bot.session",
  botLog: "sf.bot.log",
  botScope: "sf.bot.scope",
  checkoutPrefs: "sf.checkout.prefs",
  notice: "sf.notice",
};

/** Safe storage helpers (storage can be missing / full / blocked: private windows, embedded previews). */
function store(kind) {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}
export const sfStore = {
  get(key, kind = "session") {
    try {
      return store(kind)?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key, value, kind = "session") {
    try {
      store(kind)?.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  del(key, kind = "session") {
    try {
      store(kind)?.removeItem(key);
    } catch {
      /* ignore */
    }
  },
  getJson(key, kind = "session", fallback = null) {
    try {
      const raw = store(kind)?.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  setJson(key, value, kind = "session") {
    return this.set(key, JSON.stringify(value), kind);
  },
};

export const sfTokens = {
  get access() {
    return sfStore.get(SF_KEYS.access);
  },
  get refresh() {
    return sfStore.get(SF_KEYS.refresh);
  },
  set({ accessToken, refreshToken }) {
    if (accessToken) sfStore.set(SF_KEYS.access, accessToken);
    if (refreshToken) sfStore.set(SF_KEYS.refresh, refreshToken);
  },
  clear() {
    sfStore.del(SF_KEYS.access);
    sfStore.del(SF_KEYS.refresh);
  },
};

export const SF_LOGOUT_EVENT = "sf:logout";

const api = axios.create({ baseURL: API_URL, timeout: 30000 });

api.interceptors.request.use((config) => {
  if (!config.headers.Authorization && sfTokens.access && !config.noAuth) {
    config.headers.Authorization = `Bearer ${sfTokens.access}`;
  }
  return config;
});

let refreshing = null;
async function refreshTokens() {
  if (!sfTokens.refresh) throw new Error("no refresh token");
  if (!refreshing) {
    refreshing = axios
      .post(`${API_URL}/auth/refresh`, { refreshToken: sfTokens.refresh })
      .then((r) => {
        sfTokens.set(r.data);
        return r.data.accessToken;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config || {};
    const status = error.response?.status;
    const isAuthCall = /\/auth\/(login|refresh|otp|customer\/register)/.test(original.url || "");
    const hadToken = !!original.headers?.Authorization;
    if (status === 401 && !original._retry && !isAuthCall && hadToken && sfTokens.refresh) {
      original._retry = true;
      try {
        const token = await refreshTokens();
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      } catch {
        sfTokens.clear();
        window.dispatchEvent(new Event(SF_LOGOUT_EVENT));
      }
    } else if (status === 401 && !isAuthCall && hadToken) {
      sfTokens.clear();
      window.dispatchEvent(new Event(SF_LOGOUT_EVENT));
    }
    return Promise.reject(error);
  }
);

/** Wrappers returning response.data. `{ noAuth: true }` as config keeps the Bearer token off public calls. */
export const sfHttp = {
  get: (url, params, config) => api.get(url, { params: clean(params), ...config }).then((r) => r.data),
  post: (url, body, config) => api.post(url, body, config).then((r) => r.data),
  put: (url, body, config) => api.put(url, body, config).then((r) => r.data),
  patch: (url, body, config) => api.patch(url, body, config).then((r) => r.data),
  del: (url, config) => api.delete(url, config).then((r) => r.data),
  /** binary download through the authenticated client (proof-of-delivery photo) */
  blob: (url) => api.get(url, { responseType: "blob" }).then((r) => r.data),
};

/** Error carrying the API's machine code (409 CART_RESTAURANT_CONFLICT ...). */
export const errorCode = (err) => err?.response?.data?.code || null;
export const errorDetails = (err) => err?.response?.data?.details || null;
export const errorStatus = (err) => err?.response?.status || 0;

export const money = (n) => `$${Number(n || 0).toFixed(2)}`;
