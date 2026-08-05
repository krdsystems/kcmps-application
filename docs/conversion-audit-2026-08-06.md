# Conversion audit — mobile-first, 2026-08-06

Branch `claude/conversion-polish`. Priority order fixed by the owner: **conversion first,
mobile experience second, aesthetics as tiebreaker only.** Audited at 375×812 first, then
adapted upward.

## How this was audited (and what it is *not*)

- Walked the storefront in a real browser (Chromium via the Browser pane) against a local
  `python3 -m http.server` serving this branch's `website/` verbatim, at a 375×812 viewport.
- **Screenshot capture failed in this environment** — every `screenshot`/`zoom` call timed out
  after 30s against a page carrying 83 images. The page itself stayed responsive (scripted DOM
  reads returned instantly), so the timeout is in the capture path, not the page. **There are
  therefore no before/after screenshots in this report.** Verification was done instead by
  measured DOM geometry (`getBoundingClientRect`, `getComputedStyle`, `scrollWidth` vs
  `clientWidth`), which for the class of problems found here — clipped controls, tap-target
  sizes, below-the-fold CTAs, iOS zoom triggers — is *more* reliable than eyeballing a
  screenshot, because it produces numbers rather than impressions. Anything that needs a human
  eye (does the new spacing look right, does the motion feel right) is explicitly listed as
  **not visually verified** at the end of this document.
- `dev.kcmps.com` sits behind HTTP Basic Auth. **I did not enter those credentials** — entering
  a password to authenticate is outside what I'm permitted to do, regardless of who supplies it.
  Files were still synced to `dev-site/` for the owner to review; the browser walkthrough was
  done against a byte-identical local copy of the same tree.
- No order was placed. `store.js` routes any hostname that isn't `dev.kcmps.com` to the
  **production** checkout API, so submitting from `localhost` would have created a real order
  and fired production notification Lambdas. The walk stops one click short of "Place order".
  The GCash payment-proof popup was audited by injecting its exact rendered markup
  (copied from `renderPaymentProofStep()`) into the live page and measuring it — real CSS, real
  layout, no network call.
- **Anything behind staff auth was not tested at all.** No staff Cognito session, and
  authenticating is out of scope. `website/dashboard/*` is untouched and unaudited.

---

## Category (a) — low-risk polish (implemented on this branch)

Ordered by conversion impact, not by effort.

### A1. Product variants are physically unreachable on a 375px phone — **hard blocker**

`.seg` is `display: inline-flex; overflow: hidden` with no wrap and no scroll. When a product's
variant row is wider than the card, the overflowing options are **clipped away with no scrollbar,
no fade, and no way to reach them.** Measured on this branch:

| Product | Options clipped | `scrollWidth` vs `clientWidth` |
| --- | --- | --- |
| Inkjet Photo Print | 2 of 6 | 415 vs 281 |
| Lamination | 1 of 5 | 316 vs 281 |
| Stickers & Labels | 1 of 4 | 314 vs 281 |

A shopper on a phone cannot buy "A4 Back2Back — Glossy" at all. This is a lost sale per
occurrence, not a cosmetic issue. Fix: let `.product .seg` wrap on narrow viewports, with the
divider borders re-derived so a wrapped row still reads as one segmented control.

### A2. Quantity steppers collapse to a 20px tap target — **hard blocker**

`styles.css` already carries a deliberate `@media (max-width: 760px)` rule bumping
`.qty-stepper button` to 40×40px, with a comment citing the HIG/Material minimum. **That rule is
being defeated by flex shrink**: `.product-buy` is a `flex` row with `justify-content:
space-between`, and the stepper has no `flex: none`, so a long price string squeezes it. Measured
at 375px, **8 of the shop's 16 visible stepper buttons render below the intended 40px**:

| Product | `−` button width |
| --- | --- |
| Stickers & Labels | **21.3px** |
| Business Cards | 29.9px |
| Custom Bookmarks / Custom Self-Inking Stamps | 31.8px |
| Document Printing, Lamination, Binding, Inkjet Photo | 40px (already correct) |

21.3px is roughly a quarter of the area of a 44px target. Fix: `flex: none` on `.qty-stepper` and
its buttons so the declared size is actually honoured.

