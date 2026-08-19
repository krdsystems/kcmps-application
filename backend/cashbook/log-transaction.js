/* ============================================================
   KCMPS Cash Book — POST /cashbook/transactions
   ============================================================
   Logs one cash movement. This is the manual-entry writer in the plan's
   "one ledger, two writers" table (§2, Trap 1); the other writer is
   verify-payment.js's future auto-post, which MUST come through this
   same idempotent shape (see the AUTO-POST SEAM note at the bottom).

   AUTH: isStaff(). Any staffer may log money moving — that is the whole
   point of a cash book, and gating it would just mean transactions go
   unrecorded. Void and the month/margin reads are Admin-gated instead
   (owner decision on plan O1, 2026-08-18).

   ------------------------------------------------------------
   IDEMPOTENCY (review finding B1) — the part that is easy to get wrong
   ------------------------------------------------------------
   `TransactWriteItems` is NOT idempotent under SDK retry, and
   `ClientRequestToken` only dedupes byte-identical requests inside a
   10-minute window. Neither is enough: a double-tap on a phone is a
   *new* request, and the rollup ADDs would bump twice with nothing
   erroring — leaving a total that no later void can reconcile, because
   nobody knows there were ever two.

   So the write is guarded at the ITEM level, inside the same transaction
   as the counters:

     1. an IDEMPOTENCY#<clientId> record, Put with attribute_not_exists(PK)
     2. the TXN row itself, keyed on that same client id, also Put with
        attribute_not_exists(PK)
     3. the METRIC#DAY / METRIC#MONTH ADDs

   A replay fails (1) — and because a cancelled transaction applies
   NOTHING, the ADDs in (3) are discarded with it. The counters therefore
   cannot double-bump even in principle.

   The guard record in (1) is not redundant with (2): the TXN row's sort
   key contains its ISO timestamp, and when the server supplies that
   timestamp a replay would compute a *different* SK and sail past a
   row-only condition. The guard record has no timestamp in its key, so
   it catches the replay regardless, and it stores the row's exact keys
   so this Lambda can return the ORIGINAL transaction on a replay instead
   of a bare error. A replay is a 200, not a 409 — it means "your write
   already landed", which is success from the caller's point of view.
   ============================================================ */

