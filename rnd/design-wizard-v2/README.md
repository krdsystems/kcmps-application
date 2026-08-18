# R&D — Design subsection wizard, v2 (on the real front-end)

Same flow and layout as [v1](../design-wizard/), rebuilt so the presentation runs on the
repo's actual front-end instead of a self-contained fake.

**Still R&D. Nothing here is deployed and nothing here belongs in `website/`.** It only
*reads* from `website/` by relative path.

```bash
# needs a server (relative imports + fetch); repo root, not this folder
python3 -m http.server 5501
# → http://localhost:5501/rnd/design-wizard-v2/
```

## What changed from v1

v1 owned its own catalog, its own prices and its own cart. v2 deletes all three and drives
the same presentation off the real thing:

| Concern | v1 | v2 |
|---|---|---|
| Catalog | 8 invented designs | `window.KCMPS_STORE_DATA` — 33 real designs across the 4 apparel SKUs |
| Prices / sizes | hardcoded constants | each product's real `variants` + `shirtAddon` |
| Bulk tiers | local `BULK` array | `KCMPS_STORE.bulkTier` / `bulkUnitPrice` |
| Capacity cap | local popup | `KCMPS_STORE.requestQty` — the deployed `.cap-popup` |
| Cart | local array + custom drawer | `KCMPS_STORE.addToCart` + the real self-injected drawer |
| Styling | 160 lines of its own CSS | `website/styles.css`, by relative path |

Files: `index.html` (shell), `wizard.js` (flow), `wizard.css` (rnd-only bits), `guard.js`
(safety, below). Shirt blanks and placeholder transfers are reused from `../design-wizard/assets/`.

## `guard.js` — read before you click anything

`store.js`'s `CHECKOUT_API_BASE` is a runtime hostname check: staging on `dev.kcmps.com`,
**production everywhere else — including localhost**. An unguarded "Place order" here would
create a real production order and send a real customer email. `guard.js` wraps `fetch` and
rejects every absolute URL. It must stay loaded before `store.js`.

The cart is also the *real* cart — same `localStorage` key as the site, so on a shared origin
this mockup and the live storefront share a basket. "Clear cart" in the demo bar empties it.

## Verified in-browser (2026-08-08)

Measured in the DOM, not eyeballed:

- 33 tiles built from the real catalog; `28 of 33 available` on a black shirt — exactly the
  5 `subli` images excluded by the guard, which flips to `33` on white.
- ₱50 + ₱110 shirt = **₱160**; at 25 pcs the real 10% tier gives **₱144**; Both + the A3 bump
  = ₱150×2 + ₱110 = ₱410 → **₱369**.
- Qty 200 opens the **deployed** cap popup with the real `softCap: 150` copy ("about 2
  additional business days", Keep at max / I agree).
- "Both" adds 2 real cart lines — front ₱260×2 = ₱520 (shirt charged once), back ₱150×2 =
  ₱300, total ₱820 — keyed by placement so they can't merge.
- Two-step custom colour: the swatch only opens the panel (selection stays Black); "Use this
  color" commits and reveals the availability disclaimer. Matches `selectShirtColor()`.
- POST to the production checkout API is blocked by `guard.js`.
- No horizontal overflow at 375px; the lightbox collapses to one column.

**Not verified:** no screenshot was captured — the page renders 33 full-size catalog JPEGs and
`python -m http.server` is single-threaded, so screenshot capture timed out repeatedly. Layout
was confirmed by measuring boxes and computed styles instead. Visual polish is still unjudged.

## THE ASSET GAP — what to get from the designer

This is the one thing v2 could not fix in code, and the only blocker to the wizard's headline
feature.

**The problem.** The live shirt preview needs to recolour a garment and move/scale a print on
it. The real catalog images can't do that: every one of the 33 is a **photograph of a finished
shirt**, print already baked in, on a wood background (`01-BLACK PINK SHIRT.jpg` is a black tee
shot flat-lay). You can't recolour a photo of a black shirt into white, and you can't lift the
print off it to reposition it.

So v2 shows the real photo by default and offers "On my shirt colour" as a clearly-captioned
approximation built from v1's placeholder art. Everything else — pricing, tiers, cap, cart,
guard — is real.

### Ask 1 — the transfer artwork (the actual blocker)

For each design you want in the wizard, the **artwork alone**, off the shirt:

- **Transparent PNG** (or SVG — but note `backend/lib/upload-types.js` treats SVG as
  attachment-only, never inline-rendered, so a PNG export is the safer path here)
- Print-resolution, **300 DPI at A3** (~3500×4960 px) — it scales down to every size the
  wizard offers; a web-sized export can't scale back up
- **True transparency**, no white box, no drop shadow, no mockup background
- Trimmed to the artwork's own bounding box, so the wizard can centre it in the print area
  predictably
- Named to match the existing convention — `titleFromFilename()` turns
  `01-BLACK PINK SHIRT.png` into "Black Pink Shirt", so the naming already works

This is almost certainly work the designer *already has* — these transfers had to exist as
files before they were ever pressed onto the shirts in those photos. The ask is usually
"send the source export", not "make something new".

### Ask 2 — the shirt blanks

Real blanks to replace v1's generated geometry. Per garment style you want to offer:

- **Front and back**, same camera position and framing, so toggling views doesn't jump
- Shot on a **white or plain-light garment** on a neutral background — a light blank is what
  tints convincingly; a photo of a black shirt can't be made white
- Matching **greyscale shading/wrinkle layer + a silhouette mask** (the two-file pair v1
  generates). If that's more than the designer wants to produce, a single clean
  **transparent-background PNG of a white blank** works — the tint is then a `multiply` blend,
  slightly less controllable but good enough for a prototype
- Consistent aspect ratio across the set (v1 assumes 900×1050)

### Ask 3 — the print-area geometry

For each blank, where the printable area sits, as a percentage of the image box:
`left / top / width / height`, for front and back separately. v1 guesses
front `32/31/36/26` and back `25/26/50/38`. The designer or the presser knows the real
numbers; without them the preview shows prints in plausible-but-wrong positions.

### What you can honestly ship without any of this

Everything except the composite preview: the merged apparel grid, the object picker, real
pricing and bulk tiers, the capacity cap, placement modelling, the front/back cart pairing and
the sublimation-on-dark guard all work on the assets you already have today.

## Open modelling questions (unchanged from v1)

- **"Both" = 2 transfers, 1 shirt** — shirt charged once on the front line, back line reads
  "2nd print on the same shirt". Two lines so the presser can't misread it.
- **Back print auto-bumps to the largest size**, stated in the UI rather than done silently,
  and overridden by picking a size afterwards.
- The wizard implies a shirt, but keeps the real optional `shirtAddon` toggle rather than
  forcing it — unchecking it disables the colour picks exactly like the shop card does.
