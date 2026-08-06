# Email tab redesign — Gmail-like UX within the plain-text constraint

Owner feedback (2026-08-06): the Email tab works (passed UAT) but is hard to use — "hard to see
the conversation/thread." Ask: make it easy for allowed staff to work the shared mailboxes,
"mimic Gmail's setup/layout/function." This is a design plan only — no code changed, nothing
deployed. See the root `CLAUDE.md`'s "Staff Email page (live)" row and `docs/roadmap.md`'s
"Parallel track — Staff email panel" for how the feature got here.

## 0. Recap of what's actually deployed today

`website/dashboard/email.html` is a two-pane view: a toolbar (mailbox picker, search, reload),
a message list (`#mail-list`), and a reading pane (`#mail-read`) that shows on mobile only after
a tap (`.mail-3pane.show-read`). Backed by `website/dashboard/dashboard-data.js`'s
`getMailboxes`/`getMessages`/`getMessage`/`getThread`/`markMessageRead`/`sendReply`, which call
`backend/mail/get-mailboxes.js`, `get-mail-messages.js`, `get-mail-message.js`,
`mark-mail-read.js`, `send-reply.js`. Deployed to `kcmps-backend-staging` only.

---

## 1. What's actually wrong today

Separated into **missing feature** (doesn't exist yet) vs **poor layout** (exists, but the
presentation makes it hard to use) as requested. Evidence is file:line against the current repo.

### Missing feature

1. **No real thread view — `getThread()` is two full-mailbox fetches, filtered client-side.**
   `dashboard-data.js:1048-1057` fetches up to 200 INBOX + 200 SENT envelopes on every message
   open, filters to `threadId`, sorts ascending. This is the single biggest reason "it's hard to
   see the conversation" — it's not a rendering bug, there is no cheap thread primitive to
   render *from*. Every open message pays this cost (`email.html:300`, awaited inline).
2. **No pagination in the UI.** `getMessages()` returns `nextCursor`
   (`backend/mail/get-mail-messages.js:87-89`), and `dashboard-data.js:1026-1035` passes an
   opaque `cursor` through — but `email.html`'s `renderList()` (`email.html:119-147`) never
   reads or uses `res.nextCursor`. A mailbox with more than `DEFAULT_LIMIT` (50) messages simply
   truncates; there's no "load more," no infinite scroll, not even a "50 of 214" indicator.
3. **No attachment download path.** `email.html:330-338` renders attachment chips as inert
   `<span class="tag tag-outline">` with the literal text "open them in your mail client for
   now." `get-mail-message.js` returns metadata only (filename/contentType/size —
   `mail-parse.js:192-196`); there is no presigned-GET Lambda route for mail attachments at all,
   unlike the established pattern in `staff-api/get-orders.js`/`get-messages.js`.
4. **No compose-new.** Only reply exists (`sendReply`, `email.html:375-392`, gated on
   `mb.canSend`). There is no way to start a new outbound thread from the dashboard.
5. **No unread/starred/label affordances beyond a binary `seen` flag.** `flags` is
   `{seen, answered, flagged}` (`mail-parse.js:221`) — `flagged` is parsed and stored but never
   read anywhere in `email.html` or `dashboard-data.js`. No star toggle exists in the UI despite
   the data already carrying the field.
6. **No keyboard shortcuts.** The list rows are keyboard-operable one at a time (Enter/Space to
   open, `email.html:145`), but there's no `j`/`k` list navigation, no `e`/`#` archive-style
   action (moot — see §2), no `r` to reply, no `/` to focus search.
7. **No bulk actions.** Every row is a single click target; there's no multi-select, no "mark N
   as read," nothing beyond the auto mark-read-on-open Only.

### Poor layout (feature exists, presentation hurts it)

8. **Thread context reads as a data dump, not a conversation.** `email.html:340-349` renders
   "Earlier in this thread" as a flat `.timeline` list identical in structure to a job's status
   history (`.timeline-row`, `dashboard.css:310-312`) — three-column grid of time / sender /
   snippet, no visual distinction between "this was sent by staff" vs "this came from the
   customer," no expand-to-read-full-body, and it sits *below* the currently-open message with
   no separation of "which message am I looking at" vs "history." A staff member scanning a
   6-message back-and-forth has to mentally reconstruct order and authorship from a snippet-only
   table.
