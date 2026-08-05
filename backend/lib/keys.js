/* ============================================================
   KCMPS backend — DynamoDB PK/SK builders
   ============================================================
   Every string here matches ops-dashboard/infra/backend-infra-to-deploy.md
   §2.1 (item types table) and §2.3 (GSI1) EXACTLY. Do not hand-format a
   key anywhere else in the codebase — import these so a future rename is
   a one-file change instead of a grep-and-pray.
   ============================================================ */

// ---- Order / line item / event (main table, §2.1) ----

function orderPk(orderId) {
  return `ORDER#${orderId}`;
}

function metaSk() {
  return "META";
}

function lineItemSk(lineItemId) {
  return `LINEITEM#${lineItemId}`;
}

// isoTimestamp must already be an ISO-8601 string (e.g. new Date().toISOString()).
function eventSk(isoTimestamp, lineItemId) {
  return `EVENT#${isoTimestamp}#${lineItemId}`;
}

// ---- Metrics (§2.1) ----

function dayMetricPk(yyyyMmDd) {
  return `METRIC#DAY#${yyyyMmDd}`;
}

function monthMetricPk(yyyyMm) {
  return `METRIC#MONTH#${yyyyMm}`;
}

function summarySk() {
  return "SUMMARY";
}

function stationSk(stationId) {
  return `STATION#${stationId}`;
}

// pillar must be one of "PRINT" | "STUDIO" | "HARDWARE" per §2.1.
function pillarSk(pillar) {
  return `PILLAR#${pillar}`;
}

// ---- Blocker (§2.1) ----

function blockerPk(yyyyMmDd) {
  return `BLOCKER#${yyyyMmDd}`;
}

// The blocker's SK is the bare blockerId (no prefix) per §2.1's item table.
function blockerSk(blockerId) {
  return blockerId;
}

// ---- Inventory (§2.1) ----

function inventoryPk(sku) {
  return `INV#${sku}`;
}

// ---- Client (§2.1) ----

function clientPk(clientId) {
  return `CLIENT#${clientId}`;
}

// ---- Checkout idempotency (dedup record for POST /orders retries) ----

function idempotencyPk(idempotencyKey) {
  return `IDEMPOTENCY#${idempotencyKey}`;
}

// ---- GSI1 — sparse active-line-item-by-status index (§2.3/§2.6) ----

function statusPk(status) {
  return `STATUS#${status}`;
}

// enteredAtIso must be an ISO-8601 string — the moment the line item
// entered `status`. Pass-through wrapper (not just `enteredAtIso` inline)
// so every GSI1SK write goes through one named place.
function statusSk(enteredAtIso) {
  return enteredAtIso;
}

// ---- GSI2 — optional client order history index (§2.3) ----
// Not yet a real GSI on the table (backend/infra/foundation.cfn.yaml only
// provisions GSI1) — these attributes are written in preparation (see
// messageGsi2Pk/messageGsi2Sk below) so adding the index later needs zero
// backfill, per staff-api/get-orders.js's own note on the same tradeoff.

function clientGsi2Pk(clientId) {
  return `CLIENT#${clientId}`;
}

function orderGsi2Sk(createdAtIso) {
  return `ORDER#${createdAtIso}`;
}

// A customer's messages across every order, once GSI2 exists — same
// GSI2PK as the CRM view above (CLIENT#<sub>) so both features could
// eventually share one index, disambiguated by GSI2SK's prefix.
function messageGsi2Sk(atIso) {
  return `MSG#${atIso}`;
}

// ---- Config (settings items — new convention, no prior art in this repo) ----
// One item per config type: PK: CONFIG#<id>, SK: "META" (reuses metaSk()).
// e.g. configPk("OPERATING_HOURS") -> "CONFIG#OPERATING_HOURS", read by
// backend/lib/business-hours.js's callers, editable later via a Settings
// API behind /dashboard/settings.

function configPk(configId) {
  return `CONFIG#${configId}`;
}

// ---- Order messages / customer chat (new item type, same table) ----
// PK: ORDER#<id>, SK: MSG#<ISO timestamp>#<msgId> — co-located with the
// order they're about, consistent with EVENT#'s pattern above.

// ---- standalone malware-scan verdicts ----
// PK: SCAN#<s3:// ref>, SK: META. Written by jobs/handle-scan-result.js for
// EVERY scan, independent of whether a record referencing that object exists
// yet. This exists because design-file uploads happen BEFORE checkout: the
// scan routinely completes while the customer is still filling in the form,
// so there is no order to annotate at that moment. Without a durable
// standalone verdict the result is simply lost and the file is stuck
// "Scanning…" forever — including clean files, which would then never be
// downloadable. Read paths fall back to this item.
function scanResultPk(ref) {
  return `SCAN#${ref}`;
}

function messageSk(isoTimestamp, msgId) {
  return `MSG#${isoTimestamp}#${msgId}`;
}

// ---- Design Asset Library (docs/roadmap.md "Parallel track — Design Asset Library") ----
// PK: DESIGN#<designId>, SK: "META" (reuses metaSk()) for the design record;
// SK: EVENT#<ISO>#DESIGN for its append-only audit trail (same EVENT# convention
// as orders, so one day's audit read is uniform across item types).
function designPk(designId) {
  return `DESIGN#${designId}`;
}

// ---- Inbound mail (SES relay, docs/roadmap.md "Parallel track — Staff email
// panel", "SES relay" track) ----
// PK: MAILBOX#<mailboxId> (mailboxId is the lowercased recipient address,
// e.g. "order@kcmps.com" — the REAL address, never the mirror address; see
// ./mail.js), SK: MSG#<messageIdHash> — deliberately NOT
// MSG#<internaldate>#<messageId> (the EVENT#/order-message convention): the
// read path (get-mail-message.js) is only ever handed {mailboxId, messageId}
// by the dashboard, with no date, so the SK must be derivable from those two
// alone for a single GetItem. messageIdHash is a stable sha256 (see
// ../mail/mail-parse.js's hashMessageId()) of the RFC822 Message-ID, which
// can contain characters DynamoDB sort keys tolerate but which are awkward
// to round-trip through URL paths — hashing sidesteps that AND makes
// ingest-inbound.js's write idempotent on SES/S3-event retry (same message
// -> same key -> harmless overwrite, never a duplicate item). Ordering for
// list views is done in application code on the `date` attribute instead of
// relying on SK sort — see get-mail-messages.js's header for why that's an
// acceptable bounded-read tradeoff at this mailbox's expected volume.
function mailboxPk(mailboxId) {
  return `MAILBOX#${mailboxId}`;
}

function mailMessageSk(messageIdHash) {
  return `MSG#${messageIdHash}`;
}

module.exports = {
  orderPk,
  metaSk,
  lineItemSk,
  eventSk,
  idempotencyPk,
  dayMetricPk,
  monthMetricPk,
  summarySk,
  stationSk,
  pillarSk,
  blockerPk,
  blockerSk,
  inventoryPk,
  clientPk,
  statusPk,
  statusSk,
  clientGsi2Pk,
  orderGsi2Sk,
  messageGsi2Sk,
  configPk,
  messageSk,
  scanResultPk,
  designPk,
  mailboxPk,
  mailMessageSk,
};
