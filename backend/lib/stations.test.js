const { test } = require("node:test");
const assert = require("node:assert");
const {
  DEFAULT_STATIONS,
  normalizeStations,
  activeStations,
  isKnownStation,
  stationLabel,
  validateStationsPayload,
  MAX_STATIONS,
} = require("./stations");

const PRIOR = [
  { id: "PRESS-01", label: "Silkscreen Press", plannedHoursPerWeek: 40, retired: false },
  { id: "DIGITAL-01", label: "Digital", plannedHoursPerWeek: 32, retired: false },
];

function payload(over) {
  return [
    { id: "PRESS-01", label: "Silkscreen Press", plannedHoursPerWeek: 40 },
    { id: "DIGITAL-01", label: "Digital", plannedHoursPerWeek: 32 },
    ...(over || []),
  ];
}

/* ---- normalizeStations: never throws, always usable ---- */

test("normalizeStations falls back to defaults when nothing is stored", () => {
  for (const empty of [undefined, null, [], "nope", {}, 0]) {
    assert.deepEqual(normalizeStations(empty).map((s) => s.id), DEFAULT_STATIONS.map((s) => s.id));
  }
});

test("normalizeStations returns a mutable copy, not the frozen default", () => {
  const s = normalizeStations(null);
  s[0].label = "changed";
  assert.equal(DEFAULT_STATIONS[0].label, "Silkscreen Press");
});

test("normalizeStations drops malformed rows and keeps the good ones", () => {
  const out = normalizeStations([
    { id: "GOOD-01", label: "Good" },
    { id: "bad id!", label: "Bad" },
    null,
    "string",
    { label: "no id" },
  ]);
  assert.deepEqual(out.map((s) => s.id), ["GOOD-01"]);
});

test("normalizeStations falls back when every stored row is malformed", () => {
  assert.deepEqual(
    normalizeStations([{ id: "!!" }, null]).map((s) => s.id),
    DEFAULT_STATIONS.map((s) => s.id)
  );
});

