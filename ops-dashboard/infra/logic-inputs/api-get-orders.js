/* ============================================================
   KCMPS Ops Dashboard — GET /orders Lambda
   ============================================================
   Role-filtered order read, shared with the customer-facing
   portal per Part 6 of the Project Knowledge file ("Shared truth,
   filtered by role. Same ORDER# record; the customer sees their
   own line items via the sub claim, staff see all via the Staff
   group claim.").

   IMPORTANT: this is the server-side enforcement point. The
   frontend's client-side JWT decode (dashboard-shell.js) is
   display-only — never trust it. This Lambda independently
   verifies the JWT signature against Cognito's JWKS before
   trusting any claim.

   If you're using an API Gateway HTTP API with a JWT authorizer
   (recommended — see backend-infra-to-deploy.md §4), API Gateway
   has ALREADY verified the signature by the time this Lambda runs,
   and the claims arrive in event.requestContext.authorizer.jwt.claims.
   The manual verifyJwt() path below is kept as a fallback for a
   REST API / Lambda-URL setup where you're doing verification
   yourself.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
// npm install aws-jwt-verify — only needed for the manual-verification fallback path
const { CognitoJwtVerifier } = require("aws-jwt-verify");

const TABLE = process.env.TABLE_NAME;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const STAFF_GROUP = "Staff";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const verifier = CognitoJwtVerifier.create({
  userPoolId: USER_POOL_ID,
  tokenUse: "id",
  clientId: CLIENT_ID,
});

exports.handler = async (event) => {
  const claims = await getVerifiedClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const isStaff = (claims["cognito:groups"] || []).includes(STAFF_GROUP);
  const orders = isStaff ? await getAllOrders() : await getOrdersForSub(claims.sub);
  return response(200, { orders });
};

async function getVerifiedClaims(event) {
  // Preferred path: API Gateway HTTP API JWT authorizer already verified it.
  const gwClaims = event.requestContext?.authorizer?.jwt?.claims;
  if (gwClaims) return normalizeGroups(gwClaims);

  // Fallback: verify manually (e.g. behind a Lambda Function URL).
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  try {
    const payload = await verifier.verify(token);
    return payload;
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    return null;
  }
}

// API Gateway's JWT authorizer flattens cognito:groups into a comma-joined
// string in event.requestContext.authorizer.jwt.claims — normalize back to
// an array so downstream code can treat both paths identically.
function normalizeGroups(claims) {
  if (typeof claims["cognito:groups"] === "string") {
    return { ...claims, "cognito:groups": claims["cognito:groups"].split(",") };
  }
  return claims;
}

async function getAllOrders() {
  // NOTE: a full Scan is acceptable here ONLY because this is a bounded,
  // infrequent, staff-only read (the "all jobs" list), not a per-load
  // dashboard metric — those must stay on METRIC# counters per §2.5 of
  // backend-infra-to-deploy.md. If order volume grows large, paginate
  // this with a real query pattern (e.g. a GSI on createdAt) instead.
  const res = await client.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(PK, :prefix) AND SK = :meta",
    ExpressionAttributeValues: { ":prefix": "ORDER#", ":meta": "META" },
  }));
  const orders = res.Items || [];
  return Promise.all(orders.map(attachLineItems));
}

async function getOrdersForSub(sub) {
  // Requires GSI2 (CLIENT#<id> / ORDER#<createdAt>) once the CRM view
  // matures, per Part 5.4. Until then, filter a bounded scan by
  // customerSub — acceptable at KCMPS's current order volume.
  const res = await client.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(PK, :prefix) AND SK = :meta AND customerSub = :sub",
    ExpressionAttributeValues: { ":prefix": "ORDER#", ":meta": "META", ":sub": sub },
  }));
  const orders = res.Items || [];
  return Promise.all(orders.map(attachLineItems));
}

async function attachLineItems(order) {
  const res = await client.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": order.PK, ":prefix": "LINEITEM#" },
  }));
  return { ...order, lineItems: res.Items || [] };
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
