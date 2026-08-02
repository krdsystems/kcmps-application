/* ============================================================
   KCMPS staff API — GET /orders
   ============================================================
   Role-filtered order read (Payment System file Part 6: "Shared truth,
   filtered by role. Same ORDER# record; the customer sees their own line
   items via the sub claim, staff see all via the group claim.").

   API Gateway's Cognito JWT authorizer has already verified the token
   signature by the time this Lambda runs — claims arrive pre-verified in
   event.requestContext.authorizer.jwt.claims (backend/lib/auth.js's
   extractClaims()). Never trust a client-decoded token instead.

   Ported from ops-dashboard/infra/logic-inputs/api-get-orders.js against
   backend/lib conventions (see backend/CLAUDE.md) — same behavior, no
   duplicated key-building/claims-normalizing logic.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { extractClaims, getGroups, isStaff } = require("../lib/auth");
const { redactForCustomer } = require("../lib/customer-view");

const TABLE = process.env.TABLE_NAME;
const SCREENSHOT_URL_EXPIRY_SECONDS = 15 * 60;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.+)$/;
// "Staff" is the legacy Cognito group dashboard-shell.js still gates on
// today (see root CLAUDE.md "Legacy groups"); the 4-role model
// (Production/Sales/Finance/Admin) is the target state but not every
// staffer has been migrated off "Staff" yet, so accept either until that
// retirement happens.
const LEGACY_STAFF_GROUP = "Staff";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const staff = isStaff(claims) || getGroups(claims).includes(LEGACY_STAFF_GROUP);
  const orders = staff ? await getAllOrders() : await getOrdersForSub(claims.sub);
  if (!staff) orders.forEach(redactForCustomer);
  orders.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return response(200, { orders });
};

async function getAllOrders() {
  // A full Scan is acceptable here ONLY because this is a bounded,
  // infrequent, staff-only read (the "all jobs" list), not a per-load
  // dashboard metric. If order volume grows large, paginate this with a
  // real query pattern (e.g. a GSI on createdAt) instead.
  const res = await client.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(PK, :prefix) AND SK = :meta",
    ExpressionAttributeValues: { ":prefix": "ORDER#", ":meta": "META" },
  }));
  return Promise.all((res.Items || []).map(attachLineItems));
}

async function getOrdersForSub(sub) {
  // Requires a CLIENT#-keyed GSI once the CRM view matures. Until then, a
  // bounded scan filtered by customerSub is acceptable at KCMPS's current
  // order volume.
  const res = await client.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(PK, :prefix) AND SK = :meta AND customerSub = :sub",
    ExpressionAttributeValues: { ":prefix": "ORDER#", ":meta": "META", ":sub": sub },
  }));
  return Promise.all((res.Items || []).map(attachLineItems));
}


async function attachLineItems(order) {
  const [lineItemsRes, eventsRes] = await Promise.all([
    client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": order.PK, ":prefix": "LINEITEM#" },
    })),
    client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": order.PK, ":prefix": "EVENT#" },
    })),
  ]);
  const payment = await withScreenshotUrl(order.payment);
  return { ...order, payment, lineItems: lineItemsRes.Items || [], events: eventsRes.Items || [] };
}

// order.payment.screenshotRef is an s3:// URI — not directly loadable by a
// browser <img>. Staff need to actually SEE the proof, not just its key, so
// presign a short-lived GET URL here rather than pushing S3 creds/logic into
// the dashboard's client-side JS.
async function withScreenshotUrl(payment) {
  if (!payment || !payment.screenshotRef) return payment;
  const match = S3_URI_RE.exec(payment.screenshotRef);
  if (!match) return payment;
  const [, bucket, key] = match;
  try {
    const screenshotUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: SCREENSHOT_URL_EXPIRY_SECONDS }
    );
    return { ...payment, screenshotUrl };
  } catch (err) {
    console.error("get-orders: failed to presign screenshotUrl:", err.message);
    return payment;
  }
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
