import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, jsonResponse, fakeJwt, sessionCookie, FakeStorage, SUPABASE } from "./harness.mjs";

const USER = `${SUPABASE}/auth/v1/user`;
const SPACES = `${SUPABASE}/functions/v1/get-bookable-spaces`;
const BY_COMPANY = `${SUPABASE}/functions/v1/get-reservation-by-company`;
const BY_SPACE = `${SUPABASE}/functions/v1/get-reservation-by-space`;

test("non-Supabase requests pass through untouched", async () => {
  const t = boot();
  await t.fetch("https://app.miros.work/api/anything");
  await t.fetch("https://app.miros.work/api/anything");
  assert.equal(t.calls.length, 2);
});

test("concurrent identical GETs collapse onto one network request", async () => {
  const t = boot({ routes: { [USER]: () => jsonResponse({ id: "u1" }) } });
  const bodies = await Promise.all(
    Array.from({ length: 42 }, () => t.fetch(USER).then((r) => r.json()))
  );
  assert.equal(t.callsTo(USER).length, 1);
  for (const b of bodies) assert.deepEqual(b, { id: "u1" });
});

test("repeat GETs within the TTL are served from memory", async () => {
  const t = boot({ routes: { [USER]: () => jsonResponse({ id: "u1" }) } });
  await t.fetch(USER);
  const again = await (await t.fetch(USER)).json();
  assert.equal(t.callsTo(USER).length, 1);
  assert.deepEqual(again, { id: "u1" });
});

test("stable data persists across page loads, reservations never do", async () => {
  const storage = new FakeStorage();
  const first = boot({
    storage,
    routes: {
      [USER]: () => jsonResponse({ id: "u1" }),
      [BY_COMPANY]: () => jsonResponse({ reservations: [] }),
    },
  });
  await first.fetch(USER);
  await first.fetch(`${BY_COMPANY}?company_id=c1`);

  const keys = storage.keys().filter((k) => k.startsWith("__mirosTurbo.c1:"));
  assert.equal(keys.length, 1, "only the stable entry is persisted");
  assert.match(keys[0], /auth\/v1\/user/);

  // A fresh page load answers the identity call from disk, no network.
  const second = boot({ storage, routes: {} });
  const fromDisk = await (await second.fetch(USER)).json();
  assert.deepEqual(fromDisk, { id: "u1" });
  assert.equal(second.callsTo(USER).length, 0);
  // Reservations always hit the network again.
  await second.fetch(`${BY_COMPANY}?company_id=c1`);
  assert.equal(second.callsTo(BY_COMPANY).length, 1);
});

test("a mutating request purges the cache", async () => {
  const t = boot({ routes: { [USER]: () => jsonResponse({ id: "u1" }) } });
  await t.fetch(USER);
  await t.fetch(`${SUPABASE}/functions/v1/create-reservation`, { method: "POST" });
  await t.fetch(USER);
  assert.equal(t.callsTo(USER).length, 2, "cache was dropped after the POST");
});

test("token refresh and avatar signing do not purge the cache", async () => {
  const t = boot({ routes: { [USER]: () => jsonResponse({ id: "u1" }) } });
  await t.fetch(USER);
  await t.fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, { method: "POST" });
  await t.fetch(`${SUPABASE}/storage/v1/object/sign/user-avatar/x.png`, { method: "POST" });
  await t.fetch(USER);
  assert.equal(t.callsTo(USER).length, 1);
});

test("error responses are not cached, stable 404s are", async () => {
  let status = 401;
  const t = boot({
    routes: {
      [USER]: () => jsonResponse({ error: "no" }, status),
      [`${SUPABASE}/functions/v1/get-superadmin-by-user`]: () => jsonResponse({}, 404),
    },
  });
  await t.fetch(USER);
  await t.fetch(USER);
  assert.equal(t.callsTo(USER).length, 2, "401 was not cached");

  const admin = `${SUPABASE}/functions/v1/get-superadmin-by-user`;
  await t.fetch(admin);
  await t.fetch(admin);
  assert.equal(t.callsTo(admin).length, 1, "stable 404 was cached");
});

