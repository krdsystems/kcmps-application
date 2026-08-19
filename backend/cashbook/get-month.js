/* ============================================================
   KCMPS Cash Book — GET /cashbook/month/{month}
   ============================================================
   One Manila calendar month's in / out / net, straight off the
   METRIC#MONTH SUMMARY counter that every write ADDs to inside its own
   transaction. A single GetItem — never 31 partition queries (plan §4).

   AUTH: requireRole(Admin). Owner decision on plan O1 (2026-08-18): any
   staffer logs and reads the day view; month totals are Admin-only, in
   the same bracket as void and job margin. That is the line between
   "what happened on my shift" and "how the business is doing".

   No rows are returned and none are summed. There is deliberately no
   reconciliation check here, unlike get-day.js: verifying a month
   against its rows is exactly the 31-query scan the counter exists to
   avoid. The invariant is enforced at write time (the ADDs ride the same
   TransactWriteItems as the row) and spot-checkable per day.
   ============================================================ */

const { monthMetricPk, extractClaims, requireRole, ROLES } = require("../lib");
const { isValidMonthKey, rollupFrom, manilaMonthKey } = require("../lib/cashbook");
const { getRollup, response } = require("./shared");

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  const denied = requireRole(claims, [ROLES.ADMIN]);
  if (denied) return response(403, { error: "Month totals are Admin-only", requiredRoles: denied.requiredRoles });

  const month = (event.pathParameters && event.pathParameters.month) ||
    (event.queryStringParameters && event.queryStringParameters.month) ||
    manilaMonthKey(new Date().toISOString());

  if (!isValidMonthKey(month)) return response(400, { error: "month must be YYYY-MM (Asia/Manila)" });

  const item = await getRollup(monthMetricPk(month));
  return response(200, { month, rollup: rollupFrom(item), exists: !!item });
};
