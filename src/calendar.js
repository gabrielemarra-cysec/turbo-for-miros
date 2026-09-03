/* Miros Turbo — calendar offer
 *
 * Loads before inject.js and publishes window.__mirosTurboCalendar. When a
 * reservation is created, inject.js hands the created row and the space record
 * here, and a toast offers the booking as a Google Calendar event or an .ics
 * download.
 *
 * `build()` is pure: no DOM, no storage, no network. `offer()` is the only part
 * that touches the page, and it renders into a shadow root with no site
 * selectors, so a Miros redesign cannot break it.
 *
 * Nothing is sent anywhere. The Google link is a plain anchor the user clicks.
 */

(() => {
  "use strict";

  const NS = "__mirosTurboCalendar";
  if (window[NS]) return;

  const TOAST_MS = 20000;
  const GOOGLE = "https://calendar.google.com/calendar/render";

  /* --- pure builders ----------------------------------------------------- */

  const present = (v) => typeof v === "string" && v.trim() !== "";

  // Google's dates parameter and ICS both want basic-format UTC: 20260903T100000Z.
  function stamp(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  }

  // "Miros - <booking name> - Room <space name>", empty segments dropped.
  function title(reservation, space) {
    const parts = ["Miros"];
    if (present(reservation.name)) parts.push(reservation.name.trim());
    if (space && present(space.name)) parts.push("Room " + space.name.trim());
    return parts.join(" - ");
  }

  // Room name first, then whichever address fields the space actually carries.
  function place(space) {
    if (!space) return "";
    const loc = space.location || {};
    const tail = [
      space.company_name || loc.name,
      loc.address,
      [loc.zip, loc.city].filter(present).join(" "),
      loc.country,
    ]
      .filter(present)
      .map((s) => s.trim())
      .join(", ");

    if (!present(space.name)) return tail;
    return tail ? space.name.trim() + " — " + tail : space.name.trim();
  }

  function describe(reservation, space) {
    const lines = ["Booked via Miros."];
    if (space && present(space.name)) {
      const capacity = Number.isFinite(space.capacity) ? `, capacity ${space.capacity}` : "";
      lines.push(`Room: ${space.name}${space.type ? ` (${space.type}${capacity})` : capacity}`);
    }
    if (present(reservation.name)) lines.push(`Booking: ${reservation.name}`);
    if (present(reservation.id)) lines.push(`Reservation: ${reservation.id}`);
    return lines.join("\n");
  }

  function googleUrl({ text, dates, location, details }) {
    const q = new URLSearchParams({ action: "TEMPLATE", text, dates });
    if (location) q.set("location", location);
    if (details) q.set("details", details);
    return GOOGLE + "?" + q.toString();
  }

  const esc = (s) => String(s).replace(/([\\;,])/g, "\\$1").replace(/\r?\n/g, "\\n");

  const byteLength = (s) => {
    let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
  };

  // RFC 5545 content lines are folded at 75 octets, continuations start with a space.
  function fold(line) {
    if (byteLength(line) <= 75) return line;
    const out = [];
    let cur = "";
    let width = 0;
    let limit = 75;
    for (const ch of line) {
      const w = byteLength(ch);
      if (width + w > limit) {
        out.push(cur);
        cur = "";
        width = 0;
        limit = 74; // a continuation line spends one octet on its leading space
      }
      cur += ch;
      width += w;
    }
    out.push(cur);
    return out.join("\r\n ");
  }

  function icsText({ uid, text, start, end, location, details, stampedAt }) {
    const rows = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Turbo for Miros//Calendar offer//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${esc(uid)}`,
      `DTSTAMP:${stampedAt}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${esc(text)}`,
    ];
    if (location) rows.push(`LOCATION:${esc(location)}`);
    if (details) rows.push(`DESCRIPTION:${esc(details)}`);
    rows.push("END:VEVENT", "END:VCALENDAR");
    return rows.map(fold).join("\r\n") + "\r\n";
  }

  /**
   * Turn a created reservation into calendar links.
   *
   * `space` is the get-bookable-spaces record for reservation.space_id, or null
   * if it is not known — in which case the event carries no location.
   * Returns null when the reservation has no usable start and end.
   */
  function build({ reservation, space }) {
    if (!reservation) return null;
    const start = stamp(reservation.start_time);
    const end = stamp(reservation.end_time);
    if (!start || !end) return null;

    const text = title(reservation, space);
    const location = place(space);
    const details = describe(reservation, space);
    const uid = present(reservation.id) ? reservation.id : `${start}-${end}`;

    return {
      uid,
      title: text,
      location,
      details,
      start,
      end,
      google: googleUrl({ text, dates: `${start}/${end}`, location, details }),
      ics: icsText({
        uid,
        text,
        start,
        end,
        location,
        details,
        stampedAt: stamp(reservation.created_at) || stamp(new Date().toISOString()),
      }),
    };
  }

  /* --- toast ------------------------------------------------------------- */

  const PALETTE = {
    paper: "#16191f",
    ink: "#f2f2ef",
    muted: "#a2a8b2",
    signal: "#4fb3ad",
  };

  function style(el, props) {
    for (const [k, v] of Object.entries(props)) {
      try { el.style[k] = v; } catch { /* stub or unsupported property */ }
    }
    return el;
  }

  function anchor(doc, label, href, opts) {
    const a = doc.createElement("a");
    a.textContent = label;
    a.href = href;
    if (opts.download) a.download = opts.download;
    if (opts.blank) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    return style(a, {
      display: "block",
      padding: "7px 10px",
      borderRadius: "5px",
      textAlign: "center",
      textDecoration: "none",
      font: "600 12px/1.3 ui-sans-serif, -apple-system, system-ui, sans-serif",
      background: opts.primary ? PALETTE.signal : "transparent",
      color: opts.primary ? PALETTE.paper : PALETTE.muted,
      border: opts.primary ? "1px solid transparent" : "1px solid #2c3138",
      cursor: "pointer",
    });
  }

  /**
   * Render the offer. Returns the host element, or null if there is no DOM
   * (the test sandbox) or nothing to offer.
   */
  function offer(built) {
    const doc = typeof document !== "undefined" ? document : null;
    if (!built || !doc || typeof doc.createElement !== "function" || !doc.body) return null;

    const host = doc.createElement("div");
    style(host, {
      position: "fixed",
      zIndex: "2147483647",
      right: "16px",
      bottom: "16px",
      width: "290px",
    });

    const root = typeof host.attachShadow === "function" ? host.attachShadow({ mode: "open" }) : host;

    const card = doc.createElement("div");
    style(card, {
      boxSizing: "border-box",
      padding: "12px 13px 11px",
      borderRadius: "9px",
      background: PALETTE.paper,
      color: PALETTE.ink,
      border: "1px solid #2c3138",
      boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
      font: "13px/1.45 ui-sans-serif, -apple-system, system-ui, sans-serif",
    });

    const head = doc.createElement("div");
    style(head, { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px" });

    const heading = doc.createElement("strong");
    heading.textContent = "Reservation created";
    style(heading, { fontSize: "13px", fontWeight: "600" });

    const close = doc.createElement("button");
    close.textContent = "×";
    style(close, {
      border: "0",
      background: "transparent",
      color: PALETTE.muted,
      cursor: "pointer",
      font: "16px/1 ui-sans-serif, system-ui, sans-serif",
      padding: "0 2px",
    });

    const summary = doc.createElement("div");
    summary.textContent = built.location ? `${built.title}\n${built.location}` : built.title;
    style(summary, { margin: "6px 0 10px", color: PALETTE.muted, fontSize: "12px", whiteSpace: "pre-line" });

    const actions = doc.createElement("div");
    style(actions, { display: "grid", gap: "6px" });

    let blobUrl = null;
    try {
      if (typeof Blob === "function" && typeof URL.createObjectURL === "function") {
        blobUrl = URL.createObjectURL(new Blob([built.ics], { type: "text/calendar;charset=utf-8" }));
      }
    } catch { blobUrl = null; }

    actions.appendChild(anchor(doc, "Add to Google Calendar", built.google, { blank: true, primary: true }));
    if (blobUrl) {
      actions.appendChild(
        anchor(doc, "Download .ics", blobUrl, { download: `miros-${built.uid}.ics` })
      );
    }

    head.appendChild(heading);
    head.appendChild(close);
    card.appendChild(head);
    card.appendChild(summary);
    card.appendChild(actions);
    root.appendChild(card);
    doc.body.appendChild(host);

    let closed = false;
    const dismiss = () => {
      if (closed) return;
      closed = true;
      if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* already gone */ } }
      try { host.remove(); } catch { /* already detached */ }
    };
    if (typeof close.addEventListener === "function") close.addEventListener("click", dismiss);
    if (typeof setTimeout === "function") setTimeout(dismiss, TOAST_MS);

    return host;
  }

  window[NS] = {
    build,
    offer,
    // Last offer built, for the popup and the test suite.
    last: null,
    present(reservation, space) {
      const built = build({ reservation, space });
      if (!built) return null;
      window[NS].last = built;
      offer(built);
      return built;
    },
  };
})();
