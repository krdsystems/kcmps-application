/* ============================================================
   KCMPS backend — customer-facing order redaction
   ============================================================
   Staff-internal detail (workstation assignment, spoilage reason codes,
   staff-written correspondence notes, and the actor identity behind every
   timeline event) is stored on the same ORDER#<id> record a customer's own
   request reads — it must never reach a non-staff response. Shared here
   (pure, no I/O) so every Lambda that can return an order to a customer
   (backend/staff-api/get-orders.js today, backend/checkout/lookup-order.js)
   applies the exact same redaction instead of each reimplementing it and
   quietly drifting.
   ============================================================ */

function redactForCustomer(order) {
  delete order.correspondenceLog;
  order.lineItems = (order.lineItems || []).map((li) => {
    const { station, setupMinutes, spoilage, ...rest } = li;
    return rest;
  });
  order.events = (order.events || []).map((ev) => ({
    at: ev.at,
    from: ev.from,
    to: ev.to,
    // rejectionReason is the one meta field a customer needs (it's the
    // same text already surfaced on payment.rejectionReason) — everything
    // else in `meta` (via, station) and the actor fields are internal.
    meta: ev.meta && ev.meta.rejectionReason ? { rejectionReason: ev.meta.rejectionReason } : {},
  }));
  return order;
}

// The checkout contact field is free text (email OR phone OR Messenger
// handle — see create-order.js's header), so an exact case-sensitive match
// is too strict for phone numbers typed with different spacing/formatting.
// Compare case/whitespace-normalized first, then fall back to a digits-
// only comparison so "0917 123 4567" matches "(0917) 123-4567". Shared by
// every guest-facing endpoint that authenticates a caller against an
// order's customerContact instead of a Cognito session (lookup-order.js,
// cancel-order.js) — see either file's header for why orderId alone isn't
// a meaningful secret and this comparison is the real trust boundary.
function contactsMatch(supplied, stored) {
  if (!stored) return false;
  const normalize = (s) => String(s).trim().toLowerCase();
  if (normalize(supplied) === normalize(stored)) return true;
  const digitsOnly = (s) => String(s).replace(/\D/g, "");
  const suppliedDigits = digitsOnly(supplied);
  const storedDigits = digitsOnly(stored);
  return suppliedDigits.length >= 7 && suppliedDigits === storedDigits;
}

module.exports = { redactForCustomer, contactsMatch };
