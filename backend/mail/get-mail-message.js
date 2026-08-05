/* ============================================================
   KCMPS staff mail API — GET /mail/mailboxes/{mailboxId}/messages/{messageId}
   ============================================================
   Mirrors dashboard-data.js's getMessage(mailboxId, messageId) — returns
   the full item (bodyText + attachments included, unlike the envelope
   list). `messageId` in the path is the RFC822 Message-ID (URL-encoded by
   the caller, since it contains "<", "@", ">"); this Lambda hashes it the
   same way ingest-inbound.js did on write (../lib/keys.js's
   mailMessageSk()) to do a direct GetItem — see that file's header for why
   the SK has no date component.

   AUTH: ../lib/mail.js's canAccessMailbox(), re-checked on the path's
   mailboxId — see that module's header.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { mailboxPk, mailMessageSk, extractClaims, canAccessMailbox } = require("../lib");

const { hashMessageId } = require("./mail-parse");

const TABLE = process.env.TABLE_NAME;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const mailboxId = decodeURIComponent(event.pathParameters?.mailboxId || "");
  const messageId = decodeURIComponent(event.pathParameters?.messageId || "");
  if (!mailboxId || !messageId) return response(400, { error: "mailboxId and messageId path parameters are required" });
  if (!canAccessMailbox(claims, mailboxId)) {
    // 403, not 404: the caller is authenticated staff, just not for THIS
    // mailbox. Deliberately identical for "mailbox exists but you may not
    // open it" and "no such mailbox" so the response can't be used to
    // enumerate which mailboxes exist.
    return response(403, { error: "Forbidden" });
  }

  const res = await client.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: mailboxPk(mailboxId), SK: mailMessageSk(hashMessageId(messageId)) },
  }));
  if (!res.Item) return response(404, { error: "Message not found" });

  return response(200, { message: cleanItem(res.Item) });
};

function cleanItem(m) {
  const c = { ...m };
  delete c.PK; delete c.SK; delete c.s3Ref;
  delete c.tenantId; delete c.siteId; delete c.schemaVersion; delete c.deleted; delete c.updatedAt; delete c.createdAt;
  return c;
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
