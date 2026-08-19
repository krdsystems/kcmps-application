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
   Moving the derived rows is the actual work — and there are TWO
   ------------------------------------------------------------
   A linked transaction is stored more than once. Besides the ledger row
   under TXN#<day> there is a TXN_POINTER copy under ORDER#<orderId>, so
   the job view resolves in ONE query with no scan (plan §4) — and, for
   an EXPENSE, a COST# line, which is the only thing that actually
   charges the job.

   That second one is the trap, and it shipped broken once: revenue is
   counted from TXN# rows but expense is counted from COST# lines, never
   from TXN# rows. Moving only the pointer attaches an expense that
   counts toward neither cost nor revenue, so it silently disappears from
   the job (owner-reported on production, ORD-290E09747F, 2026-08-20).

   Every move happens in the SAME TransactWriteItems as the ledger
   update, or a crash between them leaves a job showing money that is no
   longer its own. Removal is always a SOFT delete — see the note at the
   Update below for the two independent reasons.
   ============================================================ */

const {
  orderPk, txnDayPk, txnSk, costSk, idempotencyPk, metaSk, eventSk,
  baseItem, extractClaims, isStaff,
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

  const now = new Date().toISOString();
  const actorName = claims.name || claims.email || null;

  /* ---- expenses need their COST# line moved too, not just the pointer ----

     This is the part that is easy to miss, and it shipped broken once
     (owner-reported on production 2026-08-20, ORD-290E09747F: a relinked
     ₱1,690 DTF expense appeared nowhere on the job).

     Revenue and expense reach a job's numbers by DIFFERENT routes:
       - revenue  -> counted from the TXN# rows on the order partition
       - expense  -> counted from the COST# lines, NEVER from TXN# rows
     (see lib/cashbook.js's jobCosting(): costCentavos sums `costLines`,
     revenueCentavos sums `txnRows` filtered to kind === "revenue").

     An expense logged WITH an order goes through log-cost.js, which
     writes both items. An expense logged WITHOUT one only ever gets a
     ledger row — so moving just the pointer attaches something that
     counts toward neither cost nor revenue, i.e. it silently vanishes.

     The cost line's SK is derived from the row's own occurredAt/txnId,
     exactly as log-cost.js derives it (costId === the idempotency id ===
     txnId), so the keys line up whether or not one already exists. */
  const isExpense = row.direction === "out";
  const costLineSk = costSk(row.occurredAt, row.txnId);

  // Prefer MOVING an existing cost line over rebuilding one: a line
  // written by log-cost.js carries qty/unitCostCentavos, which the ledger
  // row does not, and losing them would silently destroy the per-unit
  // economics on a job that had them.
  let priorCost = null;
  if (isExpense && priorOrderId) {
    const got = await dynamo.send(new GetCommand({
      TableName: TABLE, Key: { PK: orderPk(priorOrderId), SK: costLineSk },
    }));
    if (got.Item && !got.Item.deleted) priorCost = got.Item;
  }
  // The pointer's SK is derived from the row's OWN occurredAt/txnId, never
  // from `now` — it must match what log-transaction.js wrote, or the
  // delete below silently no-ops and the stale pointer survives.
  const pointerSk = txnSk(row.occurredAt, row.txnId);

  /* Same order in, same order out — normally a no-op. NOT a no-op when
     an expense is missing its cost line: rows relinked before the
     cost-line bug was fixed (2026-08-20) have a TXN_POINTER and nothing
     else, so they show up nowhere on the job. Re-running the link on
     such a row repairs it in place, which means the fix needs no
     backfill script and no unlink/relink dance by staff. */
  const needsCostRepair = isExpense && nextOrderId && !priorCost;
  const isMove = (priorOrderId || null) !== nextOrderId;
  if (!isMove && !needsCostRepair) {
    return response(200, { transaction: row, unchanged: true });
  }

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

  if (priorOrderId && isMove) {
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

  // Retire the old job's cost line the same soft way as the pointer.
  if (isExpense && priorOrderId && isMove) {
    transactItems.push({
      Update: {
        TableName: TABLE,
        Key: { PK: orderPk(priorOrderId), SK: costLineSk },
        UpdateExpression: "SET deleted = :true, updatedAt = :now, unlinkedFrom = :prior",
        ExpressionAttributeValues: { ":true": true, ":now": now, ":prior": priorOrderId },
      },
    });
  }

  // ...and give the new job one, either the moved original or a fresh
  // line derived from the ledger row. Field-for-field the shape
  // log-cost.js writes, so job-detail.html and get-job-costing.js can't
  // tell the two origins apart.
  if (isExpense && nextOrderId) {
    const base = priorCost || {};
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: {
          ...baseItem({ status: "Posted", createdAt: base.createdAt || row.createdAt || now }),
          PK: orderPk(nextOrderId),
          SK: costLineSk,
          itemType: "COST",
          costId: row.txnId,
          orderId: nextOrderId,
          label: base.label || row.note || row.categoryLabel || "Cost",
          categoryId: base.categoryId || row.categoryId,
          categoryLabel: base.categoryLabel || row.categoryLabel,
          subcategoryId: base.subcategoryId || row.subcategoryId || null,
          subcategoryLabel: base.subcategoryLabel || row.subcategoryLabel || null,
          qty: base.qty != null ? base.qty : null,
          unitCostCentavos: base.unitCostCentavos != null ? base.unitCostCentavos : null,
          amountCentavos: row.amountCentavos,
          // It came off the ledger, so cash genuinely moved — an
          // allocation (affectsCash:false) never has a TXN row to relink.
          affectsCash: true,
          paymentMethod: row.paymentMethod || base.paymentMethod || null,
          paymentAccount: row.paymentAccount || base.paymentAccount || null,
          incurredAt: row.occurredAt,
          note: row.note || base.note || null,
          source: "manual",
          voided: false,
          actorSub: row.actorSub || null,
          actorName: row.actorName || null,
          relinkedBy: claims.sub || null,
          relinkedAt: now,
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
