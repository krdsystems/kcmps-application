/* ============================================================
   KCMPS backend — order tags (AWS-style key/value)
   ============================================================
   Pure validation + diff for the order-tagging feature
   (backend/staff-api/set-order-tags.js), mirroring how AWS resource tags
   work: a small set of freeform key/value pairs staff attach to an order
   for filtering/reporting (e.g. Type=Reprint, Priority=Rush) rather than
   a status the order-status state machine cares about.

   The write path is a full-set PUT (`setOrderTags` sends the desired
   complete tag list, not one add/remove call per tag) — an order's tag
   editor is a single small form a staff member fills out and saves, so
   there is no meaningful concurrent-edit case worth an incremental
   add/remove API surface, and a full-set PUT means the client never has
   to reconcile a partial failure mid-batch.

   Every tag value reaches the DOM on job-detail.html — staff-authored,
   but still untrusted input, same stance as correspondenceLog notes.
   escapeHtml() at render time is the real XSS defense; the character
   allowlist here is defense in depth (also rules out ASCII the AWS
   tagging console itself rejects, so this reads as "normal" to anyone
   who has used AWS tags before).
   ============================================================ */

const MAX_TAGS_PER_ORDER = 20;
const MAX_KEY_LENGTH = 40;
const MAX_VALUE_LENGTH = 120;

// Letters/digits/spaces plus the punctuation AWS's own tag-key/value
// charset allows (minus "@", not needed here). Blocks HTML-special
// characters (< > " ' & ;) and anything else outside this set.
const ALLOWED_CHARS_RE = /^[A-Za-z0-9 _.:/=+-]+$/;

class TagValidationError extends Error {}

// Throws TagValidationError with a human-readable message on the first
// problem found; returns a normalized (trimmed, deduped-by-key) array of
// {key, value} on success. Input `tags` is whatever the client sent —
// treated as fully untrusted shape, not just untrusted content.
function validateTags(tags) {
  if (!Array.isArray(tags)) throw new TagValidationError("tags must be an array");
  if (tags.length > MAX_TAGS_PER_ORDER) {
    throw new TagValidationError(`At most ${MAX_TAGS_PER_ORDER} tags per order`);
  }

  const seenKeys = new Set();
  const normalized = [];
  for (const raw of tags) {
    if (!raw || typeof raw !== "object") throw new TagValidationError("Each tag must be a {key, value} object");
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    const value = typeof raw.value === "string" ? raw.value.trim() : "";

    if (!key) throw new TagValidationError("Every tag needs a non-empty key");
    if (key.length > MAX_KEY_LENGTH) throw new TagValidationError(`Tag key "${key}" exceeds ${MAX_KEY_LENGTH} characters`);
    if (value.length > MAX_VALUE_LENGTH) throw new TagValidationError(`Tag value for "${key}" exceeds ${MAX_VALUE_LENGTH} characters`);
    if (!ALLOWED_CHARS_RE.test(key)) {
      throw new TagValidationError(`Tag key "${key}" has a character outside letters, numbers, spaces, and . _ : / = + -`);
    }
    // Empty value is allowed (a boolean-style flag tag, e.g. "test" with
    // no value) — AWS tags permit this too. Only validate charset when
    // there IS a value.
    if (value && !ALLOWED_CHARS_RE.test(value)) {
      throw new TagValidationError(`Tag value "${value}" has a character outside letters, numbers, spaces, and . _ : / = + -`);
    }

    // Case-insensitive dedupe — "Type" and "type" reads as the same tag
    // to a shopper-facing filter, and AWS itself rejects a case-only
    // duplicate key on a single resource.
    const dedupeKey = key.toLowerCase();
    if (seenKeys.has(dedupeKey)) throw new TagValidationError(`Duplicate tag key: "${key}"`);
    seenKeys.add(dedupeKey);

    normalized.push({ key, value });
  }
  return normalized;
}

// Pure diff between the order's previous tag list and the new (already-
// validated) one, keyed case-insensitively same as validateTags' dedupe —
// used to build the EVENT# audit entry's meta so "what changed" survives
// independent of the full before/after arrays.
function diffTags(oldTags, newTags) {
  const oldMap = new Map((oldTags || []).map((t) => [t.key.toLowerCase(), t]));
  const newMap = new Map((newTags || []).map((t) => [t.key.toLowerCase(), t]));

  const added = [];
  const removed = [];
  const changed = [];

  for (const [dedupeKey, tag] of newMap) {
    const prev = oldMap.get(dedupeKey);
    if (!prev) added.push(tag);
    else if (prev.value !== tag.value) changed.push({ key: tag.key, from: prev.value, to: tag.value });
  }
  for (const [dedupeKey, tag] of oldMap) {
    if (!newMap.has(dedupeKey)) removed.push(tag);
  }
  return { added, removed, changed };
}

module.exports = {
  MAX_TAGS_PER_ORDER,
  MAX_KEY_LENGTH,
  MAX_VALUE_LENGTH,
  TagValidationError,
  validateTags,
  diffTags,
};
