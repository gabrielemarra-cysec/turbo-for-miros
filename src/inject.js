/* Miros Turbo
 *
 * Runs at document_start in the page's own JS context, before supabase-js
 * loads, and wraps window.fetch.
 *
 * The site's problem is not slow servers. It is a chain of about 16 dependent
 * round trips, each waiting on the previous, with 42 identical calls to
 * /auth/v1/user threaded through it. This addresses that three ways:
 *
 *   1. Prefetch. The URLs a route asks for are recorded on each visit. On the
 *      next visit they are fired in parallel at document_start, before the app
 *      boots. When the app walks its chain, the answers are already in memory
 *      or already in flight. This is the main win, and it costs nothing in
 *      freshness because the data is fetched live.
 *   2. Deduplicate. Concurrent and repeat GETs collapse onto one request.
 *   3. Reuse reference data. Spaces, plans, members and identity are kept in
 *      localStorage between visits and refreshed in the background.
 *
 * Booking data is never read from localStorage. A reload always shows live
 * reservations.
 */

(() => {
  "use strict";

  const NS = "__mirosTurbo";
  if (window[NS]) return;

  const VERSION = "2.0.0";
  const CACHE_PREFIX = NS + ".c1:";
  const MANIFEST_PREFIX = NS + ".m1:";
  const CONFIG_KEY = NS + ".config";
  const APIKEY_KEY = NS + ".apikey";
  const TOKEN_KEY = NS + ".token";

  const SUPABASE_HOST = /(^|\.)supabase\.co$/;
  const MAX_PERSIST_BYTES = 400 * 1024;
  const MAX_MANIFEST_URLS = 40;
  const MANIFEST_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  const PREFETCH_CONCURRENCY = 24;
  // Fraction of a TTL after which a cached answer is still served immediately
  // but refreshed in the background. Below it, no request is made at all.
  const REVALIDATE_AFTER = 0.5;

  const SEC = 1000;
  const MIN = 60 * SEC;

  /* --- cache policy ------------------------------------------------------ */

  // "stable"  reference data, persisted between visits, refreshed in background
  // "live"    memory only, never persisted, short TTL to absorb duplicate calls
  const RULES = [
    { re: /\/auth\/v1\/user\b/,                             tier: "stable", ttl: 5 * MIN },
    { re: /\/functions\/v1\/get-users\b/,                   tier: "stable", ttl: 10 * MIN },
    { re: /\/functions\/v1\/get-superadmin-by-user\b/,      tier: "stable", ttl: 30 * MIN },
    { re: /\/functions\/v1\/get-company-by-employee\b/,     tier: "stable", ttl: 30 * MIN },
    { re: /\/functions\/v1\/get-consumercompanyuserrole\b/, tier: "stable", ttl: 30 * MIN },
    { re: /\/functions\/v1\/get-consumercompany\b/,         tier: "stable", ttl: 30 * MIN },
    { re: /\/functions\/v1\/get-plan-by-user\b/,            tier: "stable", ttl: 10 * MIN },
    { re: /\/functions\/v1\/get-plan-by-consumercompany\b/, tier: "stable", ttl: 10 * MIN },
    { re: /\/functions\/v1\/get-bookable-spaces\b/,         tier: "stable", ttl: 10 * MIN },
    { re: /\/functions\/v1\/get-members-by-company\b/,      tier: "stable", ttl: 15 * MIN },
    { re: /\/functions\/v1\/pending-account-invitations\b/, tier: "stable", ttl: 5 * MIN },

    { re: /\/functions\/v1\/get-reservation/,               tier: "live",   ttl: 15 * SEC },
    { re: /\/functions\/v1\/get-evodesk-reservation/,       tier: "live",   ttl: 15 * SEC },
  ];

  // Only these methods can change server state. OPTIONS and HEAD must never
  // invalidate the cache.
  const MUTATING_METHOD = /^(POST|PUT|PATCH|DELETE)$/;

  // POSTs that read rather than write. These must not invalidate the cache:
  // avatar signing and token refresh both run on every page load.
  const NON_MUTATING_POST = /\/storage\/v1\/object\/sign\/|\/auth\/v1\/token\b/;

  // The one endpoint that creates a booking. update- and delete-reservation are
  // deliberately not hooked: an already-saved calendar event is the user's now.
  const CREATE_RESERVATION = /\/functions\/v1\/create-reservation\b/;

  /* --- config ------------------------------------------------------------ */

  const DEFAULT_CONFIG = {
    enabled: true, prefetch: true, persist: true, derive: true, calendar: true, log: false,
  };

  function readConfig() {
    try {
      return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}") };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  let config = readConfig();
  if (location.hash.includes("noturbo")) config.enabled = false;

  /* --- state ------------------------------------------------------------- */

  const memory = new Map();   // url -> entry
  const inflight = new Map(); // url -> Promise
  const seen = new Set();     // urls the app asked for this page load
  const bootedAt = Date.now();

  const stats = {
    prefetched: 0,
    derived: 0,
    memoryHits: 0,
    diskHits: 0,
    dedup: 0,
    network: 0,
    revalidations: 0,
    passthrough: 0,
    savedRequests: 0,
    calendarOffers: 0,
  };

  const log = (...a) => config.log && console.debug("%c[turbo]", "color:#1f6f6b", ...a);

  /* --- storage ----------------------------------------------------------- */

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };

  function ownKeys(prefix) {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
      }
    } catch { /* ignore */ }
    return out;
  }

  function diskRead(url) {
    if (!config.persist) return null;
    const raw = lsGet(CACHE_PREFIX + url);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function diskWrite(url, entry) {
    if (!config.persist || entry.body.length > MAX_PERSIST_BYTES) return;
    if (lsSet(CACHE_PREFIX + url, JSON.stringify(entry))) return;
    ownKeys(CACHE_PREFIX).forEach(lsDel);
    lsSet(CACHE_PREFIX + url, JSON.stringify(entry));
  }

  function purge() {
    memory.clear();
    inflight.clear();
    spaceRecords = null;
    ownKeys(CACHE_PREFIX).forEach(lsDel);
    log("cache cleared");
  }

  /* --- route manifest ---------------------------------------------------- */

  const routeKey = () => MANIFEST_PREFIX + location.pathname;

  function readManifest() {
    const raw = lsGet(routeKey());
    if (!raw) return null;
    try {
      const m = JSON.parse(raw);
      if (!m || !Array.isArray(m.urls)) return null;
      if (Date.now() - (m.at || 0) > MANIFEST_MAX_AGE) return null;
      return m;
    } catch {
      return null;
    }
  }

  function writeManifest() {
    if (!seen.size) return;
    lsSet(routeKey(), JSON.stringify({ at: Date.now(), urls: [...seen].slice(0, MAX_MANIFEST_URLS) }));
  }

  /* --- credentials for prefetch ------------------------------------------ */

  // The session lives in localStorage with supabase-js and in cookies with
  // @supabase/ssr, chunked across .0 / .1 and often base64 wrapped. This app
  // uses the cookie form. A token captured from a previous visit is the last
  // resort.
  function chunkedValue(pairs) {
    if (!pairs.length) return null;
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return pairs.map(([, v]) => v).join("");
  }

  function cookieSession() {
    let raw;
    try { raw = document.cookie; } catch { return null; }
    if (!raw) return null;
    const pairs = [];
    for (const part of raw.split(/;\s*/)) {
      const i = part.indexOf("=");
      if (i < 1) continue;
      const name = part.slice(0, i);
      if (!/^sb-.*-auth-token(\.\d+)?$/.test(name)) continue;
      let value = part.slice(i + 1);
      try { value = decodeURIComponent(value); } catch { /* keep raw */ }
      pairs.push([name, value]);
    }
    return chunkedValue(pairs);
  }

  function localSession() {
    const pairs = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /^sb-.*-auth-token(\.\d+)?$/.test(k)) pairs.push([k, lsGet(k) || ""]);
      }
    } catch { return null; }
    return chunkedValue(pairs);
  }

  function b64(input) {
    return atob(input.replace(/-/g, "+").replace(/_/g, "/"));
  }

  function parseSession(raw) {
    if (!raw) return null;
    if (raw.startsWith("base64-")) {
      try { raw = b64(raw.slice(7)); } catch { return null; }
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (Array.isArray(parsed)) return typeof parsed[0] === "string" ? parsed[0] : null;
    const s = parsed && (parsed.currentSession || parsed);
    return s && s.access_token ? s.access_token : null;
  }

  function jwtExpiry(token) {
    try {
      const claims = JSON.parse(b64(token.split(".")[1]));
      return typeof claims.exp === "number" ? claims.exp : 0;
    } catch {
      return 0;
    }
  }

  function readAccessToken() {
    const sources = [
      () => parseSession(cookieSession()),
      () => parseSession(localSession()),
      () => lsGet(TOKEN_KEY),
    ];
    for (const get of sources) {
      let token = null;
      try { token = get(); } catch { token = null; }
      if (!token) continue;
      const exp = jwtExpiry(token);
      // An expired token turns every prefetch into a wasted 401.
      if (!exp || exp * 1000 < Date.now() + 30 * SEC) continue;
      return token;
    }
    return null;
  }

  /* --- helpers ----------------------------------------------------------- */

  const ruleFor = (url) => RULES.find((r) => r.re.test(url)) || null;

  function isFresh(entry, ttl) {
    if (!entry) return false;
    const age = Date.now() - entry.at;
    return age >= 0 && age < ttl;
  }

  function toResponse(e) {
    return new Response(e.body, {
      status: e.status,
      statusText: e.statusText || "",
      headers: { "content-type": e.type || "application/json" },
    });
  }

  function isSupabase(url) {
    try { return SUPABASE_HOST.test(new URL(url, location.href).hostname); }
    catch { return false; }
  }

  function describe(input, init) {
    if (typeof Request !== "undefined" && input instanceof Request) {
      return {
        url: input.url,
        method: (init && init.method) || input.method || "GET",
        headers: (init && init.headers) || input.headers,
      };
    }
    const url = typeof URL !== "undefined" && input instanceof URL ? input.href : String(input);
    return { url, method: (init && init.method) || "GET", headers: init && init.headers };
  }

  function grabCredentials(headers) {
    if (!headers) return;
    let h;
    try { h = headers instanceof Headers ? headers : new Headers(headers); }
    catch { return; }

    const key = h.get("apikey");
    if (key && lsGet(APIKEY_KEY) !== key) lsSet(APIKEY_KEY, key);

    // Kept so the next visit can prefetch before the app has booted. It is the
    // same token the page already holds; nothing new is exposed.
    const auth = h.get("authorization");
    if (auth && /^Bearer\s+/i.test(auth)) {
      const token = auth.replace(/^Bearer\s+/i, "");
      if (lsGet(TOKEN_KEY) !== token) lsSet(TOKEN_KEY, token);
    }
  }

  // Headers for a request the extension issues on the app's behalf.
  function borrowedHeaders(observed) {
    const out = { accept: "*/*" };
    try {
      const h = observed instanceof Headers ? observed : new Headers(observed || {});
      for (const name of ["apikey", "authorization", "x-client-info"]) {
        const v = h.get(name);
        if (v) out[name] = v;
      }
    } catch { /* fall through to stored credentials */ }
    if (!out.apikey) {
      const k = lsGet(APIKEY_KEY);
      if (k) out.apikey = k;
    }
    if (!out.authorization) {
      const t = readAccessToken();
      if (t) out.authorization = "Bearer " + t;
    }
    return out.apikey && out.authorization ? out : null;
  }

  /* --- network ----------------------------------------------------------- */

  const nativeFetch = window.fetch.bind(window);

  async function store(url, rule, input, init) {
    stats.network++;
    const res = await nativeFetch(input, init);
    // 404 is a real answer for these lookups and worth keeping. 401/403/5xx
    // are not: caching those would hide a recoverable failure.
    const cacheable = res.ok || (res.status === 404 && rule.tier === "stable");
    if (!cacheable) return { res, entry: null };

    let body;
    try { body = await res.clone().text(); }
    catch { return { res, entry: null }; }

    const entry = {
      body,
      status: res.status,
      statusText: res.statusText,
      type: res.headers.get("content-type") || "application/json",
      at: Date.now(),
      tier: rule.tier,
    };
    memory.set(url, entry);
    if (rule.tier === "stable") diskWrite(url, entry);
    return { res, entry };
  }

  function revalidate(url, rule, input, init) {
    if (inflight.has(url)) return;
    stats.revalidations++;
    const p = store(url, rule, input, init)
      .then(({ res }) => {
        // A stale identity response would leave the app looking signed in
        // while every real call fails. If the refresh disagrees, drop it all.
        if (!res.ok && /\/auth\/v1\/user\b/.test(url)) {
          purge();
          if (Date.now() - bootedAt < 3000) location.reload();
        }
      })
      .catch(() => {})
      .finally(() => inflight.delete(url));
    inflight.set(url, p);
  }

  /* --- derivation --------------------------------------------------------

     get-reservation-by-company already contains every reservation the eleven
     get-reservation-by-space calls return. Verified across two independent
     captures: for all eleven spaces the sets of (start_time, end_time) are
     identical, with zero rows on either side. The eleven queried spaces are
     exactly the spaces get-bookable-spaces attributes to that company, so a
     space is only derived when its own company_id matches the company whose
     reservations were fetched. Anything unmatched falls through to the network.
  ------------------------------------------------------------------------- */

  const BY_SPACE = /\/functions\/v1\/get-reservation-by-space\?/;
  let spaceRecords = null;

  // id -> trimmed get-bookable-spaces record. Feeds both derivation
  // (company_id) and the calendar offer (name, type, address).
  function spaceIndex() {
    if (spaceRecords) return spaceRecords;
    const map = new Map();

    const absorb = (text) => {
      try {
        const spaces = JSON.parse(text).spaces;
        if (!Array.isArray(spaces)) return;
        for (const sp of spaces) {
          if (!sp || !sp.id) continue;
          map.set(sp.id, {
            id: sp.id,
            name: sp.name,
            type: sp.type,
            capacity: sp.capacity,
            company_id: sp.company_id,
            company_name: sp.company_name,
            location: sp.location,
          });
        }
      } catch { /* ignore */ }
    };

    for (const [url, entry] of memory) if (/get-bookable-spaces/.test(url)) absorb(entry.body);
    if (!map.size) {
      for (const k of ownKeys(CACHE_PREFIX)) {
        if (!/get-bookable-spaces/.test(k)) continue;
        try { absorb(JSON.parse(lsGet(k)).body); } catch { /* ignore */ }
      }
    }

    if (map.size) spaceRecords = map;
    return map;
  }

  function deriveBySpace(url, headers, input, init) {
    let spaceId, origin;
    try {
      const u = new URL(url);
      spaceId = u.searchParams.get("space_id");
      origin = u.origin;
    } catch { return null; }
    if (!spaceId) return null;

    const record = spaceIndex().get(spaceId);
    const companyId = record && record.company_id;
    if (!companyId) return null;

    const companyUrl =
      origin + "/functions/v1/get-reservation-by-company?company_id=" + encodeURIComponent(companyId);
    const companyRule = ruleFor(companyUrl);
    if (!companyRule) return null;

    const build = () => {
      const src = memory.get(companyUrl);
      if (!src) return null;
      let all;
      try { all = JSON.parse(src.body).reservations; } catch { return null; }
      if (!Array.isArray(all)) return null;

      const reservations = [];
      for (const r of all) {
        if (!r || r.space_id !== spaceId) continue;
        reservations.push({ space_id: r.space_id, start_time: r.start_time, end_time: r.end_time });
      }

      const entry = {
        body: JSON.stringify({ reservations }),
        status: 200,
        statusText: "OK",
        type: "application/json",
        at: src.at,
        tier: "live",
      };
      memory.set(url, entry);
      stats.derived++;
      stats.savedRequests++;
      return toResponse(entry);
    };

    if (isFresh(memory.get(companyUrl), companyRule.ttl)) return build();

    let pending = inflight.get(companyUrl);
    if (!pending) {
      const borrowed = borrowedHeaders(headers);
      if (!borrowed) return null;
      pending = store(companyUrl, companyRule, companyUrl, { method: "GET", headers: borrowed })
        .finally(() => inflight.delete(companyUrl));
      inflight.set(companyUrl, pending);
    }

    return pending.then(() => build() || nativeFetch(input, init));
  }

  /* --- calendar offer ---------------------------------------------------- */

  // Offer the just-created booking as a calendar event. `spaces` is a snapshot
  // taken before the POST, because purge() drops the space cache on the way past.
  async function offerCalendar(res, spaces) {
    const api = window.__mirosTurboCalendar;
    if (!api) return;

    const payload = JSON.parse(await res.text());
    const reservation = payload && payload.reservation;
    if (!reservation) return;

    const space = spaces.get(reservation.space_id) || null;
    if (api.present(reservation, space)) stats.calendarOffers++;
  }

  /* --- prefetch ---------------------------------------------------------- */

  function prefetch() {
    if (!config.enabled || !config.prefetch) return;

    const manifest = readManifest();
    if (!manifest) return;

    const token = readAccessToken();
    const apikey = lsGet(APIKEY_KEY);
    if (!token || !apikey) return;

    const headers = {
      apikey,
      authorization: "Bearer " + token,
      accept: "*/*",
      "x-client-info": "turbo-for-miros/" + VERSION,
    };

    const queue = [];
    for (const u of manifest.urls) {
      const rule = ruleFor(u);
      if (!rule || memory.has(u) || inflight.has(u)) continue;
      if (config.derive && BY_SPACE.test(u)) continue;
      // Already have it from a previous visit and still fresh: hydrate memory
      // and skip the network entirely.
      if (rule.tier === "stable") {
        const disk = diskRead(u);
        if (isFresh(disk, rule.ttl)) { memory.set(u, disk); continue; }
      }
      queue.push(u);
    }
    let cursor = 0;

    const pump = () => {
      if (cursor >= queue.length) return;
      const url = queue[cursor++];
      stats.prefetched++;
      const p = store(url, ruleFor(url), url, { method: "GET", headers, credentials: "omit" })
        .catch(() => ({ res: null, entry: null }))
        .finally(() => { inflight.delete(url); pump(); });
      inflight.set(url, p);
    };

    for (let i = 0; i < Math.min(PREFETCH_CONCURRENCY, queue.length); i++) pump();
    log("prefetching", queue.length, "urls for", location.pathname);
  }

  /* --- the patch --------------------------------------------------------- */

  window.fetch = function turboFetch(input, init) {
    if (!config.enabled) return nativeFetch(input, init);

    let url, method, headers;
    try { ({ url, method, headers } = describe(input, init)); }
    catch { return nativeFetch(input, init); }

    if (!isSupabase(url)) return nativeFetch(input, init);

    grabCredentials(headers);
    method = String(method).toUpperCase();

    if (method !== "GET") {
      const mutating = MUTATING_METHOD.test(method) && !NON_MUTATING_POST.test(url);
      // Snapshot the space records before the request: purge() below clears the
      // cache they come from, and the offer needs the room name and address.
      const spaces = config.calendar && CREATE_RESERVATION.test(url) ? spaceIndex() : null;
      return nativeFetch(input, init).then((res) => {
        if (mutating && res.ok) purge();
        // Deliberately not awaited: a booking must not wait on, or fail with, this.
        if (spaces && res.ok) offerCalendar(res.clone(), spaces).catch(() => {});
        return res;
      });
    }

    seen.add(url);

    const rule = ruleFor(url);
    if (!rule) {
      stats.passthrough++;
      return nativeFetch(input, init);
    }

    const mem = memory.get(url);
    if (isFresh(mem, rule.ttl)) {
      stats.memoryHits++;
      stats.savedRequests++;
      return Promise.resolve(toResponse(mem));
    }

    const pending = inflight.get(url);
    if (pending) {
      stats.dedup++;
      stats.savedRequests++;
      return pending.then(() => {
        const e = memory.get(url);
        return e ? toResponse(e) : nativeFetch(input, init);
      });
    }

    if (rule.tier === "stable") {
      const disk = diskRead(url);
      if (isFresh(disk, rule.ttl)) {
        memory.set(url, disk);
        stats.diskHits++;
        stats.savedRequests++;
        if (Date.now() - disk.at > rule.ttl * REVALIDATE_AFTER) {
          revalidate(url, rule, input, init);
        }
        return Promise.resolve(toResponse(disk));
      }
    }

    if (config.derive && BY_SPACE.test(url)) {
      const derived = deriveBySpace(url, headers, input, init);
      if (derived) return Promise.resolve(derived);
    }

    const p = store(url, rule, input, init).finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p.then(({ res, entry }) => (entry ? toResponse(entry) : res));
  };

  /* --- lifecycle --------------------------------------------------------- */

  prefetch();

  if (typeof addEventListener === "function") {
    addEventListener("pagehide", writeManifest);
    addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") writeManifest();
    });
  }
  setTimeout(writeManifest, 12 * SEC);

  window[NS] = {
    version: VERSION,
    get config() { return { ...config }; },
    stats() {
      return {
        ...stats,
        entries: memory.size,
        enabled: config.enabled,
        calendar: config.calendar,
        route: location.pathname,
      };
    },
    set(patch) {
      config = { ...config, ...patch };
      lsSet(CONFIG_KEY, JSON.stringify(config));
      return { ...config };
    },
    purge() {
      purge();
      ownKeys(MANIFEST_PREFIX).forEach(lsDel);
      return "cleared";
    },
    manifest: readManifest,
    snapshot: writeManifest,
    rules: RULES.map((r) => ({ pattern: String(r.re), tier: r.tier, ttlSeconds: r.ttl / SEC })),
  };

  log("active", VERSION, config);
})();
