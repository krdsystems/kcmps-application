const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveOriginalType, resolveWebType, parseDesignKey, originalKey,
} = require("./design-types");

// Source files are OPEN (owner decision, 2026-08-07) — any extension is
// accepted. What must stay true regardless: a missing/malformed extension
// is rejected, since it becomes part of an S3 key.
test("resolveOriginalType: accepts any real-looking extension, any content-type", () => {
  assert.equal(resolveOriginalType("application/x-coreldraw", "logo.cdr"), "cdr");
  assert.equal(resolveOriginalType("image/tiff", "photo.tiff"), "tiff");
  assert.equal(resolveOriginalType("application/octet-stream", "font.ttf"), "ttf");
  assert.equal(resolveOriginalType("", "weird.xyz123"), "xyz123");
  // The formats that used to be the whole allowlist still work.
  assert.equal(resolveOriginalType("application/pdf", "spec.pdf"), "pdf");
  assert.equal(resolveOriginalType("image/svg+xml", "logo.svg"), "svg");
});

test("resolveOriginalType: rejects a missing or malformed extension", () => {
  assert.equal(resolveOriginalType("image/png", "noextension"), null);
  assert.equal(resolveOriginalType("image/png", ""), null);
  // Uppercase/underscore/etc are not [a-z0-9] — extensionOf() lowercases
  // first, so mixed-case is fine, but a genuinely non-alphanumeric run is not.
  assert.equal(resolveOriginalType("image/png", "file.a b"), null);
});

test("resolveOriginalType: an absurdly long extension is rejected (key-shape guard)", () => {
  const long = "a".repeat(50);
  assert.equal(resolveOriginalType("application/octet-stream", `file.${long}`), null);
});

test("resolveWebType: still closed to raster-only — opening originals did not widen this", () => {
  assert.equal(resolveWebType("image/jpeg", "photo.jpg"), "jpg");
  assert.equal(resolveWebType("image/png", "photo.png"), "png");
  assert.equal(resolveWebType("image/webp", "photo.webp"), "webp");
  assert.equal(resolveWebType("image/svg+xml", "photo.svg"), null, "SVG must never become web-ready");
  assert.equal(resolveWebType("image/tiff", "photo.tiff"), null);
  assert.equal(resolveWebType("application/octet-stream", "photo.jpg"), null, "no octet-stream fallback for web");
});

test("parseDesignKey: accepts any well-formed extension for kind=original", () => {
  const id = "0123abcd-0123-abcd-0123-0123456789ab";
  const parsed = parseDesignKey(`designs/dtf/${id}/original.cdr`, "original");
  assert.deepEqual(parsed, { category: "dtf", designId: id, ext: "cdr", kind: "original" });
});

test("parseDesignKey: still rejects a non-raster extension for kind=web", () => {
  const id = "0123abcd-0123-abcd-0123-0123456789ab";
  assert.equal(parseDesignKey(`designs/dtf/${id}/web.cdr`, "web"), null);
  assert.equal(parseDesignKey(`designs/dtf/${id}/web.svg`, "web"), null);
});

test("parseDesignKey: still rejects a bad category or malformed designId regardless of extension", () => {
  assert.equal(parseDesignKey("designs/not-a-real-leaf/0123abcd-0123-abcd-0123-0123456789ab/original.cdr", "original"), null);
  assert.equal(parseDesignKey("designs/dtf/not-a-uuid/original.cdr", "original"), null);
});

test("originalKey: the produced key round-trips through parseDesignKey for any accepted extension", () => {
  const id = "0123abcd-0123-abcd-0123-0123456789ab";
  const ext = resolveOriginalType("", "photo.tiff");
  const key = originalKey("dtf", id, ext);
  assert.equal(key, `designs/dtf/${id}/original.tiff`);
  assert.deepEqual(parseDesignKey(key, "original"), { category: "dtf", designId: id, ext: "tiff", kind: "original" });
});
