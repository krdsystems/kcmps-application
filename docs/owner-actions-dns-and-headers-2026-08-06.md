# Owner actions — DNS/DMARC and production security headers (2026-08-06)

Everything in this file is **prepared, not applied**. Two reasons: the DNS records live in a
different AWS account (`260866268499`, the `default` profile) which is off-limits to automated
changes by standing rule, and the CloudFront change targets the **production** distribution,
which is gated on your explicit go-ahead.

All findings below were verified live against AWS, not inferred.

---

## 1. The SES warning you pasted — `mirror.kcmps.com` MAIL FROM not aligned

**What's actually true.** `aws sesv2 get-email-identity --email-identity mirror.kcmps.com`
returns a `MailFromAttributes` block containing only `BehaviorOnMxFailure` — there is **no
`MailFromDomain` set at all**. Compare `kcmps.com`, which correctly has
`MailFromDomain: mail.kcmps.com` at `Status: SUCCESS`. That absence is what SES is flagging.

**Why the impact is lower than "High" suggests, in this specific case.** `mirror.kcmps.com` is a
**receive-only** identity — it exists solely so Spacemail can forward inbound mail into SES
(`MX 10 inbound-smtp.ap-southeast-1.amazonaws.com`, consumed by `backend/mail/ingest-inbound.js`).
Nothing in this codebase ever *sends* from it; all customer mail sends from the `kcmps.com`
identity. MAIL FROM alignment is a property of *sending*, so a misaligned MAIL FROM on a domain
that never sends has no deliverability impact today. SES flags it generically because the
identity is technically verified-for-sending.

**Two ways to resolve it. I recommend B.**

**Option A — satisfy the dashboard literally.** Configure a custom MAIL FROM subdomain
(e.g. `mail.mirror.kcmps.com`) and add its MX + SPF records. This clears the warning, but adds
two more records to maintain for a domain that will never send mail. Busywork.

**Option B (recommended) — declare it a non-sending domain and harden it.** Since nothing should
ever send as `mirror.kcmps.com`, say so explicitly. This is better security posture than A: it
makes the subdomain unspoofable rather than merely aligned.

Add these two records in the `kcmps.com` hosted zone (`Z06397161LBTJCRTPLL62`, account
`260866268499`):

| Name | Type | TTL | Value |
|---|---|---|---|
| `mirror.kcmps.com` | TXT | 300 | `v=spf1 -all` |
| `_dmarc.mirror.kcmps.com` | TXT | 300 | `v=DMARC1; p=reject; rua=mailto:admin@kcmps.com` |

**Honest caveat**: Option B may *not* clear the specific SES dashboard warning, because that
check is looking for a configured custom MAIL FROM, not for good anti-spoofing hygiene. If a
clean dashboard matters more to you than avoiding two junk records, take Option A instead. If
you want both, do B now and A whenever it bothers you.

⚠️ Do **not** add an SPF record for `mirror.kcmps.com` that includes `amazonses.com` — that
would authorize sending from a domain that has no reason to send.

---

## 2. The bigger DMARC finding you didn't ask about — `kcmps.com` itself

While verifying the above I checked the main domain, and there are two real gaps:

```
_dmarc.kcmps.com  TXT  "v=DMARC1; p=none;"
```

**Gap 1 — no `rua=` reporting address.** You currently receive *zero* aggregate reports. That
means you have no visibility into who is sending mail as `kcmps.com`, or whether your SPF/DKIM
alignment actually passes at real receivers. This matters directly to a problem already recorded
in `backend/infra/README.md`: Gmail was filtering/discarding KCMPS mail, and the working
assumption was "new domain, no reputation yet." **Aggregate reports are how you'd confirm that
rather than assume it.**

**Gap 2 — `p=none` is monitoring-only.** No receiver will reject or quarantine mail that fails
DMARC while claiming to be from `kcmps.com`. Anyone can spoof your domain today and it will land.
For a business sending order confirmations and payment-related email, that's worth closing.

