# KCMPS Payment System — Project Knowledge

**Kaalyados Creatives Merchandise & Printing**
Manila-based, established 2026

---

## Purpose of This File

Companion to the KCMPS Technical, Revenue Model, and Marketing Project Knowledge files — focused specifically on the design of the **mixed cart / checkout system**: how fixed-price (SKU) items and custom quote-based items coexist in a single cart and order, and how that maps onto the existing serverless architecture.

---

## The Problem Being Solved

Customers frequently want to combine two very different purchase types in one visit:

- **Instant-buy items** — pre-priced, standard SKUs (e.g. a standard 3D-printed cup holder) that should check out immediately, no human involved.
- **Custom/quote items** — jobs needing pricing input (e.g. a custom 3D print with uploaded file, specific material, custom quantity) that go through the existing quote wizard and pipeline.

Forcing these into one rigid flow creates bad outcomes either way:
- Blocking checkout until *all* items are priced kills quick-buy conversions.
- Forcing custom work into instant fixed pricing kills quote accuracy and risks underpricing labor/material.

**Solution:** one cart, two item types, split fulfillment — same order ID, different statuses per line item.

---

## Core Design: One Cart, Two Item Types

Every cart line item carries a `type`:

| Type | Price | Behavior |
|---|---|---|
| `sku` | Fixed, known at add-to-cart | Pays instantly at checkout |
| `custom` | Null until quoted | Routed into existing quote pipeline, priced by staff, paid via separate follow-up link |

**Example cart:**
- 3D-Printed Cup Holder × 1 — ₱150 (`sku`, price locked)
- Custom 3D Print (uploaded STL, PLA, qty 5) — "Pending Quote" (`custom`, price: null)

---

## Checkout Flow

1. **Pay now** for all `sku` line items — standard instant checkout/payment flow.
2. **Submit for quote** for all `custom` line items — routed into the existing quote pipeline (`Quoted` status), tied to the **same order ID** as the paid items.
3. Customer receives one order confirmation covering both:
   - *"Cup holder — paid, shipping soon."*
   - *"Custom print — quote pending, we'll follow up within 24h."*
4. Once staff prices the custom item in the dashboard, a **separate payment link** is emailed (via SES) just for that portion.
   - No need to re-collect shipping/customer info — already tied to the same order via `sub` claim and order ID.
5. Order status becomes **composite**, e.g. *"Partially fulfilled: SKU items shipped, custom item in production."* This reuses the existing job pipeline status model rather than inventing a new one.

---

## Data Model (DynamoDB — extends existing single-table design)

Fits directly into the architecture already defined in the Technical Project Knowledge file — no new table, no new service.

**`ORDER#<id>` record gains a `lineItems` array:**

```json
{
  "PK": "ORDER#1234",
  "SK": "ORDER#1234",
  "customerSub": "<cognito-sub>",
  "createdAt": "2026-07-21T10:00:00Z",
  "orderStatus": "Partially Fulfilled",
  "lineItems": [
    {
      "itemId": "SKU-CUPHOLDER-01",
      "type": "sku",
      "name": "3D-Printed Cup Holder",
      "qty": 1,
      "unitPrice": 150,
      "status": "Paid"
    },
    {
      "itemId": "CUSTOM-001",
      "type": "custom",
      "name": "Custom 3D Print",
      "qty": 5,
      "unitPrice": null,
      "material": "PLA",
      "fileRef": "s3://kcmps-uploads/custom-001.stl",
      "notes": "Client-provided dimensions, see upload",
      "status": "Quoted"
    }
  ]
}
```

- `type: sku` items → `status` moves `Paid` → `In Production` → `Delivered` (reuses existing job pipeline).
- `type: custom` items → `status` moves `Quoted` → `Priced` → `Awaiting Payment` → `Paid` → `In Production` → `QC` → `Delivered` (reuses existing quote-to-job pipeline, just scoped to a line item instead of a whole order).
- `orderStatus` at the top level is a derived/composite rollup of line item statuses (e.g. all Delivered → order Delivered; mixed → Partially Fulfilled).

