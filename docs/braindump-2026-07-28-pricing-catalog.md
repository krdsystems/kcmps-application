# KCMPS brain dump → dev prompts (2026-07-28)

Source: owner's raw notes on print/office pricing corrections, a document-upload feature, an
online-sellable/in-person classification question, and a checkout shipping/courier flow. Cleaned
up and grouped into four self-contained prompts below, ordered so the low-risk data-only pricing
pass goes first and the more architecturally open checkout/upload work goes last. Each prompt is
copy-pasteable into Claude Code on its own.

Grounding used from the repo: `website/products.js` (catalog data, `leaves.print-office`,
`leaves.dtf`/`leaves.subli`), `website/store.js` (`quoteCard()`, `skuCard()`, checkout form ~line
590-820, `buildOrderEmail()`, `openOrderPopup()`), and `docs/roadmap.md` (Milestone 1 — the
`mailto:`-based checkout is an interim state; a real backend with S3 upload and order statuses is
planned but not yet deployed).

---

## Prompt 1 — Print/Office catalog pricing correction pass

```
Context: website/products.js is the single source of truth for the storefront catalog
(window.KCMPS_STORE_DATA). It renders via website/store.js's skuCard() for priced products
(fixed price or a `variants` array) and quoteCard() for products flagged `quoteOnRequest`
(no price shown, customer requests a quote instead). This is a pricing/data correction pass
for the `print-office` leaf only — the owner has now confirmed real prices for several items
that were previously placeholders or quote-only, and wants one item removed. No changes to
store.js's rendering logic are expected — this should be data-only, unless a product's
pricing shape genuinely can't be expressed with the existing `price`/`variants`/`addon`
fields (see item 4 and 7 below, which may need a small variants restructure).

Task:
1. Remove the "Catalogs & Booklets" product entirely (id: "print-catalogs-booklets" in
   website/products.js) — the owner no longer wants to sell this.

2. "Document Printing (B/W)" (id: "print-bw-document-printing"): the current setup has a
   base price of ₱4/page with a color add-on (0/10/20/32 by graphics density). Replace this
   with a flat two-tier price: ₱4/page black-and-white, ₱7/page colored. Simplify the
   `addon` field to two options ("B/W" at +0, "Colored" at +3 over the ₱4 base, or restructure
   as a `variants` array with two flat prices — pick whichever fits skuCard()'s existing
   rendering without new UI code). Also fix the product name/blurb: it currently reads
   "Document Printing (B/W)" and says "priced per page" without mentioning color is a
   full option, not an add-on afterthought — rename to "Document Printing" and rewrite the
   blurb so it's clear color printing is a fully supported first-class option, not a minor
   add-on (the owner flagged the current display as misleading, i.e. "wrong display not just
   b/w").

3. "Photocopying (Xerox)" (id: "print-photocopying"): no price change needed — already ₱3,
   "any size" per the owner's note. Just confirm the blurb explicitly says "any size" so
   customers don't assume it's letter/A4-only.

4. "Lamination" (id: "print-lamination"): update variant prices — ID-size 20 → 25, A4
   document 65 → 70. Replace the "8R photo" variant (95) with a "4R photo (class-picture
   size)" variant at ₱40 — the owner specified 4R, not 8R, so this is a swap, not an addition.

5. "Spiral / Comb Binding" (id: "print-binding"): currently `quoteOnRequest: true` with no
   price. The owner has a real bind-only price now: ₱50 per 90 leaves, A5 size (binding only —
   does not include the cost of printing the pages themselves). Convert this from
   quoteOnRequest to a priced product. Since the unit is "per 90 leaves" rather than a flat
   per-order price, use a `variants` array with a single "Bind (per 90 leaves, A5, spiral or
   comb)" option at ₱50, and update the blurb to state it's bind-only and specify the leaf
   count and A5 size constraint. (If the page count varies, the customer can adjust quantity
   in the cart the same way any other per-unit item scales — don't build new stepper logic,
   reuse the existing qty control.)

6. "Custom Self-Inking Stamps" (id: "print-self-inking-stamps"): the current variants (Small
   1–2 lines ₱380, Medium 3–4 lines ₱480, Large ₱600) are stale placeholders — replace them
   entirely with the owner's real sizes and prices:
   - "33×13mm (up to 3 lines)" — ₱100
   - "32×12mm" — ₱130
   - "10×27mm" — ₱120
   Update the blurb to reference size in mm rather than line count as the primary variant
   axis (line count is now just a constraint on the 33×13mm option).

7. "Custom Bookmarks" (id: "print-bookmarks"): currently `quoteOnRequest: true`. Convert to
   priced with two variants: "Custom bookmark (2 pcs)" at ₱35, "Hymnal bookmark (6 pcs)" at
   ₱70. Update the blurb accordingly (drop the "pricing depends on material — request a
   quote" language since it's now fixed-price).

8. "Business Cards" (id: "print-business-cards"): currently a flat ₱450 "per box of 100."
   Replace with per-piece variants, with a stated minimum order of 10 pcs: "Front only (per
   pc, min. 10 pcs)" at ₱7, "Back-to-back / double-sided (per pc, min. 10 pcs)" at ₱15.
   The owner has confirmed this minimum must be hard-enforced, not just stated in copy: add a
   `minQty: 10` field to this product in products.js, and update website/store.js's cart
   quantity control (setQty()) and skuCard()'s quantity stepper to read an optional `minQty`
   per product, clamping the floor to `minQty` instead of the current default floor (likely 1
   or 0 — check setQty()'s current logic) for this product only. Removing the item from the
   cart entirely should still be allowed (e.g. via the existing remove button), just not
   stepping the quantity down below 10 while it stays in the cart.

9. "Stickers & Labels" (id: "print-stickers-labels"): currently priced per piece (paper ₱3.5,
   die-cut vinyl ₱16). Replace with the owner's real per-A4-sheet and per-inch pricing:
   - "Premium printable vinyl (per A4 sheet)" — ₱100
   - "Paper stickers (per A4 sheet)" — ₱45
   - "Transparent (per A4 sheet)" — ₱60
   - "Decal stickers (per inch)" — ₱5
   Update the blurb to reflect that most options are priced per full A4 sheet, not per
   individual sticker, except decal stickers which are priced per inch (customers adjust
   quantity for sheet count or inches as appropriate).

Acceptance criteria:
- website/products.js has no "print-catalogs-booklets" entry.
- All eight remaining print-office products above show the exact new prices/variants listed.
- The business-card quantity stepper cannot be decremented below 10 while the item is in the
  cart; removing the line item entirely still works normally.
- No other product's quantity floor changes — `minQty` should be opt-in per product, not a
  new global default.
- Load the storefront locally (`cd website && python3 -m http.server 5500`), open the
  Print/Office tab, and visually confirm each product card renders the correct price(s), and
  that the business-card stepper enforces the floor of 10, with no console errors.
```