9. **The open message and the thread history don't share a visual language.** The open message
   gets a full header block (`ticket-meta`, `renderChecks`, full `bodyText` in a `<pre>`) while
   every other message in the same thread is a single truncated `.timeline-row` — so the one
   thing Gmail nails (a vertically stacked, collapsible conversation where every message looks
   like a message) doesn't exist here even though the underlying data (`getThread()`) already
   has everything needed to render each entry as a mini-message.
10. **List rows carry no visual weight signal beyond `sla-warn` (unread).** `renderList()`
    (`email.html:131-140`) shows sender, age, subject+snippet, and a "replied" text mark — no
    avatar/initial, no distinction for "message on an order I'm not part of," nothing that lets
    the eye scan-and-triage the way Gmail's bold-subject + snippet + label chips does.
11. **Search is subject/sender-only with no visible scope indicator.** `mail-search`
    (`email.html:29`, wired to `getMessages(..., {search})`) searches the current mailbox/folder
    only (`get-mail-messages.js:73,77-84` filters after the folder filter) — there's no visible
    "searching order@ · INBOX" affordance, so a staff member who doesn't find a message may not
    realize they were never searching SENT, or `info@`, at all.
12. **No loading/error/empty state polish.** `renderList`/`renderRead` show a generic `q-empty`
    paragraph for "no messages match" but there's no visible spinner/skeleton while `apiFetch`
    is in flight (only the Reload button gets `withBusy`'s disabled+spinner treatment,
    `email.html:457-469) — opening a message or switching mailboxes has a silent gap.

---

## 2. Which Gmail patterns to adopt, which to skip, and why

This is a **4-person shop triaging 3 shared mailboxes for order-related correspondence**, not a
general-purpose personal inbox. Every adoption below is filtered through that lens.

### Adopt

- **Conversation view, collapsed/expanded messages.** This is the actual ask ("hard to see the
  conversation"). Directly addresses gaps #8/#9. High value, and buildable without any backend
  change (client-side rendering of the same `getThread()` data, just presented as stacked
  message cards instead of a timeline table) — see §3.
- **List ↔ reading-pane split with a persistent list.** Already built (`.mail-3pane`) and is the
  right shape for triage — keep it, refine the row density/scan-ability (gap #10).
- **Unread bold + visual weight.** Cheap, high-value, already has the data (`flags.seen`).
- **"Load more" / pagination**, not necessarily infinite scroll. The cursor already exists
  server-side and is unused — wiring it is close to free (gap #2). Recommend a "Load 50 more"
  button over true infinite scroll: infinite scroll needs scroll-position virtualization to stay
  fast, which is real complexity for a no-build-step vanilla-JS page; a button is simpler, just
  as fast to reach for a mailbox that plausibly has hundreds of messages, and avoids gap #2's
  "silent truncation" problem for zero added machinery.
- **Basic keyboard nav (`j`/`k`, Enter, `/` for search).** Cheap, matches muscle memory for
  anyone who's used Gmail, and this repo's dashboard shell already handles Escape-to-close for
  the checks popover, so a keydown listener pattern already exists to extend (`email.html:448-455`).
- **A visible reply-all/CC affordance.** `sendReply` already accepts `cc` in its payload
  (`dashboard-data.js:1072-1078`) but `email.html`'s reply box (`email.html:351-359`) has no CC
  field in the UI at all — wire the field that already exists server-side.
- **Star/flag a message.** The data field (`flags.flagged`) already exists and is unused
  (gap #5) — surfacing it as a lightweight "important" marker for triage is nearly free.

### Adopt in modified form

- **Search scope.** Gmail searches everything by default. This shop's data model is mailbox-
  scoped by access group (`backend/lib/mail.js`'s `MAILBOX_ACCESS`), so a true cross-mailbox
  search either needs N parallel calls (one per mailbox the user can see) or a new backend
  endpoint. Recommend: keep per-mailbox search as the default (matches the backend's actual
  query shape, `get-mail-messages.js:77-84`), but make the scope visible ("Searching order@ ·
  Inbox") and add folder toggle (Inbox/Sent) to the search bar rather than promising
  cross-mailbox search the backend doesn't cheaply support (see §4 for the multi-mailbox search
  cost tradeoff).
- **Compose new.** Owner's ask doesn't mention this, and the brief explicitly scoped "read +
  reply, no compose new — say whether that should change." Recommendation: **not now.**
  Reasoning: (a) it's a new attack surface (arbitrary To: field from staff, no relationship to
  an inbound thread to anchor provenance checks against), (b) it needs its own backend route
  (`send-reply.js` is reply-shaped — it likely threads off an existing `messageId`; a fresh
  compose needs a different envelope-construction path), (c) the actual workflow this panel
  serves is "someone emailed order@/info@/admin@, respond to them" — outbound cold-starts from
  staff are rare enough today that `mailto:` or Spacemail's own webmail (owner already has an
  account there) covers it without adding scope. Revisit only if staff report the gap in
  practice.
- **Labels/folders.** Gmail's labels are arbitrary and user-defined. This shop's "folders" are
  fixed: 3 sendable mailboxes (`order@`/`info@`/`admin@`) + 3 read-only system mailboxes
  (`unrouted@`/`unparseable@`/`quarantine@`), each with INBOX/SENT. Don't build a labels system —
  the mailbox picker + a folder toggle (Inbox/Sent) is the correct, honest mapping of Gmail's
  affordance onto data that doesn't actually support arbitrary labeling. Building fake labels on
  top of `flags.flagged` alone (star only) is enough signal for this scale.

### Skip outright

- **HTML rendering / rich composer.** Explicitly out of scope per the brief and per
  `email.html:162-170`'s documented threat model — no iframe (clickjacking / CSP
  `frame-ancestors` risk, and piping a live session would be a MITM on the mailbox), no
  hand-rolled sanitizer in a no-build-step repo. See §7.
- **Auto-linkified URLs.** Explicitly a phishing amplifier per the existing design note
  (`email.html:169-170`) — do not add, even as a "smart" opt-in toggle. A staff member should
  never one-click a link parsed out of unauthenticated inbound mail.
- **Smart categorization / Priority Inbox / snoozing / undo-send.** These solve personal-inbox
  overload at Gmail's scale. A 4-person shop with 3 shared mailboxes and (per the roadmap) no
  polling/push signal at all doesn't have volume that justifies ML-ish triage machinery — it has
  a "did anyone check the mailbox today" problem, which the existing "Updated HH:MM" manual-
  reload timestamp already solves honestly (`email.html:30-34`'s comment explains why polling
  was deliberately skipped — respect that decision, don't reintroduce polling to fake urgency).
- **Threaded reply-in-place composer that grows inline per message (Gmail's "reply within the
  thread stack" UI).** Nice but not necessary at this volume — a single reply box anchored to
  the currently-open (usually newest) message, as exists today, is sufficient. Building N
  inline composers (one collapsible per thread message) is real added complexity for a workflow
  that is almost always "reply to the latest message in the thread."
- **Drag-and-drop message organization, right-click context menus.** Desktop power-user chrome
  that doesn't map to 3 fixed mailboxes and no user-created structure.
- **Contact/People autocomplete for To:/CC.** No contacts model exists in this system (no
  compose-new either — see above), so this has no backing data to autocomplete from at this
  time.

---

## 3. Proposed layout + interaction design

Keeps the two-pane `.mail-3pane` skeleton (list + reading pane) — it's the correct shape, per
§2 — and focuses changes on (a) how a thread renders inside the reading pane and (b) list
scan-ability, pagination, and states.

### 3.1 Toolbar (desktop) — largely unchanged, one addition

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Mailbox [order@kcmps.com ▾] (3)   [🔍 Search order@ · Inbox        ] [Inbox▾] [↻ Reload]  Updated 14:32 │
└─────────────────────────────────────────────────────────────────────────┘
```

- New: an `[Inbox ▾ / Sent]` folder toggle next to search (today folder is hardcoded to
  `"INBOX"` everywhere — `getMessages()` defaults `o.folder` unset, meaning the backend defaults
  it to `"INBOX"` per `get-mail-messages.js:62`; there's no way to view Sent at all today except
  indirectly via `getThread()`'s internal fetch). This alone is a real missing-feature gap not
  listed in §1 because it's subtle — worth calling out here: **staff currently cannot browse
  their own Sent mail in this UI.**
- Search placeholder text made mailbox/folder-aware to fix gap #11.

### 3.2 Message list — density + scan-ability pass

```
┌ mail-list ──────────────────────────────┐
│ ● Juan Dela Cruz            2h  ⭐      │  <- unread: bold, dot marker
│   Re: Order #KC-2381 — bulk quote…      │
│   "Hi, following up on the quote fo…"   │
├──────────────────────────────────────────┤
│   Maria Santos               1d         │  <- read: normal weight
│   Payment screenshot attached            │
│   "Sent the GCash proof, ref #93…"      │
├──────────────────────────────────────────┤
│   [Load 50 more]                         │
└──────────────────────────────────────────┘
```

Changes from today's `renderList()` (`email.html:119-147`):
- Unread state gets a leading dot/dot-color (reuse `.sla-warn`'s existing color token, don't
  invent a new one — brand rule is one accent color per screen) **and** bold sender/subject text,
  not just a background tint — today `sla-warn` is a class but the CSS for it isn't visible in
  the excerpt reviewed; confirm its render distinguishes unread clearly enough, strengthen if not.
- Star icon (☆/⭐) toggles `flags.flagged` — needs a new small backend-adjacent call: either a
  generic "set flags" endpoint or extending `mark-mail-read.js`'s shape to accept `flagged` too
  (see §5 — this is the one backend change worth making, everything else in this list is
  frontend-only).
- Thread-collapse in the list: if `getMessages()` returns multiple envelopes with the same
  `threadId` (it does today — no change needed, `threadId` is already on every envelope), collapse
  them into one row showing the *latest* message with a "(4)" count, Gmail-style. This requires no
  backend change — pure client-side grouping in `renderList()`, same data already fetched. This is
  the single highest-leverage frontend-only change: it directly reduces list clutter for any
  order with several back-and-forth messages, which today are today N separate rows.
- "Load 50 more" button appended when `res.nextCursor` is present; clicking re-fetches with
  `{cursor: res.nextCursor}` and appends rather than replaces (fixes gap #2).

### 3.3 Reading pane — conversation view (the core fix for the owner's actual complaint)

Replace the flat `.timeline` thread block (`email.html:340-349`) with a stack of collapsible
message cards — the open/target message expanded, everything else in the thread collapsed to a
one-line summary that expands on click. This is the direct fix for "hard to see the
conversation."

```
┌ mail-read ────────────────────────────────────────────────────┐
│ ← Back to list                                                 │
│ Re: Order #KC-2381 — bulk quote for 500 shirts        [Replied]│
│                                                                  │
│ ┌ collapsed ─────────────────────────────────────────────────┐│
│ │ ▸ You (order@)              Aug 5, 09:14   "Thanks, quote…" ││
│ └───────────────────────────────────────────────────────────┘│
│ ┌ collapsed ─────────────────────────────────────────────────┐│
│ │ ▸ Juan Dela Cruz             Aug 5, 08:02   "Following up…" ││
│ └───────────────────────────────────────────────────────────┘│
│ ┌ EXPANDED (the message this pane opened to) ──────────────── │
│ │ Juan Dela Cruz <juan@example.com>          Aug 7, 11:40     │
│ │ ✓✓✓? Checks   [Related order: KC-2381]                      │
│ │                                                               │
│ │ Hi, is the 500-shirt quote still valid? We'd like to move    │
│ │ forward this week if the price holds.                        │
│ │                                                               │
│ │ Attachments: quote-mockup.png (240 KB)  [Scanning…]           │
│ └───────────────────────────────────────────────────────────┘│
│                                                                  │
│ Reply to Juan Dela Cruz          [+ Cc]                         │
│ ┌───────────────────────────────────────────────────────────┐│
│ │ Type your reply…                                             ││
│ └───────────────────────────────────────────────────────────┘│
│                                    [Send reply]  [Discard]      │
└──────────────────────────────────────────────────────────────┘
```

Notes on this design:
- **Only the target message defaults expanded** — mirrors Gmail's "most recent + the one you
  clicked" default. All others collapsed to sender/date/snippet, click to expand in place
  (fetches `getMessage()` lazily per expand, not all up front — thread messages today only carry
  envelope fields via `getThread()`'s internal `getMessages()` calls, so expanding one needs its
  own `getMessage()` round trip for the full body; acceptable, it's a rare click not a hot path).
- **Sender identity gets a visual "You" treatment** when `from.address` matches the mailbox's own
  address (i.e., it's a message this mailbox sent) — currently `senderOf()` (`email.html:80`)
  treats every message identically regardless of direction, so a staff member scanning a
  collapsed thread can't tell replies-from-us apart from messages-from-them without reading the
  address. This is the second-biggest contributor to "hard to see the conversation" after the
  flat-timeline problem itself.
- **Checks/provenance stays exactly as-is** (`renderChecks`/`renderProvenanceAlert`,
  `email.html:220-278`) — this is a correctly-designed, hard-won security affordance (see
  `email.html:171-220`'s extensive comments); the redesign wraps it into the new card layout,
  it does not touch its logic or its "always-visible on non-pass" rule.
- **Attachment chips gain a state machine matching the fail-closed scan pattern** used elsewhere
  in the repo (`root CLAUDE.md`'s malware-scanning row): `Scanning…` (no verdict yet, no link),
  `Download` (verdict `NO_THREATS_FOUND`, presigned GET, forced
  `Content-Disposition: attachment`), or a threat notice + no link (verdict positive) — see §5,
  this needs a new backend route, doesn't exist today at all.
- **CC field added to the reply composer** (`+ Cc` reveals a text input) — wires a payload field
  (`sendReply`'s `cc`) that already exists server-side and is silently unused client-side.

### 3.4 Empty / loading / error / scanning states

| State | Today | Proposed |
|---|---|---|
| No mailboxes assigned | Handled (`noMailboxAccess`, `email.html:121-123,282-286`) — keep as-is, it's well-designed (explains *why*, names the groups). |
| Mailbox empty | `"Inbox is empty."` — keep. |
| Search, no matches | `"No messages match that search."` — keep, but reflect the new mailbox/folder-scoped search text. |
| List loading (mailbox switch / reload) | No visible state — silent gap. | Add a lightweight skeleton (3-4 grey placeholder rows) in `#mail-list` while `getMessages()` is in flight, matching `withBusy`'s existing spinner idiom used elsewhere in the dashboard. |
| Reading pane loading (message open) | No visible state. | Same skeleton idea scoped to `#mail-read` — a couple of grey line-blocks where the header/body will land. |
| Thread message expand (lazy fetch) | N/A (doesn't exist yet) | Inline spinner inside that one collapsed card while its `getMessage()` resolves. |
| Attachment scanning | N/A | "Scanning…" chip, no link (§3.3). |
| Attachment threat found | N/A | Chip shows a plain-English threat description (reuse `backend/lib/threat-descriptions.js`'s pattern — already used for order/design uploads) with no download link. |
| Reply send error | Handled (`showInlineError`, `email.html:381-382`) — keep. |
| Reply sent, local record write failed | Handled (`result.warning`, `email.html:390`) — keep, this is a genuinely good "sent but…" non-error pattern already. |

### 3.5 Mobile

Current mobile behavior (`dashboard.css:418-431`) collapses to single-pane with a "Back to list"
button — this is the right pattern and should not change structurally. Adjustments:
- Collapsed thread cards get larger tap targets (min 44px row height) since mobile has no hover
  affordance for the expand chevron.
- "Load more" button, not infinite scroll, remains the pagination UX on mobile too — consistent
  behavior beats a different mechanism per breakpoint.
- Star/flag icon needs an explicit tap target (not hover-reveal) — mirrors the existing rule
  already applied to the scroll-indicator and design-picker patterns elsewhere in this codebase
  (touch never gets hover-only affordances, per root `CLAUDE.md`'s established gotchas).

---

## 4. Threading strategy: client-side vs. a new server endpoint

**Recommendation: stay client-side for now, but change what "client-side" means — group by
`threadId` from data already being fetched, rather than issuing the current two-full-mailbox-scan
`getThread()`.**

### Current approach and its real cost

`getThread()` (`dashboard-data.js:1048-1057`) issues `getMessages(mailboxId, {folder: "INBOX",
limit: 200})` and `getMessages(mailboxId, {folder: "SENT", limit: 200})` **every time a message
is opened**, then filters/sorts in the browser. Backend-side, `get-mail-messages.js` does a
bounded `Query` (`QUERY_CAP = 1000`) over the whole mailbox and sorts in memory
(`get-mail-messages.js:11-17,67-85`) — so opening one message triggers up to 2×1000-item table
scans server-side, every single time, discarding almost everything it fetches. This is wasteful
but not currently a user-visible latency problem at the shop's current mail volume (a handful of
messages/day). It **will** become one as volume grows — the repo's own comment already flags this
class of Query as an accepted tradeoff pending a GSI (`get-mail-messages.js:11-17`).

### Options

1. **Keep as-is.** Free, ships zero backend risk, works fine at current volume. Downside: gets
   slower and more wasteful (both in Lambda duration cost and staff-perceived latency) as thread
   history grows, and doesn't fix anything about the presentation problem (that's a frontend
   change regardless of where threading logic runs).
2. **Client-side, but cache smarter.** Fetch each mailbox's INBOX+SENT once per mailbox-switch
   (not once per message-open), keep it in module state, and derive every thread's message list
   from that cache with a simple `.filter(threadId)`. Zero backend change. Cuts N-message-opens
   down to 1 full fetch per mailbox switch instead of 1 per open — meaningfully cheaper for the
   *common* triage pattern (open several messages in the same mailbox in a row) without touching
   the API contract at all. This is the right near-term move.
3. **New server-side thread endpoint** (`GET /mail/mailboxes/{id}/threads/{threadId}`), backed by
   a new GSI (`mailboxId` + `threadId` + `date`, as the existing comment in `get-mail-messages.js`
   already anticipates). Real backend work: new index, new Lambda, new IAM, new CFN change,
   redeploy to staging, verification pass. Correctly bounded query cost regardless of mailbox
   size. Owner-gated (infra change).

**Recommendation: do #2 now (frontend-only, ships with the rest of this redesign), defer #3
until either (a) a mailbox's message count makes the `QUERY_CAP=1000` bounded scan a real
correctness risk (silently missing older thread messages beyond the cap) or (b) staff report
actual latency pain.** The presentation fix (§3.3's collapsible thread cards) is independent of
which threading data-fetch strategy backs it — building the good UI first, on the cheap fetch
improvement, de-risks the eventual GSI/endpoint work by proving out the UI against real usage
first.

---

## 5. Backend changes required (owner-gated deployment, staging first)

All of these are **new Lambda routes or field additions** — each needs the standard staging-first
gate per root `CLAUDE.md`'s deploy workflow, and needs the owner's explicit go-ahead before even
staging deployment for anything touching `kcmps-backend-staging`'s CloudFormation stack.

1. **Attachment download route** (`GET /mail/mailboxes/{id}/messages/{messageId}/attachments/{n}`
   or similar) — presigned GET, gated on a persisted GuardDuty verdict, `NO_THREATS_FOUND` only,
   forced `Content-Disposition: attachment`. This is new scope: **mail attachments are currently
   never uploaded anywhere scannable** — `mail-parse.js:28-31` explicitly keeps attachment bytes
   in the original inbound S3 object (`kcmps-inbound-mail-est-2026`) and only extracts metadata.
   Before this can ship, confirm (a) that bucket is already covered by the GuardDuty Malware
   Protection scanning root `CLAUDE.md` describes for the four upload prefixes — inbound mail is
   a fifth, currently-unlisted prefix, so this needs verifying, not assuming — and (b) a scan
   event handler analogous to `backend/jobs/handle-scan-result.js` exists or is added for this
   bucket/prefix. **This is the single largest piece of net-new backend work in this plan** —
   treat it as its own phase (see §6, Phase 3).
2. **Flag/star toggle** — smallest option: extend `mark-mail-read.js`'s request body to accept an
   optional `flagged: boolean` alongside `seen`, or add a twin `PATCH .../flags` route. Small,
   low-risk, mirrors an existing endpoint's shape closely.
3. **Sent-folder browsing in the UI** — no backend change needed; `folder=SENT` already works
   server-side (`get-mail-messages.js:62`), it's purely a frontend gap (§3.1).
4. **(Deferred, see §4) Thread GSI + endpoint** — not recommended for this phase.

Nothing above changes the access model (`MAILBOX_ACCESS`) — every new route re-checks
`canAccessMailbox()` exactly like the existing ones, no new group, no `ROLES.STAFF` addition.

---

## 6. Phased build plan

Each phase independently shippable to staging; production promotion stays gated on the owner's
go-ahead per the standard workflow, same as every other phase in this repo.

**Phase 1 — Conversation view + list scan-ability (frontend only, no backend change)**
Effort: medium (a few days). Risk: low — no API contract change, purely `email.html` +
`dashboard.css` + the `mail-3pane` scoped rules.
- Collapsible thread-message cards replacing `.timeline` (§3.3).
- Thread-collapse grouping in the list (§3.2).
- "You" vs "them" sender distinction.
- Loading skeletons for list/read pane (§3.4).
- Client-side thread cache (§4 option 2) to cut the getThread() cost.

**Phase 2 — Pagination, folder toggle, star, CC (frontend + one small backend route)**
Effort: small-medium. Risk: low.
- "Load 50 more" wired to `nextCursor` (frontend only).
- Inbox/Sent folder toggle (frontend only, backend already supports it).
- CC field on reply composer (frontend only, backend already accepts it).
- Star/flag toggle (needs backend change #2 above — small, additive).

**Phase 3 — Attachment download (backend-heavy)**
Effort: medium-large — the GuardDuty-coverage question must be answered first; this could be
"add one more scanned prefix" or "genuinely new scanning infrastructure" depending on what's
already covering the inbound-mail bucket. Risk: medium (new S3/IAM surface, a new
malware-scan-driven data flow). Owner-gated CFN change to staging before anything.

**Phase 4 (optional, deferred) — Server-side thread endpoint + GSI**
Only if Phase 1's client-cache approach proves insufficient at real volume (§4). Effort:
medium (new GSI, new Lambda, CFN change). Risk: medium — new index changes read patterns
across a shared table.

Keyboard shortcuts (`j`/`k`, `/`, Enter — §2) can ride along with Phase 1 or 2, whichever ships
first; they're a small independent addition with no sequencing dependency on anything else.

---

## 7. Explicitly out of scope

- **HTML mail rendering, in any form** (iframe, sanitizer, "reader mode" reconstruction). The
  existing threat model (`email.html:159-170`, and root `CLAUDE.md`'s mail gotcha) already ruled
  this out for good reasons that this redesign doesn't reopen: an iframe pointed at rendered
  third-party HTML is a clickjacking/tracking-pixel surface, and this repo has no build step to
  vet or maintain a hand-rolled sanitizer library against. If a genuinely safe path exists it
  would need to be a **new, explicit** proposal with its own threat-model writeup — not something
  to slip in as a side effect of a layout redesign. Nothing in this document assumes or requires
  it, and the conversation-view design in §3.3 works entirely on `bodyText`/`escapeHtml` as-is.
- **URL auto-linkification.** Same phishing-amplifier reasoning as HTML rendering — the plan
  keeps `mail-body`'s `escapeHtml`-then-`<pre>` rendering exactly as it is.
- **Compose-new.** Discussed in §2 — recommend not building it now; revisit only on demonstrated
  staff need.
- **Cross-mailbox unified search.** Discussed in §2 — the access model is mailbox-scoped by
  design, and a real unified search needs either N parallel per-mailbox calls or a new indexed
  endpoint; neither is justified by the owner's actual complaint (thread visibility), so it's
  left out of this plan entirely, not just deferred to a phase.
- **Any credential-storage / IMAP / personal-mailbox work.** Completely orthogonal — that's the
  now-superseded original architecture direction in `docs/roadmap.md`'s "Parallel track" section;
  the SES-relay + shared-mailbox model already shipped and replaced it. Not reopened here.
- **Migrating off Spacemail / provider swap.** Out of scope for a UI redesign; noted only because
  `docs/roadmap.md` mentions it as a "where this is going" possibility — this plan does not
  depend on or block that decision either way.
