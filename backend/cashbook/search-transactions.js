/* ============================================================
   KCMPS Cash Book — GET /cashbook/search?q=…
   ============================================================
   Free-text search across EVERY day, not just the one on screen.

   AUTH: isStaff() — same as get-day.js. This returns the same rows a
   staffer could already page to day by day; it only saves them the
   paging.

   ------------------------------------------------------------
   Why this is NOT a Scan
   ------------------------------------------------------------
   The obvious "search the whole table" implementation is a Scan with a
   FilterExpression. It is the wrong tool here and gets worse forever:
   a Scan reads EVERY item in the table — orders, line items, events,
   mail messages, design records, scan verdicts — and then throws away
   everything that isn't a cash book row. Mail alone will dominate that
   table. The cost of finding one ₱1,690 expense would grow with the
   volume of unrelated data.

   The key schema already gives a better route. Cash book rows live in
   per-Manila-day partitions (keys.js's txnDayPk: TXN#<YYYY-MM-DD>), and
   a METRIC#MONTH#<YYYY-MM> rollup records how many transactions each
   month holds. So:

     1. Read the month rollups across the requested window.
     2. Skip every month whose txnCount is 0 — no day in it can match.
     3. Query only the days of months that actually have activity.

   Each Query touches ONE day's cash book rows and nothing else, so the
   work is proportional to how much money actually moved, not to how big
   the table has become. For a shop a few months old that's a handful of
   month reads plus the days of one or two live months.

   ------------------------------------------------------------
   Matching
   ------------------------------------------------------------
   Terms are ANDed and matched case-insensitively against one flattened
   haystack per row — the SAME field set the client-side day filter uses
   (cashbook.html's searchHaystack), including both the raw centavos and
   a formatted peso string so "1,690", "1690" and "169000" all hit. The
   two must stay in step; if you add a field to one, add it to the other,
   or the same query returns different rows depending on which path ran.

   Filtering is done in the Lambda rather than as a DynamoDB
   FilterExpression on purpose: a FilterExpression is applied AFTER the
   read is paid for, so it would save nothing, and it cannot express
   "matches any of these formatted representations of an amount".
   ============================================================ */

const { txnDayPk, monthMetricPk, summarySk, extractClaims, isStaff } = require("../lib");
const { TABLE, dynamo, queryAll, response } = require("./shared");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");