> **Correction (measurement artifact).** An earlier pass reported these as 20/28/30/38px and
> counted 12 offenders. Those reads were taken while `.catalog.deck-reveal` was still at its
> pre-reveal `scale(0.94)` (see `index.html`'s `--deck-in`), which shrinks every measured rect by
> ~6%. Re-measured with the deck reveal complete (`--deck-progress: 1`, `transform: matrix(1,…)`),
> the true figures are the table above — the four 38px entries were always a correct 40px. The
> defect and the fix are unchanged; only the magnitude was overstated.

### A3. Every checkout field triggers an iOS Safari auto-zoom

`.input` is `font-size: 14px`. iOS Safari zooms the viewport whenever a focused form control is
under 16px, and the page's viewport meta correctly omits `maximum-scale`, so the zoom is not
suppressed. Result: tapping *any* field in the cart drawer's checkout form, the payment-proof
popup, or `track-order.html` yanks the page scale and leaves the shopper zoomed in mid-form.

Fix: raise `.input`/`.qval` to 16px at ≤760px only. **Not** by adding `maximum-scale=1` — that
suppresses the zoom by disabling pinch-zoom entirely, which is an accessibility regression.

### A4. Form controls and buttons under the 44px minimum on the critical path

Measured at 375px, on surfaces the buyer must touch to complete a purchase:

| Control | Measured | Where |
| --- | --- | --- |
| `.input` (all 9 checkout fields) | 36px tall | cart drawer, track-order |
| `.seg-opt` Pick up / Delivery | 34px tall | checkout |
| `.tab-btn` (Printing & Office / Design / Merch) | 32.2px tall | catalog nav — every shopper |
| `.tab-btn` (estimator sub-tabs) | 27px tall | bulk-quote step 01 |
| `.btn-block` Add to cart | 42.8px tall | every product card |
| `.carousel-dot` | 7×7px | hero |
| `.cart-close` | 34×34px | cart drawer |

The Add-to-cart and category-tab numbers matter most: they are on the path of every single
purchase. The carousel dots are the worst ratio but the least load-bearing (arrows and swipe both
work), so they get a padded hit area rather than a bigger dot — visual size unchanged.

### A5. The final "Submit payment proof" button sits 150px below the fold

Reconstructed the payment-proof popup at 375×812 with its real CSS. The popup is capped at 90vh
(`763px`) with `overflow-y: auto`, but its content is `913px` tall — the 200×384 GCash QR plus
three fields plus the fallback-email note. **The primary action is 150px past the bottom of the
scroll box, and the only cue that more exists is a 6px scrollbar thumb.** This is the last click
of the funnel, after the customer has already paid via GCash.

Fix: pin `.dialog-actions` to the bottom of `.order-popup` as a sticky bar with a matching
background, so the CTA is on screen the whole time the form is being filled.

### A6. GCash reference field opens an alphabetic keyboard

`#pp-ref` is a plain text input with no `inputmode`. The value is always digits. Adding
`inputmode="numeric"` costs nothing and removes a keyboard switch at the moment of payment.

### A7. Dismissing the payment popup is a dead end

`renderPaymentProofStep()` is the one popup state with **no** "Track this order" link — the
custom-only and proof-submitted states both call `trackOrderLink()`. A shopper who backgrounds
the tab to open GCash and comes back to a dismissed popup has no path to their order and no
record of the ID other than the email. Adding the same existing helper here closes it.

### A8. Hero CTA lands at y=781 of an 812px viewport

Measured on the `print-office` variant: H1 starts at **y=414**, the sub-paragraph runs **144px /
6 lines** (236 characters), and the primary CTA lands at **y=781** — technically above the fold,
practically at the very bottom edge, with the trust chips at y=1066 (well below). The `design`
variant's sub is 175 characters and fares better.

Fix is copy, not layout: tighten `PAGE_VARIANTS['print-office'].sub` and the static fallback sub
so they carry the same promise in fewer lines. No structural change to the hero — in particular
**not** reverting the mobile hero card to copy-over-image with a scrim, which `CLAUDE.md` records
as already tried and failed against this photo pool.

### A9. Checkout validation uses four native `alert()` dialogs

`submitOrder()` raises `alert()` for missing name, missing contact method, missing address, and
in-flight uploads. A native modal on mobile covers the form, doesn't say which field is wrong,
and requires a dismiss tap before the shopper can act. Both loaded skills and standard practice
call for validating inline rather than on submit.

Fix: an inline error region at the foot of the checkout view (directly above the Place-order
button), plus `aria-invalid` and focus moved to the offending field. Same validation rules, same
order — only the presentation of the failure changes.

### A10. The estimator's product grid hides 6 rows behind an unmarked internal scroll

`.est-product-grid` is capped at `max-height: 256px` with `scrollHeight: 1549px` at 375px — over
80% of the picker's content is behind an internal scroll with no affordance. The cap itself is
deliberate (documented in `CLAUDE.md`, keeps Step 02 from being pushed down the page), so the fix
is a bottom fade mask signalling "more below", not removing the cap.

### A11. Value-stack and guarantee placeholder copy

Both `<!-- OWNER: ... -->` markers left intact and unedited. Presentation only: the value-stack's
peso column and the "Typical value elsewhere" / "You pay, all-in from" rows now read as a clear
strike-through-to-price comparison rather than two similarly-weighted totals, and the guarantee
card's heading/body relationship is tightened. **No number and no promise was invented or
changed.**

---

## Post-fix verification — measured before/after at 375×812

Re-measured after implementation, comparing this branch's working tree against its merge-base
`HEAD` served side by side (`python3 -m http.server` on two ports, same browser, same 375×812
viewport). Catalog-section controls were read with the card-deck reveal forced complete
(`--deck-progress: 1`, confirmed `transform: matrix(1, 0, 0, 1, 0, 0)`) so no measurement is
taken through the pre-reveal `scale(0.94)`; hero controls were read at `--deck-progress: 0`,
where the hero itself is unscaled. **Still no screenshots — capture times out in this
environment; everything below is DOM geometry.**

| # | Control | Before | After |
| --- | --- | --- | --- |
| A1 | `.product .seg` clipped rows | **3 of 8** clipped — Inkjet Photo 415 vs 281, Lamination 316 vs 281, Stickers 314 vs 281 | **0 of 8**; 7 rows now wrap to 2–3 lines, `scrollWidth == clientWidth` |
| A2 | `.qty-stepper button` | 21.3px – 40px, **8 of 16 under 40px**, worst Stickers & Labels 21.3×37.6 | **all 16 exactly 40×40px**, stepper uniform 109px |
| A4 | `.tab-btn` (catalog) | 32.2px tall | **44px** |
| A4 | `.btn-block` Add to cart | 42.8px tall | **44px** |
| A4 | `.carousel-dot` hit area | 7×7px | **31×39px** (visual dot size unchanged) |
| A4 | `.input` (checkout) | 36px tall, **14px font** | **46.8px tall, 16px font** (also closes A3's iOS zoom) |
| A4 | `.seg-opt` Pick up / Delivery | 34px tall | **44px** |
| A4 | `.cart-close` | 34×34px | **44×44px** |
| A5 | "Submit payment proof" CTA | `top: 949.8` / `bottom: 1009.4` — **221.8px below the popup's bottom edge and ~198px below the 812px fold**; `.dialog-actions` `position: static` | `top: 727.6` / `bottom: 771.6` — **on screen**, 16px inside the popup, `position: sticky`, 44px tall |
| A6 | `#pp-ref` | no `inputmode`, 14px font | `inputmode="numeric"`, 16px font |
| A7 | payment-proof popup | no "Track this order" link | link present |
| A9 | checkout validation | four native `alert()` calls | inline error region present in the drawer |

A5's before-figure is larger than the 150px estimated during the audit pass because the
reconstruction here reproduces the full rendered markup (popup content 1009px in a 763px box).
The after-state was verified against an even taller reconstruction — 1118px of content, 355px of
overflow, including A7's new track link — and the CTA still stays pinned on screen.

**Residual, not fixed:** the quantity stepper now honours its declared 40×40px, which is the
size `styles.css` already intended, but is still under the 44px HIG/Material minimum that A4
brings the other controls up to. Raising it further changes the product card's price-row layout,
so it was left at 40px rather than widened silently.

---

## Category (b) — flow changes, NOT implemented, owner approval required

These are written up with external evidence as required. Nothing below has been coded.

### B1. The checkout form hides the order summary

Entering `checkout-mode` swaps the cart line items out for the form. The shopper's only remaining
confirmation of *what* they are buying is a "Pay now ₱80" total in the footer; seeing the items
again costs a "← Back to cart" round trip.

**Evidence.** Baymard Institute's cart & checkout research finds that an order summary must
remain accessible throughout checkout, and reports that users abandon when they cannot re-verify
contents at the point of payment; "always display the order summary during checkout" is a
long-standing Baymard checkout guideline derived from their usability test sessions
(<https://baymard.com/blog/mobile-order-summary>). Live pattern: Shopify's default checkout keeps
a collapsible order summary pinned at the top of the mobile checkout column, expanded on desktop.

**Proposed change.** A collapsed one-line summary row above the name field ("3 items · ₱480 —
tap to review") that expands the existing cart-line markup in place. Additive; the "Back to cart"
button stays.

**Why it's category (b).** It adds content and a new interaction to the checkout view rather than
restyling what's there, and it changes what the shopper sees at the decision moment.

### B2. Five equally-weighted contact fields

Name, Email, Phone, Messenger, Other contact are five flat fields of identical visual weight,
with a note underneath saying only one is required. The form reads as five obligations.

**Evidence.** Baymard's checkout benchmark attributes a substantial share of abandonment to
checkouts that are "too long / complicated", and their guideline set repeatedly recommends
reducing perceived field count. The classic supporting datapoint is the Expedia case in which
removing a single ambiguous optional field was reported to recover ~$12M/yr in bookings — widely
cited, originally reported via Expedia's own product team
(<https://baymard.com/blog/checkout-flow-average-form-fields>). The general finding — perceived
field count, not just actual, drives abandonment — is what applies here.

**Proposed change.** Keep Email and Phone visible; collapse Messenger and Other behind a single
"Add another way to reach me" disclosure. Validation logic is unchanged (still "at least one").

**Why it's category (b).** It hides fields by default, which changes the flow and could reduce
the reachability data the shop actually relies on. That's a business call, not a polish call.

### B3. Trust signals sit ~250px below the CTA on mobile

The three trust chips (reprint guarantee, automatic bulk discounts, pay-after-approval) render at
y≈1066 — the shopper decides whether to tap the CTA at y=781 before ever seeing them.

**Evidence.** Baymard's research on trust and checkout consistently finds trust signals are only
effective when co-located with the decision point rather than elsewhere on the page; the same
principle underlies the near-universal placement of guarantee badges adjacent to the buy button
on major storefronts (Amazon's "FREE Returns" line renders directly under the Buy Now button;
Shopify's Dawn theme places trust badges in the product form block, not in the footer).

**Proposed change.** Promote the single strongest chip — the reprint guarantee — to a one-line
strip directly beneath the hero CTA, leaving the full row where it is.

**Why it's category (b).** It reorders hero content, and the mobile hero card's flex `order`
sequencing is explicitly flagged in `CLAUDE.md` as fragile and previously mis-shipped. Not
something to change without the owner looking at it.

### B4. Not evaluated: anything requiring authentication

The signed-in checkout path (`co-account-note`, locked name/email), `orders.html`,
`order-detail.html`'s post-purchase surfaces, and the entire staff dashboard were **not walked**.
No account was created and no password was entered. Treat their conversion behaviour as unaudited.

---

## Explicitly rejected

**A build step / framework / CDN dependency.** Nothing in this audit needs one. Every finding
above is addressable in the existing vanilla CSS + ES5-style `store.js`. No recommendation to
introduce tooling.

---

## Not visually verified

Because screenshot capture failed (see the top of this document), the following were verified by
measurement and code inspection **only**, and want a human eye on `dev.kcmps.com`:

- That the wrapped `.seg` control still *looks* like one segmented control on the three affected
  products rather than a broken grid.
- That the sticky payment-popup action bar doesn't visually crowd the QR code.
- That the tightened hero sub-copy still reads well at both 375px and desktop.
- That the value-stack's revised emphasis reads as intended.
- Motion feel with `prefers-reduced-motion` off. The reduced-motion *code paths* were confirmed
  present and untouched (`styles.css` already gates `.btn`, `.qty-stepper`, `.cart-drawer`,
  `.order-popup`, `.cart-close`; `store.js` has `skipMotion()`), and no change on this branch
  adds an ungated transition — but "feels right" is not something measurement establishes.
