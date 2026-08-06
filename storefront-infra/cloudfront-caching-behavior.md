# Prepared, not applied — CloudFront cache behavior for `assets/*`

Staged per `docs/performance-audit-2026-08-06.md` Fix 1 (see also Fix 4, the companion
`--cache-control` deploy-script change). **Nothing in this file has been applied to either
CloudFront distribution.** Both `EY6Q5RSWLDCEF` (production, `kcmps.com`) and `E7PDB5JQRZX0E`
(dev, `dev.kcmps.com`) are confirmed (via `get-distribution-config`, 2026-08-07) still on the
AWS managed **CachingDisabled** policy for every path, on both distributions.

## What this fixes

Every request for every asset — including images that never change (logos, product photos,
`bg-texture.png`) — is currently forwarded to the S3 origin on every single page view, for
every visitor, forever. Scoping a cache behavior to `assets/*` (images, fonts,
`manifest.json`) lets CloudFront serve those from the edge on repeat requests, while leaving
`index.html`/`store.js`/`products.js`/`styles.css`/`dashboard/*.html` — anything that changes
on a normal deploy — on the existing `CachingDisabled` policy so `aws s3 sync` still shows up
instantly with no invalidation step. This is the audit's single largest lever on perceived
page-load speed, at ₱0 recurring cost (cache policies are free; this reduces S3 origin
transfer if anything).

## Why it's staged as a comment, not deployed

- **Production (`EY6Q5RSWLDCEF`) is owner-gated** — this repo's hard rule is never to modify
  the production CloudFront distribution without the owner's explicit go-ahead.
