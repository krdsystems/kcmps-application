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
  // Order tags (set-order-tags.js) are a staff-only filtering/reporting
  // aid, same "internal, not customer-facing" stance as correspondenceLog
  // — a customer has no reason to see "Type=Reprint" or "Test" on their
  // own order.
  delete order.tags;
  order.lineItems = (order.lineItems || []).map((li) => {
    const { station, setupMinutes, spoilage, ...rest } = li;
    return rest;
  });
  order.events = (order.events || [])
    // set-order-tags.js writes its audit EVENT# with the synthetic
    // lineItemId "ORDER" (it isn't scoped to any one line item) and
    // `meta.via === "setTags"` — drop these entirely rather than let a
    // redacted-but-present "Tags updated" row leak that staff have been
    // tagging the order, which isn't information a customer needs.
    .filter((ev) => !(ev.meta && ev.meta.via === "setTags"))
    .map((ev) => ({
      at: ev.at,
      from: ev.from,
      to: ev.to,
      // holdReason is the one meta field a customer needs (it's the same
      // text already surfaced on payment.holdReason) — everything else in
      // `meta` (via, station) and the actor fields are internal. The legacy
      // `rejectionReason` key is still read so events written before the
      // Payment Rejected -> On Hold rename keep rendering their reason.
      meta: ev.meta && (ev.meta.holdReason || ev.meta.rejectionReason)
        ? { holdReason: ev.meta.holdReason || ev.meta.rejectionReason }
        : {},
    }));
  return order;
}

// Checkout collects up to four separate, individually-optional contact
// fields (email/phone/messenger/otherContact — create-order.js) rather than
// one freeform string, so a guest proving their identity here might type
// back any ONE of them. Compare case/whitespace-normalized first, then fall
// back to a digits-only comparison so "0917 123 4567" matches
// "(0917) 123-4567". Shared by every guest-facing endpoint that
// authenticates a caller against an order instead of a Cognito session
// (lookup-order.js, cancel-order.js) — see either file's header for why
// orderId alone isn't a meaningful secret and this comparison is the real
// trust boundary. `order.customerContact` is kept in the candidate list for
// backward compatibility with any order written before the four-field split.
function contactsMatch(supplied, order) {
  if (!order) return false;
  const candidates = [order.email, order.phone, order.messenger, order.otherContact, order.customerContact].filter(Boolean);
  if (!candidates.length) return false;
  const normalize = (s) => String(s).trim().toLowerCase();
  const suppliedNorm = normalize(supplied);
  const digitsOnly = (s) => String(s).replace(/\D/g, "");
  const suppliedDigits = digitsOnly(supplied);
  return candidates.some((stored) => {
    if (normalize(stored) === suppliedNorm) return true;
    const storedDigits = digitsOnly(stored);
    return suppliedDigits.length >= 7 && suppliedDigits === storedDigits;
  });
}

module.exports = { redactForCustomer, contactsMatch };
