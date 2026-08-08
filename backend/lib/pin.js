/* ============================================================
   KCMPS backend — staff idle-screen PIN hashing + lockout math
   ============================================================
   Pure logic for backend/staff-api/staff-pin.js — the server side of
   dashboard-shell.js's SESSION_GUARD idle privacy screen. Node's
   built-in crypto only (scrypt), no AWS SDK, no I/O — unit-tested in
   pin.test.js like the rest of lib/.

   THREAT MODEL — be honest about what this is and isn't:
   - It defends against a passer-by at an unattended, still-logged-in
     screen (the RA 10173 exposure website/privacy.html commits to
     closing), and against the old client-side scheme's casual devtools
     bypass, where the salt+SHA-256 record sat in localStorage and a
     4-digit PIN fell to offline brute force in under a second.
   - It is NOT a defence against the authenticated staff member
     themselves — they hold the Cognito session, which is the real
     security boundary every backend route re-verifies. Someone with
     devtools on an unlocked-origin tab can still delete the overlay
     DOM and read whatever the page had already loaded; the PIN's job
     is that they can never *learn or brute-force the PIN itself*, and
     that the hash never exists client-side at all.

   Hashing: scrypt (Node built-in, a real memory-hard password KDF —
   deliberately not a bare SHA) with the standard interactive parameter
   set N=2^14, r=8, p=1 (~16 MB per hash). The parameters are stored on
   the record so they can be raised later without invalidating existing
   PINs — verifyPin() always hashes with the record's own parameters.

   Lockout: a 4–6 digit PIN has at most 10^6 combinations, so
   verification MUST be rate-limited server-side (client-side throttling
   is decoration — the endpoint is directly callable). Attempt counting
   lives on the DynamoDB record, not in memory (Lambda instances don't
   share memory and are recycled). Schedule: the first 4 wrong attempts
   just fail; the 5th locks for 30 s, and every subsequent wrong attempt
   doubles the lock, capped at 15 min. That caps a brute forcer to ~4
   guesses/hour steady-state (~14 years for the 10^4 space on average)
   while a staffer who fat-fingers their real PIN twice never notices
   the mechanism exists.
   ============================================================ */

const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

// 4 digits (the UI default) through 6 (headroom, same keypad habit).
const PIN_RE = /^\d{4,6}$/;

// Stored on every record; verifyPin() reads the record's copy, so these
// can be raised for NEW pins without breaking existing ones.
const SCRYPT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 });

const MAX_FREE_ATTEMPTS = 5;      // the attempt that crosses this locks
const BASE_LOCK_MS = 30 * 1000;   // first lock: 30 s
const MAX_LOCK_MS = 15 * 60 * 1000; // cap: 15 min

function isValidPin(pin) {
  return typeof pin === "string" && PIN_RE.test(pin);
}

async function hashPin(pin, saltB64, params = SCRYPT_PARAMS) {
  const derived = await scrypt(pin, Buffer.from(saltB64, "base64"), params.keylen, {
    N: params.N, r: params.r, p: params.p,
    // Node rejects the hash if 128*N*r exceeds maxmem (default 32 MB) —
    // give generous headroom so a future parameter bump doesn't throw.
    maxmem: 256 * 1024 * 1024,
  });
  return derived.toString("base64");
}

// Builds the credential fields for a fresh set/change — fresh random
// salt every time, parameters recorded alongside.
async function newPinFields(pin) {
  if (!isValidPin(pin)) throw new TypeError("PIN must be 4-6 digits");
  const salt = crypto.randomBytes(16).toString("base64");
  const hash = await hashPin(pin, salt);
  return { salt, hash, scryptParams: { ...SCRYPT_PARAMS } };
}

// Constant-time compare against a stored record's fields.
async function verifyPin(pin, record) {
  if (!isValidPin(pin) || !record || !record.salt || !record.hash) return false;
  const params = record.scryptParams || SCRYPT_PARAMS;
  const candidate = await hashPin(pin, record.salt, params);
  const a = Buffer.from(candidate, "base64");
  const b = Buffer.from(record.hash, "base64");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// How long the lock lasts after `failedCount` cumulative wrong attempts.
// 0 means "not locked yet".
function lockDurationMs(failedCount) {
  if (!Number.isFinite(failedCount) || failedCount < MAX_FREE_ATTEMPTS) return 0;
  const doublings = failedCount - MAX_FREE_ATTEMPTS;
  // Cap the exponent before 2**n overflows into Infinity/imprecision.
  return Math.min(BASE_LOCK_MS * 2 ** Math.min(doublings, 30), MAX_LOCK_MS);
}

// Reads a record's lockedUntil (ISO string) against `now` (ms epoch).
// Returns { locked, retryAfterMs } — retryAfterMs is 0 when unlocked.
function lockoutState(record, nowMs = Date.now()) {
  const until = record && record.lockedUntil ? Date.parse(record.lockedUntil) : NaN;
  if (!Number.isFinite(until) || until <= nowMs) return { locked: false, retryAfterMs: 0 };
  return { locked: true, retryAfterMs: until - nowMs };
}

module.exports = {
  PIN_RE,
  SCRYPT_PARAMS,
  MAX_FREE_ATTEMPTS,
  BASE_LOCK_MS,
  MAX_LOCK_MS,
  isValidPin,
  hashPin,
  newPinFields,
  verifyPin,
  lockDurationMs,
  lockoutState,
};
