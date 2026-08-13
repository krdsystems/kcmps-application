---
name: csp-when-page-goes-live
description: Any KCMPS page that starts making network calls must have connect-src added to its CSP meta tag — a silent CSP block looks exactly like a feature that does nothing.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 94c781a7-7ef4-42b3-90a7-23a43f5a5855
  modified: 2026-08-07T07:57:57.391Z
---

Every page under `website/` carries its own `Content-Security-Policy` `<meta>` tag with
`default-src 'self'`. **The moment a page starts making network requests — directly or through
a seam function it calls — its CSP needs `connect-src` listing both API hosts:**

```
connect-src 'self' https://6msg2uho6c.execute-api.ap-southeast-1.amazonaws.com https://162ufc121j.execute-api.ap-southeast-1.amazonaws.com
```

(first is production, second is staging; `dashboard-data.js`/`store.js`/`orders-data.js` switch
between them by hostname). The same applies to `img-src`, `font-src`, and `script-src` for any
new origin, including S3 buckets used for presigned PUT/GET.

**Why:** on 2026-08-06 `email.html` shipped broken. Task C4 swapped its seam from localStorage
to `fetch()` but left the CSP with no `connect-src`, so the browser blocked every `/mail/*`
request before it left the page. The mailbox list rendered **empty, with no error** — identical
to "no mail has arrived." The backend was healthy the whole time (invoking the Lambda directly
returned all six mailboxes). Root cause in the process, not just the code: C4's brief demanded
"zero changes to `email.html`" as the acceptance test of the seam design, which actively
forbade the one edit that would have prevented it. Seam purity does not exempt a page from CSP.

**It recurred twice more on 2026-08-07, same shape, different origin each time.** When the
Asset Library was promoted to production, `asset-library.html`'s CSP still listed only the
**staging** originals bucket (`kcmps-design-originals-staging`) in both `connect-src` and
`img-src` — so every direct-to-S3 upload PUT was blocked by the browser before it left the page.
It surfaced as `xhr.onerror`, which that page's UI reports as *"upload failed — check your
connection"* — a message that actively misdirects toward the network. Nothing was wrong with the
network, the presigned URL, the CORS config, or the Lambda. **A per-environment bucket/API host
is a new origin: promoting a feature to production means auditing its CSP for every
`*-staging` origin that needs a production counterpart, not just whether `connect-src` exists
at all.** The same promotion also needed a CORS policy on the new bucket (S3 buckets don't
inherit one) — CORS and CSP are two independent gates and both must be right; fixing only one
leaves the identical symptom.

**How to apply:**
- Wiring a page to a live API? Add `connect-src` in the same change. Copy the exact string from
  `jobs.html`, which is the reference.
- **Promoting a feature to production? Grep its page for `-staging` inside the CSP** and add the
  production counterpart for every hit, in `img-src` as well as `connect-src`. A one-line sweep
  catches it: for each page, does its CSP mention a staging origin without an `est-2026` one?
- A new S3 bucket needs **both** a bucket CORS policy (`put-bucket-cors`, copy the staging
  bucket's) and a CSP entry. Neither implies the other.
- Auditing: build a matrix of every page — does it make network calls at runtime, and does its
  CSP permit them? Any yes/no pair is broken. Pages that are still mock/localStorage-only
  correctly have no `connect-src`; note their status rather than silently passing them.
- **Never conclude a page works from an absence of console errors** — confirm a request actually
  reached the network. A silent CSP block produces an empty, healthy-looking page.
- Empty states must distinguish "no data" from "no permission." A `Staff`-only account gets an
  empty mailbox list *by design* (see [[open-owner-actions]] and `backend/lib/mail.js`), which
  is another way a working page can look broken.
