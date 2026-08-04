/* ============================================================
   KCMPS backend — operating-hours-aware business-time helpers
   ============================================================
   Pure functions only, no AWS SDK/I/O — same rule as every other file in
   backend/lib/. Backs the operating-hours-aware verification SLA clock
   (see backend/staff-api/verify-payment.js and its own header).

   Asia/Manila has a fixed UTC+8 offset year-round (no DST), so this
   deliberately does NOT pull in a timezone library (luxon/moment-timezone)
   — a plain `utcOffsetMinutes` on the config is exact for this single
   timezone and keeps every Lambda here dependency-free. If KCMPS ever
   operates across a DST-observing timezone, this file (not its callers)
   is where that would need to change.
   ============================================================ */

// One item, PK: CONFIG#OPERATING_HOURS, SK: "META" (see keys.js's
// configPk()/configSk()) — this is the fallback used when that item
// doesn't exist yet (no migration needed to introduce the config type;
// see root CLAUDE.md's "Adding a collection" backfill convention for the
// same don't-force-a-migration reasoning applied to a new item type
// instead of a new dashboard-data.js collection). Editable later via
// /dashboard/settings (website/dashboard/settings.html's SLA table is
// currently a read-only mock) — until that Settings API exists, this
// constant IS the operating-hours config KCMPS runs on.
const DEFAULT_OPERATING_HOURS = {
  timezone: "Asia/Manila",
  utcOffsetMinutes: 480,
  days: {
    sun: null,
    mon: { open: "09:00", close: "18:00" },
    tue: { open: "09:00", close: "18:00" },
    wed: { open: "09:00", close: "18:00" },
    thu: { open: "09:00", close: "18:00" },
    fri: { open: "09:00", close: "18:00" },
    sat: { open: "09:00", close: "14:00" },
    // sun: null (closed) — see above.
  },
};

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MINUTE_MS = 60000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function parseHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Shifts a real instant by the config's fixed UTC offset, so every
// getUTC*() call below reads "local" calendar fields deterministically —
// independent of the host machine's own timezone (critical for a Lambda,
// which may run in any AWS region, and for tests to be reproducible).
function toShiftedMs(iso, operatingHours) {
  return new Date(iso).getTime() + operatingHours.utcOffsetMinutes * MINUTE_MS;
}

function startOfShiftedDay(shiftedMs) {
  const d = new Date(shiftedMs);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function dayWindow(shiftedDayStartMs, operatingHours) {
  const dow = DAY_KEYS[new Date(shiftedDayStartMs).getUTCDay()];
  return operatingHours.days[dow] || null;
}

// Elapsed *operating* minutes between two ISO timestamps — skips any
// stretch outside `operatingHours` (overnight, weekends, or a day marked
// `null`/closed). Walks one local calendar day at a time so it composes
// correctly across an arbitrary number of closed days in between.
function businessMinutesBetween(startIso, endIso, operatingHours = DEFAULT_OPERATING_HOURS) {
  const startMs = toShiftedMs(startIso, operatingHours);
  const endMs = toShiftedMs(endIso, operatingHours);
  if (endMs <= startMs) return 0;

  let total = 0;
  let dayStartMs = startOfShiftedDay(startMs);
  while (dayStartMs < endMs) {
    const dayEndMs = dayStartMs + DAY_MS;
    const window = dayWindow(dayStartMs, operatingHours);
    if (window) {
      const openMs = dayStartMs + parseHHMM(window.open) * MINUTE_MS;
      const closeMs = dayStartMs + parseHHMM(window.close) * MINUTE_MS;
      const overlapStart = Math.max(startMs, openMs);
      const overlapEnd = Math.min(endMs, closeMs);
      if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / MINUTE_MS;
    }
    dayStartMs = dayEndMs;
  }
  return Math.round(total * 100) / 100;
}

function isWithinOperatingHours(iso, operatingHours = DEFAULT_OPERATING_HOURS) {
  const shiftedMs = toShiftedMs(iso, operatingHours);
  const dayStartMs = startOfShiftedDay(shiftedMs);
  const window = dayWindow(dayStartMs, operatingHours);
  if (!window) return false;
  const minutesOfDay = (shiftedMs - dayStartMs) / MINUTE_MS;
  return minutesOfDay >= parseHHMM(window.open) && minutesOfDay < parseHHMM(window.close);
}

// The next moment operating hours are open at/after `fromIso` — if
// `fromIso` already falls inside operating hours, returns it unchanged.
// Used to re-anchor a downstream SLA clock when the triggering action
// (e.g. a staff payment verification) happened off-hours. Bounded to a
// 14-day forward search so a misconfigured all-closed week fails loudly
// instead of looping forever.
function nextOperatingStart(fromIso, operatingHours = DEFAULT_OPERATING_HOURS) {
  const fromMs = toShiftedMs(fromIso, operatingHours);
  let dayStartMs = startOfShiftedDay(fromMs);
  for (let i = 0; i < 14; i++) {
    const window = dayWindow(dayStartMs, operatingHours);
    if (window) {
      const openMs = dayStartMs + parseHHMM(window.open) * MINUTE_MS;
      const closeMs = dayStartMs + parseHHMM(window.close) * MINUTE_MS;
      if (fromMs < closeMs) {
        const startMs = Math.max(fromMs, openMs);
        return new Date(startMs - operatingHours.utcOffsetMinutes * MINUTE_MS).toISOString();
      }
    }
    dayStartMs += DAY_MS;
  }
  throw new Error("nextOperatingStart: no open operating-hours window found within 14 days — check the operating-hours config");
}

module.exports = {
  DEFAULT_OPERATING_HOURS,
  businessMinutesBetween,
  isWithinOperatingHours,
  nextOperatingStart,
};
