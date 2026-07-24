# KCMPS design system

KCMPS is Kaalyados Creatives' studio system: navy as the dominant brand ink, one warm orange spot reserved for the single call to action per view, on a cool off-white ground. Rounded, friendly, engineered — this is a print-and-hardware studio, not a newsroom, so the system favors soft radii, generous whitespace and real photography over gimmicks. Structure comes from clear section labels and whitespace, never boxes-within-boxes.

## How to use this

- Link the one stylesheet from every page — `<link rel="stylesheet" href="styles.css">` (adjust the relative path) — and take every color, font, spacing, radius and shadow from its variables (`var(--color-*)`, `var(--font-*)`, `var(--space-*)`, `var(--radius-*)`, `var(--shadow-*)`). Never hard-code a hex, a font name or a px value the tokens already carry.
- Build with the classes below rather than inventing parallel ones; the component pages are plain HTML, so view source and copy the markup.
- `templates/` holds starting points a consuming project can copy whole.
- The whole system was derived from `theme.json`. To change the look, edit the tokens at the top of `styles.css` — every page, the thumbnail and this guide read from them — and keep `theme.json` and the written guidance in step so they don't drift from what the CSS actually does.

## Direction

Left-aligned, generous layouts with rounded corners (`--radius-lg` on cards and photos, `--radius-md` on controls) — approachable rather than industrial. Section labels ("01 · Print production") are small pill kickers, not monospace grid coordinates. Photographs are real studio and product shots; the one showcase treatment is `.duotone` (a navy-to-orange wash — see foundations/image.html), used on hero and section imagery only, never on screenshots or diagrams.

## Color

A cool light ground (`--color-bg` #f6f7f9) with `--color-text` #1a2b42 (a soft navy-charcoal, never pure black). Navy — `--color-accent-2` #1d3f72 — is the dominant brand color: the wordmark, nav brand, section headings can lean on it. Orange — `--color-accent` #f2882e — is the one true accent: reserve it for the single primary action per screen (the main CTA button, an active nav state, a key highlight) so it keeps its punch. A muted green (`--color-green`) exists only for rare status use (in stock, confirmed) — never for chrome or headings. Each ramped role carries a 100–900 tonal scale; use light steps (100–300) for tints and hovers, 500 as the base, dark steps (700–900) for text on tinted fills. For elevation use `--shadow-sm/md/lg` rather than ad-hoc box-shadows.

## Type

Plus Jakarta Sans (heading, 700/800) paired with Inter (body, 400/500/600) — a rounded geometric head over a clean grotesque body, friendly without losing precision. Headings never take the accent color for large runs of text; keep the accent to labels, buttons and small emphasis.

## Icons

Use Phosphor icons (https://phosphoricons.com), in the duotone weight throughout.

## Interaction states

Interactive states are themed, never browser defaults: give every interactive element a `:hover` tint and a pressed state from the accent ramp, and style keyboard focus with `:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }` — never leave the default blue focus ring.

## Components

| Class | What it is | Shown in |
| --- | --- | --- |
| `.btn` with `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-icon`, `.btn-block` | Actions — the primary is a solid orange fill | components/buttons.html |
| `.tag` with `.tag-accent`, `.tag-accent-2`, `.tag-neutral`, `.tag-outline` | Small pill labels tinted from the ramps | components/buttons.html |
| `.field` + `label`, `.input`, `.radio` + `.dot`, `.seg` + `.seg-opt` | Form fields and choices on native elements — no script | components/forms.html |
| `.card` with `.card-kicker`, `.card-title`, `.card-body`, `.card-meta`; `.elev-sm/md/lg` | Rounded surface-filled content cards; elevation utilities | components/cards.html |
| `.nav` + `.nav-brand` | The header bar | components/navigation.html |
| `.table` | Data tables with themed header and row rules | components/table.html |
| `.dialog-backdrop` + `.dialog` (+ `.dialog-title/-body/-actions`) | A modal at the top elevation | components/dialog.html |
| `.hr` | A horizontal rule — present, but this system prefers whitespace; avoid it | — |
| `.duotone` | The showcase photo treatment — navy-to-orange wash over real photography | foundations/image.html |
| `.halftone` | A lighter dot-screen option for interface imagery | foundations/image.html |

States are built in: hovers and pressed states come from the accent ramp, keyboard focus is the 2px accent `:focus-visible` ring, `::selection` is an accent tint, and disabled controls drop to 45% opacity. Don't restyle them per page.

## Do

- Reserve orange for the one action or highlight that matters most on a given screen.
- Let navy carry the brand voice — logo, nav, headings.
- Use real studio/product photography with `.duotone` for hero and section imagery.
- Round things — cards, photos, buttons, inputs all take a token radius.

## Don't

- Do not use both accents at full strength in the same small component.
- Do not tint large blocks of body text in the accent — reserve it for chrome and small emphasis.
- Do not reintroduce sharp, industrial/monospace styling — this system is the approachable side of a production studio, not a technical console.
- Do not use raw stock imagery without the `.duotone` treatment on hero-scale photography.

## Files

- `styles.css` — the only stylesheet: the token sheet (`:root` variables, ramps, base type) plus the component layer. Link it from every page.
- `readme.md` — this guide.
- `theme.json` — the parameters these files were derived from (a machine-readable record of the theme).
- `thumbnail.html` — the project cover (brand mark + swatches).
- `assets/logo.png`, `assets/logo-mark.png` — the KCMPS logo (full lockup and icon-only mark), background-removed.
- `foundations/type.html` — the type scale and the heading/body pairing at real sizes.
- `foundations/color.html` — color roles and the 100-900 tonal ramps, with usage notes.
- `foundations/layout.html` — the spacing scale, the grid and how edges are drawn.
- `foundations/icons.html` — the icon set at interface sizes, inline and in buttons.
- `foundations/image.html` — how photographs and figures are treated.
- `components/buttons.html` — buttons, icon buttons and tags in every variant and state.
- `components/forms.html` — text fields, radios and the segmented control on native elements.
- `components/cards.html` — content cards and the elevation steps.
- `components/navigation.html` — the header bar pattern.
- `components/table.html` — a data table with the themed header and row rules.
- `components/dialog.html` — a modal over its backdrop at the top elevation.
- `theme.html` — the theme's parameters rendered as a reference sheet.
- `templates/landing/` — the rebuilt KCMPS studio site: index/hero, capability pillars, offerings catalog, real-time estimator and contact — starting from `index.html`, its `ds-base.js` loader, and the vendored `image-slot.js` its photograph mounts.
