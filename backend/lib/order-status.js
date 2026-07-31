/* ============================================================
   KCMPS backend — derived order status
   ============================================================
   `orderStatus` on the ORDER#<id>/META item is always a rollup of its
   line items' individual `status` values — never set directly (ERP file
   §2.4, ops-dashboard/infra/backend-infra-to-deploy.md §2.4).

   This is a THIRD copy of the same rule — dashboard-data.js's
   deriveOrderStatus() and ops-dashboard/infra/logic-inputs/streams-
   handler.js's recomputeOrderStatus() each hand-roll their own identical
   version, predating this lib. Not reconciled as part of this change
   (see backend/CLAUDE.md's "Where this is going (not now)" note) — but
   any new Lambda should import THIS one rather than adding a fourth copy.
   If the rollup rule ever changes, all three call sites need the same
   edit until they're migrated to share this file.
   ============================================================ */

const { STATUS } = require("./constants");

function deriveOrderStatus(lineItemStatuses) {
  const statuses = lineItemStatuses || [];
  if (statuses.length && statuses.every((s) => s === STATUS.DELIVERED)) return STATUS.DELIVERED;
  if (statuses.some((s) => s === STATUS.DELIVERED) &&
      statuses.some((s) => s !== STATUS.DELIVERED && ![STATUS.CANCELLED, STATUS.QUOTE_EXPIRED].includes(s))) {
    return "Partially Fulfilled";
  }
  if (statuses.some((s) => s === STATUS.PENDING_PAYMENT_VERIFICATION)) return STATUS.PENDING_PAYMENT_VERIFICATION;
  if (statuses.some((s) => s === "Rework")) return "Rework";
  if (statuses.some((s) => s === STATUS.IN_PRODUCTION)) return STATUS.IN_PRODUCTION;
  if (statuses.some((s) => s === STATUS.QUOTED)) return "Awaiting Quote";
  if (statuses.some((s) => s === STATUS.PRICED)) return "Awaiting Payment";
  return statuses[0] || "Unknown";
}

module.exports = { deriveOrderStatus };
