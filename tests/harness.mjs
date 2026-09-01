// Boots src/inject.js inside a vm sandbox with a fake window, localStorage,
// cookies and fetch, so the wrapper can be exercised without a browser.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(here, "..", "src", "inject.js"), "utf8");

export const SUPABASE = "https://example-project.supabase.co";

export class FakeStorage {
  constructor(entries) {
    this.map = new Map(entries);
  }
  get length() {
    return this.map.size;
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  keys() {
    return [...this.map.keys()];
  }
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Unsigned JWT whose exp claim is `expiresInSeconds` from now.
export function fakeJwt(expiresInSeconds = 3600) {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  return `${part({ alg: "none" })}.${part({ exp })}.sig`;
}

// Cookie in the @supabase/ssr format the extension reads sessions from.
export function sessionCookie(token) {
  const value = "base64-" + Buffer.from(JSON.stringify({ access_token: token })).toString("base64");
  return `sb-example-auth-token=${value}`;
}

/**
 * Load inject.js in a sandbox.
 *
 * `routes` maps a URL without query string to a function returning a Response
 * (a fresh one per call, since bodies are consumed). Unmatched URLs get an
 * empty JSON 200. Every network call is recorded in `calls`.
 */
export function boot({ routes = {}, storage = new FakeStorage(), cookie = "", pathname = "/u/dashboard/calendar", hash = "" } = {}) {
  const calls = [];
  const timers = [];

  const nativeFetch = (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (((init && init.method) || (input && input.method)) ?? "GET").toUpperCase();
    calls.push({ url, method, init });
    const handler = routes[url.split("?")[0]];
    return Promise.resolve(handler ? handler(url, init) : jsonResponse({}));
  };

  const win = { fetch: nativeFetch };
  const location = {
    href: `https://app.miros.work${pathname}${hash}`,
    hostname: "app.miros.work",
    pathname,
    hash,
    reloaded: false,
    reload() {
      this.reloaded = true;
    },
  };

  const sandbox = {
    window: win,
    localStorage: storage,
    location,
    document: { cookie, visibilityState: "visible" },
    addEventListener() {},
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    console,
    atob,
    URL,
    Response,
    Headers,
    Request,
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "inject.js" });

  return {
    fetch: (...args) => win.fetch(...args),
    turbo: win.__mirosTurbo,
    calls,
    timers,
    storage,
    location,
    callsTo: (urlPrefix) => calls.filter((c) => c.url.startsWith(urlPrefix)),
  };
}