test("normalizeStations uppercases ids and dedupes", () => {
  const out = normalizeStations([{ id: "press-01", label: "a" }, { id: "PRESS-01", label: "b" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "PRESS-01");
  assert.equal(out[0].label, "a", "first occurrence wins");
});

test("normalizeStations defaults a missing label to the id and coerces hours", () => {
  const [s] = normalizeStations([{ id: "X-01" }]);
  assert.equal(s.label, "X-01");
  assert.equal(s.plannedHoursPerWeek, 0);
  assert.equal(s.retired, false);
});

test("normalizeStations clamps hours into range", () => {
  assert.equal(normalizeStations([{ id: "X-01", plannedHoursPerWeek: -5 }])[0].plannedHoursPerWeek, 0);
  assert.equal(normalizeStations([{ id: "X-01", plannedHoursPerWeek: 9999 }])[0].plannedHoursPerWeek, 168);
  assert.equal(normalizeStations([{ id: "X-01", plannedHoursPerWeek: "20" }])[0].plannedHoursPerWeek, 20);
  assert.equal(normalizeStations([{ id: "X-01", plannedHoursPerWeek: NaN }])[0].plannedHoursPerWeek, 0);
});

test("normalizeStations treats retired as strictly boolean true", () => {
  assert.equal(normalizeStations([{ id: "X-01", retired: "yes" }])[0].retired, false);
  assert.equal(normalizeStations([{ id: "X-01", retired: true }])[0].retired, true);
});

/* ---- activeStations / isKnownStation: the retire contract ---- */

test("activeStations hides retired stations", () => {
  const list = [{ id: "A-01", label: "A" }, { id: "B-01", label: "B", retired: true }];
  assert.deepEqual(activeStations(list).map((s) => s.id), ["A-01"]);
});

test("isKnownStation still accepts a RETIRED station", () => {
  // Load-bearing: a line item already in production at a retired station
  // must stay advanceable. See stations.js's header.
  const list = [{ id: "A-01", label: "A" }, { id: "B-01", label: "B", retired: true }];
  assert.equal(isKnownStation(list, "B-01"), true);
});

test("isKnownStation rejects unknown, empty and free-string values", () => {
  const list = [{ id: "A-01", label: "A" }];
  for (const bad of ["", null, undefined, "NOPE-99", "A-01; DROP", 42]) {
    assert.equal(isKnownStation(list, bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("isKnownStation is case-insensitive and trims", () => {
  assert.equal(isKnownStation([{ id: "A-01", label: "A" }], "  a-01 "), true);
});

test("isKnownStation validates against the defaults when nothing is stored", () => {
  assert.equal(isKnownStation(null, "PRESS-01"), true);
  assert.equal(isKnownStation(null, "MADE-UP"), false);
});

/* ---- stationLabel ---- */

test("stationLabel resolves a retired station's name for historical rows", () => {
  const list = [{ id: "OLD-01", label: "Old Press", retired: true }];
  assert.equal(stationLabel(list, "OLD-01"), "Old Press");
});

test("stationLabel echoes an unknown id rather than returning empty", () => {
  assert.equal(stationLabel([{ id: "A-01", label: "A" }], "GHOST-01"), "GHOST-01");
});

/* ---- validateStationsPayload ---- */

test("validateStationsPayload accepts a well-formed unchanged list", () => {
  const res = validateStationsPayload(payload(), PRIOR);
  assert.equal(res.ok, true);
  assert.equal(res.stations.length, 2);
  assert.equal(res.stations[0].retired, false);
});

test("validateStationsPayload allows renaming a label", () => {
  const res = validateStationsPayload(
    [{ id: "PRESS-01", label: "Big Press", plannedHoursPerWeek: 40 },
     { id: "DIGITAL-01", label: "Digital", plannedHoursPerWeek: 32 }],
    PRIOR
  );
  assert.equal(res.ok, true);
  assert.equal(res.stations[0].label, "Big Press");
});

test("validateStationsPayload allows adding a new station", () => {
  const res = validateStationsPayload(payload([{ id: "LASER-01", label: "Laser", plannedHoursPerWeek: 10 }]), PRIOR);
  assert.equal(res.ok, true);
  assert.equal(res.stations.length, 3);
});

test("validateStationsPayload allows retiring a station", () => {
  const res = validateStationsPayload(
    [{ id: "PRESS-01", label: "Silkscreen Press", plannedHoursPerWeek: 40 },
     { id: "DIGITAL-01", label: "Digital", plannedHoursPerWeek: 32, retired: true }],
    PRIOR
  );
  assert.equal(res.ok, true);
  assert.equal(res.stations[1].retired, true);
});

test("validateStationsPayload REJECTS deleting a station", () => {
  const res = validateStationsPayload(
    [{ id: "PRESS-01", label: "Silkscreen Press", plannedHoursPerWeek: 40 }],
    PRIOR
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /cannot be deleted/i);
  assert.match(res.error, /DIGITAL-01/);
});

test("validateStationsPayload REJECTS renaming an id (it reads as delete + add)", () => {
  const res = validateStationsPayload(
    [{ id: "PRESS-02", label: "Silkscreen Press", plannedHoursPerWeek: 40 },
     { id: "DIGITAL-01", label: "Digital", plannedHoursPerWeek: 32 }],
    PRIOR
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /PRESS-01/);
});

test("validateStationsPayload rejects retiring every station", () => {
  const res = validateStationsPayload(
    [{ id: "PRESS-01", label: "P", plannedHoursPerWeek: 40, retired: true },
     { id: "DIGITAL-01", label: "D", plannedHoursPerWeek: 32, retired: true }],
    PRIOR
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /at least one station/i);
});

test("validateStationsPayload rejects an empty or non-array payload", () => {
  assert.equal(validateStationsPayload([], PRIOR).ok, false);
  assert.equal(validateStationsPayload({}, PRIOR).ok, false);
  assert.equal(validateStationsPayload(null, PRIOR).ok, false);
  assert.equal(validateStationsPayload("PRESS-01", PRIOR).ok, false);
});

test("validateStationsPayload rejects too many stations", () => {
  const many = Array.from({ length: MAX_STATIONS + 1 }, (_, i) => ({
    id: `S-${String(i).padStart(3, "0")}`, label: `S${i}`, plannedHoursPerWeek: 1,
  }));
  const res = validateStationsPayload(many, []);
  assert.equal(res.ok, false);
  assert.match(res.error, /At most/);
});

test("validateStationsPayload rejects bad ids", () => {
  for (const bad of ["", "A", "has space", "lower-ok?", "-LEAD", "TOO" + "X".repeat(40), "É-01"]) {
    const res = validateStationsPayload([{ id: bad, label: "x", plannedHoursPerWeek: 1 }], []);
    assert.equal(res.ok, false, `should reject id ${JSON.stringify(bad)}`);
  }
});

test("validateStationsPayload uppercases a lowercase id rather than rejecting it", () => {
  const res = validateStationsPayload(
    [{ id: "laser-01", label: "Laser", plannedHoursPerWeek: 5 }],
    [{ id: "LASER-01", label: "Laser", plannedHoursPerWeek: 5 }]
  );
  assert.equal(res.ok, true);
  assert.equal(res.stations[0].id, "LASER-01");
});

test("validateStationsPayload rejects a duplicate id", () => {
  const res = validateStationsPayload(
    [{ id: "A-01", label: "one", plannedHoursPerWeek: 1 },
     { id: "a-01", label: "two", plannedHoursPerWeek: 1 }],
    []
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /Duplicate/i);
});

test("validateStationsPayload requires a non-blank label", () => {
  for (const bad of ["", "   ", null, undefined]) {
    const res = validateStationsPayload([{ id: "A-01", label: bad, plannedHoursPerWeek: 1 }], []);
    assert.equal(res.ok, false, `should reject label ${JSON.stringify(bad)}`);
    assert.match(res.error, /needs a name/);
  }
});

test("validateStationsPayload rejects an over-long label", () => {
  const res = validateStationsPayload([{ id: "A-01", label: "x".repeat(61), plannedHoursPerWeek: 1 }], []);
  assert.equal(res.ok, false);
  assert.match(res.error, /too long/);
});

test("validateStationsPayload rejects out-of-range or non-numeric hours", () => {
  for (const bad of [-1, 169, "abc", null, undefined, NaN, Infinity]) {
    const res = validateStationsPayload([{ id: "A-01", label: "A", plannedHoursPerWeek: bad }], []);
    assert.equal(res.ok, false, `should reject hours ${String(bad)}`);
  }
});

test("validateStationsPayload trims the label and rounds hours", () => {
  const res = validateStationsPayload(
    [{ id: "A-01", label: "  Press  ", plannedHoursPerWeek: 39.6 }],
    [{ id: "A-01", label: "A", plannedHoursPerWeek: 1 }]
  );
  assert.equal(res.ok, true);
  assert.equal(res.stations[0].label, "Press");
  assert.equal(res.stations[0].plannedHoursPerWeek, 40);
});

test("validateStationsPayload against an empty prior treats the defaults as prior", () => {
  // normalizeStations([]) falls back to DEFAULT_STATIONS, so a first-ever
  // save must still carry every default id — otherwise saving from a fresh
  // install would silently orphan the ids already written onto line items.
  const res = validateStationsPayload([{ id: "NEW-01", label: "New", plannedHoursPerWeek: 1 }], []);
  assert.equal(res.ok, false);
  assert.match(res.error, /PRESS-01/);
});

test("validateStationsPayload ignores unknown extra fields", () => {
  const res = validateStationsPayload(
    [{ id: "A-01", label: "A", plannedHoursPerWeek: 1, evil: "x", retired: false }],
    [{ id: "A-01", label: "A", plannedHoursPerWeek: 1 }]
  );
  assert.equal(res.ok, true);
  assert.deepEqual(Object.keys(res.stations[0]).sort(), ["id", "label", "plannedHoursPerWeek", "retired"]);
});
