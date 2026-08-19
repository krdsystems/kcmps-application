# Cash Book + Job Costing — design plan (2026-08-18)

Status: **plan only, nothing built.** Written from an owner brain-dump in a Claude Code session
on 2026-08-18. Decisions marked **[owner]** were answered by the owner in that session;
everything else is a recommendation open to change.

---

## 1. What this is, and what it deliberately is not

**The problem:** storefront and walk-in transactions are hardly recorded. Money moves —
a walk-in pays cash for photocopying, a supplier is paid for totebag blanks — and none of it
has a home. Staff have no way to log it, and at month end there is no answer to "what came in,
what went out, and did we actually make money on that job."

This passes the repo's governing rule (`docs/roadmap.md` line 8, from
`project_knowledge/ERP_System_Project_Knowledge.md` Part 0): *build a module only when a real
decision or transaction currently has no home.* These transactions have no home. The trigger
has fired.

**What it is:** an operational record of cash movement, plus per-job costing so a finished job
can report its own profit.

**What it is NOT — and must not drift into:**
- Not double-entry accounting. No chart of accounts, no journals, no trial balance.
- Not BIR invoicing or a CAS-registered system. `ERP_System_Project_Knowledge.md` Part 5 is
  explicit: books and BIR-compliant invoices come from an **integrated, already-accredited
  accounting platform**, never a hand-built one. Internalizing invoicing is a planned, funded,
  compliance-scoped Stage 3 step — never an accidental "we already sort of do invoices."
- Not accrual accounting. See the cash-basis decision in §3.
- Not inventory / COGS. Deliberately deferred (`docs/roadmap.md` "Deliberately deferred").
  §6 explains where this feature brushes against inventory and how it stops short.

This ledger's long-term job is to **feed** the accounting platform (CSV export, §8), not to
replace it.

---

## 2. The two traps that make this worth planning rather than just building

### Trap 1 — double-counting online orders

Online orders already record real money: `backend/staff-api/verify-payment.js` is the point at
which staff confirm GCash payment actually arrived. If staff *also* hand-log those sales in the
cash book, every online sale is counted twice. Nothing errors; the month total is just wrong.

**Resolution — one ledger, two writers:**

| Writer | `source` | Editable in UI |
|---|---|---|
| `verify-payment.js` auto-posts on payment confirmation | `"system"` | No — read-only row |
| Staff manual entry | `"manual"` | Yes (void-only, see §4) |

Both write the same transaction item type. Manual entry against an order that already has a
system-posted transaction warns before saving. This *is* the jobs↔transactions linking the
owner asked for, designed so the two views cannot disagree.

### Trap 2 — not every cost is a cash movement

The owner's real example (totebag client, §5) listed four costs. They are not the same kind of
thing:

- **Totebag blanks** — cash left the business, paid to a supplier.
- **DTF transfers** — cash out *if outsourced*; if pulled from a roll already owned, the cash
  left when that roll was bought.
- **Labor** — depends entirely on how staff are paid.

If a labor cost is booked against the job *and* the payroll payment is booked when actually
paid, expenses are double-counted.

**Resolution:** every cost line carries `affectsCash: boolean`.

- `affectsCash: true` → hits job profit **and** the daily cash book / drawer.
- `affectsCash: false` → hits job profit **only** (an internal allocation).

**[owner, 2026-08-18]** Labor is currently **piece-rate, paid per job** — so today it *is* a
real cash movement and `affectsCash` defaults to `true` for effectively every line. The flag is
still built now because two predictable changes make it load-bearing:

1. hiring a **salaried** staffer (labor stops being per-job cash), and
2. drawing materials from **stock bought earlier** (DTF is the likely first case).

Building the flag costs one boolean today. Retrofitting it later means re-deriving which
historical lines were cash and which were allocation — information that is gone. This is the
ERP file's *capture before display, foundation before feature* rule applied literally.

---

## 3. Decisions

