/* ============================================================
   KCMPS Cash Book — GET /cashbook/transactions/{txnId}
   ============================================================
   Looks up ONE transaction by its id, from any day, and tells the caller
   which day it lives on so the UI can jump straight there.

   AUTH: isStaff() — same as get-day.js. Finding a transaction you were
   already allowed to see on its own day is not a new capability.

   ------------------------------------------------------------
   Why this is a GetItem and not a search
   ------------------------------------------------------------
   The obvious implementation of "find a transaction by id" is a Scan
   with a filter, which reads the whole table and gets slower and more
   expensive every month the business operates — the exact shape of query
   this table's design exists to avoid.

   It isn't needed. log-transaction.js already writes an
   IDEMPOTENCY#<txnId> guard record whose whole job is to make a replay
   collide with itself, and it stores the row's exact keys (txnPk/txnSk)
   plus its day/month. So the id IS an index: two GetItems, no Scan, cost
   flat forever regardless of how many transactions exist.

   That also means this endpoint can only find transactions written
   through log-transaction.js or log-cost.js — which is all of them. If a
   future writer skips the guard record, it will be invisible here, and
   the fix is to write the guard, not to add a Scan.

   Broader free-text search (note/category/client) stays CLIENT-side over
   the day already loaded — see cashbook.html. Making that server-side is
   a real feature needing a real index, not a filtered Scan bolted on
   here.
   ============================================================ */

const { idempotencyPk, metaSk, extractClaims, isStaff } = require("../lib");
const { TABLE, dynamo, response } = require("./shared");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims || !claims.sub) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Staff only" });

  const raw = event.pathParameters?.txnId;
  if (!raw) return response(400, { error: "txnId is required" });
  // Ids are case-sensitive as written; trim only. A user pasting one out
  // of the UI may bring whitespace with it.
  const txnId = String(raw).trim();
  if (!txnId) return response(400, { error: "txnId is required" });

  const guard = await dynamo.send(new GetCommand({
    TableName: TABLE, Key: { PK: idempotencyPk(txnId), SK: metaSk() },
  }));
  if (!guard.Item || !guard.Item.txnPk) {
    return response(404, { error: "No transaction with that ID." });
  }

  const res = await dynamo.send(new GetCommand({
    TableName: TABLE, Key: { PK: guard.Item.txnPk, SK: guard.Item.txnSk },
  }));
  if (!res.Item) {
    // Guard exists but the row doesn't — only reachable if a cost line
    // was written with affectsCash:false (no ledger row at all). Say so
    // precisely rather than "not found", which would send someone
    // hunting for data loss that hasn't happened.
    return response(404, {
      error: "That ID belongs to a job cost that never moved cash, so it has no cash book entry.",
      orderId: guard.Item.orderId || null,
    });
  }

  return response(200, {
    transaction: res.Item,
    day: guard.Item.day || res.Item.day || null,
    month: guard.Item.month || res.Item.month || null,
  });
};
