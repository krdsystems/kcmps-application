/* ============================================================
   KCMPS job costing — POST /orders/{orderId}/costs
   ============================================================
   One cost line against a job. Stored under the order's own partition
   (ORDER#<id> / COST#<ISO>#<costId>), co-located with its EVENT#/MSG#
   siblings, so ONE query on that partition returns revenue + costs +
   profit for the job (plan §4).

   AUTH: isStaff(). Recording what a job cost is production work. The
   Admin gate is on reading the resulting profit/margin (get-job-
   costing.js), per the owner's O1 decision.

   ------------------------------------------------------------
   affectsCash: false WRITES NO TRANSACTION (review finding B8)
   ------------------------------------------------------------
   Plan Trap 2: not every cost is a cash movement.

     affectsCash: true  -> job profit AND the daily cash book. Writes the
                           COST# line, a TXN# ledger row, the order->txn
                           pointer, and the day+month rollup ADDs.
     affectsCash: false -> job profit ONLY. Writes the COST# line and
                           nothing else. No TXN# item, no pointer, no
                           counter bump — the cash for that material left
                           the business when the stock was bought, and
                           booking it again here would double-count the
                           expense.

   The prototype wrote a transaction unconditionally. That is the shape
   this Lambda deliberately does not copy, and the reason the flag is
   built now rather than retrofitted: once a salaried staffer is hired or
   materials start coming from owned stock, working out which historical
   lines were cash and which were allocation is information that is
   simply gone.

   Idempotency is the same item-level guard as log-transaction.js — see
   that file's header for why ClientRequestToken is not sufficient.
   ============================================================ */

const {
  orderPk, metaSk, costSk, txnDayPk, txnSk, idempotencyPk, eventSk,
  baseItem, extractClaims, isStaff,
} = require("../lib");
const {
  validateCostInput, rollupDelta, buildCashbookEvent, CashbookValidationError,
} = require("../lib/cashbook");
const {
  TABLE, dynamo, loadCategories, rollupUpdates,
  conditionFailedAt, isTransactionCancelled, response,
} = require("./shared");
const { GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Staff only" });

  const orderId = event.pathParameters && event.pathParameters.orderId;
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { return response(400, { error: "Invalid JSON body" }); }

  const categories = await loadCategories();
  let cost;
  try {
    cost = validateCostInput({ ...body, orderId }, { categories });
  } catch (err) {
    if (err instanceof CashbookValidationError) return response(400, { error: err.message });
    throw err;
  }

  // The order must exist. A cost line against a typo'd order id would be
  // invisible forever — it lives in that partition and nothing else
  // would ever read it.
  const order = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { PK: orderPk(orderId), SK: metaSk() } }));
  if (!order.Item) return response(404, { error: "Order not found" });

  const now = new Date().toISOString();
  const actorName = claims.name || claims.email || null;
  const cSk = costSk(cost.incurredAt, cost.costId);

  const costItem = {
    ...baseItem({ status: "Posted", createdAt: now }),
    PK: orderPk(orderId),
    SK: cSk,
    itemType: "COST",
    costId: cost.costId,
    orderId,
    label: cost.label,
    categoryId: cost.categoryId,
    categoryLabel: cost.categoryLabel,
    // qty + unit cost, not a bare total — this is what yields the
    // per-unit economics in plan §5. amountCentavos is stored too, but
    // re-derived server-side, never taken from the client.
    qty: cost.qty,
    unitCostCentavos: cost.unitCostCentavos,
    amountCentavos: cost.amountCentavos,
    affectsCash: cost.affectsCash,
    paymentMethod: cost.paymentMethod,
    incurredAt: cost.incurredAt,
    note: cost.note || null,
    source: "manual",
    voided: false,
    actorSub: claims.sub || null,
    actorName,
  };

  const guardItem = {
    ...baseItem({ status: "Consumed", createdAt: now }),
    PK: idempotencyPk(cost.costId),
    SK: metaSk(),
    itemType: "IDEMPOTENCY",
    scopeName: cost.affectsCash ? "cashbook-transaction" : "cashbook-cost",
    orderId,
    costPk: orderPk(orderId),
    costSk: cSk,
    costId: cost.costId,
  };

  const transactItems = [
    // [0] idempotency guard — must stay index 0 (replay branch below)
    { Put: { TableName: TABLE, Item: guardItem, ConditionExpression: "attribute_not_exists(PK)" } },
    // [1] the cost line — written in BOTH branches
    { Put: { TableName: TABLE, Item: costItem, ConditionExpression: "attribute_not_exists(PK)" } },
  ];

  let txnItem = null;
  if (cost.affectsCash) {
    const tPk = txnDayPk(cost.day);
    const tSk = txnSk(cost.incurredAt, cost.costId);
    txnItem = {
      ...baseItem({ status: "Posted", createdAt: now }),
      PK: tPk,
      SK: tSk,
      itemType: "TXN",
      txnId: cost.costId,
      day: cost.day,
      month: cost.month,
      occurredAt: cost.incurredAt,
      categoryId: cost.categoryId,
      categoryLabel: cost.categoryLabel,
      kind: "expense",
      direction: "out",
      amountCentavos: cost.amountCentavos,
      paymentMethod: cost.paymentMethod,
      note: cost.label,
      orderId,
      // Lets void-transaction.js flag the COST# line in the same
      // transaction that reverses this row (B2(d)).
      costRef: { orderId, costSk: cSk },
      source: "manual",
      voided: false,
      actorSub: claims.sub || null,
      actorName,
    };
    guardItem.txnPk = tPk;
    guardItem.txnSk = tSk;
    guardItem.txnId = cost.costId;
    guardItem.day = cost.day;
    guardItem.month = cost.month;
    guardItem.orderPointerSk = tSk;

    transactItems.push(
      { Put: { TableName: TABLE, Item: txnItem, ConditionExpression: "attribute_not_exists(PK)" } },
      { Put: { TableName: TABLE, Item: { ...txnItem, PK: orderPk(orderId), SK: tSk, itemType: "TXN_POINTER", txnPk: tPk, txnSk: tSk }, ConditionExpression: "attribute_not_exists(PK)" } },
      ...rollupUpdates({ day: cost.day, month: cost.month, delta: rollupDelta(txnItem), now }),
    );
  }

  transactItems.push({
    Put: {
      TableName: TABLE,
      Item: buildCashbookEvent({
        pk: orderPk(orderId), sk: eventSk(now, `cost.${cost.costId}`),
        from: null, to: "Cost line added", actorSub: claims.sub, actorName, at: now,
        meta: {
          via: "manual", costId: cost.costId, categoryId: cost.categoryId,
          amountCentavos: cost.amountCentavos, affectsCash: cost.affectsCash,
          // Explicit in the audit trail so "why is there no transaction
          // for this cost" is answerable years later.
          wroteTransaction: !!txnItem,
        },
      }),
    },
  });

  try {
    await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (isTransactionCancelled(err) && conditionFailedAt(err, 0)) {
      const existing = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { PK: orderPk(orderId), SK: cSk } }));
      return response(200, { cost: existing.Item || null, idempotentReplay: true });
    }
    throw err;
  }

  return response(201, {
    cost: costItem,
    // B8, made explicit in the response so a caller (and a future
    // reviewer) can see which branch ran without inspecting the table.
    transaction: txnItem,
    wroteTransaction: !!txnItem,
  });
};
