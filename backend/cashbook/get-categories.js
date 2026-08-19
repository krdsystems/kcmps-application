/* ============================================================
   KCMPS Cash Book — GET /cashbook/categories
   ============================================================
   The category list the entry form builds its chips from (plan §9 —
   chips, never a <select>; the owner already rejected a <select> once on
   the bulk-quote picker).

   AUTH: isStaff(). It is the vocabulary staff log against.

   Read-only. Categories are config (CONFIG#TXN_CATEGORIES) rather than
   hardcoded, but nothing writes that item yet — a future Settings API
   owns editing. Until then this serves ../lib/cashbook.js's seed list,
   the same no-migration-needed fallback business-hours.js uses.

   The client is NOT trusted with any of this. It renders `direction` and
   `sign` for display only; both are re-resolved from the server's own
   copy on every write (review finding B5), so an out-of-date tab can
   never post a positive refund or an inflow-shaped expense.
   ============================================================ */

const { extractClaims, isStaff } = require("../lib");
const { PAYMENT_METHODS } = require("../lib/cashbook");
const { loadCategories, response } = require("./shared");

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Staff only" });

  const categories = await loadCategories();
  return response(200, {
    categories,
    paymentMethods: PAYMENT_METHODS,
    costCategoryIds: categories.filter((c) => c.kind === "expense").map((c) => c.id),
  });
};
