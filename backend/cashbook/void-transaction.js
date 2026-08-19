/* ============================================================
   KCMPS Cash Book — POST /cashbook/transactions/{txnId}/void
   ============================================================
   D2 in the plan makes this ledger append-only: there is no edit and no
   delete. A correction is a VOID, which flags the original and writes a
   REVERSING row. The original's amount is never altered and the row is
   never removed — a money record that can be silently edited is
   worthless as a record.

   AUTH: requireRole(Admin). Owner decision on plan O1 (2026-08-18): any
   staffer logs, only an Admin voids or sees month totals / margin. All
   four founders are Admin today, so this gates nobody now — it is wired
   because gating later means auditing every historical action to work
   out who should have been allowed to do what.

   ------------------------------------------------------------
   ONE TRANSACTION, SINGLE-SHOT (review finding B2)
   ------------------------------------------------------------
   Everything below happens in ONE TransactWriteItems, so a void either
   fully lands or does not happen at all:

     - Update the original, guarded by
       (attribute_not_exists(voided) OR voided = false) — the double-void
       guard. A second void request fails this condition and the entire
       transaction is cancelled, so the reversal is never written twice
       and the counters never over-correct.
     - Put the reversal row, keyed on a DERIVED id (reversalIdFor) and
       condition-protected by its own attribute_not_exists(PK) — belt and
       braces on the guard above.
     - ADD the negation to the day AND month rollups, in the same
       transaction, so totals return to EXACTLY their pre-transaction
       values.
     - Flag the linked ORDER#/COST# line and the ORDER#/TXN# pointer.

   Voiding a reversal is refused outright: reversing a reversal is how a
   ledger turns into a knot nobody can unwind. Re-post instead.

   ------------------------------------------------------------
   CROSS-DAY VOIDS (review finding B3) — the convention
   ------------------------------------------------------------
   The reversal row is stored in the ORIGINAL day's partition, not
   today's. It carries its own `occurredAt` (the moment of the void) and
   a `reversalDay` field recording the real calendar day it was made, so
   nothing about when it happened is lost.

   Why: the day view's invariant is that a day's METRIC#DAY rollup equals
   the sum of that day's TXN# rows. Filing the reversal under today would
   break yesterday's day view permanently — its rollup would be corrected
   while its rows were not — and no later write could repair it without a
   cross-partition job. Keeping the pair together makes every day
   self-reconciling, forever.
   ============================================================ */

