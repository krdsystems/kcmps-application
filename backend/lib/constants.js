/* ============================================================
   KCMPS backend — shared constants
   ============================================================
   Source of truth: project_knowledge/Payment_System_Project_Knowledge.md
   and ops-dashboard/infra/backend-infra-to-deploy.md §2.1/§2.6.

   SITE_ID / SCHEMA_VERSION are the launch-blocking data conventions from
   ERP_System_Project_Knowledge.md §2.3 — one value today, but present on
   every item from day one so multi-site and schema evolution are a filter
   later, not a re-key.
   ============================================================ */

const SITE_ID = "SITE#MNL";
const CURRENCY = "PHP";
const SCHEMA_VERSION = 1;

// Canonical status vocabulary — every line item's `status` field, and the
// only strings STATUS# GSI1 keys and the state machine may use.
const STATUS = Object.freeze({
  // A sku line item's real starting status at checkout — before the
  // customer has submitted any GCash proof. Only submitPaymentProof.js
  // (backend/checkout) advances it to PENDING_PAYMENT_VERIFICATION, once
  // proof actually exists. See that Lambda's header.
  ORDER_PLACED: "Order Placed",
  QUOTED: "Quoted",
  PRICED: "Priced",
  PENDING_PAYMENT_VERIFICATION: "Pending Payment Verification",
  CONFIRMED: "Confirmed",
  PAYMENT_REJECTED: "Payment Rejected",
  SCHEDULED: "Scheduled",
  IN_PRODUCTION: "In Production",
  QC: "QC",
  REWORK: "Rework",
  READY_FOR_DISPATCH: "Ready for Dispatch",
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  READY_FOR_PICKUP: "Ready for Pickup",
  PICKED_UP: "Picked Up",
  CANCELLED: "Cancelled",
  AUTO_CANCELLED: "Auto-Cancelled",
  QUOTE_EXPIRED: "Quote Expired",
});

// Terminal statuses — a line item never leaves one of these once entered.
// PICKED_UP is pickup fulfillment's equivalent to DELIVERED (§6 customer
// progress bar) — deriveOrderStatus() treats the two as interchangeable for
// rollup purposes (backend/lib/order-status.js).
const TERMINAL_STATUSES = new Set([
  STATUS.DELIVERED,
  STATUS.PICKED_UP,
  STATUS.CANCELLED,
  STATUS.AUTO_CANCELLED,
  STATUS.QUOTE_EXPIRED,
]);

// Every other status keeps the line item "active" — i.e. it should carry
// GSI1PK/GSI1SK so it shows up in a staff action queue (backend-infra-to-
// deploy.md §2.3/§2.6, "sparse index hygiene"). Derived from
// TERMINAL_STATUSES rather than hand-duplicated so the two sets can never
// drift apart.
const ACTIVE_STATUSES = new Set(
  Object.values(STATUS).filter((s) => !TERMINAL_STATUSES.has(s))
);

module.exports = {
  SITE_ID,
  CURRENCY,
  SCHEMA_VERSION,
  STATUS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
};
