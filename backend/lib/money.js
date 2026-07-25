/* ============================================================
   KCMPS backend — money helpers
   ============================================================
   Money is stored as INTEGER CENTAVOS, never floats (ERP_System_Project_
   Knowledge.md §2.3.4). A float peso amount (₱1,500.07) rounds to the
   nearest centavo on the way in and is never re-derived from a float once
   stored — every write path goes through toCentavos() once, at the edge.
   ============================================================ */

function assertCentavos(n) {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new TypeError(`Expected an integer number of centavos, got ${JSON.stringify(n)}`);
  }
  return n;
}

// Pesos (float or numeric string, e.g. 1500.07) -> integer centavos (150007).
// Rounds to the nearest centavo so float drift never accumulates past the
// single conversion point.
function toCentavos(pesos) {
  const n = typeof pesos === "string" ? Number(pesos) : pesos;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TypeError(`Expected a finite peso amount, got ${JSON.stringify(pesos)}`);
  }
  return Math.round(n * 100);
}

// Integer centavos -> pesos as a float (150007 -> 1500.07). For display
// math / passing to formatters — never re-store the result as money.
function toPesos(centavos) {
  assertCentavos(centavos);
  return centavos / 100;
}

// Integer centavos -> "₱1,500.07" (en-PH thousands separator, always 2
// decimal places since the source is an exact integer, not a float that
// might already be "clean").
function formatPeso(centavos) {
  assertCentavos(centavos);
  const pesos = centavos / 100;
  return "₱" + pesos.toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

module.exports = { toCentavos, toPesos, formatPeso, assertCentavos };
