# Analytics options — decision memo

The site has zero analytics today: no way to tell whether a conversion change (bulk-quote
picker, capacity soft-cap, lightbox, etc.) actually helps. This memo lays out options for the
owner to pick from. **Nothing in this file has been applied — no AWS changes, no `website/`
changes.**

Constraints: CSP is `script-src 'self'` (any third-party script requires deliberately loosening
it — a real decision, not a default); cost soft cap is ₱500/mo total AWS spend
(`docs/cost-governance.md`); the storefront collects PII (checkout, accounts) under RA 10173, so
gratuitous trackers are a liability, not a freebie.

## Option A — CloudFront standard access logs → S3 (recommended baseline)

Enable standard logging on the production distribution (`EY6Q5RSWLDCEF`) and optionally the dev
one (`E7PDB5JQRZX0E`), delivering gzipped log files to a new/existing S3 prefix. Query with
Athena.

**Why it's the baseline:** zero frontend change, zero CSP change, no cookies, no consent banner
needed (server logs, not client tracking — nothing to disclose beyond what's already implicit in
serving the site), cost is S3 storage pennies. It answers "are people visiting, and what are
they looking at" without touching the conversion-sensitive frontend at all.

**What it can't do:** no funnels, no client-side events (add-to-cart, checkout start), no
per-session journeys — it's page/asset requests, not user behavior. Good for traffic volume and
top-pages; not for conversion analysis.

**Enable (commands only — do not run):**
```bash
# One-time: create/confirm a logging bucket (can reuse an existing low-traffic bucket with a
# dedicated prefix, e.g. kcmps-online-bucket-est-2026/cf-logs/)
aws s3api put-bucket-acl --bucket <logs-bucket> --grant-write \
  URI=http://acs.amazonaws.com/groups/s3/LogDelivery --grant-read-acp \
  URI=http://acs.amazonaws.com/groups/s3/LogDelivery --profile kcmps-claude-priv

aws cloudfront get-distribution-config --id EY6Q5RSWLDCEF --profile kcmps-claude-priv > /tmp/dist.json
# edit /tmp/dist.json: Logging.Enabled=true, Bucket=<logs-bucket>.s3.amazonaws.com,
# Prefix=prod/, IncludeCookies=false
aws cloudfront update-distribution --id EY6Q5RSWLDCEF --if-match <ETag> \
  --distribution-config file:///tmp/dist-logging.json --profile kcmps-claude-priv

# repeat for E7PDB5JQRZX0E with Prefix=dev/ if desired
```

**Starter Athena setup:**
```sql
CREATE EXTERNAL TABLE cf_logs (
  date STRING, time STRING, x_edge_location STRING, sc_bytes BIGINT,
  c_ip STRING, cs_method STRING, cs_host STRING, cs_uri_stem STRING,
  sc_status STRING, cs_referer STRING, cs_user_agent STRING, cs_uri_query STRING,
  cs_cookie STRING, x_edge_result_type STRING, x_edge_request_id STRING,
  x_host_header STRING, cs_protocol STRING, cs_bytes BIGINT, time_taken FLOAT,
  x_forwarded_for STRING, ssl_protocol STRING, ssl_cipher STRING,
  x_edge_response_result_type STRING, cs_protocol_version STRING,
  fle_status STRING, fle_encrypted_fields STRING, c_port INT, time_to_first_byte FLOAT,
  x_edge_detailed_result_type STRING, sc_content_type STRING, sc_content_len BIGINT,
  sc_range_start BIGINT, sc_range_end BIGINT
)
ROW FORMAT DELIMITED FIELDS TERMINATED BY '\t'
STORED AS TEXTFILE
LOCATION 's3://<logs-bucket>/prod/'
TBLPROPERTIES ('skip.header.line.count'='2');

-- daily visits (unique IPs as a rough proxy — no cookies/sessions in this data)
SELECT date, COUNT(DISTINCT c_ip) AS approx_visitors, COUNT(*) AS requests
FROM cf_logs
WHERE cs_uri_stem = '/' OR cs_uri_stem LIKE '%.html'
GROUP BY date ORDER BY date DESC;

-- top pages
SELECT cs_uri_stem, COUNT(*) AS hits
FROM cf_logs
WHERE sc_status LIKE '2%' AND cs_uri_stem LIKE '%.html'
GROUP BY cs_uri_stem ORDER BY hits DESC LIMIT 20;
```
Athena is pay-per-query-scanned (~$5/TB); at this site's traffic volume, queries run on
kilobytes-to-low-megabytes of logs, effectively free.

