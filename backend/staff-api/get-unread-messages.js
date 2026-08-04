/* ============================================================
   KCMPS staff/customer API — GET /messages/unread
   ============================================================
   Cross-order unread-message summary — the seam a future Messages
   inbox (staff tab, or the customer's own "Unread messages" section)
   reads from. Deliberately shaped as a list of per-order "threads" (not
   just a bare count) so that future UI renders this SAME response as
   full rows instead of a badge/banner; only the frontend changes, this
   Lambda doesn't. See docs/roadmap.md's "Customer chat via order
   threads" entry for why neither a real GSI2 nor a single-query
   cross-order view exists yet.

   Same staff-vs-customer branch as get-orders.js, but the query shape
   differs by role because a customer's own messages aren't safe to
   find via a whole-table Scan the way staff's are:
     - staff: bounded Scan for `senderRole = "customer" AND readAt =
       null` across every order — staff need to see unread replies FROM
       any customer, and there's no per-caller scope to narrow by.
     - customer: first finds the caller's own orders (customerSub
       match, same bounded-scan tradeoff get-orders.js's
       getOrdersForSub() already documents), then Queries `MSG#` items
       per owned order (bounded by their own order count, not a table
       Scan) for `senderRole = "staff" AND readAt = null` — a customer
       only ever sees unread replies on orders they actually own.
   Neither branch marks anything read (unlike get-messages.js) — this
   is a live summary read, not the thread view, so opening this
   shouldn't silently mark messages seen before the caller actually
   reads them.

   Response shape:
     { threads: [{ orderId, customerName, unreadCount, lastMessageAt,
                    lastMessageBody }], totalUnread }
   Sorted by lastMessageAt descending. `customerName` is only populated
   for staff callers (a customer already knows which of their own
   orders is which) — kept in the shape for both roles anyway so a
   future shared inbox UI doesn't need two response types.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, QueryCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { metaSk, extractClaims, isStaff } = require("../lib");

const TABLE = process.env.TABLE_NAME;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const threads = isStaff(claims) ? await staffThreads() : await customerThreads(claims.sub);
  threads.sort((a, b) => (b.lastMessageAt || "").localeCompare(a.lastMessageAt || ""));
  const totalUnread = threads.reduce((sum, t) => sum + t.unreadCount, 0);
  return response(200, { threads, totalUnread });
};

async function staffThreads() {
  const unread = await scanAll({
    FilterExpression: "begins_with(SK, :prefix) AND senderRole = :customer AND readAt = :null",
    ExpressionAttributeValues: { ":prefix": "MSG#", ":customer": "customer", ":null": null },
  });
  if (!unread.length) return [];

  const byOrder = groupByOrder(unread);
  return Promise.all(
    Array.from(byOrder.values()).map(async (entry) => {
      const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: entry.pk, SK: metaSk() } }));
      return { ...toThread(entry), customerName: orderRes.Item?.customerName || null };
    })
  );
}

async function customerThreads(sub) {
  // Same tradeoff as staff-api/get-orders.js's getOrdersForSub(): a
  // bounded scan filtered by customerSub is acceptable at KCMPS's
  // current order volume; a CLIENT#-keyed GSI2 would replace this once
  // the CRM view matures (see keys.js's clientGsi2Pk()).
  const owned = await scanAll({
    FilterExpression: "begins_with(PK, :prefix) AND SK = :meta AND customerSub = :sub",
    ExpressionAttributeValues: { ":prefix": "ORDER#", ":meta": "META", ":sub": sub },
  });
  if (!owned.length) return [];

  const perOrder = await Promise.all(owned.map((order) => client.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    FilterExpression: "senderRole = :staff AND readAt = :null",
    ExpressionAttributeValues: { ":pk": order.PK, ":prefix": "MSG#", ":staff": "staff", ":null": null },
  }))));
  const unread = perOrder.flatMap((res) => res.Items || []);
  if (!unread.length) return [];

  return Array.from(groupByOrder(unread).values()).map((entry) => ({ ...toThread(entry), customerName: null }));
}

function groupByOrder(messages) {
  const byOrder = new Map();
  messages.forEach((m) => {
    const orderId = m.orderId || m.PK.replace(/^ORDER#/, "");
    if (!byOrder.has(orderId)) byOrder.set(orderId, { pk: m.PK, orderId, unreadCount: 0, lastMessageAt: null, lastMessageBody: null });
    const entry = byOrder.get(orderId);
    entry.unreadCount++;
    if (!entry.lastMessageAt || m.at > entry.lastMessageAt) {
      entry.lastMessageAt = m.at;
      entry.lastMessageBody = m.body;
    }
  });
  return byOrder;
}

function toThread(entry) {
  return { orderId: entry.orderId, unreadCount: entry.unreadCount, lastMessageAt: entry.lastMessageAt, lastMessageBody: entry.lastMessageBody };
}

// Same LastEvaluatedKey-looping rationale as get-orders.js's scanAll():
// Scan's 1MB page cap applies before FilterExpression, so a single
// un-paginated call can come back empty/partial well before item COUNT
// looks "large".
async function scanAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await client.send(new ScanCommand({ TableName: TABLE, ...params, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