**Custom line items reuse the existing quote wizard fields** (material, qty, dimensions, notes, file upload) — this is not a second form. The wizard becomes an "Add Custom Item to Cart" action instead of a standalone quote submission, feeding the same submission Lambda.

---

## Backend Logic (Lambda / API Gateway)

- **`addToCart`** — appends a `sku` or `custom` line item to an in-progress cart (client-side state until checkout, or a `CART#<sub>` record if persistence across sessions is needed).
- **`checkout`** — splits the cart into:
  - Payment intent for the sum of `sku` items only.
  - `custom` items written into the `ORDER#<id>` record at `Quoted` status, no payment collected yet.
- **`submitQuotePrice`** (staff-only, dashboard action) — staff enters a price for a `custom` line item → status moves to `Priced` → triggers SES email with a payment link scoped to that line item.
- **`payCustomItem`** — customer-facing endpoint hit via the emailed payment link; on success, line item status → `Paid`, and DynamoDB Streams trigger the same auto-job-card / inventory-decrement automation already defined for `sku` items.
- All of the above reuse the **existing IAM least-privilege pattern** — each Lambda scoped to only the DynamoDB actions it needs on the single table, no new roles or broad policies required.

---

## Why This Fits the Existing Architecture (No New Infra)

| Existing component | Reused for |
|---|---|
| Single-table DynamoDB (`ORDER#`, `CLIENT#`, `INV#`) | `lineItems` array lives inside the existing `ORDER#` item — no new table |
| Cognito group claims (`Customers` / `Staff`) | Same auth split — staff price custom items via `/dashboard/*`, customers only see/pay their own |
| Quote wizard (estimator) | Becomes the "custom item" entry form inside the cart flow, not a separate system |
| Job pipeline (Quoted → Confirmed → In Production → QC → Delivered) | Reused per-line-item instead of per-order only |
| DynamoDB Streams → Lambda automation | Same stock-decrement / job-card-creation trigger, now fires per line item on status change |
| SES notifications | Extended to send a **second** email per order (custom item price-ready payment link) instead of just one status email |

**Net effect:** this is a data-shape and workflow decision layered on top of the architecture already planned — it does not require new AWS services, new cost line items, or a rework of the build order. It slots into **Phase 2–3** (DynamoDB schema + dashboard) of the existing roadmap.

---

## Relationship to "Launch Kit" Bundling

This is the same underlying mechanism as the previously planned **Launch Kit bundle** (design + print + hardware sold as one decision), generalized to the line-item level. Bundling is a *pre-packaged* combination of items; mixed cart is the *ad hoc* version — letting any combination of instant-buy and custom work live in a single order, not just curated bundles. Both reuse the same `lineItems` + composite status model.

---

## Bridge Payment Method: Manual GCash Verification (Pre-BIR/DTI Registration)

**Context:** While BIR/DTI registration is in process, KCMPS cannot yet onboard a registered payment gateway (PayMongo, HitPay, etc.). This section defines a manual GCash-based verification flow as a temporary bridge — designed so it slots into the same order/status model and can be swapped for an automated gateway later with minimal rework.

**Current implementation status (2026-07-28):** only a front-end-only interim step has shipped — a popup shown after "Place order," before checkout's `mailto:` fires, with a placeholder GCash QR and copyable payment instructions (`website/store.js` `openOrderPopup()`, see `docs/history.md` entry 22). None of the flow below (order creation in `Pending Payment Verification`, the reference-number field, S3 screenshot upload, staff verify/reject queue) is built yet — the customer still emails proof manually and staff still process it outside the system. This section remains the target design for Milestone 1.

### Flow

