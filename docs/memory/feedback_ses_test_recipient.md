---
name: ses-test-recipient
description: All KCMPS email testing must send only to admin+admin.kcmps.uat@kcmps.com — bogus test recipients bounce and threaten the live SES sender reputation.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 94c781a7-7ef4-42b3-90a7-23a43f5a5855
  modified: 2026-08-07T09:14:00.355Z
---

When testing anything that sends email in KCMPS, send **only** to these four addresses
(owner-owned and confirmed 2026-08-07 — the tag is literally `+test`, not a freeform label):

- `kenneth.dungca+test@kcmps.com`
- `ken.rodulfo.dungca+test@gmail.com`
- `admin+admin.kcmps.uat@kcmps.com`
- `kenneth.dungca@krdsystems.com`

`kenneth.dungca@kcmps.com` is a genuine owner-controlled mailbox (worth noting because the shop
otherwise has only one Spacemail mailbox, `admin@kcmps.com` with `order@`/`info@` as aliases, so
it is reasonable to wonder).

Enforced, not just documented: `MAIL_ALLOWED_RECIPIENTS` on `kcmps-staging-send-mail-reply` holds
exactly this list. The check is an **exact lowercased string match**, which is why the tag is
fixed at `+test` — a freeform tag like `+threading` would be rejected. Widening it to arbitrary
tags needs a code change (plus-address normalisation), not just an env-var edit.

**The four-address rule applies in production too, with no safety net.** Production changes
inevitably need testing against production, so test sends from production are expected — the
recipient must still be one of the four.

**Production leaves `MAIL_ALLOWED_RECIPIENTS` UNSET on purpose and it must stay unset** — unset
means unrestricted, which is required because `send-mail-reply` is how staff reply to real
customers. Setting it in production would reject every genuine customer reply and silently break
a live feature.

Understand the asymmetry: **on staging the runtime enforces the list; in production only the
person typing does.** The missing env var is a technical necessity, not permission to widen the
list. A mistake in production is unprotected — a real send from the live `kcmps.com` identity,
charged against the reputation carrying every customer order notification. Be more careful there,
not less.

**Never invent an address outside this list** — no `example.com`, no `test@test.com`, no
placeholder or made-up local part, and never a real customer address. A made-up address is not
"harmlessly fake": it is *guaranteed to bounce*, which is exactly the damage this rule exists to
prevent.

**Why:** SES production access is live for `kcmps.com` (granted 2026-08-03/04), and the 5
production notification Lambdas send real customer email. A test order placed against a
*production* Lambda therefore sends a real message, and a bogus recipient bounces. On
2026-08-05 the trailing-24h numbers hit **38 sends / 5 bounces (~13%)** — above AWS's ~5%
warning and ~10% suspension thresholds. Account enforcement was still `HEALTHY` and the
official `Reputation.BounceRate` metric still read 0.0 (it lags ~a day and AWS is lenient at
low volume), but a sustained rate like that risks throttling or suspension of the whole
sending identity, which would silently kill every customer notification.

**NEVER design a test whose success condition is a bounce or a rejected send.** This rule was
violated on 2026-08-06: a task brief told a subagent to "send to a non-permitted address and
confirm SES rejects it" as proof a catchall had been removed — in the same brief that forbade
non-approved recipients. The contradictory instruction won, produced a real bounce, and the
owner found out via the SNS bounce alert. The verification was also **completely unnecessary**:
`aws ses describe-active-receipt-rule-set` shows the accepted-recipient list directly, which is
faster, free, and stronger evidence than inferring config from a failed delivery.

Prove negative/rejection cases by **inspecting configuration**, never by sending mail:
- Receipt rules / accepted recipients → `describe-active-receipt-rule-set`
- Suppression, verification, identity state → `sesv2 get-email-identity` / `get-account`
- Routing and parsing logic → invoke the Lambda directly with a synthetic event, or unit-test it
If a check genuinely cannot be made without a bad send, it does not get made — say so in the
report and let the owner decide.

**How to apply:**
- Any test that can trigger a send uses `admin+admin.kcmps.uat@kcmps.com` as the recipient.
- Prefer staging (`kcmps-staging-*` Lambdas): SES env vars are deliberately unset there, so
  staging can never email a real address by construction. Double-check you are invoking
  `kcmps-staging-<name>`, not the bare `kcmps-<name>` production function — that exact
  mix-up happened on 2026-08-05 (see [[lambda-migration-open-bugs]]).
- Bounces are currently **unmonitored** — the SES bounce/complaint SNS topic is planned in
  the Track C SES-relay work but not built yet, so nothing alerts on a rising rate.
