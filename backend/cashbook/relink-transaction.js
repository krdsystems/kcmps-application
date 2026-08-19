/* ============================================================
   KCMPS Cash Book — PATCH /cashbook/transactions/{txnId}/link
   ============================================================
   Re-points an already-logged transaction at a different order (or at no
   order at all). Added 2026-08-20 on owner request: staff log money fast
   on a phone the moment it moves, and often don't know the order id yet —
   without this, the only way to attribute it afterwards was to void the
   entry and retype it, which is friction that ends in nothing being
   linked at all.

   AUTH: isStaff(), same as log-transaction.js and for the same reason —
   this is the correction step of an entry any staffer was allowed to
   make. Void stays Admin-gated (that one destroys money); this one moves
   a label.

   ------------------------------------------------------------
   THIS IS NOT AN "EDIT TRANSACTION" ENDPOINT — read before extending
   ------------------------------------------------------------
   The cash book is APPEND-ONLY (plan D2): there is no edit and no delete,
   and a void writes a REVERSING entry rather than mutating the original.
   That rule exists so a day's rollup can always be reconciled against
   the rows in its own partition.

   This endpoint does not break that rule, and only because of exactly
   what it refuses to touch: amount, direction, kind, category, payment
   method, occurredAt and day are all immutable here. Every one of those
   feeds rollupDelta() — changing any of them would require negating the
   old rollup and applying a new one, which is precisely the reversing
   entry a void already does properly.

   `orderId` is the one field that feeds NO rollup. It is attribution
   metadata: it decides which job's costing the row appears under, and
   nothing else. That is why it can be corrected in place.

   So: if a future request is "let staff fix the amount too", the answer
   is a void + re-log, NOT a new field in ALLOWED below. Adding a
   money field here would silently desync every METRIC#DAY/MONTH counter.

   ------------------------------------------------------------
   The pointer row is the actual work
   ------------------------------------------------------------
   A linked transaction is stored twice: the ledger row under
   TXN#<day>, and a TXN_POINTER copy under ORDER#<orderId> so the job
   view resolves costs in ONE query with no scan (plan §4). Re-linking
   therefore has to delete the old pointer and write the new one in the
   SAME transaction as the ledger update, or a crash between them leaves
   a job showing a transaction that no longer belongs to it.
   ============================================================ */

