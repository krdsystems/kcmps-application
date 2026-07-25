# KCMPS ERP System — Project Knowledge

**Kaalyados Creatives Merchandise & Printing**
Manila-based, established 2026 | 4 founders

---

## Purpose of This File

Supersedes the framing of the standalone Operations Dashboard file by placing it inside a **complete ERP**. Companion to the Technical, Revenue Model, Marketing, and Payment System Project Knowledge files.

The prior plan designed a good *operations dashboard*. This file designs an **ERP that is small enough to run today with 4 founders and ₱500/month, and structured so it scales into a full enterprise system without a rewrite.** The operations dashboard is not discarded — it becomes the Production/MES + Analytics modules of the ERP.

**Governing constraint:** every scaling decision must be *additive*, never a migration. We build a modular monolith on the existing serverless stack, with clean module boundaries and an event backbone, so growth means turning on a module — not rebuilding the core.

---

## Part 0 — What "ERP" Means Here (and What It Deliberately Doesn't, Yet)

An ERP is one shared data model and one event flow across every business function, so a fact is entered once and every module that needs it reads the same truth. That single principle — **enter once, use everywhere** — is the entire point. It is the same "zero re-entry" idea from the ops research, generalized from the shop floor to the whole company.

The trap for a 4-person shop is building all of ERP at once. We avoid it with a rule:

> **Build the module only when a real decision or transaction currently has no home.** Everything else is a defined interface with a stub behind it. A stubbed module costs nothing but reserves its seat in the data model so it slots in later without reshaping anything.

So this is a *complete ERP architecture* with a *deliberately partial initial build*. The completeness is in the design; the partiality is in what ships first.

---

## Part 1 — The Module Map

Nine modules. For each: what it does, whether KCMPS **builds** it or **integrates** an existing system, and when.

| # | Module | Core job | Build vs. integrate | Ships in |
|---|---|---|---|---|
| 1 | **Sales & Order Mgmt** | Storefront, quote-to-order, mixed cart, order lifecycle | **Build** (mostly exists) | Launch |
| 2 | **CRM** | Client records, order history, reorder, quiet-client detection | **Build** (thin at first) | Launch |
| 3 | **Production / MES** | Job pipeline, scheduling, QC, spoilage, the `/today` `/week` `/month` dashboards | **Build** (this is the ops dashboard) | Launch → post-launch |
| 4 | **Inventory & Materials** | Stock, consumables, BOM per SKU, reorder points, valuation | **Build** (basic first) | Launch → grow |
| 5 | **Procurement / Suppliers** | Supplier records, purchase orders, receiving | **Build** (light) | Growth |
| 6 | **Finance & Accounting** | AR/AP, invoicing, GL, VAT, BIR books | **Integrate** an accredited system first; internalize later | Growth |
| 7 | **HR & Payroll** | Employees, SSS/PhilHealth/Pag-IBIG, DOLE, payroll | **Integrate / defer** until non-founder staff exist | Later |
| 8 | **Analytics / BI** | Cadence dashboards + cross-module reporting | **Build** (operational) + **add tier** (analytical) at scale | Launch → grow |
| 9 | **Platform / Admin** | Auth, roles, audit trail, master data, settings | **Build** (foundation) | Launch (first) |

The single most consequential call is **Module 6: do not build your own accounting/invoicing engine first** — see Part 4. It's a regulatory and effort trap that the print-MIS industry itself avoids.

---

## Part 2 — Scalability Architecture (the heart of the revision)

The question "will this scale?" is really three questions: will the **data model** scale, will the **compute** scale, and will the **reporting** scale. They have different answers and different scaling points.

### 2.1 The honest tension

The existing stack (single-table DynamoDB + Lambda) is *excellent* for the operational/transactional side of an ERP — high-volume, key-based reads and writes, cheap, serverless. It is *poor* for the cross-module, ad-hoc, relational reporting a maturing ERP eventually needs ("show me margin by client by product line by quarter, joined to procurement cost"). Pretending one database does both well is how ERP builds rot.

The scalable answer is not to pick one database. It's to **separate the operational plane from the analytical plane** and let each scale on its own curve.

### 2.2 The three-stage scale path