## Option B — first-party beacon (`POST /metrics`)

A small same-origin Lambda + API route that counts `page-view` / `add-to-cart` / `checkout`
events into `METRIC#` items in the existing DynamoDB table (or a dedicated table). Frontend adds
a tiny `fetch('/metrics', {...})` call at each event site (`store.js`'s `addToCart`,
`submitOrder`, page load).

**Pros:** answers the question Option A can't — actual funnel/conversion, same-origin (no CSP
change), first-party (no third-party cookie/tracker exposure), cheap at this volume (DynamoDB
on-demand + Lambda free tier, likely $0–1/mo).

**Cons — the real one:** this is new product surface (a route, a Lambda, a data model, a
dashboard view to make the numbers legible) for a question that's currently speculative, not
demonstrated. The repo's standing rule (`docs/roadmap.md` Milestone 2's deferred telemetry, and
the cost-governance principle of "grow only on a measurable trigger, not a hunch") is to not
build ahead of a real trigger. Building this now is scope creep relative to that rule **unless**
the owner explicitly decides "measuring conversion is itself the trigger" — which is a legitimate
call to make, just one that should be made on purpose, not defaulted into. If chosen, scope it to
3 events only (page-view, add-to-cart, checkout-start) and skip the dashboard UI until Option A's
log review shows there's traffic worth funneling.

## Option C — hosted analytics (Plausible / GoatCounter class)

A third-party script (self-hosted or SaaS) reporting pageviews/events to an external service.

- **Cost:** Plausible Cloud starts ~$9–19/mo (~₱500–1,100) depending on plan — at the low end it
  *consumes the entire Stage-0 soft cap* on analytics alone, competing with every other AWS
  service in the budget. Self-hosting Plausible/GoatCounter on a small EC2/Lightsail instance
  avoids the SaaS fee but adds ~$5–10/mo compute plus real operational surface (patching, an
  always-on instance) this repo has deliberately avoided everywhere else (no servers, no
  containers, no build step).
- **CSP:** requires adding the vendor's script origin to `script-src`, and (for cloud-hosted
  options) their collection endpoint to `connect-src`/`img-src`. That is a genuine, visible
  loosening of a policy this repo currently keeps tight — worth a one-line justification in the
  CSP itself, not a silent addition.
- **Privacy:** GoatCounter/Plausible are cookieless and don't need a consent banner under most
  readings of RA 10173/GDPR-alikes (no cross-site tracking, no PII collection beyond IP-derived
  aggregate stats, which they discard/hash) — meaningfully better than GA4. Still worth a line in
  a privacy policy noting an analytics vendor is in the loop, since it's genuinely third-party
  data leaving the S3-only footprint the rest of the site has.
- **When to reach for it:** once Option A/B show there's enough traffic that funnel/segment
  breakdowns (referrer, device, geography) matter — not before.

## Recommendation

Ship **Option A** now — it's free, reversible, requires no code or CSP change, and directly
answers "are people visiting, what are they looking at," which is the actual open question today.
Revisit Option B only if the owner decides conversion-funnel measurement is worth building ahead
of demonstrated need; revisit Option C only if Option A's logs show traffic that justifies
per-session/segment tooling.

### Drafted cost-governance entry (paste into `docs/cost-governance.md` once approved)

> - **CloudFront standard access logs enabled** (`EY6Q5RSWLDCEF` production, optionally
>   `E7PDB5JQRZX0E` dev) — **~₱0–5/mo**: gzipped log delivery to S3, queried ad hoc via Athena
>   (pay-per-TB-scanned, effectively free at this site's request volume). Chosen over a
>   first-party beacon or hosted analytics because it answers today's actual question (is there
>   traffic, what pages get hit) with zero frontend/CSP change and no cookie/consent surface — RA
>   10173 exposure stays at server-log level, not client tracking. Revisit only if log review
>   shows enough traffic to justify funnel-level measurement (Option B) or segment/referrer
>   breakdowns (Option C, hosted analytics) — see `docs/analytics-options.md`.
