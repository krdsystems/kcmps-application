/* ============================================================
   KCMPS staff API — POST /orders/{orderId}/tags
   ============================================================
   AWS-style order tagging: staff attach small key/value pairs to an
   order (e.g. Type=Reprint, Priority=Rush, Test=(empty)) for their own
   filtering/reporting — separate from the order-status state machine
   `../lib/order-status.js` owns, and separate from the staff-written
   free-text notes in add-correspondence.js's correspondenceLog.

   Full-set PUT, not an incremental add/remove API: the tag editor on
   job-detail.html is a small form staff fill out and save, so the
   client always sends the COMPLETE desired tag list and this Lambda
   diffs it against what's stored to build the audit trail. See
   ../lib/tags.js's header for why a full-set PUT was chosen over a
   per-tag add/remove pair.

   Body shape: { tags: [{key, value}] } — value may be "" (a boolean-
   style flag tag). Validation (length caps, character allowlist, max
   tag count, duplicate-key rejection) lives in ../lib/tags.js, shared
   with its own unit tests (tags.test.js) so the rules can't drift
   between this Lambda and any future caller.

   Response: { tags } — the normalized, stored tag list.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { orderPk, metaSk, buildEvent, extractClaims, isStaff, validateTags, diffTags, TagValidationError } = require("../lib");

const TABLE = process.env.TABLE_NAME;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Staff only" });

  const orderId = event.pathParameters?.orderId;
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  let tags;
  try {
    tags = validateTags(body.tags);
  } catch (err) {
    if (err instanceof TagValidationError) return response(400, { error: err.message });
    throw err;
  }

  const pk = orderPk(orderId);
  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  if (!orderRes.Item) return response(404, { error: "Order not found" });

  const previousTags = Array.isArray(orderRes.Item.tags) ? orderRes.Item.tags : [];
  const { added, removed, changed } = diffTags(previousTags, tags);
  const now = new Date().toISOString();
  const staffName = claims.name || claims.email;

  // No-op save (identical set resubmitted) still succeeds but skips the
  // EVENT# write — nothing happened, so nothing to audit.
  const hasChange = added.length || removed.length || changed.length;

  const transactItems = [
    {
      Update: {
        TableName: TABLE,
        Key: { PK: pk, SK: metaSk() },
        UpdateExpression: "SET tags = :tags, updatedAt = :updatedAt",
        ExpressionAttributeValues: { ":tags": tags, ":updatedAt": now },
      },
    },
  ];
  if (hasChange) {
    transactItems.push({
      Put: {
        TableName: TABLE,
        // lineItemId "ORDER" (not a real LINEITEM#) marks this as an
        // order-level event, same convention as verify-payment.js's
        // per-line-item events but for something that isn't scoped to
        // any one line — get-orders.js still returns it (it only filters
        // on the EVENT# SK prefix), and customer-view.js's
        // redactForCustomer() strips it before a non-staff caller sees
        // it, same as correspondenceLog.
        Item: buildEvent({
          orderId, lineItemId: "ORDER", from: null, to: "Tags updated",
          actorSub: claims.sub, actorName: staffName, at: now,
          meta: { via: "setTags", added, removed, changed },
        }),
      },
    });
  }

  await client.send(new TransactWriteCommand({ TransactItems: transactItems }));

  return response(200, { tags });
};

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
