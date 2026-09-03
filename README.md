# Turbo for Miros

A browser extension that speeds up the [Miros](https://app.miros.work) meeting
room reservation webapp by prefetching, deduplicating and reusing the backend
requests the app was going to make anyway. On captures of the calendar route
it cut load time from several seconds to well under one.

It also offers each new reservation as a calendar event, so a booking does not
have to be retyped into your own calendar.

> Not affiliated with, endorsed by, or connected to Miros. "Miros" is used only
> to identify the site this extension works with. All trademarks belong to
> their respective owners.

> **Use at your own risk.** This extension rewrites how the site fetches data.
> A site update can break the extension, and a bug in the extension can break
> the site — stale views, missing data, or a page that fails to load. If
> anything looks wrong, turn it off from the toolbar popup (or add `#noturbo`
> to the URL), clear the cache, and reload.

## Where the time goes

These measurements are from a HAR capture of one cached reload of the calendar
view, taken in September 2026. The app is under active development and may
have improved since; re-measure before assuming they still hold.

| | |
|---|---|
| Static assets | all cache hits, `onLoad` at 346 ms |
| Supabase requests | 78 |
| Dependency depth | 16 sequential round trips |
| Calls to `/auth/v1/user` | 42, identical |
| Server time for those 42 calls | 94 ms total, per `x-envoy-upstream-service-time` |
| Wall clock they consumed | 17.7 s, of which 14.3 s was browser-side queueing |

None of the responses carry a `Cache-Control` header, so the browser creates a
heuristic cache entry for each identical GET and serializes them on the
cache-entry lock. On top of that, several edge functions are called multiple
times in a row with identical results, and eleven `get-reservation-by-space`
calls duplicate data already contained in the single
`get-reservation-by-company` response.

None of this is unusual for a young product, and only the vendor can address
it in the app itself. This extension works around it from the client side in
the meantime.

## What it does

`inject.js` runs in the page's own JavaScript context at `document_start`,
before supabase-js loads, and wraps `window.fetch`.

**Prefetch.** Every visit records which Supabase URLs the current route asked
for. On the next visit those URLs are fired in parallel at `document_start`,
before the app boots. When the app walks its 16-step dependency chain, each
answer is already in memory or already in flight. This is where most of the
speedup comes from, and it costs nothing in freshness because the data is
fetched live.

**Deduplicate.** Concurrent and repeat GETs for the same URL collapse onto one
request. This alone removes 41 of the 42 identity calls.

**Reuse reference data.** Spaces, plans, members, roles and identity are kept
in `localStorage` between visits with TTLs from 5 to 30 minutes, and refreshed
in the background once past half their TTL.

**Derive.** `get-reservation-by-company` already contains every row the eleven
`get-reservation-by-space` calls return (verified against independent
captures: the derived JSON is byte-identical to the real responses). So the
per-space calls are answered from the by-company response instead of hitting
the network. A space is only derived when `get-bookable-spaces` attributes it
to the company whose reservations were fetched; anything unmatched falls
through to a real request.

Measured on real captures of the calendar route:

| | Supabase requests | last response |
|---|---|---|
| Without the extension | 78 | 7573 ms |
| Dedup and disk cache only | 18 | 1058 ms |
| Plus prefetch and derivation | ~7 | under 700 ms |

## Add to calendar

When a booking succeeds, a small panel appears in the corner of the page with
two ways to keep it:

- **Add to Google Calendar** — a Google
  [event template](https://calendar.google.com/calendar/render) link, prefilled.
  Google shows you its own event form and nothing is saved until you press save
  there.
- **Download .ics** — an RFC 5545 file for Outlook, Apple Calendar or anything
  else.

The event is built from the `create-reservation` response and the room's own
record in `get-bookable-spaces`, which the extension has already cached:

| | |
|---|---|
| Title | `Miros - <booking name> - Room <room name>` |
| Location | `<room name> — <venue>, <street>, <zip> <city>, <country>` |
| Times | taken as UTC, exactly as the API returns them |

So a 10:00 booking of the "Startup" room reads
`Miros - CYSEC - Room Startup`, located at
`Startup — Le VillageByCA Toulouse 31, 31 ALLEES JULES GUESDE, 31000 TOULOUSE, France`.
An empty booking name is simply left out of the title.

Times are anchored in UTC rather than a guessed timezone, so the event lands at
the right moment whatever timezone your calendar is set to. If the booking name
is blank or the room is not in the cache, the panel still appears with whatever
is known.

Turn it off from the popup, or with `__mirosTurbo.set({ calendar: false })`.

## Freshness and safety

- Reservation data is never written to `localStorage` and never read from it.
  A reload always fetches live bookings. Within a single page load, repeat
  calls for the same reservation URL are answered from memory for 15 seconds,
  enough to absorb the app's own duplicates.
- Any `POST`, `PUT`, `PATCH` or `DELETE` to Supabase clears the entire cache,
  so creating or cancelling a booking cannot leave stale data behind. Two
  read-only POSTs are exempt because the app issues them on every page load:
  avatar URL signing and token refresh.
- `401` and `5xx` responses are never cached. A `404` from a stable lookup
  like `get-superadmin-by-user` is cached, because it is a real and stable
  answer.
- If a background refresh of `/auth/v1/user` comes back non-OK, the whole
  cache is dropped, so a signed-out session cannot present as signed-in.
- Token expiry is checked by decoding the JWT's own `exp` claim, so an expired
  session skips prefetch rather than burning requests on 401s.

## Privacy

Everything stays in your browser. The extension talks only to the same
Supabase backend the site itself uses, sends only requests the app was going
to send anyway (and fewer of them in total), and collects no analytics or
telemetry of any kind.

The calendar panel does not change that: the Google link is an ordinary link,
and the extension never follows it. If you click it, your browser navigates to
Google with the event title, times and room address in the URL — the same thing
that happens when you use Google's "add event" links anywhere else. Not clicking
sends nothing. The `.ics` file is generated locally and never leaves the
machine.

The session token the page already holds may be mirrored to `localStorage` on
the site's own origin so the next visit can prefetch before the app boots. It
is the same token any script on that origin can already read, so this exposes
nothing new.

## Install

Download the zip from the [latest release](../../releases/latest) and unpack
it, or clone this repo and use the `src/` folder.

The first load after installing is unchanged. The second is fast, because that
is when the route manifest exists.

### Chrome, Edge, Brave, or any Chromium browser (111+)

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the unpacked folder
4. Reload `app.miros.work`

### Firefox (140+)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and select `manifest.json` inside the
   unpacked folder
3. Firefox treats MV3 host permissions as opt-in: open the site, click the
   extension's icon in the toolbar (puzzle piece menu), and grant it
   permission to access `app.miros.work` — or do it from
   `about:addons` → Turbo for Miros → **Permissions**
4. Reload `app.miros.work`

A temporary add-on is removed when Firefox restarts. For a permanent install,
Firefox requires the extension to be signed: run it through
[AMO unlisted self-distribution](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
yourself, or use Firefox Developer Edition / Nightly with
`xpinstall.signatures.required` set to `false` in `about:config`.

## Controls

Click the toolbar icon for counters, switches for the speedup and the calendar
offer, and a "Clear cache" button.

From the page console:

```js
__mirosTurbo.stats()               // counters
__mirosTurbo.rules                 // what is cached and for how long
__mirosTurbo.manifest()            // URLs prefetched for this route
__mirosTurbo.purge()               // drop everything
__mirosTurbo.set({ log: true })    // log every decision
__mirosTurbo.set({ prefetch: false })
__mirosTurbo.set({ derive: false })
__mirosTurbo.set({ calendar: false })
__mirosTurbo.set({ enabled: false })
```

Adding `#noturbo` to a URL disables it for that page load.

## Limits

The site is not ours, so this is a workaround, not a fix. Things that will
break it:

- Renamed or restructured edge function endpoints. Update `RULES` in
  `src/inject.js`.
- A renamed `create-reservation` endpoint silently stops the calendar panel.
  Update `CREATE_RESERVATION` in `src/inject.js`. Editing or cancelling a
  booking deliberately does not touch a calendar event you already saved —
  `update-reservation` and `delete-reservation` are not hooked.
- A route whose data genuinely changes between the prefetch and the app's own
  request. Reservations are already excluded; if another endpoint turns out to
  be time-sensitive, move it to the `live` tier.
- `localStorage` pressure. The cache is capped at 400 KB per entry and clears
  itself when the quota is hit. Typical footprint is around 115 KB.

## Development

No dependencies. Node 20+.

```sh
npm test                     # unit tests: loads the content scripts in a vm and simulates the app
npx --yes addons-linter src  # validates the manifest and code for Firefox
npm run package              # builds dist/turbo-for-miros-v<version>.zip
```

Layout:

```
src/manifest.json   MV3 manifest, two MAIN-world content scripts
src/inject.js       the fetch wrapper, prefetcher and cache
src/calendar.js     builds the Google/.ics links and renders the offer
src/popup.html      counters and controls
src/popup.js        reads stats out of the page
tests/              node:test suite with a sandboxed fetch harness
```

### Releasing

```sh
npm run version:set 1.1.0    # syncs manifest.json, inject.js, package.json
git commit -am "Release v1.1.0"
git tag v1.1.0
git push && git push --tags
```

Pushing the tag triggers the release workflow: it runs the tests, checks the
tag against the manifest version, zips `src/` and publishes a GitHub release
with generated notes and the zip attached.

## License

[Apache-2.0](LICENSE.md)
