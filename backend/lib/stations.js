/* ============================================================
   KCMPS backend — production stations (config item + validation)
   ============================================================
   Pure functions only, no AWS SDK/I/O — same rule as every other file in
   backend/lib/. Backs staff-api/stations.js (the GET/PUT Settings route)
   and staff-api/advance-line-item.js (which validates the `station` it is
   handed against this list).

   ---- Why ids are immutable and stations are retired, never deleted ----

   A station id is NOT just a picker option. advance-line-item.js writes it
   onto the line item AND stamps it into the append-only EVENT# audit
   record for that transition, so by the time anyone opens Settings there
   are already historical rows pointing at these strings. Renaming an id
   would orphan every one of them; deleting one would leave the Week view
   and job-detail rendering a station that no longer resolves to a name.

   So the editable surface is deliberately narrow:
     - `label`  — free to change, it is display text only
     - `plannedHoursPerWeek` — free to change, capacity planning input
     - `retired` — hides a station from new pickers, keeps it resolvable
     - adding a NEW station with a new id — always fine
   and `id` itself is create-only. This is the same two-list split the cash
   book needed for the retired `card` payment method (a writeable set for
   new entries, plus a label map that still resolves historical values) —
   for the same reason, arrived at the same way.

   Retiring is intentionally NOT gated on "no active job is at this
   station". A line item already in production at a retired station keeps
   running and keeps displaying correctly, because isKnownStation() below
   accepts retired ids; retiring only removes it from the choices offered
   for NEW work. Blocking the retire until the floor is clear would make
   the setting unusable exactly when someone wants it (a station breaks
   down mid-week and should stop being scheduled).
   ============================================================ */

// The fallback used when the CONFIG#STATIONS item does not exist yet — no
// migration is needed to introduce this config type, identical in spirit
// to business-hours.js's DEFAULT_OPERATING_HOURS (read that file's note
// for the full reasoning). Until someone saves in Settings, THIS is the
// station list KCMPS runs on, and it is byte-for-byte the list that was
// hardcoded in website/dashboard/dashboard-data.js before 2026-08-19.
const DEFAULT_STATIONS = Object.freeze([
  { id: "PRESS-01", label: "Silkscreen Press", plannedHoursPerWeek: 40, retired: false },
  { id: "DIGITAL-01", label: "Digital / Large Format", plannedHoursPerWeek: 32, retired: false },
  { id: "3DPRINT-01", label: "3D Printing", plannedHoursPerWeek: 60, retired: false },
  { id: "HEATPRESS-01", label: "Heat Press / Apparel", plannedHoursPerWeek: 36, retired: false },
  { id: "FINISHING-01", label: "Finishing / Packing", plannedHoursPerWeek: 30, retired: false },
]);

// Uppercase letters/digits plus - and _, 2–32 chars. Constrained because
// the id becomes part of a DynamoDB sort key (keys.js's stationSk()) and
// is echoed into audit events — a free-form string there is the same
// unvalidated-input problem this module exists to close.
const STATION_ID_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

const MAX_STATIONS = 40;
const MAX_LABEL_LEN = 60;
const MAX_PLANNED_HOURS = 168; // hours in a week — a hard physical ceiling

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Accepts whatever came back from DynamoDB (or nothing) and always returns
// a usable list. A malformed/partial stored item falls back rather than
// throwing: a bad config row must not be able to take the whole dashboard
// down, and the default list is always a correct-if-stale answer.
function normalizeStations(stored) {
  if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_STATIONS.map((s) => ({ ...s }));
  const out = [];
  for (const raw of stored) {
    if (!isPlainObject(raw)) continue;
    const id = String(raw.id || "").trim().toUpperCase();
    if (!STATION_ID_RE.test(id)) continue;
    if (out.some((s) => s.id === id)) continue;
    out.push({
      id,
      label: String(raw.label || id).trim().slice(0, MAX_LABEL_LEN) || id,
      plannedHoursPerWeek: clampHours(raw.plannedHoursPerWeek),
      retired: raw.retired === true,
    });
  }
  return out.length ? out : DEFAULT_STATIONS.map((s) => ({ ...s }));
}

