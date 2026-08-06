/* ============================================================
   KCMPS Asset Library — server-side allowlists & key shapes
   ============================================================
   The single server-side source of truth for what a STAFF member may
   upload into the Design Asset Library, and for how an object's S3 key
   is built. Same stance as backend/lib/upload-types.js (the customer-
   facing checkout allowlist, deliberately a separate list — customers
   and staff upload for different reasons and the accepted sets differ):

     the client is UNTRUSTED. website/dashboard/asset-library.html may
     mirror these lists for immediate UX feedback, but that copy is a
     convenience, never a security boundary. Everything here re-validates.

   Two files per design, both landing on the PRIVATE originals bucket
   (kcmps-design-originals-*) under one `designs/` prefix:

     designs/<category>/<designId>/original.<ext>   PSD | AI | PDF
     designs/<category>/<designId>/web.<ext>        JPG | PNG | WEBP

   Why the web-ready file is ALSO staged privately instead of being PUT
   straight into the public storefront bucket: GuardDuty Malware
   Protection is configured on the `designs/` prefix of the originals
   bucket only. Uploading directly to the public bucket would mean the
   one file the whole internet can fetch is the one file nobody scanned.
   publish-design.js copies it across only after a clean verdict — that
   copy is the trust boundary, and it is server-side.

   The designer's own filename NEVER appears in a key (no traversal, no
   extension confusion, no length games); it survives only as the
   record's display `name`. The extension comes from the *validated*
   content-type/extension pair, not from what was handed to us.
   ============================================================ */

// Source files. Deliberately narrower than the customer allowlist: no
// office documents, no raster-only formats, and (same reasoning as
// upload-types.js) no archives.
//
// SVG (owner decision, 2026-08-07): allowed as a SOURCE file only. An SVG
// can carry script, so it is ATTACHMENT-ONLY everywhere: list-designs.js
// already forces Content-Disposition: attachment + application/octet-stream
// on every original download, and SVG must NEVER be added to WEB_TYPES,
// never reach an <img>/inline render, and never enter store.js's
// SAFE_IMAGE_RE. The web-ready allowlist below stays raster-only.
const ORIGINAL_TYPES = Object.freeze({
  "image/vnd.adobe.photoshop": "psd",
  "application/x-photoshop": "psd",
  "application/illustrator": "ai",
  "application/postscript": "ai", // what a browser usually reports for .ai
  "application/pdf": "pdf",
  "image/svg+xml": "svg",
});
const ORIGINAL_EXTENSIONS = Object.freeze({ psd: "psd", ai: "ai", pdf: "pdf", svg: "svg" });

// Derived, storefront-facing image. Only formats a browser renders
// natively and that carry no scripting surface.
const WEB_TYPES = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
});
const WEB_EXTENSIONS = Object.freeze({ jpg: "jpg", jpeg: "jpg", png: "png", webp: "webp" });

// Resolved decision (docs/roadmap.md, 2026-08-02): 300MB per file via a
// single presigned PUT — no multipart. Signed into the URL as an exact
// ContentLength, so this is a real server-side constraint, not advice.
const MAX_DESIGN_BYTES = 300 * 1024 * 1024;

// Catalog leaves from website/products.js's KCMPS_STORE_DATA.leaves.
// Mirrored here so the server can reject a category outright rather than
// trusting a dropdown — the dashboard sources its <select> from
// products.js, so ADD A LEAF THERE AND HERE TOGETHER or a newly added
// category silently 400s on upload.
const DESIGN_CATEGORIES = Object.freeze([
  "print-office", "dtf", "subli", "hotmelt", "3dprint", "souvenir", "network", "storage",
]);

const KEY_PREFIX = "designs";

// Both the declared content-type AND the filename extension must land in
// the same allowlist and agree — see upload-types.js's resolveUploadType()
// for the full reasoning (a spoofed type on a payload.exe is caught on the
// extension; a renamed executable is stored under a server-chosen key with
// a server-chosen extension and is never executed). `.psd`/`.ai` routinely
// arrive as application/octet-stream with no OS mapping, so that one
// generic type is accepted for originals only.
function resolveOriginalType(contentType, filename) {
  return resolve(contentType, filename, ORIGINAL_TYPES, ORIGINAL_EXTENSIONS, true);
}

// No octet-stream fallback for the web-ready file: every accepted format
// has a registered IANA type that browsers always report correctly, so a
// missing/generic type here means something is wrong, not something is
// unmapped.
function resolveWebType(contentType, filename) {
  return resolve(contentType, filename, WEB_TYPES, WEB_EXTENSIONS, false);
}

function resolve(contentType, filename, types, extensions, allowOctetStream) {
  const ext = extensions[extensionOf(filename)];
  if (!ext) return null;
  const declared = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (types[declared]) return types[declared] === ext ? ext : null;
  if (allowOctetStream && (declared === "application/octet-stream" || declared === "binary/octet-stream" || declared === "")) {
    return ext;
  }
  return null;
}

function extensionOf(filename) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(filename || "").trim());
  return m ? m[1].toLowerCase() : "";
}

function isValidCategory(category) {
  return DESIGN_CATEGORIES.includes(category);
}

// A designId is server-generated (randomUUID) at upload-url time and is
// the ONLY caller-supplied piece of a key publish-design.js will accept —
// so it gets a strict shape check before it is ever concatenated into an
// S3 key or a DynamoDB PK.
const DESIGN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isValidDesignId(id) {
  return typeof id === "string" && DESIGN_ID_RE.test(id);
}

function originalKey(category, designId, ext) {
  return `${KEY_PREFIX}/${category}/${designId}/original.${ext}`;
}

function webKey(category, designId, ext) {
  return `${KEY_PREFIX}/${category}/${designId}/web.${ext}`;
}

// Parses a key back into its parts and re-validates every component.
// publish-design.js uses this instead of trusting the s3Key strings in
// the request body: a caller can only ever name a key this function
// would itself have produced (right prefix, known category, well-formed
// uuid, allowlisted extension, exact basename) — which rules out copying
// an arbitrary object out of the private bucket into the public one.
function parseDesignKey(key, kind) {
  if (typeof key !== "string") return null;
  const parts = key.split("/");
  if (parts.length !== 4) return null;
  const [prefix, category, designId, basename] = parts;
  if (prefix !== KEY_PREFIX) return null;
  if (!isValidCategory(category) || !isValidDesignId(designId)) return null;
  const m = /^(original|web)\.([a-z0-9]+)$/.exec(basename);
  if (!m) return null;
  const [, base, ext] = m;
  if (base !== kind) return null;
  const allowed = kind === "original" ? ORIGINAL_EXTENSIONS : WEB_EXTENSIONS;
  if (allowed[ext] !== ext) return null;
  return { category, designId, ext, kind };
}

module.exports = {
  ORIGINAL_TYPES, ORIGINAL_EXTENSIONS, WEB_TYPES, WEB_EXTENSIONS,
  MAX_DESIGN_BYTES, DESIGN_CATEGORIES, KEY_PREFIX,
  resolveOriginalType, resolveWebType, extensionOf,
  isValidCategory, isValidDesignId,
  originalKey, webKey, parseDesignKey,
};