1. **Checkout (customer side)**
   - Customer sees KCMPS's personal GCash QR code and the exact amount to pay.
   - To make manual matching possible, either add a small unique variance to the amount (e.g. ₱1,500.00 → ₱1,500.07) or require the Order ID as the GCash payment note/message.
   - Customer submits: (a) a screenshot of the GCash confirmation, and (b) the **GCash reference number** typed into a separate field (not just visible in the screenshot — needed so staff can cross-check against actual GCash transaction history; screenshots alone are editable).
   - Order is created immediately in status `Pending Payment Verification` — not blocked, so the customer sees progress right away.

2. **Notifications (SES)**
   - On submission: *"Order #X received — under payment verification, we'll confirm within [X hours]."*
   - On staff approval: *"Order #X verified — payment confirmed, moving to production."*
   - On rejection: *"We couldn't verify payment for Order #X — please check the reference number and resubmit, or contact us."*

3. **Staff dashboard**
   - New queue: **Pending Verification** — shows screenshot, reference number, claimed amount, order ID, timestamp.
   - Staff actions: **Verify** (→ `Confirmed`) or **Reject** (→ `Payment Rejected`, customer notified, can resubmit).
   - Auto-expiry: orders sitting in `Pending Payment Verification` past a defined window (e.g. 48h) with no resubmission auto-cancel, releasing any inventory hold.

4. **Customer-facing progress bar**
   Prepends payment stages onto the existing job pipeline:
   ```
   Order Placed → Payment Verification → Confirmed → In Production → QC → Delivered
                       (or → Rejected → resubmit)
   ```

### Data Model Addition (extends existing `ORDER#<id>` record)

```json
{
  "PK": "ORDER#1234",
  "SK": "ORDER#1234",
  "orderStatus": "Pending Payment Verification",
  "payment": {
    "method": "gcash_manual",
    "claimedAmount": 1500.07,
    "gcashRefNumber": "1234567890123",
    "screenshotRef": "s3://kcmps-uploads/payments/order-1234.jpg",
    "submittedAt": "2026-07-21T14:00:00Z",
    "verifiedBy": null,
    "verifiedAt": null,
    "rejectionReason": null
  }
}
```

### Lambda Functions (reuse existing IAM least-privilege pattern)

- **`submitPaymentProof`** — customer-facing; returns a pre-signed S3 upload URL (private bucket, same pattern as custom-print file uploads) for the screenshot, writes ref number + claimed amount to the order.
- **`verifyPayment`** (staff-only) — marks payment verified, updates order status, triggers SES confirmation email + existing Streams automation (job card creation, inventory decrement).
- **`rejectPayment`** (staff-only) — marks rejected, triggers SES rejection email, allows resubmission on the same order.
- **`expirePendingOrders`** — scheduled Lambda (EventBridge cron) that auto-cancels stale unverified orders past the cutoff window.

No new AWS services required — S3, Lambda, DynamoDB, SES, and Cognito are all already in the existing stack.

### Migration Note (Bridge → Permanent Gateway)

This manual flow is intentionally temporary. Once BIR/DTI registration clears, the plan is to move to a **GCash for Business** account or a registered gateway (e.g. PayMongo), since:
- Personal GCash accounts are scoped for personal use and can create bookkeeping/reconciliation issues once formal registration is active — business and personal income get blurred.
- The `verifyPayment` step is designed to become **automatic** (triggered by gateway webhook) instead of staff-triggered, with the same order/status model carrying over unchanged — no rework of the pipeline, dashboard, or data model needed, only the verification trigger source changes.

---

## Open Design Questions (Not Yet Decided)

- Does the customer pay a deposit upfront for `custom` items at cart submission, or fully pay-on-quote (current assumption: pay-on-quote, no deposit)?
- Should there be a cap on how long a `custom` line item can sit in `Quoted` before staff must respond (affects SLA messaging to customer)?
- Should partial cancellation be allowed (e.g. customer cancels the custom item but keeps the paid SKU items)?

---

*File created from payment system / mixed-cart design discussion — companion reference to KCMPS Technical, Revenue Model, and Marketing Project Knowledge files.*
