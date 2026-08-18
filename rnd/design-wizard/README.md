# R&D — Design subsection wizard (mockup)

Clickable prototype of the proposed Design-subsection flow:
**object picker → design grid → lightbox with live shirt mockup (color · placement · size · qty) → cart.**

Not deployed, not wired to anything. Nothing here belongs in `website/`.

> **See [`../design-wizard-v2/`](../design-wizard-v2/) first.** Same flow and layout, rebuilt on
> the real `styles.css`, the real `products.js` catalog and the real `store.js` cart. This v1
> folder is kept for its shirt blanks and placeholder transfers (v2 reuses them) and as the
> record of the original modelling decisions.

## Files

| File | What it is |
|---|---|
| `design-wizard-mockup.html` | **Open this.** Single self-contained file, all images inlined as base64. Double-click, no server. |
| `template.html` | Editable source. Image slots are `__SHIRT_FRONT__`, `__D1__`…`__D8__` placeholders. |
| `build.py` | Inlines `assets/*.png` into `template.html` → `design-wizard-mockup.html`. Run after editing the template. |
| `generate-assets.py` | Regenerates the placeholder shirt templates + 8 sample designs with Pillow. Only needed if you want different art. |
| `assets/*.png` | Generated shirt shading/mask pairs (front + back) and 8 sample design PNGs. |

```bash
python3 generate-assets.py   # optional — regenerate placeholder art
python3 build.py             # re-inline into the single-file mockup
```

## What it demonstrates

- Object picker on entry (Apparel / 3D Print / Souvenir) with a "just browse" escape hatch
- Process tabs (DTF / sublimation / hotmelt) merged into one apparel grid — shopper never sees the word "DTF"
- Live shirt mockup: black / white / any custom hex, front + back templates, print area scales with transfer size
- Custom color is a **two-step** commit (pick → "Use this color"), mirroring the deployed `selectShirtColor()` behaviour
- Placement front / back / both; back auto-bumps to A3 with an overridable note
- Bulk tiers (10/25/50/100 → 6/10/13/16%) and the capacity soft-cap (150) + hard ceiling (750) popups
- **Sublimation-on-dark guard** — subli designs grey out when a dark shirt is selected
- Cart lines keyed by placement so a front run and a back run can't merge

## Modelling decisions baked in (open to change)

- **"Both" = 2 transfers, 1 shirt.** Shirt addon charged once on the front line; the back line reads "2nd print on the same shirt". Two lines, joined by a pair badge, so the presser can't misread it.
- **Back print defaults to A3**, stated in the UI rather than done silently.

## Known limitations

- Shirt art is programmatically generated placeholder geometry, not photos of real blanks.
- The 8 designs are throwaway samples, not the real catalog.
- Never rendered in a browser during authoring — visual polish is unverified.
