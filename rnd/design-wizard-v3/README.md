# R&D — Design subsection wizard, v3 (the whole site)

The full KCMPS site, with the **Design subsection replaced by the wizard**. `index.html` and
`styles.css` here are copies of `website/`, free to restyle; `products.js` and `store.js` are
loaded from `website/` unmodified, so catalog, pricing, capacity and cart stay real.

**Still R&D. Nothing here is deployed and nothing here belongs in `website/`.**

```bash
# repo root, not this folder
python3 -m http.server 5501
# → http://localhost:5501/rnd/design-wizard-v3/  → click the "Design" tab
```

## What v3 changed

**The composite shirt preview is gone.** v2 tried to fake a live mockup without transparent
artwork — first placeholder art, then deriving an alpha channel from the catalog photo's
luminance. The luminance key worked on high-contrast lettering and fell apart on everything
else: photographic designs came out bleached, dark-on-dark artwork collapsed into an opaque
rectangle. It was convincing right up until it wasn't, which is the worst property a mockup
can have.

So the lightbox's **left side is now just the catalog photograph** — the one honest,
high-quality asset that exists today. Shirt colour, placement and size are still real controls
driving real prices and real cart lines; they've stopped pretending to render a preview they
can't.

**The Design panel is the rnd page.** Upstream it's a two-level tab tree (Apparel / 3D Print /
Souvenir, then DTF / Subli / Hotmelt). All of it is gone: the process tabs forced a production
decision onto the shopper. v3 merges every apparel leaf into one grid and picks the process
from the design's own `leaf`. The other two objects become the object picker, which opens when
you enter the subsection — not on page load, since this is a full site now.

Print & Office and Merch are untouched and still render through `store.js`'s `renderCatalog()`.

## Two bugs from the v2 screenshot, fixed

- **A colour read as selected while the shirt toggle was off.** v2 defaulted `S.color` to black
  and kept the pick highlighted, so an unchecked row still showed a selected swatch. Now no
  colour is selected until the shopper picks one; unchecking clears it; the colour chip in the
  strip only appears once a shirt is actually part of the order.
- **The Front/Back view toggle showed when placement was Front.** It belonged to the composite
  and is gone with it.

## `guard.js` — read before clicking anything

`store.js`'s `CHECKOUT_API_BASE` is a runtime hostname check: staging on `dev.kcmps.com`,
**production everywhere else — localhost included**. Unguarded, "Place order" here would create
a real production order and send a real customer email. `guard.js` wraps `fetch` and rejects
every absolute URL. It must stay loaded before `store.js`.

The cart is also the *real* cart, same `localStorage` key as the site — this mockup and the
live storefront share a basket on a shared origin.

## Verified in-browser (2026-08-08)

Measured in the DOM:

- The full site still renders — 12 Print & Office cards, hero, Merch — with the Design panel
  now the wizard: 33 tiles, old process tabs gone.
- Entering Design opens the object picker; picking Apparel closes it; a tile opens the lightbox
  with the **catalog photo** on the left, no composite and no view toggle in the DOM.
- Shirt toggle off: no colour selected, all picks disabled, price ₱50 (transfer only).
  Toggled on: defaults to Black, ₱160.
- 25 pcs + Both + the A3 bump quotes **₱9,225** (₱369 each) and the cart totals **₱9,225**
  — front ₱5,850 (shirt charged once) + back ₱3,375, two lines keyed by placement.
- Sublimation guard: on black it blocks the add, shows the inline notice, and greys exactly the
  5 `subli` tiles (`28 of 33`); "Switch to white" recovers and re-enables the add.
- No horizontal overflow at 390px; grid drops to 2 columns, lightbox to 1.

**Not verified:** no screenshot — capture timed out repeatedly against a page rendering 33
full-size catalog JPEGs through a single-threaded `python -m http.server`. Layout was confirmed
by measuring boxes and computed styles. Visual polish is unjudged; judge it in your own browser.

**A caught false alarm, recorded so it isn't re-investigated:** an early cart check showed
₱9,963 against a quoted ₱9,225. That was leftover v2 test lines merging on an identical key
(qty 27 = 25 + 2), with the unit price correctly re-tiered — the real cart working as designed,
not a v3 defect. Clearing the cart reproduced an exact match.

## Still the asset gap

A live shirt preview needs **transparent transfer artwork** — print-resolution PNGs of the
artwork alone, off the shirt, trimmed to its bounding box. Everything else the wizard does
already works on today's assets. See [v2's README](../design-wizard-v2/README.md#the-asset-gap--what-to-get-from-the-designer)
for the full designer brief (artwork, blanks, print-area geometry).
