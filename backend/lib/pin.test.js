/* Tests for lib/pin.js — the staff idle-screen PIN hashing + lockout
   math behind backend/staff-api/staff-pin.js. Run with the rest:
   node --test backend/lib/*.test.js (name the files — see backend/CLAUDE.md). */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  isValidPin, newPinFields, verifyPin, hashPin,
  lockDurationMs, lockoutState,
  SCRYPT_PARAMS, MAX_FREE_ATTEMPTS, BASE_LOCK_MS, MAX_LOCK_MS,
} = require("./pin");

// ---- PIN format ----

test("isValidPin accepts 4-6 digit strings only", () => {
  assert.equal(isValidPin("1234"), true);
  assert.equal(isValidPin("123456"), true);
  assert.equal(isValidPin("123"), false);
  assert.equal(isValidPin("1234567"), false);
  assert.equal(isValidPin("12a4"), false);
  assert.equal(isValidPin(""), false);
  assert.equal(isValidPin(1234), false); // number, not string
  assert.equal(isValidPin(null), false);
  assert.equal(isValidPin(undefined), false);
  assert.equal(isValidPin("12.4"), false);
  assert.equal(isValidPin(" 1234"), false);
});

// ---- hashing ----

test("newPinFields produces scrypt fields and a fresh salt every time", async () => {
  const a = await newPinFields("1234");
  const b = await newPinFields("1234");
  assert.ok(a.salt && a.hash);
  assert.notEqual(a.salt, b.salt, "salt must be fresh per set");
  assert.notEqual(a.hash, b.hash, "same PIN + different salt = different hash");
  assert.deepEqual(a.scryptParams, SCRYPT_PARAMS);
  // A real KDF output, not a bare SHA-256 of the pin
  assert.equal(Buffer.from(a.hash, "base64").length, SCRYPT_PARAMS.keylen);
});

test("newPinFields rejects malformed pins", async () => {
  await assert.rejects(() => newPinFields("abc1"), TypeError);
  await assert.rejects(() => newPinFields("12345678"), TypeError);
});

test("verifyPin round-trips correct pin, rejects wrong pin", async () => {
  const rec = await newPinFields("4321");
  assert.equal(await verifyPin("4321", rec), true);
  assert.equal(await verifyPin("4322", rec), false);
  assert.equal(await verifyPin("43210", rec), false);
});

test("verifyPin fails closed on missing/damaged records and bad input", async () => {
  const rec = await newPinFields("1234");
  assert.equal(await verifyPin("1234", null), false);
  assert.equal(await verifyPin("1234", {}), false);
  assert.equal(await verifyPin("1234", { salt: rec.salt }), false);
  assert.equal(await verifyPin("not-digits", rec), false);
  assert.equal(await verifyPin("", rec), false);
});

test("verifyPin honors the record's own scrypt parameters (future-proofing)", async () => {
  // A record hashed with lighter params must still verify with those
  // params, not today's defaults.
  const light = { N: 1024, r: 8, p: 1, keylen: 32 };
  const salt = Buffer.from("0123456789abcdef").toString("base64");
  const hash = await hashPin("9999", salt, light);
  const rec = { salt, hash, scryptParams: light };
  assert.equal(await verifyPin("9999", rec), true);
  assert.equal(await verifyPin("9998", rec), false);
});

// ---- lockout math ----

test("lockDurationMs: free attempts, then exponential backoff, capped", () => {
  assert.equal(lockDurationMs(0), 0);
  assert.equal(lockDurationMs(MAX_FREE_ATTEMPTS - 1), 0);
  assert.equal(lockDurationMs(MAX_FREE_ATTEMPTS), BASE_LOCK_MS);          // 5th wrong: 30 s
  assert.equal(lockDurationMs(MAX_FREE_ATTEMPTS + 1), BASE_LOCK_MS * 2);  // 60 s
  assert.equal(lockDurationMs(MAX_FREE_ATTEMPTS + 2), BASE_LOCK_MS * 4);  // 120 s
  assert.equal(lockDurationMs(MAX_FREE_ATTEMPTS + 20), MAX_LOCK_MS);      // capped at 15 min
  assert.equal(lockDurationMs(MAX_FREE_ATTEMPTS + 1000), MAX_LOCK_MS);    // no overflow at silly counts
  assert.equal(lockDurationMs(NaN), 0);
  assert.equal(lockDurationMs(undefined), 0);
});

test("lockoutState reads lockedUntil against now", () => {
  const now = Date.parse("2026-08-07T04:00:00.000Z");
  const locked = { lockedUntil: "2026-08-07T04:00:30.000Z" };
  assert.deepEqual(lockoutState(locked, now), { locked: true, retryAfterMs: 30000 });
  const expired = { lockedUntil: "2026-08-07T03:59:59.000Z" };
  assert.deepEqual(lockoutState(expired, now), { locked: false, retryAfterMs: 0 });
  assert.deepEqual(lockoutState({}, now), { locked: false, retryAfterMs: 0 });
  assert.deepEqual(lockoutState(null, now), { locked: false, retryAfterMs: 0 });
  assert.deepEqual(lockoutState({ lockedUntil: "garbage" }, now), { locked: false, retryAfterMs: 0 });
});