test("per-space reservations are derived from the by-company response", async () => {
  const t = boot({
    routes: {
      [SPACES]: () =>
        jsonResponse({ spaces: [{ id: "s1", company_id: "c1" }, { id: "s2", company_id: "c1" }] }),
      [BY_COMPANY]: () =>
        jsonResponse({
          reservations: [
            { space_id: "s1", start_time: "2026-09-01T09:00", end_time: "2026-09-01T10:00" },
            { space_id: "s2", start_time: "2026-09-01T11:00", end_time: "2026-09-01T12:00" },
          ],
        }),
    },
  });

  await t.fetch(SPACES);
  await t.fetch(`${BY_COMPANY}?company_id=c1`);
  const derived = await (await t.fetch(`${BY_SPACE}?space_id=s1`)).json();

  assert.deepEqual(derived, {
    reservations: [{ space_id: "s1", start_time: "2026-09-01T09:00", end_time: "2026-09-01T10:00" }],
  });
  assert.equal(t.callsTo(BY_SPACE).length, 0, "answered without a network call");
  assert.equal(t.turbo.stats().derived, 1);
});

test("a space not attributed to a known company falls through to the network", async () => {
  const t = boot({
    routes: {
      [SPACES]: () => jsonResponse({ spaces: [{ id: "s1", company_id: "c1" }] }),
      [BY_SPACE]: () => jsonResponse({ reservations: [] }),
    },
  });
  await t.fetch(SPACES);
  await t.fetch(`${BY_SPACE}?space_id=unknown`);
  assert.equal(t.callsTo(BY_SPACE).length, 1);
});

test("prefetch fires the recorded route URLs before the app boots", () => {
  const pathname = "/u/dashboard/calendar";
  const storage = new FakeStorage([
    ["__mirosTurbo.apikey", "anon-key"],
    [
      "__mirosTurbo.m1:" + pathname,
      JSON.stringify({ at: Date.now(), urls: [USER, `${SPACES}?company_id=c1`] }),
    ],
  ]);
  const t = boot({
    storage,
    pathname,
    cookie: sessionCookie(fakeJwt(3600)),
    routes: { [USER]: () => jsonResponse({ id: "u1" }) },
  });
  assert.equal(t.calls.length, 2, "both manifest URLs prefetched at boot");
  const auth = new Headers(t.calls[0].init.headers).get("authorization");
  assert.match(auth, /^Bearer /);
});

test("an expired session token disables prefetch", () => {
  const pathname = "/u/dashboard/calendar";
  const storage = new FakeStorage([
    ["__mirosTurbo.apikey", "anon-key"],
    ["__mirosTurbo.m1:" + pathname, JSON.stringify({ at: Date.now(), urls: [USER] })],
  ]);
  const t = boot({ storage, pathname, cookie: sessionCookie(fakeJwt(-60)) });
  assert.equal(t.calls.length, 0);
});

test("#noturbo in the URL disables the extension for that page load", async () => {
  const t = boot({ hash: "#noturbo", routes: { [USER]: () => jsonResponse({ id: "u1" }) } });
  await t.fetch(USER);
  await t.fetch(USER);
  assert.equal(t.callsTo(USER).length, 2);
});

test("the console API reports stats and purges", async () => {
  const t = boot({ routes: { [USER]: () => jsonResponse({ id: "u1" }) } });
  await t.fetch(USER);
  await t.fetch(USER);
  const stats = t.turbo.stats();
  assert.equal(stats.network, 1);
  assert.equal(stats.savedRequests, 1);
  t.turbo.purge();
  await t.fetch(USER);
  assert.equal(t.callsTo(USER).length, 2);
});
