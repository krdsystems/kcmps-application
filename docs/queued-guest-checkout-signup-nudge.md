# Queued: guest-checkout signup nudge + guest order-detail handoff

**Status: QUEUED, not started.** Specified by the owner 2026-08-07 while paused on credits.
Nothing here is built. Read this whole file before starting — the ordering constraints matter
more than the UI.

## The problem this solves

Today a guest clicking "Place order" goes straight to order creation. Guests get no prompt to
sign up, and afterwards they hold an order they can't track, message about, or find again if
they lose the confirmation. Signed-up customers get order tracking, the message thread, and
order history; guests get none of it and aren't told so at the one moment they'd care.

## Flow A — interstitial before the order is created

**The key sequencing change: do NOT create the order when checkout is clicked.** Show the
interstitial first; the order is only created after the customer chooses a path. This is the
part most likely to be got wrong — `store.js`'s `submitOrder()` currently POSTs immediately.

On "Place order" as a guest, show a panel that:
- States plainly they're checking out as a guest.
- Names what signing up adds: order tracking, messaging with staff about the order, order
  history. Keep it factual, not a hard sell.
- Offers a **sign-up button in the same area** — not a link away to somewhere else.
- Offers a clear way to continue as a guest (Flow B).

### If they sign up

1. **The cart must survive sign-up.** Sign-up routes through Cognito (`index.html`'s
   `openAuthModal()` — custom form, plus Hosted UI for login), which involves navigation.
   Cart lives in `localStorage` via `store.js` so it should persist, but this must be verified
   end-to-end, including the Hosted-UI round trip and the confirmation-code step.
2. **After sign-up completes, return them to the exact "clicked checkout" state** — not the
   homepage, not an empty cart. Then create the order, so they land on the GCash QR + order ID
   payment step ready to pay, upload proof, and submit.
3. **The order must be linked to the new account.** `create-order.js` reads the verified JWT
   `sub` into `customerSub`; the order is created *after* sign-up specifically so this is
   populated and the order appears in their history and is reachable by the messaging thread.
   An order created before sign-up would be orphaned as a guest order — that's the whole reason
   for the sequencing above.
4. Needs a resume mechanism to survive the navigation: persist "was mid-checkout, resume at
   payment step" and re-enter that state on return. Consider the case where the customer
   abandons sign-up halfway — they must not end up stuck or with a silently lost cart.

## Flow B — guest opts out

Show a final guest-mode notice that:
- Confirms they're proceeding as a guest.
- Tells them to **save the order ID**, and notes that the email / contact details they entered
  at checkout are what the order is reachable by.
- Explains they can track it via their email, or via the **Track** feature on `index.html`
  (`track-order.html`, which already exists and takes order ID + contact).
- Shows a **small order-details text block with a copy button**. On click, copy to clipboard and
  show a brief confirmation: *"data copied to clipboard"*.
- Has a confirm button: **"I have saved the important details"**.

The copied block should contain what `track-order.html` actually needs to find the order — at
minimum the order ID and the contact it's keyed to — so pasting it back is sufficient.

## Constraints and gotchas

- `store.js` is the cart/checkout seam (`window.KCMPS_STORE`); everything goes through it, no
  page-level `fetch`/`localStorage`. Read the `store.js` gotchas in the root `CLAUDE.md` first.
- Guest checkout must keep working. `create-order.js` verifies a Bearer token if present but
  never requires one — don't accidentally make auth mandatory.
- `track-order.html` and `POST /orders/lookup` already exist; the guest path should point at
  them rather than inventing a second lookup.
- Clipboard API needs a secure context and can fail — handle rejection with a visible fallback
  (e.g. select-the-text) rather than a silent no-op.
- Mobile-first: this is a checkout interstitial on the critical conversion path. Verify at 375px.
  Adding friction before payment is a real conversion risk — the guest path must stay obviously
  available, never dark-patterned into signing up.
- Any new network origin means updating that page's CSP (`connect-src`). This class of bug has
  shipped repeatedly in this repo and looks exactly like a dead feature.

## Open questions for the owner

- Should an existing customer who is **logged out** get a "log in" option here too, or only
  "sign up"? Logging in mid-checkout has the same cart-survival and resume requirements.
- Should the guest confirmation email (already sent by `create-order.js` when `FROM_EMAIL` is
  set) be reworded to carry the same "save your order ID / track it here" guidance?
