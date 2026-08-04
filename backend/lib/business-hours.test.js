const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_OPERATING_HOURS,
  businessMinutesBetween,
  isWithinOperatingHours,
  nextOperatingStart,
} = require("./business-hours");

// All timestamps below are real UTC instants chosen so that (UTC + 8h)
// lands on the intended Asia/Manila local wall-clock time and weekday —
// 2026-08-03 is a Monday, 2026-08-01 a Saturday, 2026-08-02 a Sunday,
// 2026-07-31 a Friday (verified against the real calendar).

test("businessMinutesBetween: same-day case counts only the operating window", () => {
  // Monday 10:00 -> Monday 14:00 local, entirely inside 09:00-18:00.
  const start = "2026-08-03T02:00:00Z"; // Mon 10:00 Manila
  const end = "2026-08-03T06:00:00Z"; // Mon 14:00 Manila
  assert.equal(businessMinutesBetween(start, end, DEFAULT_OPERATING_HOURS), 240);
});

test("businessMinutesBetween: overnight-spanning case skips the closed hours", () => {
  // Monday 16:00 -> Tuesday 11:00 local: 2h (16:00-18:00 Mon) + 2h (09:00-11:00 Tue) = 4h, skipping 18:00-09:00 overnight.
  const start = "2026-08-03T08:00:00Z"; // Mon 16:00 Manila
  const end = "2026-08-04T03:00:00Z"; // Tue 11:00 Manila
  assert.equal(businessMinutesBetween(start, end, DEFAULT_OPERATING_HOURS), 240);
});

test("businessMinutesBetween: weekend-spanning case skips all of Sunday", () => {
  // Friday 17:00 -> Monday 10:00 local: 1h (Fri 17-18) + 5h (Sat 09-14) + 0h (Sun closed) + 1h (Mon 09-10) = 7h.
  const start = "2026-07-31T09:00:00Z"; // Fri 17:00 Manila
  const end = "2026-08-03T02:00:00Z"; // Mon 10:00 Manila
  assert.equal(businessMinutesBetween(start, end, DEFAULT_OPERATING_HOURS), 420);
});

test("businessMinutesBetween: returns 0 when end is not after start", () => {
  const iso = "2026-08-03T02:00:00Z";
  assert.equal(businessMinutesBetween(iso, iso, DEFAULT_OPERATING_HOURS), 0);
  assert.equal(businessMinutesBetween("2026-08-03T06:00:00Z", iso, DEFAULT_OPERATING_HOURS), 0);
});

test("isWithinOperatingHours: true inside a weekday window, false outside it and on Sunday", () => {
  assert.equal(isWithinOperatingHours("2026-08-03T02:00:00Z", DEFAULT_OPERATING_HOURS), true); // Mon 10:00
  assert.equal(isWithinOperatingHours("2026-08-03T13:00:00Z", DEFAULT_OPERATING_HOURS), false); // Mon 21:00 (after close)
  assert.equal(isWithinOperatingHours("2026-08-02T02:00:00Z", DEFAULT_OPERATING_HOURS), false); // Sun 10:00 (closed day)
});

test("nextOperatingStart: returns the same instant when already open", () => {
  const iso = "2026-08-03T02:00:00Z"; // Mon 10:00 Manila
  assert.equal(nextOperatingStart(iso, DEFAULT_OPERATING_HOURS), new Date(iso).toISOString());
});

test("nextOperatingStart: rolls an after-hours verification to next-day opening", () => {
  const iso = "2026-08-03T14:00:00Z"; // Mon 22:00 Manila (after 18:00 close)
  assert.equal(nextOperatingStart(iso, DEFAULT_OPERATING_HOURS), "2026-08-04T01:00:00.000Z"); // Tue 09:00 Manila
});

test("nextOperatingStart: rolls a Sunday timestamp forward to Monday opening", () => {
  const iso = "2026-08-02T04:00:00Z"; // Sun 12:00 Manila
  assert.equal(nextOperatingStart(iso, DEFAULT_OPERATING_HOURS), "2026-08-03T01:00:00.000Z"); // Mon 09:00 Manila
});
