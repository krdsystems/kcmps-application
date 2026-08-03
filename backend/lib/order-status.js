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

// A line item is "fulfilled" once it's Delivered (courier) or Picked Up
// (pickup) — §6's two terminal branches are equivalent for rollup purposes.
function isFulfilled(s) { return s === STATUS.DELIVERED || s === STATUS.PICKED_UP; }

function deriveOrderStatus(lineItemStatuses) {
  const statuses = lineItemStatuses || [];
  if (statuses.length && statuses.every(isFulfilled)) return STATUS.DELIVERED;
  if (statuses.some(isFulfilled) &&
      statuses.some((s) => !isFulfilled(s) && ![STATUS.CANCELLED, STATUS.QUOTE_EXPIRED].includes(s))) {
    return "Partially Fulfilled";
  }
  if (statuses.some((s) => s === STATUS.PENDING_PAYMENT_VERIFICATION)) return STATUS.PENDING_PAYMENT_VERIFICATION;
  // Placed but no payment proof submitted yet — earlier in the funnel than
  // Pending Payment Verification, so that check above still wins if any
  // line item on a mixed order has already reached it.
  if (statuses.some((s) => s === STATUS.ORDER_PLACED)) return STATUS.ORDER_PLACED;
  if (statuses.some((s) => s === STATUS.REWORK)) return STATUS.REWORK;
  if (statuses.some((s) => s === STATUS.IN_PRODUCTION)) return STATUS.IN_PRODUCTION;
  if (statuses.some((s) => s === STATUS.QUOTED)) return "Awaiting Quote";
  if (statuses.some((s) => s === STATUS.PRICED)) return "Awaiting Payment";
  return statuses[0] || "Unknown";
}

module.exports = { deriveOrderStatus };