const {
  orderPk, txnDayPk, txnSk, idempotencyPk, metaSk, eventSk,
  baseItem, extractClaims, isStaff,
} = require("../lib");
const {
  validateTransactionInput, rollupDelta, buildCashbookEvent, CashbookValidationError,
} = require("../lib/cashbook");
const {
  TABLE, dynamo, loadCategories, rollupUpdates, queryAll,
  conditionFailedAt, isTransactionCancelled, response,
} = require("./shared");
const { GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Staff only" });

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return response(400, { error: "Invalid JSON body" }); }

  const categories = await loadCategories();
  let txn;
  try {
    txn = validateTransactionInput(body, { categories });
  } catch (err) {
    if (err instanceof CashbookValidationError) return response(400, { error: err.message });
    throw err;
  }

  const now = new Date().toISOString();
  const actorName = claims.name || claims.email || null;

  const pk = txnDayPk(txn.day);
  const sk = txnSk(txn.occurredAt, txn.txnId);
  const pointerSk = txn.orderId ? txnSk(txn.occurredAt, txn.txnId) : null;

  // Trap 1 / review finding B4: a manual entry against an order that the
  // system has ALREADY auto-posted for is the double-counting case this
  // whole feature was planned around. It is a WARNING, not a rejection —
  // a partial payment, a top-up, or a separate walk-in charge against
  // the same job are all legitimate second entries, and refusing them
  // would push staff back to not recording money at all. The response
  // carries `warning` so the UI can make staff confirm.
  let warning = null;
  if (txn.orderId) {
    const existing = await queryAll({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :txn)",
      ExpressionAttributeValues: { ":pk": orderPk(txn.orderId), ":txn": "TXN#" },
    });
    const systemPosted = existing.filter((i) => i.source === "system" && !i.voided);
    if (systemPosted.length) {
      warning = `This order already has ${systemPosted.length} system-posted transaction(s) from payment verification. Logging another may double-count it.`;
    }
  }

  const item = {
    ...baseItem({ status: "Posted", createdAt: now }),
    PK: pk,
    SK: sk,
    itemType: "TXN",
    txnId: txn.txnId,
    day: txn.day,
    month: txn.month,
    occurredAt: txn.occurredAt,
    categoryId: txn.categoryId,
    categoryLabel: txn.categoryLabel,
    subcategoryId: txn.subcategoryId,
    subcategoryLabel: txn.subcategoryLabel,
    kind: txn.kind,
    direction: txn.direction,
    amountCentavos: txn.amountCentavos,
    paymentMethod: txn.paymentMethod,
    note: txn.note || null,
    orderId: txn.orderId,
    // The plan's two-writers table. "manual" rows are voidable by an
    // Admin; "system" rows (auto-posted) are read-only in the UI.
    source: "manual",
    voided: false,
    actorSub: claims.sub || null,
    actorName,
  };

  const delta = rollupDelta(item);

  const transactItems = [
    // [0] the idempotency guard — see the header. Must stay index 0; the
    // replay branch below identifies itself by that index.
    {
      Put: {
        TableName: TABLE,
        Item: {
          ...baseItem({ status: "Consumed", createdAt: now }),
          PK: idempotencyPk(txn.txnId),
          SK: metaSk(),
          itemType: "IDEMPOTENCY",
          scopeName: "cashbook-transaction",
          txnPk: pk,
          txnSk: sk,
          txnId: txn.txnId,
          day: txn.day,
          month: txn.month,
          orderId: txn.orderId,
          orderPointerSk: pointerSk,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    // [1] the ledger row itself
    { Put: { TableName: TABLE, Item: item, ConditionExpression: "attribute_not_exists(PK)" } },
    // [2],[3] the day + month counters, atomically, in this same transaction
    ...rollupUpdates({ day: txn.day, month: txn.month, delta, now }),
    // [4] append-only audit, filed in the transaction's own day partition
    {
      Put: {
        TableName: TABLE,
        Item: buildCashbookEvent({
          pk, sk: eventSk(now, txn.txnId), from: null, to: "Transaction logged",
          actorSub: claims.sub, actorName, at: now,
          meta: { via: "manual", categoryId: txn.categoryId, amountCentavos: txn.amountCentavos, orderId: txn.orderId },
        }),
      },
    },
  ];

  // [5] order pointer, so the job view sees payments without a scan (plan §4)
  if (txn.orderId) {
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: { ...item, PK: orderPk(txn.orderId), SK: pointerSk, itemType: "TXN_POINTER", txnPk: pk, txnSk: sk },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
  }

  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (isTransactionCancelled(err) && conditionFailedAt(err, 0)) {
      // Idempotent replay. NOTHING was applied by this attempt — no row,
      // no counter bump. Return the transaction the original call wrote.
      const existing = await loadExistingTransaction(txn.txnId);
      return response(200, { transaction: existing, idempotentReplay: true, warning });
    }
    throw err;
  }

  return response(201, {
    transaction: item,
    // B5: true means the client's sign was wrong for this category and
    // the server corrected it. Surfaced rather than silently patched, so
    // a stale client is visible instead of invisible.
    normalized: txn.normalized,
    warning,
  });
};

async function loadExistingTransaction(txnId) {
  const guard = await dynamo.send(new GetCommand({
    TableName: TABLE, Key: { PK: idempotencyPk(txnId), SK: metaSk() },
  }));
  if (!guard.Item) return null;
  const row = await dynamo.send(new GetCommand({
    TableName: TABLE, Key: { PK: guard.Item.txnPk, SK: guard.Item.txnSk },
  }));
  return row.Item || null;
}

/* ------------------------------------------------------------
   AUTO-POST SEAM (Trap 1 / review finding B4) — NOT WIRED YET
   ------------------------------------------------------------
   Phase 2 in the plan wires backend/staff-api/verify-payment.js to post
   a "system" row here when staff confirm a GCash payment. Two things
   that seam must honour, both of which are already provided for above:

   1. It must reuse THIS idempotent path, with the id from
      ../lib/cashbook.js's autoPostIdempotencyId(orderId, paymentId) —
      never a fresh uuid. verify-payment.js sweeps every line item still
      Pending Payment Verification PLUS any already On Hold in one call,
      so a single invocation can legitimately post more than once; keying
      on orderId alone would collapse those into one, and keying on
      nothing would double-post on retry.
   2. Its rows carry source: "system", which is what makes the B4 warning
      above fire for a staffer about to hand-log the same money.

   Deliberately left unwired here: verify-payment.js is a live production
   payment path, and extending its transaction is a change that deserves
   its own scoped pass rather than riding along with the ledger build.
   ------------------------------------------------------------ */