**Stage 1 — Modular monolith (now, 4 founders, launch):**
- One DynamoDB single table, one set of Lambdas behind one API Gateway, gated by Cognito groups.
- Modules are *code boundaries and key-prefix boundaries*, not separate services. `ORDER#`, `CLIENT#`, `INV#`, `SUPPLIER#`, `PO#`, `METRIC#`, `EVENT#` all in one table.
- Everything reactive runs off **DynamoDB Streams → one dispatcher Lambda** that fans out to per-module handlers.
- Analytics is the pre-aggregated counter pattern from the ops design (`METRIC#DAY#…`). No analytical database yet.
- Cost: unchanged, ~₱120–250/month.

**Stage 2 — Add the analytical plane (growth, first employees, real reporting need):**
- Turn on **DynamoDB → S3 export** (point-in-time export or Streams → Firehose → S3 as Parquet).
- Query it with **Athena**, visualize with **QuickSight** (or keep the custom `/month` view, now reading Athena for the heavy joins).
- Operational reads stay on DynamoDB and stay fast/cheap; analysts hit S3/Athena and never touch the operational table. This is the split that lets reporting get arbitrarily complex without threatening operational latency or cost.
- Introduce **EventBridge** as the event backbone alongside Streams — external integrations (accounting, later payroll) subscribe to events instead of being wired point-to-point.
- Cost: +~$5–15/month at this stage. Athena/QuickSight are pay-per-query/per-user.

**Stage 3 — Split into services (scale, multi-site or multiple non-founder teams):**
- The clean module boundaries from Stage 1 become the seams. A module that needs to scale or deploy independently (typically Finance, or Production if multi-site) splits into its own Lambda set + API + possibly its own store.
- Modules that are genuinely relational-heavy (Finance, if internalized) can move to **Aurora Serverless v2** while the rest stay on DynamoDB. The event backbone keeps them consistent.
- Multi-site / multi-tenant: add a `tenantId` / `siteId` partition dimension. Reserved in the key design from day one (see 2.3) so this is a filter, not a migration.
- Cost: scales with actual usage; still no fixed per-seat licensing, which is the structural advantage over buying an off-the-shelf ERP.

**The point of the three stages:** at every step, the previous stage keeps working unchanged. You are adding planes and splitting seams, never migrating data out of a design that assumed something smaller.

### 2.3 Data-model decisions that must be made NOW to allow later scale

These cost nothing today but are expensive to retrofit, so they go in at launch even though nothing uses them yet:

1. **`tenantId` / `siteId` on every item.** One value for now (`SITE#MNL`). Reserves multi-location without a re-key later.
2. **Immutable event log** (`EVENT#<ts>#<lineItem>`), already in the ops design. This *is* the ERP audit trail and — critically — the raw material BIR expects a computerized system to preserve. Never delete or mutate an event.
3. **Master-data records as first-class items** (`SKU#`, `MATERIAL#`, `STATION#`, `SUPPLIER#`, `CLIENT#`, `TAXRATE#`), each with a stable ID that other modules *reference*, never copy. This is what makes "enter once" real across modules.
4. **Money stored in centavos as integers**, with an explicit `currency` field. Floats in financial data are a scale-stage nightmare.
5. **`schemaVersion` on every item.** Lets you evolve records module-by-module without a big-bang migration.
6. **Soft-delete + status, never hard delete** on any record a report or the tax authority might need historically.

### 2.4 What "scalable" explicitly does NOT mean

It does not mean building for a thousand users on day one — that's the opposite mistake. It means: small footprint now, and no decision made now that has to be *un*made to grow. Concretely, we are *not* adding Kubernetes, a message queue cluster, a data warehouse, or microservices at launch. Those are Stage-2/3 answers to Stage-2/3 problems.

---

## Part 3 — Module Detail

### 3.1 Platform / Admin (Module 9 — build first, it's the foundation)

- **Auth & roles.** Extend the existing Cognito Customer/Staff split into ERP roles: `Customer`, `Production`, `Sales`, `Finance`, `Admin`. All four founders get `Admin` now (see everything). The finer roles exist in the model immediately so that hiring a production helper later is a group assignment, not a rebuild — consistent with the Technical file's deferred-staff-roles note, but the *slots* are defined now.
- **Master data management.** SKUs, materials, stations, tax rates, SLA windows, reorder points — all editable in `/settings`, all referenced by ID elsewhere.
- **Audit trail.** The event log doubles as who-did-what. Required at ERP scale and for BIR.
- **Feature flags per module.** How a stubbed module stays dark until switched on.

