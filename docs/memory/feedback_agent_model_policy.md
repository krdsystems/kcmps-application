---
name: agent-model-policy
description: "Default subagents to Opus for hard work and Sonnet for mechanical work — escalate to Fable only when Opus has demonstrably fallen short, never on framing alone."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 94c781a7-7ef4-42b3-90a7-23a43f5a5855
  modified: 2026-08-07T08:38:02.989Z
---

**Model ladder for spawning subagents, in order of preference:**

1. **Sonnet** — mechanical, well-specified work with a clear in-repo reference pattern to copy
   (a new route modeled on an existing one, a CSS layout matching a supplied sketch, doc edits,
   deploy steps that are already written down).
2. **Opus** — the default for anything requiring judgement: production changes, security-relevant
   code, auditing, diagnosing a bug from symptoms, anything where being wrong is expensive.
3. **Fable** — **only** when Opus has actually been tried and demonstrably fallen short on this
   specific problem. Not a starting point.

**Why:** on 2026-08-07 four subagents were dispatched, three of them Fable, and they consumed
roughly 950k tokens between them — enough to burn most of the owner's remaining credits in a
single batch. The owner had to stop mid-work and asked to pause. Reaching for Fable was the
main driver.

**The judgement error to avoid repeating:** Fable was chosen because the tasks *sounded* high
stakes — "production", "payment path", "security feature", "live customer mail". But reviewing
what actually created the value, it was **diligence, not reasoning horsepower**: the email agent
checking and discovering mail attachments were never GuardDuty-scanned (contradicting the brief);
the asset-library agent finding the real product ids differed from what the brief assumed; the
nav agent measuring the DOM rather than trusting a screenshot. Every one of those is careful
verification, which Opus does well. **High stakes justify care and a good brief — they do not by
themselves justify the most expensive model.**

**How to apply:**
- Default to Opus for hard tasks; state the model when dispatching so the choice is visible.
- Put the care into the *brief* — the traps, the verification requirements, "report what you
  verified by running vs. by reading" — rather than buying it with model tier. Those instructions
  are what produced the good catches.
- Before choosing Fable, be able to name the specific reasoning step Opus is expected to fail at.
  If the honest answer is "it just feels important", use Opus.
- Cost is a real constraint for this owner, not an abstraction. Watch total spend across a batch,
  not just per-agent, and warn before dispatching several expensive agents at once.
- See [[wip-2026-08-07]] for what those agents produced and where it was parked.

**The owner asked to be held to this, explicitly (2026-08-07)** — he wants to be warned when he
is about to override it, because in the moment ("use the best model", "escalate to Fable") it is
easy to undo a budget decision he made deliberately when calm. Treat it as a pre-commitment:

1. **Pause before dispatching** — never spawn first and raise cost afterwards.
2. Say plainly that it departs from the policy, with the concrete comparison (the ~950k-token,
   four-agent batch that caused this rule).
3. Offer the Opus alternative and what, if anything, is actually lost.
4. **If he still wants Fable, require a specific reason**: name the reasoning step Opus is
   expected to fail at. "It's important" / "it's production" / "it's security" are **not**
   sufficient — they describe stakes, not reasoning difficulty, and conflating the two is exactly
   what caused the overspend.
5. Given a real reason, **proceed** — it is his call and his budget. Record the reason in the
   dispatch so the decision stays visible.

Warn about **batch size** as well as tier — the overspend was four concurrent agents and would
have hurt on any model. State how many agents and the rough cost before dispatching a batch.
Warn once, clearly, then respect the answer; do not nag.
