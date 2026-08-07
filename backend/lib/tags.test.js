const test = require("node:test");
const assert = require("node:assert/strict");
const { validateTags, diffTags, TagValidationError, MAX_TAGS_PER_ORDER, MAX_KEY_LENGTH, MAX_VALUE_LENGTH } = require("./tags");

test("validateTags: accepts a normal key/value list, trims whitespace", () => {
  const result = validateTags([{ key: "  Type ", value: " Reprint " }, { key: "Priority", value: "Rush" }]);
  assert.deepEqual(result, [{ key: "Type", value: "Reprint" }, { key: "Priority", value: "Rush" }]);
});

test("validateTags: allows an empty value (boolean-style flag tag)", () => {
  const result = validateTags([{ key: "Test", value: "" }]);
  assert.deepEqual(result, [{ key: "Test", value: "" }]);
});

test("validateTags: rejects a non-array", () => {
  assert.throws(() => validateTags("nope"), TagValidationError);
  assert.throws(() => validateTags(undefined), TagValidationError);
});

test("validateTags: rejects more than MAX_TAGS_PER_ORDER tags", () => {
  const tags = Array.from({ length: MAX_TAGS_PER_ORDER + 1 }, (_, i) => ({ key: `k${i}`, value: "v" }));
  assert.throws(() => validateTags(tags), TagValidationError);
});

test("validateTags: rejects an empty key", () => {
  assert.throws(() => validateTags([{ key: "  ", value: "v" }]), TagValidationError);
  assert.throws(() => validateTags([{ key: "", value: "v" }]), TagValidationError);
});

test("validateTags: rejects a key or value over the length cap", () => {
  assert.throws(() => validateTags([{ key: "k".repeat(MAX_KEY_LENGTH + 1), value: "v" }]), TagValidationError);
  assert.throws(() => validateTags([{ key: "k", value: "v".repeat(MAX_VALUE_LENGTH + 1) }]), TagValidationError);
});

test("validateTags: rejects characters outside the allowlist", () => {
  assert.throws(() => validateTags([{ key: "<script>", value: "v" }]), TagValidationError);
  assert.throws(() => validateTags([{ key: "k", value: "v\"; DROP TABLE" }]), TagValidationError);
  assert.throws(() => validateTags([{ key: "k&m", value: "v" }]), TagValidationError);
});

test("validateTags: allows the AWS-style punctuation subset", () => {
  const result = validateTags([{ key: "team:printing", value: "priority/high-2.0" }]);
  assert.deepEqual(result, [{ key: "team:printing", value: "priority/high-2.0" }]);
});

test("validateTags: rejects a duplicate key, case-insensitively", () => {
  assert.throws(() => validateTags([{ key: "Type", value: "a" }, { key: "type", value: "b" }]), TagValidationError);
});

test("validateTags: rejects a non-object tag entry", () => {
  assert.throws(() => validateTags([null]), TagValidationError);
  assert.throws(() => validateTags(["Type"]), TagValidationError);
});

test("diffTags: reports added/removed/changed against the previous set", () => {
  const oldTags = [{ key: "Type", value: "Original" }, { key: "Test", value: "" }];
  const newTags = [{ key: "Type", value: "Reprint" }, { key: "Priority", value: "Rush" }];
  const diff = diffTags(oldTags, newTags);
  assert.deepEqual(diff.added, [{ key: "Priority", value: "Rush" }]);
  assert.deepEqual(diff.removed, [{ key: "Test", value: "" }]);
  assert.deepEqual(diff.changed, [{ key: "Type", from: "Original", to: "Reprint" }]);
});

test("diffTags: no-op diff when nothing changed", () => {
  const tags = [{ key: "Type", value: "Reprint" }];
  const diff = diffTags(tags, tags);
  assert.deepEqual(diff, { added: [], removed: [], changed: [] });
});

test("diffTags: handles empty old/new lists", () => {
  assert.deepEqual(diffTags([], []), { added: [], removed: [], changed: [] });
  assert.deepEqual(diffTags(null, [{ key: "Type", value: "Reprint" }]).added, [{ key: "Type", value: "Reprint" }]);
  assert.deepEqual(diffTags([{ key: "Type", value: "Reprint" }], null).removed, [{ key: "Type", value: "Reprint" }]);
});