| # | Decision | Value | Why |
|---|---|---|---|
| D1 | Basis | **Cash-basis** — record when money moves, not when an order is confirmed | Simplest, matches a pre-BIR shop, and is the only basis under which the physical drawer reconciles |
| D2 | Mutability | **Append-only.** No edit, no delete — corrections are *voids* that write a reversing entry | A money record that can be silently edited is worthless as a record. Matches the existing `EVENT#` audit convention |
| D3 | Money representation | **Integer centavos** via `toCentavos()` at the edge | `backend/lib/money.js`; repo-wide rule, floats never stored |
| D4 | Dates | **Asia/Manila** (fixed +8) via `backend/lib/business-hours.js` | A UTC `toISOString().slice(0,10)` files every evening transaction under tomorrow |
| D5 | The "job" | **An existing order** — including manual/walk-in orders | `create-manual-order.js` already mints real orders in the same ID space; no new entity needed |
| D6 | Rush fee **[owner]** | A **cost paid out** (supplier rush / overtime / courier), not a customer charge | Owner-confirmed 2026-08-18 |
| D7 | Labor **[owner]** | **Piece-rate, paid per job** → `affectsCash: true` today | Owner-confirmed 2026-08-18. See Trap 2 for why the flag still exists |
| D8 | Placement | Its **own dashboard page**, with a summary card on `today.html` linking into it | `today.html` is "daily control"; a full ledger crowds it |

### Resolved since

- **O1 — Permissions. RESOLVED [owner, 2026-08-18], built and verified on staging.** Any
  `isStaff()` may **log** transactions and **read the day view**; `requireRole(Admin)` gates
  **void**, **month totals**, and **job profit/margin**. `ROLES.STAFF` is deliberately *not*
  treated as a capability — the same rule `backend/lib/mail.js` already enforces: `Staff` means
  "may open the dashboard", not "may do this". `Finance` is **not** in the Admin-gated set
  today; it logs and reads a day like any other staff role, and promoting it is a one-line
  change when a real Finance hire exists. Wired now even though all four founders are Admin,
  because gating later means auditing every historical action to work out who should have been
  allowed to do what. Verified against the deployed staging Lambdas: a `[Staff]` claim gets 200
  on the day view, 403 on void, 403 on month totals, 403 on job costing.

### Still open

- **O2 — DTF sourcing.** Outsourced (cash) or drawn from owned stock (allocation)? Determines
  the default `affectsCash` for the most common cost line. See §6.
- **O3 — Page name.** "Cash Book" vs "Transactions" vs "Ledger". Doc uses **Cash Book**.

---

## 4. Data model

Reuses seats already reserved in `backend/lib/keys.js`. No new key conventions.

| Item | PK | SK | Notes |
|---|---|---|---|
| Transaction (cash movement) | `TXN#<YYYY-MM-DD>` | `TXN#<ISO>#<txnId>` | Manila date. One day = one partition |
| Job cost line | `ORDER#<orderId>` | `COST#<ISO>#<costId>` | Co-located with its order |
| Order↔txn pointer | `ORDER#<orderId>` | `TXN#<ISO>#<txnId>` | So job view sees payments without a scan |
| Day rollup | `METRIC#DAY#<YYYY-MM-DD>` | `SUMMARY` | `dayMetricPk()` + `summarySk()` — already defined |
| Month rollup | `METRIC#MONTH#<YYYY-MM>` | `SUMMARY` | `monthMetricPk()` — already defined |
| Categories config | `CONFIG#TXN_CATEGORIES` | `META` | `configPk()` — already defined |

**Why rollups rather than summing rows:** a month total must not require 31 partition queries.
Counters are bumped with an atomic `ADD` **inside the same `TransactWriteItems`** as the
transaction write, so a total can never drift from the rows that produced it. This reuses the
`METRIC#` seats the schema reserved for exactly this and does **not** constitute building the
deferred analytics plane — these are transactional counters, not an S3/Athena reporting layer.

**Co-location** of `COST#` and the txn pointer under `ORDER#` is the same trick `EVENT#` and
`MSG#` already use: one query on the order partition returns revenue + costs + profit for a job.

**Void (D2):** writes a reversing entry, flags the original `voided: true` with
`voidReason` + actor, and `ADD`s the negation to the rollups. Original row is never mutated
beyond the flag and never deleted.

