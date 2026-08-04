# Ops Dashboard — User Test Script

This is a step-by-step script for **you** (an external user, no coding
needed) to confirm the dashboard's logic works as designed. It runs
entirely on **mock data in your browser** — nothing here touches AWS, so
there's nothing to break or pay for. Every check below verifies a specific
piece of design logic from the Operations Dashboard Project Knowledge file.

Estimated time: **15–20 minutes**.

---

## 0. Setup

1. Open a terminal and run:
   ```bash
   cd website
   python3 -m http.server 5500
   ```
2. In a browser, go to `http://localhost:5500/dashboard/` (note the trailing
   slash — this loads `dashboard/index.html`, the dashboard's own landing
   page, not the storefront).

> **You do not need a real AWS/Cognito account for this script.** This build
> has no backend yet (see `../infra/backend-infra-to-deploy.md`), so the
> dashboard's login gate offers a **local-only test-staff bypass** whenever
> it detects you're on `localhost` — see Test 1. That bypass is hard-disabled
> outside localhost, so it can never appear on the real deployed site.

---

## Test 1 — Staff gate works, with a local bypass for testing

**What this checks:** only `Staff`-group Cognito users can reach the
dashboard in production (Part 3 of the Project Knowledge file: "gated by the
`Staff` group claim"), while still letting you test the dashboard itself
without needing AWS set up.

1. On `http://localhost:5500/dashboard/`, you should land on a card titled
   **"No staff session found"** — this is the gate correctly stopping you,
   not a bug.
2. **Expected:** because you're on `localhost`, the card also shows a
   **"Continue as test Staff user (local only)"** button.
3. Click it.
4. **Expected:** you land on the Today view immediately — sidebar visible,
   "Test Staff" shown in the top-right. No flicker, no bouncing between
   URLs.
5. Navigate to a couple of other pages (This Week, Jobs) using the sidebar.
6. **Expected:** you stay logged in across every page — the bypass session
   persists for the rest of your browser tab, same as a real login would.

**If you instead see the URL rapidly flicker/switch** between
`dashboard/today.html` and `index.html?login=required` — stop, and let
whoever built this know; that's the exact symptom of the redirect-loop bug
this bypass was added to fix, so if you still see it, something regressed.

**To test with a real Cognito Staff account instead** (e.g. once a real
backend exists): open `http://localhost:5500/` (the storefront), click
**Login / Sign-up**, sign in with an account in the `Staff` group, then
click the **Dashboard** link in the nav. Ask whoever administers the
Cognito User Pool to add your test user to the `Staff` group if you don't
have one (see the main `README.md`'s Cognito section).

---

## Test 2 — Today: action queues sort oldest-first

**What this checks:** Part 3.1 — queues are "a count + tappable list,
sorted by aging," which is what makes the daily huddle work.

1. On `/today`, look at the **Pending Payment Verification** queue.
2. **Expected:** the top item shows the *longest* aging time (e.g. "9h"
   before "6h" before "3h") — oldest problem first, not newest.
3. Find any item with a red left-edge and red aging time.
4. **Expected:** that's a queue item over its SLA — for Pending Payment
   Verification, that's ≥4 hours old (Part 3.1's SLA table).
5. **Expected:** every item in this specific queue also shows a second
   line reading `Ref <code> · claimed ₱<amount>` — this is the manual
   GCash bridge's staff-dashboard spec (Payment System Project Knowledge
   file: "shows screenshot, reference number, claimed amount, order ID,
   timestamp"). Staff should never have to open a ticket just to see the
   reference number to cross-check against GCash transaction history.

---

## Test 3 — Today: WIP is never shown without its pair

**What this checks:** Design Principle 5 — "Never show utilization alone.
Always beside throughput and WIP count" (and on `/today`, WIP itself is
paired with Jobs Due Today, so a busy-looking board can't hide a stuck one).

1. Look at the **WIP count** tile.
2. **Expected:** it has a sub-label explaining what it's paired with
   ("Confirmed → QC · pair with utilization on Week") — it's never a bare
   number implying "good" or "bad" on its own.

---

## Test 4 — Blockers require an owner and a due date

**What this checks:** Part 3.1 / Part 4 — "enforced — cannot save without
both," directly answering the "problems raised daily but never resolved"
failure mode from the market research.

1. Scroll to **Blockers board**.
2. In the form, type something in "What's blocking?" only, leave Owner and
   Due date empty, and click **Log it**.
3. **Expected:** nothing is added to the list (the browser's built-in
   `required` validation blocks the submit — you'll see a small "please
   fill out this field" prompt on Owner).
4. Now fill in all three fields (text, owner name, a due date) and submit.
5. **Expected:** a new row appears immediately at the bottom of the list.
6. Click **Resolve** on it.
7. **Expected:** it disappears from the open list (it's marked resolved,
   not deleted — this matters once the real backend exists, so resolved
   blockers stay in the history).

---

## Test 5 — Recurring blockers promote to the weekly view

**What this checks:** Part 3.1 — "Auto-flags an issue as 'recurring' if a
similar tag appears 3+ times in 30 days, which promotes it to the weekly
agenda."

1. Still on `/today`, note the two blockers mentioning ink (the seed data
   ships with the `ink-supply` tag logged twice already — two isn't enough
   to trigger recurring yet, which is the point: the threshold is 3+).
2. Add one more blocker with the exact tag `ink-supply` (owner + due date
   required, per Test 4).
3. **Expected:** after adding the third one, all ink-supply blockers in the
   list now show the **Recurring — promote to weekly** badge.
4. Go to **This Week** in the sidebar, scroll to **Recurring blockers**.
5. **Expected:** the same ink-supply blocker(s) appear there too — proving
   the promotion actually surfaces on the weekly board, not just a label
   on the daily one.

---

## Test 6 — OTIF is measured against the *original* promise date

**What this checks:** Design Principle 4 and the Caveat in Part 1 — "must
be measured against the customer's **original** requested date," never a
revised one. This is the single most-cited way OTIF numbers get gamed.

1. Go to **This Month**.
2. Look at the **OTIF** tile — note the percentage.
3. Open **Jobs** in the sidebar, find any ticket, and click into its detail
   page.
4. **Expected:** the ticket shows an **Original promise date** field, and
   nowhere in the UI is there a way to edit or "revise" that date — advancing
   a ticket's status never touches it. That's the enforcement: there's no
   button that lets a revised date quietly replace the original.

---

## Test 7 — Job ticket state machine only allows legal transitions

**What this checks:** Part 5.1 — the line-item state machine. The UI must
only ever offer the *next legal* status, never let you skip steps.

1. Go to **Jobs**, filter the status dropdown to `Confirmed`, and open one.
2. **Expected:** the only action button offered is **Schedule** (not
   "Mark Delivered" or any other out-of-sequence jump).
3. Click **Schedule**, pick a station from the dropdown, and confirm.
4. **Expected:** the ticket's status pill updates to `Scheduled`, and a new
   row appears at the bottom of the **Event timeline** showing
   `Confirmed → Scheduled` with a timestamp.
5. Click through **Start production** (station + setup minutes) → **Send to
   QC**.
6. On the `QC` ticket, click **Fail QC → Rework**.
7. **Expected:** an inline form appears asking for spoiled units, a reason
   code (dropdown), and a peso value — you cannot fail QC without logging
   *why* (Part 5.2: "Reason codes are what make spoilage actionable rather
   than merely depressing").
8. Submit it.
9. **Expected:** status becomes `Rework`, and a **Spoilage on this line**
   card appears above the timeline showing exactly what you entered.
10. Go back to **Today** and confirm the **Spoilage** tile's "today" number
    increased and the **QC Hold / Rework** queue now shows this ticket.

---

## Test 7a — GCash verify/reject acts on the whole order, not just one line

**What this checks:** the manual GCash bridge (Payment System Project
Knowledge file, "Bridge Payment Method: Manual GCash Verification") — one
GCash transaction covers every `sku` line item on an order at once, so
verifying or rejecting it must act on the *order's* payment, not a single
line item, and a reject must always capture a reason the customer will see.

1. Open a ticket from the **Pending Payment Verification** queue (Test 2).
2. **Expected:** above the Advance-this-job card, a card shows **GCash
   reference**, **claimed amount**, **screenshot** (an S3 path — no real
   image in this mock build), and **submitted** timestamp — this is the
   proof staff would cross-check against actual GCash transaction history.
3. Click **Verify payment**, then confirm.
4. **Expected:** the ticket's status becomes `Confirmed`, a new **Verified**
   field appears on the payment card with a timestamp and your name, and
   the **Event timeline** logs `Pending Payment Verification → Confirmed`.
5. Open a *different* ticket still in `Pending Payment Verification` and
   click **Set to On-Hold**.
6. **Expected:** an inline textarea asks what needs checking — try
   confirming with it empty first; nothing happens until you type something
   (matches Design Principle 3 elsewhere in this app: no silent, reason-less
   status changes).
7. Type a reason and confirm.
8. **Expected:** status becomes `On Hold`, and the payment card now
   shows your **On-hold reason** text instead of a Verified field.
9. On that same on-hold ticket, click **Verify payment** and confirm.
10. **Expected:** status goes straight to `Confirmed` — no detour back
    through `Pending Payment Verification`, and the customer is never asked
    to resubmit their proof. The **Event timeline** logs
    `On Hold → Confirmed`.

---

## Test 7b — Mixed cart: one order, two item types, one derived status

**What this checks:** the Payment System file's core design — "One Cart,
Two Item Types": a single order can hold both a pay-now `sku` item and a
pay-on-quote `custom` item, and `orderStatus` is always a computed rollup,
never set by hand.

1. Go to **Jobs**, search for **"Cup Holder"**.
2. Open its ticket — note the order ID shown under the title.
3. Go back to **Jobs** and search for **"Custom 3D Print — client STL"**.
4. **Expected:** it shows the *same* order ID as the Cup Holder ticket —
   one cart, two item types, exactly as described in the Payment System
   file's own worked example ("3D-Printed Cup Holder... Custom 3D Print
   (uploaded STL, PLA, qty 5)").
5. **Expected:** the Cup Holder line is `Delivered` while the Custom 3D
   Print line is still `In Production` — different statuses, same order.
   There is no "orderStatus" field anywhere in the UI you can edit directly;
   it's always shown as a byproduct of the line items' own statuses.

---

## Test 8 — Setup minutes capture ("two taps")

**What this checks:** Part 5.2 — "a single 'start setup / start run' tap on
the job ticket. Two taps buys the entire makeready metric."

1. Find any ticket in `Scheduled` status (or create one via Test 7).
2. Click **Start production**.
3. **Expected:** the inline form asks for **Setup minutes** as a single
   number field — no separate multi-step wizard.
4. Enter a number (e.g. `15`) and confirm.
5. Go to **This Week**.
6. **Expected:** that station's card now factors the setup minutes into
   its committed-hours math (the "Bookable this week" hours will have
   shifted slightly versus before).

---

## Test 9 — Capacity threshold drives the rush-order note

**What this checks:** Part 3.2 — "when a station's week is >85% committed,
the estimator's turnaround quote for that method automatically shifts out,
and the rush surcharge multiplier engages."

1. On **This Week**, find any station card with a committed % **above
   85%** (in the seed data this may not exist yet — see step 3).
2. **Expected:** that card shows an amber outline and an inline note:
   "&gt;85% committed — turnaround for this station extends automatically
   and the rush surcharge engages."
3. If no station is currently over 85%, go push one there: open **Jobs**,
   advance a few `Confirmed` tickets on the same station through to
   `In Production` with large setup-minute values (Test 7 + Test 8), then
   recheck `/week`.

---

## Test 10 — Low stock alerts show days-of-cover, not just a flag

**What this checks:** Part 3.1 — "with days-of-cover estimated from
trailing 30-day consumption," so staff know *how urgent*, not just *that*
something is low.

1. On **Today**, scroll to **Low stock alerts**.
2. **Expected:** every row shows on-hand qty, the reorder point, **and** a
   "Xd cover" figure — never just a bare "low stock" flag.
3. Go to **Inventory**, click **Adjust** on any low-stock item, and set its
   quantity to something clearly above its reorder point (e.g. from `2` to
   `50`).
4. Go back to **Today**.
5. **Expected:** that item no longer appears in Low stock alerts.

---

## Test 11 — Monthly view stays capped (~12 metrics)

**What this checks:** the explicit design constraint in Part 3.3 — "the
monthly view is capped at ~12 metrics. The research is unambiguous that
more metrics produce less action."

1. On **This Month**, count the tiles in the top **Headline KPIs** row.
2. **Expected:** 12 tiles, no more. A few show "—" with a note like "wire
   up once X is tracked" rather than being deleted — that's intentional:
   the slot is reserved so the cap doesn't quietly get violated once the
   real metric exists.

---

## Test 12 — Client concentration surfaces quiet B2B accounts

**What this checks:** Part 3.3 / Part 9 — "a lapsed B2B reorder account is
a warm lead the marketing side can work immediately."

1. On **This Month**, look at the **Quiet accounts** table.
2. **Expected:** it lists only `B2B` clients whose last order is *older*
   than their normal reorder interval — check against the **Clients** page
   to confirm (a client flagged "reorder overdue" there should also appear
   in the Month view's quiet-accounts list, and vice versa).
3. Confirm B2C clients (no reorder interval) never appear in this list —
   they have no reorder cadence to compare against.

---

## Test 13 — Resetting the demo

**What this checks:** that mock mode is clearly a demo, not a shared
backend — every browser/tab has its own independent copy.

1. Go to **Settings** → **Demo data** → **Reset demo data**.
2. Reload any other open dashboard tab.
3. **Expected:** all your Test 7–10 edits are gone; the dashboard is back
   to its original seeded state. This confirms the mock layer really is
   local-only (`localStorage`), which is also why it's safe to test
   destructively — there's no real order or customer data to damage.

---

## If something fails

Note which numbered test failed and what you saw vs. what was expected,
then check the browser console (F12 → Console tab) for errors before
reporting it — most logic lives in
[`../dashboard-data.js`](../dashboard-data.js), and reading the function
name in a console error usually points straight at the responsible test
number above.