---

## Prompt 2 — Apparel transfer (DTF/Sublimation) size & shirt add-on pricing

```
Context: website/products.js has three near-identical apparel-transfer products across two
leaves — "Street Statement Print" (dtf and subli leaves) and "Clean Logo Transfer" /
"Typographic Quote Print" (dtf leaf) — all sharing the same `variants` array (2×3 in ₱50, A4
₱80, A3 ₱120) and all opting into the shared `shirtAddon` (website/products.js top-level
`shirtAddon: { id: "shirt", label: "Press onto a shirt (+₱120)", price: 120 }`, applied via
each product's `shirtAddon: true` flag). The owner wants pricing updates across all of these
at once, since they all share the same variant structure and the same shirt add-on.

Task:
1. Rename the existing "2×3 in" variant label to "3×5 in" on all four products — same ₱50
   price, this is a relabel only, not a new size tier (owner confirmed: the note "2x3 --> 3x5
   ---> 50" meant the old size label becomes the new one, price unchanged).
2. Raise the A3 variant price from ₱120 to ₱150 on all four products that carry it:
   "dtf-street-statement", "subli-street-statement", "dtf-logo-transfer", "dtf-typographic".
3. Lower the shared `shirtAddon.price` from 120 to 110, and update its `label` string to
   match ("Press onto a shirt (+₱110)").

Acceptance criteria:
- All four apparel-transfer products show "3×5 in" (not "2×3 in") at ₱50 — no product still
  has a variant labeled "2×3 in", and no product has both a 2×3 and a 3×5 option.
- All four apparel-transfer products show A3 at ₱150.
- The shared shirtAddon price is ₱110 everywhere it's referenced (data + rendered label).
```

