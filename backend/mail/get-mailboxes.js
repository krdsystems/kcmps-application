/* ============================================================
   KCMPS staff mail API — GET /mail/mailboxes
   ============================================================
   Mirrors dashboard-data.js's getMailboxes(): [{id, address, label, kind,
   canSend, total, unreadCount}]. `canSend` is always false here — sending
   (SMTP relay) is out of scope for this Lambda set (C1/C2's job was
   receive-only; see docs/roadmap.md's "Staff email panel" track for the
   send side, still gated on the Spacemail app-password finding).

   STATIC MAILBOX LIST, not derived from what's actually landed in the
   table — same reasoning as the mock's seedMailboxes(): the dashboard
   needs a stable list to render tabs from even when a mailbox is empty.
   MAILBOXES below is the source of truth for what mirror.kcmps.com
   addresses this system treats as real staff mailboxes; anything else
   inbound mail is routed to (ingest-inbound.js's CATCHALL_MAILBOX /
   UNPARSEABLE_MAILBOX) is intentionally left off this list — see the
   TODO below for why they're still reachable.

   AUTH: isStaff() only, for now. TODO(C3): per-mailbox access is supposed
   to be governed by backend/lib/mail.js's MAILBOX_ACCESS model
   (docs/roadmap.md ~608-617: order@ -> Sales/Finance/Admin, info@ ->
   Sales/Admin, personal mailboxes -> owner only) — that file doesn't
   exist yet. Every read-path Lambda in backend/mail/ has the same TODO;
   fix them together so the model can't drift between endpoints.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { mailboxPk, extractClaims, isStaff } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// TODO(C3): replace with backend/lib/mail.js's MAILBOX_ACCESS-driven list,
// filtered per caller's groups instead of hardcoded here.
const MAILBOXES = [
  { id: "order@mirror.kcmps.com", address: "order@mirror.kcmps.com", label: "Orders", kind: "shared", canSend: false },
  { id: "info@mirror.kcmps.com", address: "info@mirror.kcmps.com", label: "General enquiries", kind: "shared", canSend: false },
  { id: "admin@mirror.kcmps.com", address: "admin@mirror.kcmps.com", label: "Admin", kind: "shared", canSend: false },
];

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Forbidden" });

  const mailboxes = await Promise.all(MAILBOXES.map(async (mb) => {
    const res = await client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": mailboxPk(mb.id) },
      // Bounded read — same tradeoff staff-api/get-unread-messages.js
      // documents for its own per-mailbox scan, acceptable at this
      // mailbox's expected volume; revisit with a counter item if a
      // mailbox ever grows large enough for this to matter.
      ProjectionExpression: "flags",
    }));
    const items = res.Items || [];
    return {
      ...mb,
      total: items.length,
      unreadCount: items.filter((m) => m.flags && m.flags.seen === false).length,
    };
  }));

  return response(200, { mailboxes });
};

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