### 3.2 Sales & Order Management (Module 1 — mostly exists)

Carries over wholesale from the Payment System file: mixed cart (`sku` + `custom` line items), one order ID, split fulfillment, composite order status. No change except that it now writes into the shared ERP model and emits events other modules consume.

### 3.3 CRM (Module 2 — thin now, grows)

- Now: client record, order history, reorder-from-history, the quiet-client detection the Revenue Model file depends on for B2B outreach.
- Scale: quote pipeline, contact log, segmentation, campaign linkage (Marketing file). Reserved via `GSI2PK = CLIENT#<id>`.

### 3.4 Production / MES (Module 3 — this is the operations dashboard)

**Unchanged in substance from the Operations Dashboard file — it is imported here as a module, not rewritten.** Summary of what it contributes to the ERP:

- Unified line-item state machine (`Quoted → Priced → Confirmed → Scheduled → In Production → QC → Dispatch → Delivered`, plus exception states).
- The three cadence views — `/today` (daily control), `/week` (capacity & scheduling), `/month` (trend/margin/learning) — mapped to daily/weekly/monthly decision frequency.
- Every status transition writes an `EVENT#` record; from that single stream, cycle time, makeready, utilization, queue aging, OTIF, and NRFT are all derived for free.
- Two manual captures only: **spoilage + reason code** at QC, and **setup minutes** (one tap). Everything else is a byproduct of moving the job.
- Utilization is **never shown alone** — always paired with throughput and WIP (the anti-gaming rule from the KPI research).
- OTIF measured against the **original** promised date, never a revised one.

Full detail (queues, escalation rules, KPI formulas, huddle cadence) lives in the Operations Dashboard file, which remains the module's design spec.

### 3.5 Inventory & Materials (Module 4 — basic now, deepens)

