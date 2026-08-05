/* ============================================================
   KCMPS staff mail API — GET /mail/mailboxes
   ============================================================
   Mirrors dashboard-data.js's getMailboxes(): [{id, address, label, kind,
   canSend, total, unreadCount}].

   THE LIST IS NOW PER-CALLER, not a hardcoded constant. ../lib/mail.js's
   visibleMailboxes(claims, PERSONAL_MAILBOXES) returns only the mailboxes
   this staffer may actually open — the shared shop inboxes their Cognito
   groups allow, plus their own personal mailbox if one is registered. The
   `roles` allow-list is stripped before it reaches the client (see that
   module), so the response never advertises who else can read a mailbox.

   VISIBILITY IS NOT AUTHORIZATION. docs/roadmap.md is explicit that every
   other handler must re-check, because nothing stops a client asking
   get-mail-messages.js for a mailboxId this endpoint never returned — and
   all three of those handlers now do, via the same canAccessMailbox().

   STILL A STATIC MAILBOX LIST in the sense that matters: it comes from
   MAILBOX_ACCESS/PERSONAL_MAILBOXES, not from what's landed in the table
   — same reasoning as the mock's seedMailboxes(), the dashboard needs a
   stable set of tabs to render even when a mailbox is empty.

   `canSend` is now true for the shared + personal mailboxes (send-reply.js
   exists as of C3) and false for the operational catchall/unparseable
   mailboxes — replying *from* an address that only exists because routing
   failed is never right.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { mailboxPk, extractClaims, visibleMailboxes, parsePersonalMailboxes } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const PERSONAL_MAILBOXES = parsePersonalMailboxes(process.env.PERSONAL_MAILBOXES);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const allowed = visibleMailboxes(claims, PERSONAL_MAILBOXES);
  // An authenticated caller with no mailboxes (Customer, or Production
  // with no personal mailbox registered) gets an empty list, not a 403 —
  // the dashboard renders "no mailboxes available" rather than an error.
  if (!allowed.length) return response(200, { mailboxes: [] });

  const mailboxes = await Promise.all(allowed.map(async (mb) => {
    const res = await client.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": mailboxPk(mb.id) },
      // Bounded read — same tradeoff staff-api/get-unread-messages.js
      // documents for its own per-mailbox scan, acceptable at this
      // mailbox's expected volume; revisit with a counter item if a
      // mailbox ever grows large enough for this to matter.
      ProjectionExpression: "flags, folder",
    }));
    const items = res.Items || [];
    // INBOX only for the counts: a reply this staffer just sent lands as a
    // folder:"SENT" item under the same PK (see send-reply.js), and it
    // would otherwise inflate the mailbox's `total` on every send.
    const inbox = items.filter((m) => (m.folder || "INBOX") === "INBOX");
    return {
      ...mb,
      total: inbox.length,
      unreadCount: inbox.filter((m) => m.flags && m.flags.seen === false).length,
    };
  }));

  return response(200, { mailboxes });
};

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
