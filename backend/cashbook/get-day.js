/* ============================================================
   KCMPS Cash Book — GET /cashbook/day/{day}
   ============================================================
   One Manila calendar day's ledger: every TXN row in that day's
   partition, plus that day's METRIC#DAY rollup.

   AUTH: isStaff(). Reading today's takings is ordinary shop-floor
   information — the Admin gate (owner decision on plan O1) is on void
   and on the MONTH totals / margin, not on the day view staff work from.

   RECONCILIATION IS RETURNED, NOT ASSUMED. The response carries both the
   stored rollup and a `computed` total summed from the rows actually
   returned, plus `reconciles: true|false`. The plan's whole reason for
   keeping counters (§4) is that a month total must not cost 31 queries —
   but a counter that silently drifts from its rows is worse than no
   counter, so the one view that CAN cheaply check the invariant does
   check it, on every read, and says so out loud.
   ============================================================ */

const { txnDayPk, dayMetricPk, extractClaims, isStaff } = require("../lib");
const { isValidDayKey, sumRows, rollupFrom, manilaDayKey } = require("../lib/cashbook");
const { TABLE, queryAll, getRollup, response } = require("./shared");

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Staff only" });

  const day = (event.pathParameters && event.pathParameters.day) ||
    (event.queryStringParameters && event.queryStringParameters.day) ||
    manilaDayKey(new Date().toISOString());

  if (!isValidDayKey(day)) return response(400, { error: "day must be YYYY-MM-DD (Asia/Manila)" });

  const [rows, rollupItem] = await Promise.all([
    queryAll({
      TableName: TABLE,
      // begins_with keeps the EVENT# audit records in this same
      // partition out of the ledger view — they are a separate concern
      // and would otherwise be counted as rows.
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :txn)",
      ExpressionAttributeValues: { ":pk": txnDayPk(day), ":txn": "TXN#" },
    }),
    getRollup(dayMetricPk(day)),
  ]);

  const stored = rollupFrom(rollupItem);
  const computed = sumRows(rows);
  const reconciles = ["cashInCentavos", "cashOutCentavos", "netCentavos", "txnCount"]
    .every((f) => stored[f] === computed[f]);

  // Newest first, matching the mobile list in plan §9.
  rows.sort((a, b) => String(b.occurredAt || "").localeCompare(String(a.occurredAt || "")));

  return response(200, { day, rows, rollup: stored, computed, reconciles });
};