**Do these in order — do NOT skip to step 3.**

**Step 1 (do now, zero risk):** add reporting. Change `_dmarc.kcmps.com` to:
```
v=DMARC1; p=none; rua=mailto:admin@kcmps.com; ruf=mailto:admin@kcmps.com; fo=1
```
Still `p=none`, so nothing changes about delivery — you just start receiving daily XML reports.

**Step 2 (after ~2 weeks of reports):** read them. Confirm every legitimate sender
(SES via `mail.kcmps.com`, and Spacemail via `spf.spacemail.com`) is passing aligned. Spacemail
is the one to watch — verify it DKIM-signs as `kcmps.com` (there is a `spacemail._domainkey`
record present, which is a good sign).

**Step 3 (only once step 2 is clean):** tighten to `p=quarantine`, then later `p=reject`.

⚠️ **Do not jump straight to `p=reject`.** If any legitimate sender is currently misaligned, you
would immediately start bouncing your own customer order emails, and you'd have no reports to
diagnose it with. The staged path exists precisely to prevent that.

---

## 3. Production has no security headers at all (new finding, from the UAT console sweep)

The UAT console error — *"The Content Security Policy directive 'frame-ancestors' is ignored when
delivered via a `<meta>` element"* — is **correct browser behavior, not a bug in our markup**.
Per the CSP spec, `frame-ancestors` is only honored as an HTTP response header and is ignored in
a meta tag. The fix is not editable in `index.html`.

Chasing it down surfaced something worse. Verified live:

```
$ curl -sI https://kcmps.com/    →  no CSP, no HSTS, no X-Frame-Options,
                                    no X-Content-Type-Options, no Referrer-Policy
$ aws cloudfront get-distribution-config --id EY6Q5RSWLDCEF
    DefaultCacheBehavior.ResponseHeadersPolicyId: null
```

**The production distribution has no response-headers policy attached whatsoever.** So:

- `frame-ancestors 'none'` is silently doing nothing → **the live site has no clickjacking
  protection**. It can be framed by any origin today.
- No HSTS, so a first visit over `http://` is downgrade-attackable before the redirect.
- No `X-Content-Type-Options: nosniff`, no `Referrer-Policy`.

The `<meta>` CSP still enforces every *other* directive correctly (`script-src`, `connect-src`,
etc.) — those are fine in a meta tag. It is specifically `frame-ancestors` that is inert.

**Recommended fix**: attach a response-headers policy to the production distribution carrying
`Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`), HSTS,
`nosniff`, and a `Referrer-Policy`. The dev distribution already demonstrates the pattern —
`storefront-infra/dev-domain.cfn.yaml` defines `DevResponseHeadersPolicy` (currently only
`X-Robots-Tag`), so there is a working template to copy.

**Why I haven't applied it**: production CloudFront is owner-gated, and this is the kind of change
that can break a site in ways that aren't obvious until a specific page loads (an over-tight CSP
header can conflict with the existing meta CSP). Recommend we build it, apply it to the **dev**
distribution first, exercise the full UAT checklist against `dev.kcmps.com`, and only then
promote to production. Say the word and I'll prepare the CloudFormation.

---

## 4. Root `/favicon.ico` 403 — trivial, and lower severity than it looks

The site's own icon references are all healthy — `assets/favicon.ico`, `assets/favicon.png`, and
`assets/apple-touch-icon.png` each return `200` on production. The 403 is only on the *root*
`/favicon.ico`, which browsers request automatically by convention regardless of what the HTML
declares. It returns 403 rather than 404 because S3 returns `AccessDenied` for a missing key when
`ListBucket` isn't granted — normal for a correctly-locked-down bucket.

Impact: cosmetic console noise only. Fix: place a copy of the icon at the site root so the
conventional path resolves. I've added `website/favicon.ico` for this; it ships with the next
normal sync, no infra change needed.