---

## Prompt 3 — File attachment for print jobs + online-sellable vs. in-person classification

```
Context: KCMPS's storefront checkout (website/store.js, submitOrder() around line 810,
buildOrderEmail() around line 708) is currently a `mailto:` link — there is no backend yet
(see docs/roadmap.md, Milestone 1, not started). Customers who need to submit a document,
photo, or artwork for print-office jobs (document printing, business cards, custom stamps,
4R photo lamination) currently have no way to attach a file — the only workaround is the
existing "Custom request details / design links" textarea in the checkout form, where
customers are expected to paste a Google Drive / cloud-storage link.

IMPORTANT CONSTRAINT the owner may not be aware of: `mailto:` links cannot carry file
attachments — this is a hard limitation of the mailto: URI scheme in every browser/mail
client, not a bug in this codebase. So "attach a file to print" cannot be implemented as a
literal file upload that rides along with the current checkout flow without either (a) real
backend storage (an upload endpoint — this is what docs/roadmap.md Milestone 1.2's
`submitPaymentProof` Lambda + S3 presigned-upload pattern is designed for, just for payment
screenshots rather than print files, and it isn't deployed yet), or (b) instructing the
customer to manually attach the file themselves in their email client after the mailto:
compose window opens (the storefront can't do this for them).

Task:
1. Go through every product in website/products.js's print-office leaf (plus any other leaf
   with a similar "needs the customer's own content" shape) and classify each as one of:
   - **Fully online-sellable** — fixed price, no customer-supplied file or in-person item
     needed (e.g. photocopying assumes a walk-in original; lamination assumes a walk-in
     physical item — see below, these may NOT be fully online-sellable).
   - **Needs a customer-supplied file** — document printing, business cards (artwork), custom
     stamps (logo/text) — these need the customer to provide digital content before or during
     checkout.
   - **Needs a physical item in-store** — photocopying, lamination, spiral/comb binding —
     these require the customer to bring or have already delivered a physical original; they
     cannot be fulfilled purely from a digital file.
   Add a lightweight classification field to each affected product in products.js (e.g.
   `fulfillmentInput: "file" | "in-person" | "none"`) so the storefront can eventually show
   different guidance/UI per product type. Don't invent new visual UI for this yet if it's
   out of scope — flag it as data-only if you defer the UI half; see acceptance criteria.
2. For products classified `fulfillmentInput: "file"`, update the checkout flow so the
   existing "Custom request details / design links" textarea explicitly prompts for a file
   link when the cart contains such a product (e.g. dynamic placeholder text: "Paste a
   Google Drive/Dropbox link to your file(s) for printing"), given the mailto: constraint
   above rules out true attach-and-send today.
3. Do not attempt to build a real file-upload backend in this task — that's Milestone 1.2 in
   docs/roadmap.md and depends on infrastructure (S3 bucket, presigned-upload Lambda) that
   doesn't exist yet. This task is scoped to classification + checkout copy/prompt only.

Acceptance criteria:
- Every print-office product (and any similarly-shaped product elsewhere) has an explicit
  fulfillmentInput classification in products.js.
- The checkout notes field's placeholder/label dynamically reflects when the cart contains a
  file-needing product, without breaking the existing custom-item flow for leaves that don't
  need this (dtf/subli custom design requests already handle file/design references their own
  way — don't regress that).
- No new backend, upload widget, or file-storage code is introduced — this stays a client-side
  data + copy change, consistent with docs/roadmap.md's "don't build ahead of a real trigger"
  rule.
```

---

## Prompt 4 — Checkout: courier choice, shipping details, confirmation SLA, pickup hold policy