**Idempotency:** every write carries a client-generated key via the existing
`idempotencyPk()`. A double-tap on mobile must not create two transactions.

### Cost line shape

Store **qty and unit cost**, not just a total — this is what yields per-unit economics (§5):

```
{ costId, orderId, label, category, qty, unitCostCentavos,
  amountCentavos,          // derived = qty * unitCost, stored for auditability
  affectsCash,             // Trap 2
  incurredAt, actorSub, source }
```

**[amended, prototype build 2026-08-18] Which field is authoritative depends on which one
staff actually typed — never round-trip through the other:**

- **Staff enter qty × unit cost:** store all three, with `amountCentavos = qty *
  unitCostCentavos` computed exactly, in integer centavos. This is exact by construction —
  there is no rounding step at all.
- **Staff enter only a total:** store the total as authoritative and derive `unitCostCentavos`
  for *display only* (`amountCentavos / qty`, rounded once, at render time).
- **Never store a rounded unit cost and re-multiply it back into an amount.** ₱1,960 ÷ 150 =
  ₱13.0666…, which rounds to ₱13.07 for display; ₱13.07 × 150 = ₱1,960.50, not ₱1,960 — a
  46-centavo silent corruption of a real total the owner actually paid, purely from picking the
  wrong field as authoritative. The prototype's seed data hits exactly this trap (the owner's
  real totebag figures don't divide cleanly) and is the reason the derived-unit rule above
  exists — see `dashboard-data.js`'s `CASHBOOK_DEMO_ORDER` seed comment for the worked case.

---

## 4a. Conventions settled while building Phase 1 (2026-08-18/19)

Recorded here so the next session does not re-derive them. All three were **verified by
invoking the deployed staging Lambdas and querying `kcmps-staging` directly**, not by reading
code. Backend lives in `backend/cashbook/` + `backend/lib/cashbook.js` (pure, unit-tested).

### The idempotency pattern (B1) — why `ClientRequestToken` is not enough

`TransactWriteItems` is **not** idempotent under SDK retry, and `ClientRequestToken` only
dedupes byte-identical requests inside a 10-minute window. Neither covers the real case: a
double-tap on a phone is a genuinely *new* request, and the rollup `ADD`s would bump twice with
nothing erroring — leaving a total no later void can reconcile, because nobody knows there were
ever two.

The write is therefore guarded **at the item level, inside the same transaction as the
counters**:

1. an `IDEMPOTENCY#<clientId>` record, `Put` with `ConditionExpression: attribute_not_exists(PK)`
2. the `TXN#` row itself, **keyed on that same client-generated id**, also
   `attribute_not_exists(PK)`
3. the `METRIC#DAY` / `METRIC#MONTH` `ADD`s

A replay fails (1); because a cancelled transaction applies **nothing**, the `ADD`s in (3) are
discarded with it. The counters cannot double-bump even in principle. The Lambda treats
`TransactionCanceledException` with `ConditionalCheckFailed` **at index 0** as *success* and
returns the original row with `idempotentReplay: true` — a replay means "your write already
landed", which is a 200, not a 409.

**The guard record in (1) is not redundant with (2)**, and this is the part that is easy to get
wrong: the `TXN#` row's sort key contains its ISO timestamp, so when the *server* supplies that
timestamp a replay computes a **different SK** and sails straight past a row-only condition.
The guard record has no timestamp in its key. It also stores the row's exact `{PK, SK}`, which
is what lets a void address a transaction by bare `txnId` with no day parameter — so a void can
never be aimed at the wrong partition by a caller guessing a date.

Auto-post from `verify-payment.js` (Trap 1, Phase 2) **must** reuse this same path with
`autoPostIdempotencyId(orderId, paymentId)`. That Lambda sweeps every line item still `Pending
Payment Verification` *plus* any already `On Hold` in one call, so a single invocation can
legitimately post more than once — keying on `orderId` alone would collapse those into one.

### Cross-day voids (B3) — the reversal lives in the ORIGINAL day's partition

