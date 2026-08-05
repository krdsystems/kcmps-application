/* ============================================================
   KCMPS staff/customer API — GET /orders/{orderId}/messages
   ============================================================
   Order-scoped read of the thread send-message.js writes. Same
   staff-vs-customer branch as get-orders.js: staff sees any order's
   thread, the order's own customer (JWT sub === order.customerSub) sees
   theirs, anyone else gets 403.

   Account-level view (Payment System file's "reused pattern"
   principle, and this feature's own account-level requirement): NOT a
   separate endpoint yet. GSI2 (CLIENT#<sub>/MSG#<at>) isn't provisioned
   on the table (see send-message.js's header), so a true one-query
   "all my messages across every order" view is deferred until that
   index exists. Until then, the equivalent view is: call GET /orders
   (already returns every order the caller can see) then this endpoint
   per order — more round trips, same accepted-interim tradeoff
   get-orders.js's own CLIENT# comment documents. Frontend deliberately
   only builds order-scoped panels for now (order-detail.html,
   dashboard/job-detail.html), not a global inbox, so this gap doesn't
   block anything asked for.

   Side effect (OPT-IN via ?markRead=true): marks the OTHER party's
   messages as read — a customer marks staff messages read, staff marks
   customer messages read. This is what backend/jobs/notify-unread-
   messages.js's 2-hour reminder checks against, and it's the only "mark
   read" path — no separate endpoint, per the "reused pattern" simplicity
   principle. Best-effort: a failed mark-read never blocks the read
   response, since a stale readAt just means one extra reminder email at
   worst.

   Defaulting markRead to OFF (was unconditional until 2026-08-04) is
   deliberate: both order-detail.html and job-detail.html call this
   Lambda unconditionally on page load and every 8s poll just to render
   the thread, which meant simply opening a ticket to check whether a
   message had arrived silently consumed the very unread signal you were
   there to look for — the sidebar badge / customer banner would already
   read 0 by the time you looked back at it. Callers now pass
   `?markRead=true` only from a real engagement signal (frontend: the
   reply box gaining focus), so glancing at a thread no longer clears it.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { orderPk, metaSk, scanResultPk, extractClaims, isStaff } = require("../lib");
const { contentDispositionFor, INLINE_VIEWABLE_TYPES } = require("../lib/upload-types");

const TABLE = process.env.TABLE_NAME;
const ATTACHMENT_URL_EXPIRY_SECONDS = 15 * 60;
const S3_URI_RE = /^s3:\/\/([^/]+)\/(.+)$/;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const orderId = event.pathParameters?.orderId;
  if (!orderId) return response(400, { error: "orderId path parameter is required" });

  const pk = orderPk(orderId);
  const orderRes = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  const order = orderRes.Item;
  if (!order) return response(404, { error: "Order not found" });

  const staff = isStaff(claims);
  if (!staff && claims.sub !== order.customerSub) {
    return response(403, { error: "You don't have access to this order." });
  }

  const res = await client.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
    ExpressionAttributeValues: { ":pk": pk, ":prefix": "MSG#" },
  }));
  const messages = (res.Items || []).sort((a, b) => (a.at || "").localeCompare(b.at || ""));

  const markRead = event.queryStringParameters?.markRead === "true";
  if (markRead) {
    const otherPartyRole = staff ? "customer" : "staff";
    const toMarkRead = messages.filter((m) => m.senderRole === otherPartyRole && !m.readAt);
    if (toMarkRead.length) {
      const now = new Date().toISOString();
      await Promise.all(toMarkRead.map((m) =>
        client.send(new UpdateCommand({
          TableName: TABLE,
          Key: { PK: m.PK, SK: m.SK },
          UpdateExpression: "SET readAt = :now",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: { ":now": now },
        })).then(() => { m.readAt = now; }).catch((err) => {
          console.error("get-messages: mark-read failed for", m.SK, err.message);
        })
      ));
    }
  }

  const withUrls = await Promise.all(messages.map(withAttachmentUrls));
  return response(200, { messages: withUrls });
};

// Each attachment's `ref` is an s3:// URI (send-message.js) — not directly
// loadable by a browser, since the bucket is private. Same two rules as
// staff-api/get-orders.js (see its header comment for the full reasoning):
//
//  1. SCAN GATE — jobs/handle-scan-result.js persists GuardDuty's verdict on
//     the message item. Anything not NO_THREATS_FOUND gets no url; infected
//     files are already deleted from S3 by that Lambda, and the attachment
//     record survives so both sides can see what was sent and that it was
//     destroyed. No persisted verdict yet = PENDING = blocked (fail closed).
//  2. DISPOSITION — images and PDFs are served `inline` so staff can open a
//     customer's photo or spec in a tab instead of routing it through the
//     Downloads folder; every other type still gets `attachment` +
//     octet-stream. The allowlist lives in backend/lib/upload-types.js's
//     contentDispositionFor() and is closed — SVG is excluded there on
//     purpose and must stay excluded, since rendering one executes its
//     script. Inline is reached ONLY after rule 1 passes.
//
//     This path deserves the most care in the system: send-message.js
//     accepts attachments from CUSTOMERS (any logged-in customer, on their
//     own order), so it is the one upload path fed by an outsider. It was
//     presigned for staff with neither a scan nor a disposition override
//     until 2026-08-05, when both were added. What makes inline acceptable
//     now is the combination — a closed type allowlist, a mandatory clean
//     scan verdict, and rendering from the S3 presigned host rather than
//     kcmps.com, so a hostile file cannot reach the dashboard's session.
async function withAttachmentUrls(message) {
  if (!Array.isArray(message.attachments) || !message.attachments.length) return message;
  const attachments = await Promise.all(message.attachments.map(async (raw) => {
    // Fall back to the standalone SCAN# verdict when the attachment wasn't
    // annotated in place — see get-orders.js's resolveVerdict() for why
    // that happens and why it must not become a permanent "Scanning…".
    let a = raw;
    if (!a.scanStatus && a.ref) {
      try {
        const v = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: scanResultPk(a.ref), SK: metaSk() } }));
        if (v.Item) a = { ...a, ...v.Item, PK: undefined, SK: undefined };
      } catch (err) {
        console.error("get-messages: scan-verdict lookup failed for", a.ref, err.message);
      }
    }
    if (a.scanStatus !== "NO_THREATS_FOUND") {
      return { ...a, url: null, scanStatus: a.scanStatus || "PENDING" };
    }
    const match = a.ref && S3_URI_RE.exec(a.ref);
    if (!match) return a;
    const [, bucket, key] = match;
    try {
      // Images and PDFs open in a tab; anything else still downloads. The
      // NO_THREATS_FOUND gate above is unchanged and still runs first — see
      // contentDispositionFor() in backend/lib/upload-types.js.
      const url = await getSignedUrl(s3, new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...contentDispositionFor(a.contentType, a.filename),
      }), { expiresIn: ATTACHMENT_URL_EXPIRY_SECONDS });
      return { ...a, url, inlineViewable: INLINE_VIEWABLE_TYPES.has(String(a.contentType || "").toLowerCase()) };
    } catch (err) {
      console.error("get-messages: failed to presign attachment", a.ref, err.message);
      return { ...a, url: null };
    }
  }));
  return { ...message, attachments };
}

// Mirrors get-orders.js's helper — strips quotes/backslashes/control chars
// (CR/LF would be header injection) out of the Content-Disposition value.

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
