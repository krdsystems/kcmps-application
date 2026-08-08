/* Unit tests for backend/mail/mail-parse.js's threading logic — the
   2026-08-07 fix for "threads split after 3 messages". Pure functions only
   (deriveThreadId / normalizeReferences); the mailparser-dependent paths
   are exercised on staging by invoking the ingest Lambda with a synthetic
   S3 event against a real inbound MIME object.

   Run by name, never the bare directory (backend/CLAUDE.md):
     node --test backend/lib/*.test.js backend/mail/mail-parse.test.js
*/

const test = require("node:test");
const assert = require("node:assert");
const { deriveThreadId, normalizeReferences, MAX_REFERENCES, hashMessageId } = require("./mail-parse");

const ROOT_ID = "<root-123@customer.example>";

test("root and its replies share one threadId (the split-after-3 bug)", () => {
  // Inbound root: no References, no In-Reply-To.
  const root = deriveThreadId({ messageId: ROOT_ID, subject: "Order question" });

  // Customer's reply back to OUR reply: References = [root, ourReply],
  // In-Reply-To = ourReply. This is the exact message that used to fork a
  // new thread.
  const ourReplyId = "<reply-abc@kcmps.com>";
  const customerReply = deriveThreadId({
    messageId: "<msg2@customer.example>",
    subject: "Re: Order question",
    references: [ROOT_ID, ourReplyId],
    inReplyTo: ourReplyId,
  });

  assert.strictEqual(root, `THR#ref#${hashMessageId(ROOT_ID)}`);
  assert.strictEqual(customerReply, root);
});

test("reply with only In-Reply-To derives from the parent id", () => {
  const t = deriveThreadId({ messageId: "<m@x.example>", inReplyTo: ROOT_ID });
  assert.strictEqual(t, `THR#ref#${hashMessageId(ROOT_ID)}`);
});

test("references as a bare string (mailparser sometimes) still works", () => {
  const t = deriveThreadId({ messageId: "<m@x.example>", references: ROOT_ID });
  assert.strictEqual(t, `THR#ref#${hashMessageId(ROOT_ID)}`);
});

test("subject-hash fallback only when there is no Message-ID at all", () => {
  const a = deriveThreadId({ subject: "Re: Hello there" });
  const b = deriveThreadId({ subject: "hello there" });
  assert.match(a, /^THR#subj#/);
  assert.strictEqual(a, b); // Re:-stripped, case-folded
});

test("a 100-message back-and-forth stays one thread", () => {
  // Simulate alternating inbound messages, each referencing the whole chain.
  const chain = [ROOT_ID];
  const ids = new Set([deriveThreadId({ messageId: ROOT_ID, subject: "s" })]);
  for (let i = 1; i < 100; i++) {
    const myId = `<m${i}@customer.example>`;
    ids.add(deriveThreadId({
      messageId: myId,
      subject: "Re: s",
      references: [...chain],
      inReplyTo: chain[chain.length - 1],
    }));
    chain.push(myId);
  }
  assert.strictEqual(ids.size, 1);
});

test("normalizeReferences caps the chain keeping root + most recent", () => {
  const refs = [];
  for (let i = 0; i < MAX_REFERENCES + 50; i++) refs.push(`<m${i}@x.example>`);
  const out = normalizeReferences(refs);
  assert.strictEqual(out.length, MAX_REFERENCES);
  assert.strictEqual(out[0], "<m0@x.example>"); // root preserved — refs[0] threading depends on it
  assert.strictEqual(out[out.length - 1], refs[refs.length - 1]); // newest preserved
});

test("normalizeReferences drops empties and tolerates string/undefined", () => {
  assert.deepStrictEqual(normalizeReferences(undefined), []);
  assert.deepStrictEqual(normalizeReferences("<a@x> "), ["<a@x>"]);
  assert.deepStrictEqual(normalizeReferences(["", null, "<a@x>"]), ["<a@x>"]);
});
