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

function clientGsi2Pk(clientId) {
  return `CLIENT#${clientId}`;
}

function orderGsi2Sk(createdAtIso) {
  return `ORDER#${createdAtIso}`;
}

module.exports = {
  orderPk,
  metaSk,
  lineItemSk,
  eventSk,
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
};