const {
  orderPk, txnDayPk, txnSk, idempotencyPk, metaSk, eventSk,
  extractClaims, isStaff,
} = require("../lib");
const { buildCashbookEvent } = require("../lib/cashbook");
const { TABLE, dynamo, response, isTransactionCancelled } = require("./shared");
const { GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");

// Mirrors create-order.js's id shape. Kept local rather than imported so
// this file states the contract it enforces.
const ORDER_ID_RE = /^ORD-[A-Z0-9]{4,16}$/;

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims || !claims.sub) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Staff only" });

  const txnId = event.pathParameters?.txnId;
  if (!txnId) return response(400, { error: "txnId is required" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  // null / "" both mean "unlink" — a legitimate correction when a row was
  // attached to the wrong job and belongs to none.
  let nextOrderId = body.orderId == null ? null : String(body.orderId).trim().toUpperCase();
  if (nextOrderId === "") nextOrderId = null;
  if (nextOrderId && !ORDER_ID_RE.test(nextOrderId)) {
    return response(400, { error: `"${body.orderId}" doesn't look like an order id.` });
  }

  /* The IDEMPOTENCY#<txnId> guard record written by log-transaction.js
     carries this row's exact keys (txnPk/txnSk) plus its current
     orderId/orderPointerSk — so one GetItem resolves everything needed to
     find both the ledger row and the pointer it may already have. That is
     why it stores them: see log-transaction.js's header. */
  const guard = await dynamo.send(new GetCommand({
    TableName: TABLE, Key: { PK: idempotencyPk(txnId), SK: metaSk() },
  }));
  if (!guard.Item) return response(404, { error: "Transaction not found" });

  const { txnPk, txnSk: rowSk, day, month } = guard.Item;
  const priorOrderId = guard.Item.orderId || null;

  const rowRes = await dynamo.send(new GetCommand({
    TableName: TABLE, Key: { PK: txnPk, SK: rowSk },
  }));
  const row = rowRes.Item;
  if (!row) return response(404, { error: "Transaction not found" });

  // A void already wrote a reversing entry against this row's original
  // attribution. Re-pointing it now would move the original without
  // moving its reversal, leaving both jobs wrong.
  if (row.voided) return response(409, { error: "This transaction was voided — log a new one instead." });
  if (row.reversesTxnId) return response(409, { error: "A reversing entry can't be re-linked." });
  // System-posted rows are derived from payment verification and are
  // read-only in the UI; their order link is the thing that created them.
  if (row.source === "system") return response(409, { error: "System-posted transactions can't be re-linked." });

  if ((priorOrderId || null) === nextOrderId) {
    return response(200, { transaction: row, unchanged: true });
  }

  const now = new Date().toISOString();
  const actorName = claims.name || claims.email || null;
  // The pointer's SK is derived from the row's OWN occurredAt/txnId, never
  // from `now` — it must match what log-transaction.js wrote, or the
  // delete below silently no-ops and the stale pointer survives.
  const pointerSk = txnSk(row.occurredAt, row.txnId);

  const transactItems = [
    {
      Update: {
        TableName: TABLE,
        Key: { PK: txnPk, SK: rowSk },
        UpdateExpression: "SET orderId = :o, updatedAt = :now",
        // Re-assert the row is still un-voided at write time: the check
        // above is a read, and an Admin could void it in between.
        ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(voided) OR voided = :false)",
        ExpressionAttributeValues: { ":o": nextOrderId, ":now": now, ":false": false },
      },
    },
    {
      // Keep the guard record's copy honest — it is what THIS endpoint
      // reads to find the current pointer, so a stale value here would
      // orphan the next re-link's delete.
      Update: {
        TableName: TABLE,
        Key: { PK: idempotencyPk(txnId), SK: metaSk() },
        UpdateExpression: "SET orderId = :o, orderPointerSk = :ps, updatedAt = :now",
        ExpressionAttributeValues: {
          ":o": nextOrderId, ":ps": nextOrderId ? pointerSk : null, ":now": now,
        },
      },
    },
    {
      Put: {
        TableName: TABLE,
        Item: buildCashbookEvent({
          pk: txnPk, sk: eventSk(now, txnId),
          from: priorOrderId || "(unlinked)", to: nextOrderId || "(unlinked)",
          actorSub: claims.sub, actorName, at: now,
          meta: { via: "relink", txnId, amountCentavos: row.amountCentavos },
        }),
      },
    },
  ];

  if (priorOrderId) {
    /* SOFT-delete the stale pointer, never a hard Delete.

       Two independent reasons, and both matter:
       (1) `baseItem()` makes soft-delete a repo-wide invariant — nothing
           in the order partition is ever physically removed, so the audit
           story of a job stays complete.
       (2) The staff-api Lambda role has NO dynamodb:DeleteItem, on
           purpose. A hard delete here fails at runtime with
           AccessDeniedException (confirmed on staging 2026-08-20), and
           the fix is NOT to widen that role — DeleteItem would then be
           granted to every staff-api Lambda sharing it.

       Readers skip `deleted` pointers (get-job-costing.js's txnRows
       filter and lib/cashbook.js's jobCosting()), so the row stops
       counting toward the old job's revenue immediately. */
    transactItems.push({
      Update: {
        TableName: TABLE,
        Key: { PK: orderPk(priorOrderId), SK: pointerSk },
        UpdateExpression: "SET deleted = :true, updatedAt = :now, unlinkedFrom = :prior",
        ExpressionAttributeValues: { ":true": true, ":now": now, ":prior": priorOrderId },
      },
    });
  }
  if (nextOrderId) {
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: {
          ...row, orderId: nextOrderId, updatedAt: now,
          PK: orderPk(nextOrderId), SK: pointerSk,
          itemType: "TXN_POINTER", txnPk, txnSk: rowSk,
        },
      },
    });
  }

  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (isTransactionCancelled(err)) {
      return response(409, { error: "That transaction changed while you were editing — reload and try again." });
    }
    throw err;
  }

  return response(200, { transaction: { ...row, orderId: nextOrderId, updatedAt: now }, day, month });
};