A void writes its reversing row into the **original** day's partition (`TXN#<original day>`),
carrying its own `occurredAt` (the real moment of the void) and a `reversalDay` field recording
the calendar day it was actually made. Nothing about when it happened is lost.

Why: the invariant is **a day's `METRIC#DAY` rollup equals the sum of that day's `TXN#` rows**.
Filing the reversal under *today* would leave yesterday's rollup corrected while yesterday's
rows were not, permanently, and no later write could repair it without a cross-partition job.

**Voided rows and reversal rows are both excluded from totals** (`countsTowardTotals()`), and
the rollup is `ADD`ed the *negation* of the original — so net, gross-in, gross-out and count all
return to exactly their pre-transaction values. Both rows stay physically present forever;
append-only is preserved, they simply are not double-counted.

> A first implementation counted every row and let the direction-flipped reversal cancel the
> original. **Net was correct and every other field was wrong** — a day with one voided ₱35,000
> sale reported ₱35,000 in *and* ₱35,000 out and 3 transactions, none of which happened. Caught
> in staging UAT by reconciling the live rollup against the live rows, which is exactly why
> `GET /cashbook/day/{day}` returns `rollup`, `computed` and `reconciles` on every read rather
> than trusting the counter. Do not reintroduce it.

Proven live: voiding a `2026-08-18` row on `2026-08-19` left the reversal at
`PK: TXN#2026-08-18` / `reversalDay: 2026-08-19`; `2026-08-18` reconciled at zero with all 4
rows still in the partition, and `2026-08-19` was untouched.

### Sign is owned by the category, enforced server-side (B5)

Amounts are stored **positive-with-direction**; the one exception is a **sign-carrying
category** (`sign: -1`), today only `refund`, modelled as *negative revenue* rather than an
expense. Whatever sign a client sends is discarded and the category's own sign re-applied, with
`normalized: true` on the response so a stale client is visible rather than silently patched
over. A positive ₱500 refund posted against the deployed staging Lambda stored as `-50000`.

### `affectsCash: false` writes NO transaction (B8)

An allocation line writes the `ORDER#`/`COST#` item **and nothing else** — no `TXN#`, no
order→txn pointer, no rollup bump. Verified live: two cost lines against one order produced two
`COST#` items and exactly one `TXN#`.

### Two-level categories: category → subcategory (2026-08-19, owner-approved)

