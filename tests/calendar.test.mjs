// Unit tests for the pure calendar builders. Fixtures are the real payloads
// from a HAR capture of one booking on app.miros.work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./harness.mjs";

const RESERVATION = {
  id: "f8bec515-8366-461e-80f9-6d100db099a8",
  creator_id: "63d49ed7-c84c-48fa-ab69-18a42e6c532f",
  space_id: "7b7bdd2a-1c19-49b5-a012-4b043d9b1c19",
  start_time: "2026-09-03T10:00:00+00:00",
  end_time: "2026-09-03T10:15:00+00:00",
  time_before_cancellation: 0,
  name: "CYSEC",
  created_at: "2026-09-03T09:37:40.274419+00:00",
};

const SPACE = {
  id: "7b7bdd2a-1c19-49b5-a012-4b043d9b1c19",
  name: "Startup",
  type: "meeting_room",
  capacity: 5,
  company_id: "03555aed-0f44-46ca-8c15-bfbacb4e3445",
  company_name: "Le VillageByCA Toulouse 31",
  location: {
    name: "Le VillageByCA Toulouse 31",
    address: "31 ALLEES JULES GUESDE",
    zip: "31000",
    city: "TOULOUSE",
    country: "France",
  },
};

const ADDRESS = "Le VillageByCA Toulouse 31, 31 ALLEES JULES GUESDE, 31000 TOULOUSE, France";

const build = (reservation = RESERVATION, space = SPACE) =>
  boot().calendar.build({ reservation, space });

// ICS folds long lines as CRLF + space; undo that to assert on logical content.
const unfold = (ics) => ics.replace(/\r\n /g, "");

test("the title reads Miros - booking name - Room space name", () => {
  assert.equal(build().title, "Miros - CYSEC - Room Startup");
});

test("a blank booking name collapses its segment rather than leaving a gap", () => {
  assert.equal(build({ ...RESERVATION, name: "   " }).title, "Miros - Room Startup");
  assert.equal(build({ ...RESERVATION, name: undefined }).title, "Miros - Room Startup");
});

test("the location leads with the room name", () => {
  assert.equal(build().location, `Startup — ${ADDRESS}`);
});

test("the location joins only the address fields the space carries", () => {
  const sparse = { name: "Startup", location: { address: "31 ALLEES JULES GUESDE", country: null } };
  assert.equal(build(RESERVATION, sparse).location, "Startup — 31 ALLEES JULES GUESDE");
  assert.equal(build(RESERVATION, { name: "Startup" }).location, "Startup");
});

test("times are anchored in UTC, not the local zone", () => {
  const { google, start, end } = build();
  assert.equal(start, "20260903T100000Z");
  assert.equal(end, "20260903T101500Z");
  assert.match(google, /[?&]dates=20260903T100000Z%2F20260903T101500Z(&|$)/);
});

test("the Google link is a template URL carrying the title and location", () => {
  const url = new URL(build().google);
  assert.equal(url.origin + url.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("text"), "Miros - CYSEC - Room Startup");
  assert.equal(url.searchParams.get("location"), `Startup — ${ADDRESS}`);
  assert.match(url.searchParams.get("details"), /Room: Startup \(meeting_room, capacity 5\)/);
  assert.equal(url.searchParams.get("ctz"), null);
});

test("the ICS carries the reservation id as its UID and escapes text values", () => {
  const ics = build().ics;
  const flat = unfold(ics);

  assert.match(flat, /^BEGIN:VCALENDAR\r\n/);
  assert.match(flat, /\r\nEND:VCALENDAR\r\n$/);
  assert.ok(flat.includes(`UID:${RESERVATION.id}`));
  assert.ok(flat.includes("DTSTART:20260903T100000Z"));
  assert.ok(flat.includes("DTEND:20260903T101500Z"));
  assert.ok(flat.includes("DTSTAMP:20260903T093740Z"));
  assert.ok(flat.includes("SUMMARY:Miros - CYSEC - Room Startup"));

  // RFC 5545: commas are literal only when escaped, newlines become \n.
  assert.ok(
    flat.includes(
      "LOCATION:Startup — Le VillageByCA Toulouse 31\\, 31 ALLEES JULES GUESDE\\, " +
        "31000 TOULOUSE\\, France"
    )
  );
  assert.ok(flat.includes("DESCRIPTION:Booked via Miros.\\nRoom: Startup"));
});

test("ICS lines are folded at 75 octets", () => {
  const lines = build().ics.split("\r\n");
  assert.ok(lines.some((l) => l.startsWith(" ")), "expected at least one folded line");
  for (const line of lines) {
    assert.ok(
      Buffer.byteLength(line, "utf8") <= 75,
      `line exceeds 75 octets: ${JSON.stringify(line)}`
    );
  }
});

test("an unknown space still yields an offer, without a location", () => {
  const built = build(RESERVATION, null);
  assert.equal(built.title, "Miros - CYSEC");
  assert.equal(built.location, "");
  assert.equal(new URL(built.google).searchParams.get("location"), null);
  assert.ok(!built.ics.includes("LOCATION:"));
});

test("a reservation without usable times yields nothing", () => {
  assert.equal(build({ ...RESERVATION, start_time: null }), null);
  assert.equal(build({ ...RESERVATION, end_time: "not a date" }), null);
  assert.equal(boot().calendar.build({ reservation: null, space: SPACE }), null);
});
