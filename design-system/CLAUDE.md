# CLAUDE.md — design-system/

This folder is a **design-tool export** (generated once, hand-edited since), not app code.
It's reference material for `website/styles.css`, not deployed itself.

Only loaded when you're actually working in this folder — see the root `CLAUDE.md` for
project-wide orientation.

## What's here

- `KCMPS Redesign/readme.md` — the design system reference: tokens, components, do/don't
  guidance. Read this first for anything visual (colors, type, spacing, component classes).
- `KCMPS Redesign/theme.json` — the source tokens the whole system was derived from.
- `KCMPS Redesign/styles.css` — a **mirror** of `website/styles.css`. If you change one,
  change the other — they're meant to stay identical (see root `CLAUDE.md`'s conventions).
- `KCMPS Redesign/components/*.html`, `foundations/*.html` — plain HTML reference pages,
  view-source-and-copy the markup rather than inventing parallel classes.
- `KCMPS Redesign.zip` — a zipped duplicate of the `KCMPS Redesign/` folder next to it.
  **Don't open or edit the zip** — it's not the source of truth, the extracted folder is.
- `_ds_bundle.js`, `_ds_manifest.json`, `_adherence.oxlintrc.json`, `.thumbnail`,
  `thumbnail.html`, `theme.html` — design-tool internals, not meant to be hand-edited.

## When you'd touch this folder

- Changing brand tokens/colors/type → edit `theme.json` and `styles.css` here, then apply
  the same change to `website/styles.css`.
- Adding a new reusable component → prototype it in `components/*.html` here first, then
  port the class to `website/styles.css` and use it in `website/index.html`.
- Everything else (page copy, cart logic, product data) lives in `website/` — don't look
  here for it.
