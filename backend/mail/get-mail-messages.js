/* ============================================================
   KCMPS staff mail API — GET /mail/mailboxes/{mailboxId}/messages
   ============================================================
   Mirrors dashboard-data.js's getMessages(mailboxId, {folder, limit,
   search}): { mailboxId, folder, total, unreadCount, messages: [...],
   nextCursor }. Each envelope strips bodyText/attachments (envelopeOf() in
   the mock) — same reasoning: the list view must not depend on fields only
   the single-message read fetches, mirroring IMAP's ENVELOPE-vs-BODY[]
   split across two round trips.

   BOUNDED READ, SORTED IN APPLICATION CODE: ../lib/keys.js's
   mailMessageSk() is a hash with no date component (see its header), so
   there's no cheap "Query in date order" — this Query pulls every item
   under the mailbox's PK (capped at QUERY_CAP) and sorts by the `date`
   attribute in memory. Same accepted tradeoff staff-api/get-unread-
   messages.js documents for its own bounded scan; revisit with a GSI
   (mailboxId + date) if a mailbox ever grows past QUERY_CAP messages.

   CURSOR: `nextCursor` here is a base64 JSON offset into the
   already-sorted-and-filtered list, NOT a DynamoDB LastEvaluatedKey (the
   in-memory sort makes a real one meaningless) and NOT the mock's IMAP
   UID either — see this Lambda's row in the field-comparison table in the
   session report. Functionally equivalent: pass it back as `cursor` to
   get the next page.

   RESERVED WORDS: none used here — this Lambda only reads, no
   Update/FilterExpression attribute names collide with DynamoDB's
   reserved list (`scan`/`status`/`name`/`size`/`tags`).

   AUTH: ../lib/mail.js's canAccessMailbox(), re-checked here on the
   path's mailboxId — get-mailboxes.js decides visibility, but a client can
   ask this endpoint for any mailboxId it likes, so visibility is never
   sufficient. See that module's header for the model.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { mailboxPk, extractClaims, canAccessMailbox } = require("../lib");


const TABLE = process.env.TABLE_NAME;
const QUERY_CAP = 1000;
const DEFAULT_LIMIT = 50;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const mailboxId = decodeURIComponent(event.pathParameters?.mailboxId || "");
  if (!mailboxId) return response(400, { error: "mailboxId path parameter is required" });
  if (!canAccessMailbox(claims, mailboxId)) {
    // 403, not 404: the caller is authenticated staff, just not for THIS
    // mailbox. Deliberately identical for "mailbox exists but you may not
    // open it" and "no such mailbox" so the response can't be used to
    // enumerate which mailboxes exist.
    return response(403, { error: "Forbidden" });
  }

  const qs = event.queryStringParameters || {};
  const folder = qs.folder || "INBOX";
  const limit = Math.min(parseInt(qs.limit, 10) || DEFAULT_LIMIT, 200);
  const search = (qs.search || "").trim().toLowerCase();
  const offset = decodeCursor(qs.cursor);

  const res = await client.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": mailboxPk(mailboxId) },
    Limit: QUERY_CAP,
  }));
  let rows = (res.Items || []).filter((m) => (m.folder || "INBOX") === folder);
  const total = rows.length;
  const unreadCount = rows.filter((m) => m.flags && m.flags.seen === false).length;

  if (search) {
    rows = rows.filter((m) =>
      (m.subject || "").toLowerCase().includes(search) ||
      (m.from && m.from.name || "").toLowerCase().includes(search) ||
      (m.from && m.from.address || "").toLowerCase().includes(search) ||
      (m.snippet || "").toLowerCase().includes(search)
    );
  }
  rows.sort((a, b) => new Date(b.date) - new Date(a.date));

  const page = rows.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const nextCursor = nextOffset < rows.length ? encodeCursor(nextOffset) : null;

  return response(200, {
    mailboxId, folder, total, unreadCount,
    messages: page.map(envelopeOf),
    nextCursor,
  });
};

function envelopeOf(m) {
  const e = { ...m };
  delete e.bodyText;
  delete e.attachments;
  delete e.PK; delete e.SK; delete e.s3Ref;
  delete e.tenantId; delete e.siteId; delete e.schemaVersion; delete e.deleted; delete e.updatedAt; delete e.createdAt;
  return e;
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset })).toString("base64");
}
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    return Math.max(0, parseInt(JSON.parse(Buffer.from(cursor, "base64").toString("utf8")).offset, 10) || 0);
  } catch {
    return 0;
  }
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
