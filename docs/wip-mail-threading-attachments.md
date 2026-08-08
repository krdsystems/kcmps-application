# WIP handoff — mail threading + attachment viewing (2026-08-07)

Branch: `claude/mail-threading-attachments` (worktree `.claude/worktrees/wt-mail-fixes`).
Session was paused before any deploy. **Read this whole note before touching anything —
mail is LIVE in production and carries real customer correspondence.**

## Environment state RIGHT NOW

**Nothing is deployed anywhere. Staging and production are byte-for-byte as they were
before this session.** All work below is code-complete on this branch, unit-tested
(125/125 green via `node --test backend/lib/*.test.js backend/asset-library/*.test.js
backend/mail/mail-parse.test.js`), but **never invoked against staging**. No S3 sync ran,
no Lambda was updated, no IAM/GuardDuty change was applied, no backfill ran. There is no
half-applied slice to roll back.

Pre-built deployment zips (require-rewrite applied and asserted clean) exist in the
session scratchpad at `.../scratchpad/mail-build/*.zip` but scratchpads are
session-specific — **rebuild them; do not hunt for these.**

## Bug 1 — threading: verified root cause

The parent diagnosis was **correct and verified**, with one refinement:

- `backend/mail/mail-parse.js` `deriveThreadId()`: a root message (no
  References/In-Reply-To) got `THR#subj#<hash(normalized subject)>`, while any reply
  referencing it got `THR#ref#<hash(root's Message-ID)>`. Different namespaces, different
  inputs — they can never match. Sequence producing "splits after 3": inbound root →
  `THR#subj#X`; our reply (send-reply.js inherits `original.threadId`) → `THR#subj#X`;
  customer's reply back (carries References/In-Reply-To) → `THR#ref#Y` → new thread.
- Refinement: the second defect (send-reply.js's `buildReferences()` producing a
  one-element chain) is real, and its cause is that `ingest-inbound.js` persisted neither
  `references` nor `inReplyTo` on the message item. Also, a client that truncates
  References and sets In-Reply-To to OUR reply (not the root) would still fork under a
  pure refs[0] derivation — fixed with DB-backed parent inheritance (below), which as a
  bonus lets new replies join OLD (pre-fix, subject-hash) threads without any backfill.

### The fix (all on this branch, none deployed)

- `backend/mail/mail-parse.js`:
  - `deriveThreadId()` — root now derives `THR#ref#<hash(own Message-ID)>`; replies still
    derive from refs[0]/In-Reply-To in the same namespace, so they collide correctly.
    `THR#subj#` survives only for messages with no Message-ID at all.
  - New `normalizeReferences()` + `MAX_REFERENCES = 200` (keeps root + most recent when
    trimming — refs[0] threading depends on the root staying first). Exported.
  - `toMailFields()` now persists `inReplyTo` and `references` on every message item.
- `backend/mail/ingest-inbound.js`: new `resolveThreadId(mailboxId, fields)` — before
  writing each mailbox copy, looks up the parent (In-Reply-To first, then References
  newest→oldest, max 5 GetItems) and inherits the parent's STORED threadId when found;
  falls back to the derived id. Never fails ingest. This is what heals old threads
  forward and covers truncated-References clients.
- `backend/mail/send-reply.js`: `buildReferences()` now caps via `normalizeReferences`;
  the SENT item persists `references` (chain deepens through long back-and-forths).
- `backend/mail/mail-parse.test.js` (new): 7 tests incl. the exact split-after-3
  reproduction and a 100-message single-thread invariant.

## Bug 2 — attachments/images: key discovery + design

**The task brief's premise "attachments are stored in S3 and already GuardDuty-scanned"
is FALSE.** Attachment bytes live only inside the raw MIME in
`kcmps-inbound-mail-est-2026`, and that bucket has **no GuardDuty Malware Protection
plan** (verified: the 4 plans cover `kcmps-payment-uploads-est-2026`,
`kcmps-payment-uploads-staging`, `kcmps-design-originals-est-2026`,
`kcmps-design-originals-staging`). Serving bytes from the inbound bucket would bypass the
repo's fail-closed scan gate entirely.