const {
  orderPk, txnDayPk, txnSk, idempotencyPk, metaSk, eventSk,
  baseItem, extractClaims, requireRole, ROLES,
} = require("../lib");
const {
  rollupDelta, negateDelta, reversalIdFor, isReversal, validateVoidReason,
  manilaDayKey, buildCashbookEvent, CashbookValidationError,
} = require("../lib/cashbook");
const {
  TABLE, dynamo, conditionFailedAt, isTransactionCancelled, response,
} = require("./shared");
const { GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  const denied = requireRole(claims, [ROLES.ADMIN]);
  if (denied) return response(403, { error: "Voiding a transaction is Admin-only", requiredRoles: denied.requiredRoles });

  const txnId = event.pathParameters && event.pathParameters.txnId;
  if (!txnId) return response(400, { error: "txnId path parameter is required" });

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return response(400, { error: "Invalid JSON body" }); }

  let reason;
  try { reason = validateVoidReason(body.reason); }
  catch (err) {
    if (err instanceof CashbookValidationError) return response(400, { error: err.message });
    throw err;
  }

  // The idempotency guard record written at log time doubles as the
  // pointer from a bare txnId to its exact {PK, SK} — which is why a
  // void needs no day parameter and cannot be aimed at the wrong
  // partition by a caller guessing a date.
  const guard = await dynamo.send(new GetCommand({
    TableName: TABLE, Key: { PK: idempotencyPk(txnId), SK: metaSk() },
  }));
  if (!guard.Item || guard.Item.scopeName !== "cashbook-transaction") {
    return response(404, { error: "Transaction not found" });
  }

  const original = (await dynamo.send(new GetCommand({
    TableName: TABLE, Key: { PK: guard.Item.txnPk, SK: guard.Item.txnSk },
  }))).Item;
  if (!original) return response(404, { error: "Transaction not found" });

  if (isReversal(original)) {
    return response(409, { error: "This row is itself a reversal and cannot be voided. Log a new transaction instead." });
  }
  if (original.voided) {
    return response(409, { error: "This transaction is already voided", reversalTxnId: original.reversalTxnId || null });
  }

  const now = new Date().toISOString();
  const actorName = claims.name || claims.email || null;
  const day = original.day;
  const month = original.month;
  const reversalId = reversalIdFor(original.txnId);
  const reversalSk = txnSk(now, reversalId);
  const delta = negateDelta(rollupDelta(original));

  const reversalRow = {
    ...baseItem({ status: "Posted", createdAt: now }),
    // B3: the ORIGINAL day's partition, deliberately.
    PK: txnDayPk(day),
    SK: reversalSk,
    itemType: "TXN",
    txnId: reversalId,
    day,
    month,
    // Its own occurredAt — the real moment of the void, not the
    // original's timestamp. Nothing about when it happened is lost.
    occurredAt: now,
    // The calendar day the void was actually made, which may differ from
    // `day` above. This is the field that makes a cross-day void
    // auditable despite living in the earlier partition.
    reversalDay: manilaDayKey(now),
    reversesTxnId: original.txnId,
    categoryId: original.categoryId,
    categoryLabel: original.categoryLabel,
    kind: original.kind,
    // A reversal flips the direction and keeps the magnitude+sign, so
    // rollupDelta() on it is the exact negation of the original.
    direction: original.direction === "in" ? "out" : "in",
    amountCentavos: original.amountCentavos,
    paymentMethod: original.paymentMethod,
    note: `Reversal of ${original.txnId}: ${reason}`,
    orderId: original.orderId || null,
    source: "system",
    voided: false,
    actorSub: claims.sub || null,
    actorName,
  };

  const transactItems = [
    // [0] the double-void guard
    {
      Update: {
        TableName: TABLE,
        Key: { PK: guard.Item.txnPk, SK: guard.Item.txnSk },
        UpdateExpression:
          "SET voided = :true, voidReason = :reason, voidedAt = :now, voidedBySub = :sub, " +
          "voidedByName = :name, reversalTxnId = :rev, updatedAt = :now",
        ConditionExpression:
          "attribute_exists(PK) AND (attribute_not_exists(voided) OR voided = :false) " +
          "AND attribute_not_exists(reversesTxnId)",
        ExpressionAttributeValues: {
          ":true": true, ":false": false, ":reason": reason, ":now": now,
          ":sub": claims.sub || null, ":name": actorName, ":rev": reversalId,
        },
      },
    },
    // [1] the reversal row, protected by its own deterministic key
    { Put: { TableName: TABLE, Item: reversalRow, ConditionExpression: "attribute_not_exists(PK)" } },
    // [2] guard record for the reversal, so it is addressable and
    //     itself replay-safe
    {
      Put: {
        TableName: TABLE,
        Item: {
          ...baseItem({ status: "Consumed", createdAt: now }),
          PK: idempotencyPk(reversalId), SK: metaSk(),
          itemType: "IDEMPOTENCY", scopeName: "cashbook-transaction",
          txnPk: txnDayPk(day), txnSk: reversalSk, txnId: reversalId, day, month,
          reversesTxnId: original.txnId,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    // [3],[4] negate the day + month counters in the same transaction
    ...rollupUpdatesFor({ day, month, delta, now }),
    // [5] audit
    {
      Put: {
        TableName: TABLE,
        Item: buildCashbookEvent({
          pk: txnDayPk(day), sk: eventSk(now, `void.${original.txnId}`),
          from: "Posted", to: "Voided", actorSub: claims.sub, actorName, at: now,
          meta: {
            via: "void", reason, txnId: original.txnId, reversalTxnId: reversalId,
            amountCentavos: original.amountCentavos,
            crossDay: manilaDayKey(now) !== day,
          },
        }),
      },
    },
  ];

  // Flag the order-side pointer so job costing stops counting it.
  if (original.orderId && guard.Item.orderPointerSk) {
    transactItems.push({
      Update: {
        TableName: TABLE,
        Key: { PK: orderPk(original.orderId), SK: guard.Item.orderPointerSk },
        UpdateExpression: "SET voided = :true, voidReason = :reason, updatedAt = :now",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":true": true, ":reason": reason, ":now": now },
      },
    });
  }

  // ...and the COST# line this transaction paid for, if any (B2(d)).
  if (original.costRef && original.costRef.orderId && original.costRef.costSk) {
    transactItems.push({
      Update: {
        TableName: TABLE,
        Key: { PK: orderPk(original.costRef.orderId), SK: original.costRef.costSk },
        UpdateExpression: "SET voided = :true, voidReason = :reason, updatedAt = :now",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":true": true, ":reason": reason, ":now": now },
      },
    });
  }

  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (isTransactionCancelled(err) && (conditionFailedAt(err, 0) || conditionFailedAt(err, 1) || conditionFailedAt(err, 2))) {
      // Lost the race with a concurrent void of the same row. Nothing
      // was applied — the counters are untouched.
      return response(409, { error: "This transaction is already voided" });
    }
    throw err;
  }

  return response(200, {
    voided: true,
    txnId: original.txnId,
    reversalTxnId: reversalId,
    // B3, made visible in the API: the reversal lives in the original's
    // partition so that day stays self-reconciling.
    partitionDay: day,
    reversalDay: manilaDayKey(now),
    reason,
  });
};

// Local re-export so this file reads top-to-bottom; identical to
// shared.js's rollupUpdates.
function rollupUpdatesFor(args) {
  return require("./shared").rollupUpdates(args);
}
