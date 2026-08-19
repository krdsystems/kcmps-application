/* ============================================================
   KCMPS Cash Book — GET /cashbook/history
   ============================================================
   The year → month → day drill-down behind the Cash book's History tab.

     GET /cashbook/history            -> years, each with its months
     GET /cashbook/history?month=YYYY-MM -> that month's days

   Transactions for a single day are NOT served here — the page calls the
   existing GET /cashbook/day/{day} for that, so there is exactly one
   implementation of "what happened on this day" (and only that one
   returns `reconciles`, which a totals view must never quietly lose).

   AUTH: requireRole(Admin). Owner decision O1 (2026-08-18) makes month
   totals and job margin Admin-only while logging and reading a single
   day stay isStaff(). This endpoint IS month totals — served a year at a
   time — so gating it any looser would be a back door around
   get-month.js, and the two would disagree about who may see the same
   number. Re-confirmed by the owner on 2026-08-20 when this was built.

   ------------------------------------------------------------
   Reads rollups, never transactions
   ------------------------------------------------------------
   Every figure here comes from the METRIC#MONTH / METRIC#DAY summary
   items that log-transaction.js and void-transaction.js maintain inside
   the same TransactWriteItems as the rows themselves. So a whole year
   costs at most 12 GetItems and a month at most 31 — it never reads a
   single transaction, and the cost does not grow with how busy a month
   was.

   Year totals are summed from the month rollups HERE rather than in the
   page, so the year row and the month rows under it can never disagree
   about the same money, and a future CSV export of this view gets the
   identical arithmetic for free.

   A month/day with no rollup item is a month/day with no transactions —
   every writer bumps the rollup in the same transaction as the row, so
   absence is a real zero, not missing data. Those are omitted rather
   than rendered as zero rows: a history of an eight-month-old business
   should not open with four years of empty months.
   ============================================================ */

const {
  monthMetricPk, dayMetricPk, summarySk,
  extractClaims, requireRole, ROLES,
} = require("../lib");
const { TABLE, dynamo, response } = require("./shared");
const { GetCommand } = require("@aws-sdk/lib-dynamodb");

const MAX_MONTHS = 60;         // 5 years
const CONCURRENCY = 8;
// Nothing in this business predates 2026; a floor keeps a hand-edited
// `from` from turning into hundreds of pointless reads.
const EPOCH_MONTH = "2026-01";

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims || !claims.sub) return response(401, { error: "Unauthorized" });
  const denied = requireRole(claims, [ROLES.ADMIN]);
  if (denied) {
    return response(403, { error: "Month and year totals are visible to Admins only." });
  }

  const q = event.queryStringParameters || {};

  try {
    if (q.month) {
      if (!/^\d{4}-\d{2}$/.test(q.month)) return response(400, { error: "month must be YYYY-MM" });
      return await handleMonth(q.month);
    }
    return await handleYears();
  } catch (err) {
    console.error("get-history error:", err);
    return response(500, { error: "Something went wrong. Please try again." });
  }
};

/* ---- years -> months ---- */

async function handleYears() {
  const months = monthsFrom(EPOCH_MONTH, currentMonth()).slice(-MAX_MONTHS);
  const rollups = await mapLimit(months, CONCURRENCY, async (m) => {
    const res = await dynamo.send(new GetCommand({
      TableName: TABLE, Key: { PK: monthMetricPk(m), SK: summarySk() },
    }));
    return { month: m, item: res.Item || null };
  });

  const byYear = new Map();
  for (const { month, item } of rollups) {
    if (!item || !hasActivity(item)) continue;   // real zero — omit, see header
    const year = month.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(totals(month, item, "month"));
  }

  const years = [...byYear.entries()]
    .map(([year, monthRows]) => {
      monthRows.sort((a, b) => b.month.localeCompare(a.month));   // newest first
      return { year, ...sumRows(monthRows), months: monthRows };
    })
    .sort((a, b) => b.year.localeCompare(a.year));

  return response(200, { years, grandTotal: sumRows(years) });
}

/* ---- one month -> its days ---- */

async function handleMonth(month) {
  const days = daysInMonth(month);
  const rollups = await mapLimit(days, CONCURRENCY, async (d) => {
    const res = await dynamo.send(new GetCommand({
      TableName: TABLE, Key: { PK: dayMetricPk(d), SK: summarySk() },
    }));
    return { day: d, item: res.Item || null };
  });

  const rows = rollups
    .filter(({ item }) => item && hasActivity(item))
    .map(({ day, item }) => totals(day, item, "day"))
    .sort((a, b) => b.day.localeCompare(a.day));

  return response(200, { month, days: rows, ...sumRows(rows) });
}

/* ---- shaping ---- */

// A rollup that exists but records nothing (every transaction on it was
// voided) is still an empty period as far as this view is concerned.
function hasActivity(item) {
  return Number(item.txnCount || 0) > 0
    || Number(item.cashInCentavos || 0) !== 0
    || Number(item.cashOutCentavos || 0) !== 0;
}

function totals(key, item, kind) {
  const inC = Number(item.cashInCentavos || 0);
  const outC = Number(item.cashOutCentavos || 0);
  return {
    [kind]: key,
    inCentavos: inC,
    outCentavos: outC,
    // Recomputed rather than trusting the stored net, so the three
    // columns on a row are always internally consistent even if a
    // counter were ever repaired by hand.
    netCentavos: inC - outC,
    txnCount: Number(item.txnCount || 0),
  };
}

function sumRows(rows) {
  return rows.reduce((acc, r) => ({
    inCentavos: acc.inCentavos + r.inCentavos,
    outCentavos: acc.outCentavos + r.outCentavos,
    netCentavos: acc.netCentavos + r.netCentavos,
    txnCount: acc.txnCount + r.txnCount,
  }), { inCentavos: 0, outCentavos: 0, netCentavos: 0, txnCount: 0 });
}

/* ---- dates (Manila, fixed +8 — same approach as business-hours.js) ---- */

function currentMonth() {
  return new Date(Date.now() + 8 * 60 * 60000).toISOString().slice(0, 7);
}

function monthsFrom(startMonth, endMonth) {
  const out = [];
  let y = Number(startMonth.slice(0, 4));
  let m = Number(startMonth.slice(5, 7));
  const ey = Number(endMonth.slice(0, 4));
  const em = Number(endMonth.slice(5, 7));
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
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();   // day 0 of next month
  const out = [];
  for (let d = 1; d <= n; d += 1) out.push(`${yyyyMm}-${String(d).padStart(2, "0")}`);
  return out;
}

async function mapLimit(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}