- Now: `INV#` items, reorder points, days-of-cover, stock decrement via Streams on production, low-stock → storefront "made to order" flip.
- Scale: **BOM per SKU** (which materials/quantities a product consumes — lets a sale automatically reserve and cost its inputs), stock valuation (FIFO/weighted-average, needed once Finance is real), multi-location stock, batch/lot tracking if ever needed for defect tracing.
- The BOM link is what eventually makes **estimated-vs-actual cost per job** (the Revenue Model file's highest-risk item) fully automatic instead of partly manual.

### 3.6 Procurement / Suppliers (Module 5 — growth)

- `SUPPLIER#` records, purchase orders (`PO#`), receiving that increments stock.
- The `/week` view's "consolidate the week's purchasing into one supplier run" becomes an actual PO, not just a note.
- Closes the loop: low stock → suggested PO → received → stock up → available on storefront. Fully event-driven.

### 3.7 Finance & Accounting (Module 6 — INTEGRATE first; see Part 4)

### 3.8 HR & Payroll (Module 7 — defer/integrate)

Only real once there are non-founder employees. Philippine payroll means SSS, PhilHealth, Pag-IBIG, and DOLE compliance — a solved problem in existing PH payroll tools. When the time comes, **integrate a PH payroll provider**, don't build statutory payroll math from scratch. Reserved in the model via the `Employee#`/role structure already defined in Platform.

### 3.9 Analytics / BI (Module 8)

- Operational (now): the pre-aggregated `METRIC#` counters powering the cadence dashboards. One query per view. Cheap.
- Analytical (Stage 2): S3 + Athena + QuickSight for cross-module, ad-hoc, historical reporting. This is where "margin by pillar by client by season joined to procurement cost" lives — queries too heavy or too relational for the operational table.

---

## Part 4 — The Finance Module Decision (build-vs-integrate, and why it's the crux)

This is the decision that most determines whether the ERP is buildable by 4 founders or becomes a multi-year regulatory project.

**The regulatory reality (Philippines, current):**
- A system that keeps books of accounts and issues invoices is treated by the BIR as a **Computerized Accounting System (CAS)** or Computerized Books of Accounts (CBA). Under **RMC 5-2021 / RMO 9-2021**, the old pre-approval Permit to Use is gone — you now *register* the system and the BIR issues an **Acknowledgement Certificate**, typically within ~3 working days of complete documents.
- A CAS may be one integrated system *or* linked modules (sales, purchases, inventory, payroll, GL); the BIR registers the whole set that produces your books and invoices.
- **E-invoicing (EIS):** under **RR 11-2025 as amended by RR 26-2025**, covered taxpayers must transmit invoice/sales data to the BIR's Electronic Invoicing/Sales System in near-real-time (no later than 3 calendar days), with a compliance deadline of **31 December 2026**. A system-generated invoice only counts as a valid e-invoice if the system can actually transmit in the required structured format.
- Material system changes generally must be re-reported to the BIR.

**What this means for KCMPS:** building your own invoicing/accounting engine means you own CAS registration, EIS transmission capability, and re-registration on every material change — a compliance surface a 4-founder shop should not take on early. The print-MIS industry independently reaches the same conclusion for operational reasons: the recommended pattern is a dedicated operations system that **pushes data into a dedicated accounting platform**, which kills double entry and leaves statutory reporting to tools built (and accredited) for it.

**Decision:**

1. **Now — integrate.** KCMPS's ERP owns operations (Modules 1–5, 8, 9). For books and BIR-compliant invoices, **integrate an already-BIR-accredited/CAS-ready accounting platform.** The ERP sends it clean transactional data over the event backbone; no re-keying. During the pre-BIR/DTI bridge period, the manual GCash flow (Payment System file) records *cash movement* in the ERP, and formal invoicing begins when registration clears.
2. **The event log is the bridge.** Because every money-relevant event is already captured immutably, feeding an accounting platform is a mapping exercise, not a data-collection project — and it's exactly the audit trail BIR wants preserved.
3. **Later — internalize deliberately, if ever.** Once volume makes the integration's per-transaction or per-seat cost exceed the effort of owning it, internalize invoicing as a *purpose-built, CAS-registered, EIS-transmitting* module on Aurora Serverless (Stage 3). This is a planned, funded step with the compliance work scoped — never an accidental "we already sort of do invoices."

This single decision is what keeps the ERP inside the ₱500 operational budget and inside a 4-founder build capacity while still being a *complete* ERP in architecture.

---

## Part 5 — Roles & Access (ERP-grade, defined now)

| Role | Sees | Can do |
|---|---|---|
| `Customer` | Own orders, own line items (via `sub` claim) | Order, pay, reorder, track |
| `Production` | Job board, run instructions, inventory | Advance job status, log spoilage/setup, receive stock |
| `Sales` | CRM, quotes, order pipeline | Price custom items, manage clients, send quotes |
| `Finance` | Money views, exports to accounting | Verify payments, run financial reports |
| `Admin` | Everything | All of the above + settings/master data |

Now: all four founders are `Admin`. The other roles exist in the Cognito group model and in Lambda authorization branching from day one, so the first hire is a group assignment. This is the "not drowning production staff in sales data" principle from the research — reserved, not yet enforced.

---

## Part 6 — Build Phasing (ERP-scoped, mapped to the existing roadmap)

Extends the existing 7-phase technical roadmap and the ops dashboard's A–G stages. Nothing here adds an AWS service before its stage.

| Phase | ERP scope | Modules touched | Maps to |
|---|---|---|---|
| **0** | Platform foundation: Cognito roles (all 5 defined), master-data records, event log, `tenantId`/`schemaVersion`/centavo-money conventions baked in | 9 | Existing Phase 1 |
| **1** | Sales & Order Mgmt + mixed cart + GCash bridge; event emission on every transaction | 1 | Existing Phase 2–3 |
| **2** | Production/MES `/today` + queues + payment verification; manual status advance | 3, 9 | Ops Stages A–C |
| **3** | Inventory basics + Streams stock decrement + storefront availability flip | 4, 1 | Existing Phase 5 |
| **4** | `METRIC#` counters + `/today` numbers + spoilage/setup capture; CRM thin (history, reorder, quiet-client) | 3, 8, 2 | Ops Stage D |
| **5** | `/week`: capacity, scheduling, utilization/throughput/WIP, batching; storefront capacity→turnaround loop | 3, 8, 1 | Ops Stages E–F |
| **6** | Procurement: suppliers + POs + receiving, closing the inventory loop | 5, 4 | Post Phase 5 |
| **7** | **Integrate accounting platform** over the event backbone; Finance role live | 6, 8 | Growth |
| **8** | Analytical plane: S3 export + Athena + `/month` heavy reports; EventBridge backbone | 8, all | Stage 2 |
| **9+** | On demand: HR/payroll integration, service split, multi-site, internalized CAS invoicing | 7, 6 | Stage 3 |

**Sequencing rule (unchanged and load-bearing):** *capture before display, foundation before feature.* Phase 0's conventions and the event log cannot be backfilled — a metric or an audit record you didn't instrument on day one is gone. Everything visual is trivially added later.

**Effort:** Phases 0–5 are essentially the existing ~9–13 focused days plus the ops dashboard's +5–8, i.e. a usable operational ERP core in roughly **3–5 focused weeks** (2–3 months side-project). Phases 6–8 are growth-stage, weeks each, done when the need is real. Phase 9+ is genuinely later and shouldn't be estimated now.

---

## Part 7 — Cost by Stage

| Stage | What's running | Est. monthly | vs. ₱500 cap |
|---|---|---|---|
| **1 — Operational ERP** | S3, CloudFront, Cognito, API GW, Lambda, DynamoDB (+1–2 GSI), Streams, SES, EventBridge cron | ~₱120–250 | Comfortable |
| **2 — + Analytical plane** | above + S3 export, Athena (per-query), QuickSight (per-user), accounting integration fee | ~₱250–600 core + integration/BI subscription | Core still near cap; BI/accounting are separate business-tool budget lines, like WAF |
| **3 — Service split / scale** | above + Aurora Serverless (if finance internalized), more compute | Scales with real usage; no fixed per-seat ERP license | The structural win: cost tracks usage, not headcount |

The off-the-shelf comparison worth keeping visible: commercial print MIS runs on the order of hundreds of USD/month, and full PH ERP builds are quoted in the ₱1.5M–₱3M range. KCMPS's build trades that recurring/upfront license cost for founder dev time and keeps operational infra near ₱200/month by owning only the operational plane and integrating the regulated one.

---

## Part 8 — What Changed From the Previous Plan

For anyone reading this against the standalone Operations Dashboard file:

1. **Reframed, not replaced.** The ops dashboard is now Module 3 (Production/MES) + Module 8 (Analytics). Its design spec is intact; this file wraps it in the other eight modules.
2. **Explicit scale path added** (Part 2): modular monolith → analytical plane → service split, with the data-model decisions that must land at launch to make later scaling additive.
3. **Finance is now integrate-first** (Part 4), driven by BIR CAS/EIS reality — the single decision that keeps a "complete ERP" buildable by 4 founders on a ₱500 budget.
4. **Full role model defined now, enforced later** (Part 5).
5. **Master data, event log as audit trail, centavo money, `tenantId`, `schemaVersion`** promoted to launch-blocking conventions because they can't be retrofitted.

---

## Part 9 — Open Questions (carried + new)

Carried from prior files: station list & planned hours (blocks `/week`); huddle ownership (phone vs. desktop `/today`); verification SLA hours; spoilage reason codes; is design/prepress labor tracked or overhead; deposit vs. pay-on-quote; quote-response SLA cap; partial cancellation.

New at ERP scope:
- **Which accounting platform to integrate** for Module 6 — must be BIR CAS-ready/accredited and expose an API the event backbone can feed. Shortlist and pick before Phase 7.
- **Is KCMPS a covered taxpayer for the EIS Dec-2026 e-invoicing deadline?** Determines urgency of the accounting-integration phase — confirm with the accountant/BIR RDO.
- **When does the first non-founder hire land?** Triggers real role enforcement (Part 5) and eventually HR/payroll (Module 7).
- **Multi-site on the horizon?** If a second location is plausible within ~2 years, `siteId` stays reserved (already is); if not, it's still cheap insurance.
- **Internalize invoicing ever, or integrate permanently?** A Stage-3 decision, but worth a rough volume threshold now so it's a trigger, not a debate.

---

*File created from ERP design discussion — supersedes the standalone Operations Dashboard framing and serves as the overarching system reference alongside the KCMPS Technical, Revenue Model, Marketing, Payment System, and Operations Dashboard Project Knowledge files.*