// Hard ceilings so one request can never turn into an unbounded job.
const MAX_MONTHS = 36;          // 3 years of history is more than this business has
const MAX_DAY_QUERIES = 400;    // ~13 active months' worth of days
const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 1000;
const QUERY_CONCURRENCY = 8;

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims || !claims.sub) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Staff only" });

  const q = event.queryStringParameters || {};
  const terms = String(q.q || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return response(400, { error: "A search term is required." });

  const limit = clampInt(q.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const to = isDay(q.to) ? q.to : manilaToday();
  // Default window starts well before this business existed, so "all"
  // really is all — the month-rollup skip below makes empty months free.
  const from = isDay(q.from) ? q.from : "2026-01-01";
  if (from > to) return response(400, { error: "`from` must be on or before `to`." });

  const months = monthsBetween(from, to).slice(0, MAX_MONTHS);
  const activeMonths = await filterToActiveMonths(months);

  // Only the days that fall inside the requested window AND inside a
  // month that has any activity at all.
  const days = [];
  for (const m of activeMonths) {
    for (const d of daysInMonth(m)) {
      if (d >= from && d <= to) days.push(d);
    }
  }
  days.sort();
  const truncatedScan = days.length > MAX_DAY_QUERIES;
  // Newest days first, so a truncated scan drops the OLDEST days rather
  // than the most recent ones — the opposite would hide today's work.
  const scanDays = days.slice(-MAX_DAY_QUERIES);

  const rows = [];
  await inBatches(scanDays, QUERY_CONCURRENCY, async (day) => {
    const items = await queryAll({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": txnDayPk(day), ":sk": "TXN#" },
    });
    for (const it of items) {
      if (it.deleted) continue;               // relink tombstones
      if (it.itemType && it.itemType !== "TXN") continue;
      if (matches(it, terms)) rows.push(it);
    }
  });

  // Newest first — the same order the day view uses.
  rows.sort((a, b) => String(b.occurredAt || "").localeCompare(String(a.occurredAt || "")));

  return response(200, {
    transactions: rows.slice(0, limit),
    total: rows.length,
    // true => there are more matches than `limit` returned, so the UI can
    // say so rather than silently implying it found everything.
    truncated: rows.length > limit || truncatedScan,
    searchedDays: scanDays.length,
    from, to,
  });
};

/* ---- matching ---- */

function matches(it, terms) {
  const hay = haystack(it);
  return terms.every((t) => hay.includes(t));
}

function haystack(it) {
  const c = Number(it.amountCentavos) || 0;
  const pesos = (c / 100).toFixed(2);                       // "1690.00"
  const grouped = Number(pesos).toLocaleString("en-US", {   // "1,690.00"
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return [
    it.txnId, it.note, it.orderId, it.actorName, it.actorSub,
    it.categoryId, it.categoryLabel, it.subcategoryId, it.subcategoryLabel,
    it.paymentMethod, it.paymentAccount, it.label,
    it.direction === "in" ? "revenue" : "expense",
    it.voided ? "voided" : "",
    String(c), pesos, grouped,
    it.occurredAt, it.day,
  ].filter(Boolean).join(" ").toLowerCase();
}

/* ---- month rollups: the thing that keeps this cheap ---- */

async function filterToActiveMonths(months) {
  if (!months.length) return [];
  const active = [];
  /* Parallel GetItems rather than a BatchGetItem. BatchGetItem would be
     one call instead of ~36, but the shared staff-api Lambda role does
     NOT grant dynamodb:BatchGetItem (confirmed on staging 2026-08-20 —
     the first build of this handler failed with AccessDeniedException),
     and widening a role every staff-api Lambda shares is the wrong trade
     for saving a few milliseconds on a read that is already bounded to
     MAX_MONTHS and run 8 at a time. */
  await inBatches(months, QUERY_CONCURRENCY, async (m) => {
    const res = await dynamo.send(new GetCommand({
      TableName: TABLE, Key: { PK: monthMetricPk(m), SK: summarySk() },
    }));
    const it = res.Item;
    if (it) { if (Number(it.txnCount || 0) > 0) active.push(m); return; }
    /* No rollup item at all. For a PAST month that means genuinely zero
       transactions, not "unknown": every writer bumps the month rollup
       inside the SAME TransactWriteItems as the row itself
       (log-transaction.js / log-cost.js), so a month that ever held a
       transaction always has one. Skipping these is what keeps a search
       proportional to real activity — before this, a default window
       starting 2026-01-01 queried 232 days to find 2 rows, and that
       number would grow with the calendar forever.

       The current and previous month are still swept unconditionally, as
       cheap insurance for the one case where the invariant could be
       mid-flight or a rollup was repaired by hand. */
    if (m >= recentMonthFloor()) active.push(m);
  });
  active.sort();
  return active;
}

// Current and previous Manila month — always searched, rollup or not.
function recentMonthFloor() {
  const t = manilaToday();
  let y = Number(t.slice(0, 4));
  let m = Number(t.slice(5, 7)) - 1;
  if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

/* ---- date helpers (Manila, fixed +8 — same approach as business-hours.js) ---- */

function manilaToday() {
  return new Date(Date.now() + 8 * 60 * 60000).toISOString().slice(0, 10);
}

function isDay(v) { return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v); }

function monthsBetween(from, to) {
  const out = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ey, em] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function daysInMonth(yyyyMm) {
  const y = Number(yyyyMm.slice(0, 4));
  const m = Number(yyyyMm.slice(5, 7));
  // Day 0 of the NEXT month is the last day of this one.
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= n; d += 1) out.push(`${yyyyMm}-${String(d).padStart(2, "0")}`);
  return out;
}

function clampInt(v, dflt, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Bounded parallelism — 400 simultaneous Queries would just self-throttle.
async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}
