// Boots the content scripts inside a vm sandbox with a fake window, DOM,
// localStorage, cookies and fetch, so they can be exercised without a browser.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, "..", "src", f), "utf8");

// Same order as the manifest's content_scripts js array.
export const SOURCES = { "calendar.js": read("calendar.js"), "inject.js": read("inject.js") };

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

/* --- DOM stub ----------------------------------------------------------- */

// Just enough element for the calendar toast: styles, a shadow root, children
// and a click listener. Nothing here pretends to be a real DOM.
function fakeElement(tagName) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    style: {},
    children: [],
    textContent: "",
    shadow: null,
    removed: false,
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    attachShadow() {
      el.shadow = fakeElement("#shadow-root");
      return el.shadow;
    },
    addEventListener(type, fn) {
      (el.listeners[type] ||= []).push(fn);
    },
    click() {
      for (const fn of el.listeners.click || []) fn();
    },
    remove() {
      el.removed = true;
    },
  };
  el.listeners = {};
  return el;
}

// Every element in a subtree, shadow roots included.
export function descendants(node) {
  if (!node) return [];
  const kids = [...(node.children || []), ...(node.shadow ? [node.shadow] : [])];
  return [node, ...kids.flatMap(descendants)];
}

export const anchors = (node) => descendants(node).filter((e) => e.tagName === "A");

// The real URL, plus the object-URL statics the toast looks for.
class SandboxURL extends URL {}
SandboxURL.createObjectURL = (blob) => `blob:sandbox/${blob && blob.size}`;
SandboxURL.revokeObjectURL = () => {};

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

  const body = fakeElement("body");
  const document = {
    cookie,
    visibilityState: "visible",
    body,
    createElement: fakeElement,
  };

  const sandbox = {
    window: win,
    localStorage: storage,
    location,
    document,
    addEventListener() {},
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    console,
    atob,
    URL: SandboxURL,
    URLSearchParams,
    Blob,
    Response,
    Headers,
    Request,
  };

  vm.createContext(sandbox);
  for (const [filename, source] of Object.entries(SOURCES)) {
    vm.runInContext(source, sandbox, { filename });
  }

  return {
    fetch: (...args) => win.fetch(...args),
    turbo: win.__mirosTurbo,
    calendar: win.__mirosTurboCalendar,
    calls,
    timers,
    storage,
    location,
    document,
    // The toasts the calendar offer appended, in order.
    toasts: () => body.children,
    callsTo: (urlPrefix) => calls.filter((c) => c.url.startsWith(urlPrefix)),
  };
}