function clampHours(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), MAX_PLANNED_HOURS);
}

// Stations offered for NEW work — what a picker should render.
function activeStations(stations) {
  return normalizeStations(stations).filter((s) => !s.retired);
}

// Accepts retired ids on purpose — see the header. This is the check
// advance-line-item.js runs, and a job already sitting at a retired
// station must still be advanceable.
function isKnownStation(stations, stationId) {
  const id = String(stationId || "").trim().toUpperCase();
  if (!id) return false;
  return normalizeStations(stations).some((s) => s.id === id);
}

function stationLabel(stations, stationId) {
  const id = String(stationId || "").trim().toUpperCase();
  const hit = normalizeStations(stations).find((s) => s.id === id);
  return hit ? hit.label : (stationId || "");
}

/* ---- PUT payload validation ----
   Returns { ok: true, stations } or { ok: false, error } — a plain result
   object rather than a throw, so the Lambda maps it straight to a 400 with
   the message the staffer actually needs to read.

   `prior` is the currently-stored list. It is required because the two
   rules that matter here are both relative to it: an existing id may not
   change (ids are create-only), and an id may not disappear (removal is
   expressed as retired: true). Validating the payload in isolation cannot
   see either violation. */
function validateStationsPayload(payload, prior) {
  if (!Array.isArray(payload)) return { ok: false, error: "stations must be an array" };
  if (payload.length === 0) return { ok: false, error: "At least one station is required" };
  if (payload.length > MAX_STATIONS) return { ok: false, error: `At most ${MAX_STATIONS} stations` };

  const priorList = normalizeStations(prior);
  const seen = new Set();
  const out = [];

  for (const raw of payload) {
    if (!isPlainObject(raw)) return { ok: false, error: "Each station must be an object" };

    const id = String(raw.id || "").trim().toUpperCase();
    if (!STATION_ID_RE.test(id)) {
      return { ok: false, error: `Invalid station id "${raw.id}" — use 2–32 characters: A–Z, 0–9, - or _` };
    }
    if (seen.has(id)) return { ok: false, error: `Duplicate station id "${id}"` };
    seen.add(id);

    const label = String(raw.label || "").trim();
    if (!label) return { ok: false, error: `Station "${id}" needs a name` };
    if (label.length > MAX_LABEL_LEN) {
      return { ok: false, error: `Station name for "${id}" is too long (max ${MAX_LABEL_LEN})` };
    }

    const hours = Number(raw.plannedHoursPerWeek);
    if (!Number.isFinite(hours) || hours < 0 || hours > MAX_PLANNED_HOURS) {
      return { ok: false, error: `Planned hours for "${id}" must be between 0 and ${MAX_PLANNED_HOURS}` };
    }

    out.push({ id, label, plannedHoursPerWeek: Math.round(hours), retired: raw.retired === true });
  }

  // No id may be dropped — history points at these. Retire, don't remove.
  const missing = priorList.filter((s) => !seen.has(s.id)).map((s) => s.id);
  if (missing.length) {
    return {
      ok: false,
      error: `Stations cannot be deleted (jobs and audit history reference them). Retire instead: ${missing.join(", ")}`,
    };
  }

  // Every station retired at once would leave no choice in the picker and
  // make Confirmed -> Scheduled unperformable.
  if (!out.some((s) => !s.retired)) {
    return { ok: false, error: "At least one station must stay active" };
  }

  return { ok: true, stations: out };
}

module.exports = {
  DEFAULT_STATIONS,
  STATION_ID_RE,
  MAX_STATIONS,
  MAX_LABEL_LEN,
  MAX_PLANNED_HOURS,
  normalizeStations,
  activeStations,
  isKnownStation,
  stationLabel,
  validateStationsPayload,
};
