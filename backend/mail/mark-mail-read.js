/* ============================================================
   KCMPS staff mail API — POST /mail/mailboxes/{mailboxId}/messages/{messageId}/read
   ============================================================
   Mirrors dashboard-data.js's markMessageRead(mailboxId, messageId, seen).
   Body: { seen?: boolean } (default true, matching the mock's `seen !==
   false` default). Returns the updated message envelope.

   SHARED-INBOX \Seen SEMANTICS: same open decision the mock's own header
   flags (docs/roadmap.md ~628-632) — one staffer marking a shared mailbox
   message read marks it read for everyone. Not fixed here; still true of
   the real backend.

   RESERVED WORDS: `flags` is not reserved, but this file still uses
   ExpressionAttributeNames for future-proofing since the nested attribute
   name is caller-adjacent code that's easy to extend carelessly later —
   cheap insurance, not because `flags`/`seen` currently collide with
   DynamoDB's reserved list.

   AUTH: isStaff() only — see get-mailboxes.js's TODO(C3).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { mailboxPk, mailMessageSk, extractClaims, isStaff } = require("../lib");
const { hashMessageId } = require("./mail-parse");

const TABLE = process.env.TABLE_NAME;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Forbidden" });

  const mailboxId = decodeURIComponent(event.pathParameters?.mailboxId || "");
  const messageId = decodeURIComponent(event.pathParameters?.messageId || "");
  if (!mailboxId || !messageId) return response(400, { error: "mailboxId and messageId path parameters are required" });

  let body = {};
  try { body = event.body ? JSON.parse(event.body) : {}; } catch { /* default below */ }
  const seen = body.seen !== false;

  try {
    const res = await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: mailboxPk(mailboxId), SK: mailMessageSk(hashMessageId(messageId)) },
      ConditionExpression: "attribute_exists(PK)",
      UpdateExpression: "SET #flags.#seen = :seen",
      ExpressionAttributeNames: { "#flags": "flags", "#seen": "seen" },
      ExpressionAttributeValues: { ":seen": seen },
      ReturnValues: "ALL_NEW",
    }));
    return response(200, { message: cleanItem(res.Attributes) });
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return response(404, { error: "Message not found" });
    console.error("mark-mail-read: update failed", err.message);
    return response(500, { error: "Failed to update message" });
  }
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
