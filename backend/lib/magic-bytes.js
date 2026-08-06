/* ============================================================
   KCMPS backend — file-signature ("magic bytes") sniffing
   ============================================================
   Closes the gap `resolveUploadType()` (upload-types.js) cannot close by
   construction: that function validates the CLAIMED Content-Type against
   the filename extension, both of which are attacker-controlled and
   agree trivially when someone simply renames a file (a JPEG renamed to
   `invoice.pdf` declares `application/pdf` and has a `.pdf` extension —
   both checks pass, nothing here contradicts either of them). Only the
   file's actual first bytes can catch that, and this checkout's uploads
   go browser -> S3 directly via a presigned PUT — no Lambda ever sees
   the bytes at request time (see upload-design-file.js's header). This
   module is pure sniffing logic so it can run wherever the bytes
   eventually ARE available (an S3-event-triggered Lambda that reads a
   short Range of the object — see jobs/validate-upload-content.js) and
   be unit-tested without any AWS SDK or I/O.

   Deliberately conservative: `sniffFamily()` returns a family name only
   when the leading bytes are an unambiguous, well-known signature, and
   `null` when they aren't recognized. `matchesExpectedFamily()` then
   only reports a mismatch when the sniff was CONFIDENT and disagrees
   with what the extension claims — an unrecognized/ambiguous buffer is
   never treated as evidence of tampering. That asymmetry is intentional:
   a false "this is fine" just means one more layer (GuardDuty, private
   bucket, forced download) has to catch a real threat; a false "this is
   disguised" would delete a legitimate customer file. Every extension
   this repo accepts (upload-types.js's ALLOWED_UPLOAD_EXTENSIONS) either
   maps to a family here or is intentionally left unchecked (ambiguous
   containers like legacy doc/xls/ppt all share the OLE signature, so
   they're grouped as one family, not distinguished from each other).
   ============================================================ */

// Family -> signature checkers. Each returns true if `buf` starts with (or,
// for text-ish formats, contains near the start) that family's signature.
const SIGNATURES = {
  jpg: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  png: (buf) => buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a,
  gif: (buf) => buf.length >= 6 && asciiEquals(buf.subarray(0, 6), "GIF87a") || (buf.length >= 6 && asciiEquals(buf.subarray(0, 6), "GIF89a")),
  webp: (buf) => buf.length >= 12 && asciiEquals(buf.subarray(0, 4), "RIFF") && asciiEquals(buf.subarray(8, 12), "WEBP"),
  tif: (buf) => buf.length >= 4 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) || // little-endian "II*\0"
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)), // big-endian "MM\0*"
  pdf: (buf) => buf.length >= 5 && asciiEquals(buf.subarray(0, 5), "%PDF-"),
  ps: (buf) => buf.length >= 2 && asciiEquals(buf.subarray(0, 2), "%!"), // PostScript / legacy EPS/AI
  psd: (buf) => buf.length >= 4 && asciiEquals(buf.subarray(0, 4), "8BPS"),
  // Legacy Office (doc/xls/ppt) — OLE Compound File Binary signature.
  // Deliberately one family for all three: the container signature alone
  // can't tell a .doc from a .xls, and this module doesn't need it to.
  ole: (buf) => buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0 &&
    buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1,
  // Modern Office (docx/xlsx/pptx) — a ZIP container ("PK\x03\x04").
  zip: (buf) => buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07),
  // SVG — XML/text, not a fixed binary signature. Skip UTF-8 BOM and
  // leading whitespace/XML prolog/comments, then look for an opening
  // "<svg" tag within a bounded prefix. Conservative on purpose: this
  // only returns true for something that unambiguously looks like SVG
  // markup, never merely "some XML".
  svg: (buf) => {
    const text = stripBom(buf).subarray(0, 512).toString("latin1").trimStart();
    return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype[^>]*>\s*)?<svg[\s>]/i.test(text);
  },
};

// Extension (as canonicalized by upload-types.js's EXTENSION_CANONICAL) ->
// the set of families that are a legitimate signature for it. More than
// one entry where a real-world encoder can legitimately produce either
// (e.g. modern .ai files are PDF-compatible; legacy ones are PostScript).
const EXPECTED_FAMILIES = {
  jpg: ["jpg"],
  png: ["png"],
  webp: ["webp"],
  tif: ["tif"],
  pdf: ["pdf"],
  ai: ["pdf", "ps"],
  eps: ["ps", "pdf"],
  psd: ["psd"],
  svg: ["svg"],
  doc: ["ole"],
  xls: ["ole"],
  ppt: ["ole"],
  docx: ["zip"],
  xlsx: ["zip"],
  pptx: ["zip"],
};

// Returns the recognized family name for `buf`'s leading bytes, or null if
// nothing matched. Checked in a fixed order; formats never share a
// signature so order doesn't affect correctness, only micro-perf.
function sniffFamily(buf) {
  if (!buf || !buf.length) return null;
  for (const family of ["png", "jpg", "gif", "webp", "tif", "pdf", "psd", "ole", "zip", "svg", "ps"]) {
    if (SIGNATURES[family](buf)) return family;
  }
  return null;
}

// True when the sniffed family is a KNOWN, confident mismatch against what
// `ext` (a canonical extension from upload-types.js) claims to be. False
// for both "matches" and "couldn't determine" — see header for why an
// inconclusive sniff must never be treated as tampering evidence.
function isConfidentMismatch(ext, buf) {
  const expected = EXPECTED_FAMILIES[ext];
  if (!expected) return false; // extension has no known signature (shouldn't happen for this repo's allowlist)
  const sniffed = sniffFamily(buf);
  if (!sniffed) return false; // inconclusive — never flag
  return !expected.includes(sniffed);
}

function asciiEquals(buf, str) {
  if (buf.length < str.length) return false;
  for (let i = 0; i < str.length; i++) {
    if (buf[i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

function stripBom(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3);
  return buf;
}

module.exports = { sniffFamily, isConfidentMismatch, EXPECTED_FAMILIES };