Design chosen (reuses the established pattern, no new mechanism): **extract each MIME
attachment part at ingest to its own object** under a new `mail-attachments/` prefix on
the payment-uploads bucket (already GuardDuty-covered, already wired to
`handle-scan-result.js`, which already writes the standalone `SCAN#<ref>` verdict item
unconditionally). Read path presigns only on `NO_THREATS_FOUND` via the existing
`contentDispositionFor()` closed inline allowlist (SVG can never render inline).

### Code (all on this branch, none deployed)

- `backend/mail/ingest-inbound.js`: `extractAttachments()` — deterministic keys
  `mail-attachments/<hash(Message-ID)>/<index>.<ext>` (idempotent on S3-event retry),
  caps 10 attachments / 25MB each, server-chosen extension, sanitized ContentType,
  best-effort per part (failure ⇒ metadata-only, never fails ingest). Gated on new env
  var `UPLOADS_BUCKET_NAME` (unset = extraction off = today's behavior). Quarantined
  mail never reaches extraction (attachments already dropped).
- `backend/mail/get-mail-message.js` (rewritten): per attachment with a `ref`, reads the
  standalone `SCAN#<ref>` item (same fail-closed semantics as
  `asset-library/scan-verdict.js`: no item = PENDING = no URL), presigns a 15-min GET
  with `contentDispositionFor()` overrides, returns `url` + `inline` + `scanStatus` (+
  `threatInfo` for blocked). Refuses to presign any ref not under `mail-attachments/` on
  its own `UPLOADS_BUCKET_NAME`. Needs env var `UPLOADS_BUCKET_NAME`.
- `backend/jobs/handle-scan-result.js`: log-only `mail-attachments/` branch in
  `recordVerdict()` (no record annotation on purpose — the message lives in 1–3 MAILBOX#
  partitions unrecoverable from the key; the read path consults `SCAN#` live, so nothing
  is lost). Purge-on-THREATS_FOUND already works bucket/prefix-agnostically.
- `backend/mail/package.json`/`package-lock.json`: added `@aws-sdk/s3-request-presigner`.
- `backend/infra/backend-lambdas.cfn.yaml` (staging): `MailLambdaRole` gains policy
  `mail-attachments-bucket` (`s3:PutObject`+`GetObject` on
  `${UploadsBucket}/mail-attachments/*`); `UPLOADS_BUCKET_NAME` env added to
  `IngestInboundFunction` and `GetMailMessageFunction`.
- `website/dashboard/email.html`: `renderAttachment()` — scan-clean images render as
  inline thumbnails (presigned S3 URL) linking to full-size in a new tab; inline-viewable
  non-images get "Open", others "Download"; `PENDING` renders "Scanning for malware…";
  blocked renders the `threatInfo.label` + "(file destroyed)", no link; legacy
  refless attachments keep the old metadata-only chip + note. Also fixed a latent bug:
  it read `a.sizeBytes` but the backend stores `size` (was rendering "NaN MB").
  **CSP `img-src` extended** with exactly two hosts:
  `https://kcmps-payment-uploads-est-2026.s3.ap-southeast-1.amazonaws.com` and
  `https://kcmps-payment-uploads-staging.s3.ap-southeast-1.amazonaws.com`. connect-src
  untouched (nothing fetch()es the attachment; `<img>`/anchor only).
- `website/dashboard/dashboard.css`: `.mail-att-img`/`.mail-att-imglink`/
  `.mail-att-link`/`.mail-att-blocked` styles.

### Deliberately NOT done

- **Body-HTML / remote images in message bodies: NOT enabled, on purpose.** The body
  remains plain-text-only per the root CLAUDE.md gotcha. Remote `<img>` in bodies are
  tracking pixels / phishing vectors — a different thing from scanned attachments. If the
  owner wants inline body images, that is a separate decision to put to them; do not
  slip it in via this branch.
- **No second GuardDuty plan for the inbound-mail bucket** — extraction into the
  already-covered bucket is the whole design.
- `get-mail-messages.js` (envelope list) untouched — envelopes still strip attachments.

## Backfill decision

**Decision: backfill, staging first, then production — script written but NEVER RUN.**
`backend/mail/backfill-threading-2026-08-07.js` (ops script, not deployed): recomputes
threadId/references/inReplyTo from each item's immutable raw MIME (`s3Ref`), extracts
attachments identically to the new ingest, then re-parents SENT items (no s3Ref) onto
their original's new threadId via In-Reply-To to a fixpoint. Safe/idempotent: pure
function of the raw MIME, deterministic S3 keys, only touches those 4 fields, per-item
guard that the parsed Message-ID hashes to the item's SK, **dry-run by default**
(`--apply` to write). Volumes measured 2026-08-07: production 10 items total, staging 42
— small enough that backfill is low-risk, and without it old SENT replies would split
from their (re-derived) inbound thread the other way. Note: even without backfill, the
`resolveThreadId()` inheritance keeps *future* replies attached to old threads — so if a
future session judges the backfill unnecessary, fix-forward alone is coherent; just run
the dry-run first and look.

## Exact remaining steps, in order (nothing below has been started)

1. **Staging deploy** (all CFN — see `backend/infra/README.md` "Deploy (staging)",
   template >51KB so `--s3-bucket/--s3-prefix` required):
   a. Build zips: per mail function `index.js` (handler renamed) + `mail-parse.js` —
      **BOTH with `require("../lib` → `require("./lib` rewritten** — + flattened
      `backend/lib/` (minus `*.test.js`) + `node_modules` from `backend/mail` (`npm
      install --omit=dev` first; the presigner dep is new, so stale node_modules will
      break `get-mail-message`). Changed functions: `kcmps-ingest-inbound`,
      `kcmps-get-mail-message`, `kcmps-send-mail-reply`; plus
      `kcmps-handle-scan-result` from `backend/jobs` (no mail-parse.js in that zip).
      **Assert `grep -l 'require("\.\./lib' <builddir>/*.js` is empty per zip** — this
      miss shipped broken deploys three times on 2026-08-06.
   b. New artifacts prefix under `kcmps-lambda-artifacts-staging`: `aws s3 sync` the old
      prefix forward first (ArtifactsPrefix is stack-wide), THEN overwrite the 4 changed
      zips (sync will have carried stale copies).
   c. `aws cloudformation deploy --stack-name kcmps-backend-staging ...
      --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ArtifactsPrefix=<new>`
      — the template changes deliver the staging IAM policy + env vars.
   d. **GuardDuty**: `aws guardduty update-malware-protection-plan
      --malware-protection-plan-id b2cfe8b34e713cef6b48` (= plan for
      `kcmps-payment-uploads-staging`) adding `mail-attachments/` to ObjectPrefixes
      (currently 4; the per-plan limit is 5, so this lands exactly at the cap —
      flag that to the owner). Preserve the existing 4 prefixes in the call.
   e. Frontend: `aws s3 sync website/ s3://kcmps-online-bucket-est-2026/dev-site/
      --profile kcmps-claude-priv`.
2. **Staging verification — no email sends needed or permitted**:
   - Threading: `aws lambda invoke` `kcmps-staging-ingest-inbound` with a synthetic S3
     event naming an EXISTING `inbound/` object (staging ingest is unwired from the
     bucket trigger since the prod repoint, and writes only to `kcmps-staging` — safe).
     Then `dynamodb query` the mailbox and confirm the item's threadId is
     `THR#ref#<hash(its own Message-ID)>` and `references`/`inReplyTo` persisted.
   - Attachments: after that invoke (pick/craft an inbound object that has an
     attachment), confirm the `mail-attachments/` object exists, wait for the GuardDuty
     verdict (SCAN# item), invoke `kcmps-staging-get-mail-message` with synthetic Admin
     JWT claims (`event.requestContext.authorizer.jwt.claims`, groups string is
     bracket-space format `"[Admin]"`) and confirm `url`/`inline`/`scanStatus`; before
     the verdict lands, confirm `scanStatus: "PENDING"` and **no url** (fail closed).
   - CSP/browser: load `https://dev.kcmps.com/dashboard/email.html` (Basic Auth — creds
     in the owner's password manager, not the repo) and confirm the thumbnail actually
     renders. **A missing CSP origin looks exactly like a dead feature** — verify by
     loading, not by reading the header. Presigned URLs are virtual-hosted style
     (`https://<bucket>.s3.ap-southeast-1.amazonaws.com/...`) which is what the two CSP
     entries assume; if a URL ever comes out path-style or regionless, the CSP will
     silently block it — check the DevTools console for CSP violations specifically.
   - Backfill rehearsal: dry-run `node backend/mail/backfill-threading-2026-08-07.js
     --table kcmps-staging --uploads-bucket kcmps-payment-uploads-staging`, review every
     WOULD line, then `--apply`, then re-verify `getThread` grouping on dev.kcmps.com.
3. **Production** (owner go-ahead per repo rule; the original task brief authorized it
   after staging verification, but this pause resets that — re-confirm):
   - Same 4 zips → `aws lambda update-function-code` on `kcmps-ingest-inbound`,
     `kcmps-get-mail-message`, `kcmps-send-mail-reply`, `kcmps-handle-scan-result`
     (production is CLI-managed, no CFN).
   - `aws lambda update-function-configuration` to add `UPLOADS_BUCKET_NAME=
     kcmps-payment-uploads-est-2026` to `kcmps-ingest-inbound` (KEEP its existing
     `TABLE_NAME=kcmps`; note prod currently has NO `EXPECTED_FORWARDER_HOST`) and
     `kcmps-get-mail-message` (keep `TABLE_NAME=kcmps`) — **the Environment map is
     replaced whole, not merged; pass every existing var or you'll silently drop them.**
   - `aws iam put-role-policy` on `kcmps-mail-lambda-role`: new inline policy
     `mail-attachments-bucket`, s3:PutObject+GetObject on
     `arn:aws:s3:::kcmps-payment-uploads-est-2026/mail-attachments/*` (mirror the CFN
     policy in `backend-lambdas.cfn.yaml`).
   - GuardDuty plan `7acfe6ba55d9edc67956` (= `kcmps-payment-uploads-est-2026`): add
     `mail-attachments/` prefix (again lands at the 5-prefix cap).
   - Frontend: prod S3 sync (no `--delete`, per CLAUDE.md).
   - Invoke `kcmps-get-mail-message` once post-deploy (a deploy status proves nothing).
   - Backfill: dry-run against `--table kcmps --uploads-bucket
     kcmps-payment-uploads-est-2026`, review all ~10 lines, then `--apply`.
4. Update root `CLAUDE.md` (Email page row + plain-text gotcha now say "attachments are
   metadata-only chips" — stale once this ships) and `backend/infra/README.md`.

## Traps already hit / verified this session (don't rediscover)

- `mail-parse.js` requires `../lib` too — the rewrite applies to BOTH files in every
  mail zip, not just `index.js`.
- `email.html` read `a.sizeBytes`; backend writes `size`. Fixed on the branch; don't
  "restore" it.
- `envelopeOf()` in get-mail-messages/send-reply strips `attachments` but NOT
  `references`/`inReplyTo` — envelopes now carry ~200-id arrays in a worst-case long
  thread. Harmless, but if list payloads ever feel heavy, strip them there.
- The mail read Lambdas were historically shipped without node_modules (runtime SDK);
  `get-mail-message` now uses `@aws-sdk/s3-request-presigner` — the built zip vendors
  node_modules to be safe (staff-api precedent). Keep doing that.
- Testing rules remain absolute: only `admin+admin.kcmps.uat@kcmps.com`, never a test
  whose success is a bounce, prove routing/config by `describe-*`/direct invoke.
- 125/125 tests green at pause time: `node --test backend/lib/*.test.js
  backend/asset-library/*.test.js backend/mail/mail-parse.test.js` (name files — the
  bare-directory form is a false green).
