# CLAUDE.md — storefront-infra/

Build-time tooling for the storefront's **product-image asset bucket** (separate from the
`website/` deploy bucket — this is the private S3 bucket + CloudFront/OAC pair that serves
catalog and hero photography). Not deployed itself — this is planning/infra material, kept
separate so an S3 sync of `website/` never uploads it.

Only loaded when you're actually working in this folder — see the root `CLAUDE.md` for
project-wide orientation.

## Current state: bucket convention defined, manifest Lambda not yet deployed

The frontend (`website/index.html` hero carousel) already knows how to consume
`manifest.json` — see `HERO_MANIFEST_URL` near the carousel script. Until the real Lambda
below is deployed, `website/assets/manifest.json` is a hand-maintained sample so local dev
and the hero rotation work end-to-end without AWS.

## What's here

- `assets-bucket-structure.md` — the S3 folder convention (one prefix per shop category),
  the primary/gallery image naming convention, the manifest JSON shape, and the
  S3-event-triggered Lambda plan that regenerates it.
- `logic-inputs/generate-asset-manifest.js` — the actual Lambda source to deploy.
- `logic-inputs/site-kcmps-redirect.function.js` — the CloudFront Function (viewer-request,
  301-redirects `site.kcmps.com` → `https://kcmps.com`) live on distribution `EY6Q5RSWLDCEF`
  in account `600929977538`. Unrelated to the asset bucket, kept here only because this is
  where other non-deployed infra source lives; there's no CLI/IaC deploy path for CloudFront
  Functions in this repo, so this file is the copy of record — edit it, then re-paste into the
  console's Functions editor. See `docs/history.md` step 40 and the root `CLAUDE.md`'s
  "Deploying to production" section for the full domain/DNS picture.

## When you'd touch this folder

- Actually deploying the manifest Lambda → follow `assets-bucket-structure.md`.
- Adding a new shop category or changing the primary-image naming rule → update
  `assets-bucket-structure.md` first, then `generate-asset-manifest.js`'s parsing logic,
  then confirm `website/index.html`'s hero carousel still degrades gracefully if the
  manifest shape changes.
- Changing how the hero carousel consumes the manifest → that's frontend work in
  `website/index.html`, not this folder; this folder only owns what produces
  `manifest.json`.