- **Applying it to dev right now would actively sabotage dev.kcmps.com's whole purpose.**
  Dev's entire value is that `aws s3 sync .../dev-site/` shows up on refresh with zero wait.
  Caching `assets/*` at the edge means a synced image wouldn't reflect until the cached entry
  expires (`CachingOptimized`'s default max-age) or is explicitly invalidated — the opposite
  of what a fast-iteration staging domain is for. So even though `dev-domain.cfn.yaml` is
  CloudFormation-managed (safe to redeploy), the change is left commented out there rather
    than applied.

The prepared `CacheBehaviors` block lives directly in `storefront-infra/dev-domain.cfn.yaml`'s
`DevDistribution` resource, commented out immediately below `DefaultCacheBehavior`, ready to
uncomment when the tradeoff above is intentionally accepted (e.g. once dev testing habits
shift to "check it, then invalidate/wait" for asset-only changes — HTML/JS/CSS are untouched
either way).

## To apply — dev (CloudFormation)

1. Uncomment the `CacheBehaviors` block in `storefront-infra/dev-domain.cfn.yaml`.
2. `aws cloudformation deploy --template-file storefront-infra/dev-domain.cfn.yaml --stack-name kcmps-dev-domain --region us-east-1 --parameter-overrides BasicAuthPassword='<existing password — see storefront-infra/CLAUDE.md>' --profile kcmps-claude-priv --no-fail-on-empty-changeset`
   (all other parameters keep their existing defaults; only `BasicAuthPassword` has no
   default and must be re-passed on every deploy).

## To apply — production (CLI, since prod's distribution predates and isn't CloudFormation-managed)

Production has no template to add a resource to — it's a live distribution managed via the
CLI. The equivalent change is a `get-distribution-config` → edit → `update-distribution`
round trip, run only after the owner has said to promote:

```bash
# 1. Pull the current config + its ETag (required for the update call)
aws cloudfront get-distribution-config \
  --id EY6Q5RSWLDCEF \
  --profile kcmps-claude-priv \
  > /tmp/prod-dist-config.json

# 2. Extract the ETag separately (update-distribution wants it as a flag, not in the body)
ETAG=$(jq -r '.ETag' /tmp/prod-dist-config.json)

# 3. Edit /tmp/prod-dist-config.json's .DistributionConfig:
#    - Add a CacheBehaviors entry (bump CacheBehaviors.Quantity to 1, Items to a one-element
#      array) with:
#        PathPattern: "assets/*"
#        TargetOriginId: <same value as .DistributionConfig.DefaultCacheBehavior.TargetOriginId>
#        ViewerProtocolPolicy: "redirect-to-https"
#        Compress: true
#        AllowedMethods: { Quantity: 2, Items: ["GET","HEAD"], CachedMethods: { Quantity: 2, Items: ["GET","HEAD"] } }
#        CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6"   # AWS managed CachingOptimized
#      Leave DefaultCacheBehavior (and everything else) untouched — this only adds a second,
#      more specific behavior; it does not replace the default.
#    - jq one-liner to do the same programmatically instead of hand-editing:
jq '.DistributionConfig.CacheBehaviors = {
      Quantity: 1,
      Items: [{
        PathPattern: "assets/*",
        TargetOriginId: .DistributionConfig.DefaultCacheBehavior.TargetOriginId,
        ViewerProtocolPolicy: "redirect-to-https",
        Compress: true,
        AllowedMethods: { Quantity: 2, Items: ["GET","HEAD"], CachedMethods: { Quantity: 2, Items: ["GET","HEAD"] } },
        CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
        SmoothStreaming: false,
        FieldLevelEncryptionId: "",
        LambdaFunctionAssociations: { Quantity: 0 },
        FunctionAssociations: { Quantity: 0 },
        TrustedSigners: { Enabled: false, Quantity: 0 },
        TrustedKeyGroups: { Enabled: false, Quantity: 0 }
      }]
    }' /tmp/prod-dist-config.json > /tmp/prod-dist-config.edited.json

# 4. Apply — note the body must be ONLY .DistributionConfig, not the get-distribution-config
#    wrapper, and IfMatch must be the ETag from step 2
aws cloudfront update-distribution \
  --id EY6Q5RSWLDCEF \
  --distribution-config "$(jq '.DistributionConfig' /tmp/prod-dist-config.edited.json)" \
  --if-match "$ETAG" \
  --profile kcmps-claude-priv
```

Do not run this against production without the owner's explicit go-ahead per the root
`CLAUDE.md`'s "Standard deploy workflow" — this is documentation of the exact steps, not an
instruction to execute them.

## Companion change — `Cache-Control` on the sync (Fix 4)

Stacks with the above; independently useful even before the CloudFront behavior is applied,
since it lets a shopper's own browser cache assets between visits in the same session. Add
`--cache-control` scoped to the `assets/` prefix only on future syncs, e.g.:

```bash
aws s3 sync website/assets/ s3://kcmps-online-bucket-est-2026/assets/ \
  --cache-control "public,max-age=31536000,immutable" \
  --profile kcmps-claude-priv
aws s3 sync website/ s3://kcmps-online-bucket-est-2026/ \
  --exclude "assets/*" \
  --profile kcmps-claude-priv
```

(split into two syncs so only `assets/*` gets the long-lived header; everything else keeps
the current no-cache-metadata behavior matching `CachingDisabled`'s "instant visibility"
intent). Not run here — this is the prepared command, to be added to the root `CLAUDE.md`'s
deploy section once the CloudFront side is also ready to go live.

## Verify after applying (either distribution)

1. `curl -I https://<domain>/assets/leaves/subli.jpg` twice in a row — second response should
   show `X-Cache: Hit from cloudfront` (first may be `Miss`).
2. Confirm `index.html`/`store.js`/`products.js` requests still show `CachingDisabled`
   behavior (`Cache-Control: no-cache` treatment) — a sync should still be visible
   on refresh with no invalidation.
3. Dev only: do a trivial `assets/` change (e.g. touch a test image), sync, and confirm how
   long it takes to show up — if this now lags, that's the expected tradeoff described above,
   not a bug.