Every `DEFAULT_TXN_CATEGORIES` parent id is **frozen** (stored on existing rows, never renamed —
see the constant's own header comment) and now carries an optional `subcategories: [{id, label}]`
array. Subcategory ids are unique only **within** their parent, not globally.

**Subcategory is OPTIONAL on every write.** A staffer may always save the parent category alone;
`resolveSubcategory()` in `backend/lib/cashbook.js` returns `{subcategoryId: null,
subcategoryLabel: null}` when none is supplied, and both `validateTransactionInput` and
`validateCostInput` accept that. A `subcategoryId` that IS supplied must belong to the given
parent (cross-category and no-such-subcategory are both rejected with a 400) — the server owns
and validates the vocabulary; there is no free-text/client-invented category path.

Approved taxonomy:

| Parent (frozen id) | Subcategories (id — label) |
|---|---|
| `sale` | `print_office` — Print — office · `print_large` — Print — large format · `merch` — Merch / apparel · `design` — Design service · `walkin` — Walk-in |
| `other_income` | none |
| `refund` | none (still `sign: -1`, unchanged) |
| `materials` | `blanks` — Blanks (shirts/totebags) · `transfers` — Transfers (DTF/vinyl/subli) · `ink` — Ink & toner · `paper` — Paper & board · `packaging` — Packaging |
| `labor` | `piece_rate` — Piece-rate · `overtime` — Overtime |
| `service` | `subcontract` — Subcontracted print · `rush` — Rush fee · `courier` — Courier |
| `supplies`, `rent`, `utilities`, `transport`, `equipment`, `misc` | none |

Existing rows written before this change have no `subcategoryId` field at all (not even `null`)
— there is no backfill/migration, and `countsTowardTotals()`/rollups/job-costing all read them
unaffected, verified live against a pre-existing production-shaped row.

Frontend: `website/dashboard/cashbook.html`'s chip-based category picker was replaced with a
searchable combobox (`dashboard-shell.js`'s `createCombobox()`, shared with the "link to job"
order picker below) — type-to-filter across both levels, most-used-first when the search box is
empty (persisted via `KCMPS_DASH`'s `recordCashbookCategoryPick()`/`getCashbookRecentPicks()`,
never direct `localStorage`), full-screen sheet on mobile (≤760px) mirroring `store.js`'s
`.design-subcatalog` pattern, anchored dropdown on desktop.

### Job picker: search by name, store the id (2026-08-19, owner-approved)

The "Link to job / Order ID" field is the **same** combobox, reusing `getAllOrders()` (no new
search endpoint) fetched once and filtered client-side — real search-index limits apply (see the
GSI2 note in §7); fine at this shop's volume. The stored value is always the order id; a
pasted/typed raw id still works even if the picker never loaded (`allowFreeText`), and a failed/
slow/forbidden orders fetch degrades to plain text entry rather than blocking logging money.
Recent jobs (`getCashbookRecentOrderIds()`) are pinned above search results, no typing required
— the common case is several cost lines against the same job in one sitting. Selecting a job
derives the Client field from it (read-only while linked, so there is never a second,
independently-typed value that could disagree) — clearing the link restores the manual input.
Placement is a **permanent** field between Payment method and Save, not inside the collapsed
"extras" disclosure (which still holds only genuinely occasional fields: note, qty, unit cost,
the allocation checkbox).

---

## 5. Worked example — the owner's real totebag job

Owner's figures: transaction worth ₱35,000; costs totebag ₱19,500, DTF ₱1,960, rush fee ₱500,
labor ₱1,500. Quantity of 150 pcs is **illustrative** (chosen so ₱19,500 ÷ 150 = ₱130/bag);
real qty comes from the order.

| Line | Type | Qty | Unit | Amount | Cash? |
|---|---|---|---|---|---|
| Totebag order | Revenue | 150 | ₱233.33 | **+35,000.00** | in |
| Totebag blanks | Cost · materials | 150 | ₱130.00 | −19,500.00 | out |
| DTF transfers | Cost · materials | 150 | ₱13.07 | −1,960.00 | out (see O2) |
| Rush fee | Cost · service | — | — | −500.00 | out |
| Labor | Cost · labor | — | — | −1,500.00 | out (piece-rate, D7) |

- **Total cost:** ₱23,460.00
- **Job profit:** ₱35,000 − ₱23,460 = **₱11,540.00**
- **Margin:** 32.97%
- **Per bag:** ₱233.33 revenue − ₱156.40 cost = **₱76.93 profit/bag**
- **Net cash movement:** **+₱11,540.00** (identical to profit, because every line is cash today)

The per-unit figure is the number that answers "should we take the next job like this," and it
only exists because qty/unit cost are stored rather than bare totals.

Under D7's future change (salaried staff), the same job would report profit ₱11,540 but cash
+₱13,040 — two different, both-correct numbers from one entry. That divergence is the entire
reason `affectsCash` exists.

---

## 6. Where this stops short of inventory

Deliberate boundary. If 500 totebags are bought and 150 used on this job, cash left once (the
purchase) while the job should carry only the 150 consumed. Doing that correctly requires
inventory + COGS, which `docs/roadmap.md` defers until real consumption events exist.

**Interim rule:** cost lines are allocated at **actual purchase cost for job-specific buys**.
Materials drawn from existing stock are entered as an allocation (`affectsCash: false`) at
estimated unit cost. This is approximate and should be labelled as such in the UI — it is not a
stock-accurate COGS figure, and pretending otherwise is how "ERP builds rot"
(`ERP_System_Project_Knowledge.md` §on operational vs analytical planes).

O2 (DTF sourcing) is the first real instance of this.

---

## 7. Grouping by client — the one real blocker

The owner wants "see everything for this client." Two facts from `CLAUDE.md`:

1. The client dropdown in `jobs.html` is **local autocomplete convenience only — there is no
   real Client/CRM entity.**
2. **GSI2 is not provisioned** on the table (`foundation.cfn.yaml` provisions GSI1 only).

But `backend/lib/keys.js` already writes `clientGsi2Pk()` / `orderGsi2Sk()` attributes *in
preparation*, precisely so adding the index later needs zero backfill.

| Stage | Approach | Good for |
|---|---|---|
| Now | Normalized client name on the order; aggregate client-side | Current volume (4-person shop, low order count) |
| Proper | **Provision GSI2**; query client → orders → costs | Real per-client history at any volume |

Provisioning GSI2 is a small, well-anticipated infra step with a modest write-cost increase
(a GSI roughly duplicates write cost for indexed items). It should be costed against the ₱500
soft cap when scheduled — see `docs/cost-governance.md`.

---

## 8. Features required to make this actually work

Beyond what the owner described. Grouped by necessity.

**Must have**
- **Payment method** (cash / GCash / bank / card). Without it the drawer cannot be reconciled,
  and GCash reconciliation is already how this shop operates.
- **Expense categories** — supplies, rent, utilities, salaries, transport, equipment, misc.
  Without these the month view is a single meaningless number.
- **Refunds as negative revenue**, never as an expense — otherwise both sides inflate and
  margin lies. **[amended, prototype build 2026-08-18]** Concretely: a refund is a
  **Revenue-side category** (`direction: "in"`) whose stored `amountCentavos` is **negated**,
  and that sign is owned by the category's own config (`{ id: "refund", ..., sign: -1 }`),
  never by a staffer typing a minus into the amount field. Staff always type a positive number;
  the write path looks up the chosen category's `sign` and negates at that point. This keeps
  the amount input's validation simple ("must be > 0" always holds) and makes the behavior
  generic — any future sign-carrying revenue category (e.g. a chargeback) works the same way
  with no new code path. A display consequence falls out of this for free: the +/− glyph on a
  ledger row must be derived from the *resulting signed value*
  (`(direction === "out" ? -1 : 1) * amountCentavos`), not from `direction` alone, or a refund
  (still `direction: "in"`) would render with a "+" while actually decreasing revenue.
- **Staffer attribution** from the JWT `sub` (same pattern as `correspondenceLog`); voids
  require a reason.
- **Categories as config**, not hardcoded — `CONFIG#TXN_CATEGORIES`, seeded from catalog
  leaves, editable in Settings. This is the owner's "flexible enough to add products."

**Should have**
- **End-of-day cash reconciliation** — opening float + cash in − cash out = expected; count,
  record variance. This is the actual reason shops keep a cash book.
- **Receipt photo** on expenses — reuses the existing presigned-upload + GuardDuty scan path
  (design uploads / payment proof), including its fail-closed "no verdict, no download" rule.
- **CSV export** — the handoff to the accounting platform (§1). **[amended, prototype build
  2026-08-18]** All amount cells are stored as positive magnitudes except where a category's
  sign already applies (refunds — see above), so a plain `SUM()` over the amount column
  double-counts every voided/reversed row. The export encodes a netting convention via two
  columns so the file can be safely summed without staff needing to know the internal void
  model:
  - **`Counts toward totals`** — `yes`/`no`, `true` only for a row that is `!voided &&
    !isReversal` **and** is an actual cash movement (`affectsCash`). A voided original is
    excluded because it's voided; its reversing entry is excluded because excluding the pair
    together is the same arithmetic as netting them and easier to audit; a non-cash allocation
    line (Trap 2, `affectsCash: false`) is excluded because it never moved cash and would
    corrupt a cash-net sum even though it's real for job-profit purposes.
  - **`Signed amount (PHP)`** — revenue positive, expense negative
    (`(direction === "out" ? -1 : 1) * amountCentavos`, the same convention the on-screen
    ledger's +/− glyph uses). `SUM(Signed amount WHERE Counts toward totals = yes)` over a day's
    export equals that day's cash net exactly.
  - Numeric cells (`Amount (PHP)`, `Signed amount (PHP)`, `Unit amount (PHP)`) are exempted from
    the CSV formula-injection guard (which prefixes a leading `=`/`+`/`-`/`@` with a literal
    quote) — a legitimately negative amount like `-500.00` matches
    `/^-?\d+\.\d{2}$/`, which cannot itself be an injected formula, but WOULD be silently turned
    into a text cell by the guard, breaking `SUM()` for every spreadsheet reader. Free-text
    cells (notes, labels, category names, client names) keep the guard applied exactly as
    before — it is still load-bearing there.
- **Cost templates** — "Totebag + DTF" prefills the standard lines; staff edit amounts. On
  mobile this is the difference between costs being logged and not bothering.
- **Estimated vs actual cost** — store the cost assumed at quoting time. After a handful of
  jobs this reveals systematic underquoting, which is the highest-value number a print shop can
  have and is nearly free to capture.
- Filter by category / method / staffer.

**Explicitly not now**
P&L with accruals, payroll, supplier invoices/POs, inventory decrement, COGS. Reserved seats,
dark until their own triggers fire.

---

## 9. Mobile-first UI

**[owner] Staff use mobile more than desktop — mobile is the primary target, not the fallback.**

The owner's described layout (left entry rail, right transaction list) is a desktop shape. It
inverts on mobile. Same DOM, CSS-only — the same technique the mobile hero already uses
(re-sequencing with flex `order`, never reordering markup).

### Mobile (≤760px) — the list *is* the page
- Sticky top: month strip — **in / out / net**
- Date strip: `‹  Tue Aug 18 · Today  ›`, tap opens a date picker
- Transaction list, newest first: category, staffer, method chip, amount (+green / −red)
- Fixed bottom bar: **＋ Log transaction** (thumb zone)
- Tap → bottom sheet, in this order:
  1. **Revenue | Expense** segmented control (sets the sign)
  2. **Amount, autofocused** — amount-first is the fastest possible entry
  3. Category chips → method chips
  4. Optional: link to order, note, receipt photo
  5. Full-width Save

### Desktop (≥761px)
The owner's two-pane: sticky always-open left form rail + right list. No sheet.

### Mobile specifics that are load-bearing, not polish
- **Category chips, not a `<select>`.** The owner already rejected a `<select>` as too hard to
  use on the bulk-quote picker (`CLAUDE.md`, "Bulk-quote product picker"). Same lesson.
- `inputmode="decimal"` on amount → numeric keypad, no spinners.
- Nothing hover-dependent — see the repo's `(hover: hover) and (pointer: fine)` gotchas.
- Minimum 44px tap targets.
- **Optimistic insert + retry queue.** Shop wifi is spotty; a half-typed entry lost to a
  dropped request is how staff stop trusting the tool.
- **Double-tap guard** backed by the idempotency key (§4).

All UI goes behind the existing `window.KCMPS_DASH` seam in `dashboard-data.js` — no page
touches `localStorage` or `fetch` directly.

---

## 10. Phasing

| Phase | Scope | Why this order |
|---|---|---|
| **1** | Manual log + day view + day/month rollups. Mobile sheet, real backend. Categories config. | Useful on day one; the cash book stands alone without job costing |
| **2** | Job costing: `COST#` lines, qty/unit cost, profit + per-unit margin on `job-detail.html`. Auto-post from `verify-payment.js` (Trap 1). | Needs Phase 1's transaction type to exist first |
| **3** | Cash reconciliation, receipt photos, CSV export, cost templates, estimate-vs-actual. | Refinements; none block daily use |
| **4** | GSI2 + real per-client rollups (§7). | Infra step, costed separately |

---

## 11. Cost

Negligible against the ₱500/mo soft cap: a few hundred small DynamoDB writes per month on a
table that already exists, plus rollup updates in the same transaction. The only line item
needing its own justification is **GSI2 in Phase 4** (§7) — modest, but it should be stated
when scheduled per `docs/cost-governance.md`.

---

## 12. Deployment

Standard repo gate, no exceptions: `dev.kcmps.com` + `kcmps-backend-staging` first, production
only on the owner's explicit go-ahead. Any production push mirrors back to `dev-site/` in the
same turn (`CLAUDE.md`, "A production push mirrors back to staging too").
