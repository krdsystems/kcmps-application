/* ============================================================
   KCMPS job costing — GET /orders/{orderId}/costing
   ============================================================
   Revenue, costs, profit, margin and per-unit economics for one job,
   from ONE query on that order's partition — which is the entire reason
   COST# lines and the order->txn pointers are co-located there (plan §4,
   the same trick EVENT# and MSG# already use).

   AUTH: requireRole(Admin). Owner decision on plan O1 (2026-08-18): job
   profit/margin sits with month totals and void on the Admin side of the
   line. Any staffer can log a cost (log-cost.js); reading what the shop
   made on the job is a different question.

   All the arithmetic is ../lib/cashbook.js's jobCosting() — pure and
   unit-tested against the owner's real totebag job (plan §5), including
   the salaried-labour variant where profit and net cash diverge. This
   handler only fetches and shapes.

   Units for the per-unit figure come from the order's own LINEITEM# qty
   values, or an explicit ?units= override. Plan §5 is explicit that the
   150-piece quantity in the worked example was illustrative and that the
   real number comes from the order — so it is read, never assumed.
   ============================================================ */

const { orderPk, metaSk, extractClaims, requireRole, ROLES } = require("../lib");
const { jobCosting } = require("../lib/cashbook");
const { TABLE, queryAll, response } = require("./shared");

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  const denied = requireRole(claims, [ROLES.ADMIN]);
  if (denied) return response(403, { error: "Job profit/margin is Admin-only", requiredRoles: denied.requiredRoles });

  const orderId = event.pathParameters && event.pathParameters.orderId;
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  const items = await queryAll({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": orderPk(orderId) },
  });

  const meta = items.find((i) => i.SK === metaSk());
  if (!meta) return response(404, { error: "Order not found" });

  const costLines = items.filter((i) => String(i.SK).startsWith("COST#"));
  // `!i.deleted` skips pointers left behind by a re-link: moving a
  // transaction to a different job soft-deletes its old TXN_POINTER
  // rather than removing it (relink-transaction.js explains why it must
  // be a soft delete), so without this filter the money would keep
  // counting toward the job it was just moved off.
  const txnRows = items.filter((i) => String(i.SK).startsWith("TXN#") && !i.deleted);

  let units = null;
  const q = event.queryStringParameters || {};
  if (q.units !== undefined) {
    const n = Number(q.units);
    if (!Number.isInteger(n) || n <= 0) return response(400, { error: "units must be a positive integer" });
    units = n;
  } else {
    const lineQtys = items
      .filter((i) => String(i.SK).startsWith("LINEITEM#"))
      .map((i) => Number(i.qty))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (lineQtys.length) units = lineQtys.reduce((a, b) => a + b, 0);
  }

  const summary = jobCosting({ costLines, txnRows, units });

  return response(200, {
    orderId,
    summary,
    costLines: costLines.sort((a, b) => String(a.incurredAt || "").localeCompare(String(b.incurredAt || ""))),
    transactions: txnRows.sort((a, b) => String(a.occurredAt || "").localeCompare(String(b.occurredAt || ""))),
  });
};