```
Context: website/store.js's checkout form (~line 590-605) currently collects name, contact
(email/phone/Messenger), a Pickup-vs-Delivery radio, and a notes textarea, then builds an
email via buildOrderEmail() and opens a GCash payment popup via openOrderPopup() before
firing the mailto:. There is no courier selection, no structured shipping-address fields, and
no stated confirmation-time SLA or pickup-expiry policy anywhere in the UI or copy. The owner
wants these added to the same checkout form/flow.

Task:
1. Add a courier choice, shown only when "Delivery" is selected on the existing co-fulfill
   radio group: two options, "Grab" and "Lalamove" (the owner's actual two delivery partners —
   this is not a live booking integration, just capturing the customer's preference so staff
   know which courier app to book with).
2. When "Delivery" is selected, add structured shipping-detail fields (currently there are
   none — customers would have had to type an address into the free-text notes field): full
   name (can reuse the existing name field), exact address, contact number (can reuse the
   existing contact field or add a dedicated phone field if "contact" is meant to stay
   email/Messenger-flexible — your call, note which you picked), and a landmark field. These
   should only be required when Delivery is selected, not Pickup.
3. Update buildOrderEmail() so the generated email body/format includes the courier choice and
   full shipping details block when Delivery is selected, in the same structured style as the
   existing itemized cart breakdown.
4. Add a customer-facing confirmation-time SLA statement to the checkout flow copy: an email
   confirmation will be sent, and includes delivery timing of "1-2 business days max" — surface
   this near the submit button or in the GCash payment popup copy (openOrderPopup()) so
   customers see it before they commit, not just after.
5. Add pickup-hold policy copy near the Pickup option: orders paid via Pickup that are not
   collected within 3 business days are cancelled and the payment forfeited, no refund (owner
   confirmed this is the intended policy — matches common small-shop practice for
   custom/perishable print jobs). State this plainly so customers see the consequence before
   they choose Pickup, e.g. "Pickup orders not collected within 3 business days will be
   cancelled with no refund." Do not build actual automated enforcement (order cancellation,
   refund logic) — there's no backend or order-status system live yet (docs/roadmap.md
   Milestone 1 is the eventual home for an automated version of this, similar in spirit to the
   planned `expire-pending-orders.js` cron for unpaid orders — this task is customer-facing
   copy only, staff will enforce it manually for now).

Acceptance criteria:
- Selecting "Delivery" reveals courier choice + address/landmark fields; selecting "Pickup"
  hides them and shows the 3-business-day forfeiture policy copy instead.
- buildOrderEmail() output includes courier + shipping details when Delivery is chosen, and
  omits them cleanly when Pickup is chosen (no blank/placeholder lines).
- The 1-2 business day confirmation SLA is visible to the customer before they submit.
- No new backend calls, no automated order-expiry logic — copy and form-field changes only.
- Manually test both Pickup and Delivery paths locally (`cd website && python3 -m http.server
  5500`) and confirm the popup + generated email text look correct for each, including the
  pickup forfeiture copy.
```

---

## Decisions (resolved 2026-07-28)

All decisions that originally blocked parts of Prompts 1, 2, and 4 have been confirmed by the
owner and are now baked directly into the prompts above:

1. **Prompt 2 — 2×3 vs 3×5**: rename only. The existing 2×3 in variant becomes 3×5 in on all
   four apparel-transfer products, same ₱50 price, no second small-size tier added.
2. **Prompt 4 — pickup non-collection policy**: forfeiture. A paid Pickup order not collected
   within 3 business days is cancelled with no refund. Enforcement stays manual/staff-driven
   for now (no backend exists yet); the checkout copy states this upfront.
3. **Prompt 1, item 8 — business-card minimum**: hard-enforced. A `minQty: 10` field is added
   to the product, and the cart's quantity stepper (setQty()/skuCard() in website/store.js) is
   updated to respect a per-product minimum floor instead of relying on blurb copy alone.

**Still open, not yet resolved:** Prompt 3's file-attachment work remains scoped to
classification + checkout copy only — no decision was requested there, since the `mailto:`
constraint rules out a true attach-and-send flow today regardless of preference. If the owner
wants real file uploads sooner than Milestone 1.2's backend work, that's a separate scoping
conversation (a lightweight interim upload endpoint vs. waiting for the full S3 presigned-
upload pattern), not something resolved by this brain dump.
