/* ============================================================
   KCMPS backend — customer design-file upload allowlist
   ============================================================
   The single server-side source of truth for what a customer may upload
   as a design/print file at checkout (backend/checkout/upload-design-
   file.js). `website/store.js` mirrors this list client-side for
   immediate UX feedback — that copy is a convenience, NOT a security
   boundary (trivially bypassed with devtools/curl), so any change here
   must be mirrored there and the server check must stay the real gate.

   Deliberately an ALLOWLIST, not a denylist of dangerous extensions. A
   denylist only stops what it already knows about; anything novel,
   renamed, or polyglot walks straight through. The owner picked this
   exact set (2026-08-04): what print customers actually send, minus two
   categories that were considered and rejected on purpose —

   - **No SVG.** Real vector artwork customers do send, but SVG is an
     XML/script container: an `<svg>` with an inline `<script>` or an
     `onload=` attribute is stored XSS the moment anything renders it
     from a KCMPS-controlled origin. Nothing here renders uploads inline
     (see upload-design-file.js's header on presigned-GET-only +
     ResponseContentDisposition=attachment), but excluding the format
     entirely means that containment is not the ONLY thing standing
     between an uploaded file and a script execution. Customers with
     vector art send PDF/AI/EPS instead, which every print workflow here
     already handles.
   - **No archives (zip/rar/7z).** An archive is opaque to Content-Type
     validation — the declared type describes the container, never what's
     inside it, which is exactly how an executable gets past a filter.
     GuardDuty does scan inside archives, but the checkout textarea
     (which stays, alongside the upload zone) already covers the
     multi-file case via a Drive/Dropbox link, so the risk buys nothing.

   Keyed by MIME type because that's what the presign call validates and
   what S3 stores; `ext` is what the generated S3 key gets, so the
   customer's own filename never becomes part of the key (see
   upload-design-file.js). Several print formats have no registered IANA
   type and arrive as application/octet-stream from browsers — those are
   handled by matching on the declared extension too, see
   resolveUploadType().
   ============================================================ */

// contentType -> canonical extension used to build the S3 key.
const ALLOWED_UPLOAD_TYPES = Object.freeze({
  // Raster artwork
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/tiff": "tif",
  // Print / design source
  "application/pdf": "pdf",
  "application/postscript": "eps", // also what .ai commonly reports
  "application/illustrator": "ai",
  "image/vnd.adobe.photoshop": "psd",
  "application/x-photoshop": "psd",
  // Office documents (print-office leaf: documents, catalogs, forms)
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
});

// Extensions the above set covers, for the octet-stream fallback below.
// .ai/.eps/.psd/.tif in particular are routinely reported by browsers as
// application/octet-stream (no OS mapping), so rejecting on MIME alone
// would block files the owner explicitly wants accepted.
const ALLOWED_UPLOAD_EXTENSIONS = Object.freeze([
  "jpg", "jpeg", "png", "webp", "tif", "tiff",
  "pdf", "ai", "eps", "psd",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx",
]);

// Normalized canonical extension per accepted extension (jpeg -> jpg etc.)
const EXTENSION_CANONICAL = Object.freeze({
  jpeg: "jpg", jpg: "jpg", png: "png", webp: "webp", tiff: "tif", tif: "tif",
  pdf: "pdf", ai: "ai", eps: "eps", psd: "psd",
  doc: "doc", docx: "docx", xls: "xls", xlsx: "xlsx", ppt: "ppt", pptx: "pptx",
});

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB — print source files are large; see upload-design-file.js
const MAX_UPLOADS_PER_ORDER = 10;

// Returns the canonical extension for an accepted (contentType, filename)
// pair, or null if the combination isn't on the allowlist.
//
// Two-key check on purpose: a browser's declared Content-Type is
// attacker-controlled, and so is the filename — neither alone is
// trustworthy. Requiring BOTH to land inside the allowlist means a
// spoofed `application/pdf` on a `payload.exe` is rejected on the
// extension, and a real `.pdf` renamed from an executable is still
// stored under a server-generated key with a server-chosen extension and
// never executed (see upload-design-file.js's containment notes).
function resolveUploadType(contentType, filename) {
  const ext = EXTENSION_CANONICAL[extensionOf(filename)];
  if (!ext) return null;

  const declared = String(contentType || "").toLowerCase().split(";")[0].trim();
  // Registered type: must be on the allowlist AND agree with the extension.
  if (ALLOWED_UPLOAD_TYPES[declared]) {
    return ALLOWED_UPLOAD_TYPES[declared] === ext ? ext : null;
  }
  // Unregistered/absent type (the .ai/.eps/.psd/.tif case above): accept
  // only the generic binary types a browser actually emits when it has no
  // mapping — never an arbitrary attacker-chosen string.
  if (declared === "application/octet-stream" || declared === "" || declared === "binary/octet-stream") {
    return ext;
  }
  return null;
}

function extensionOf(filename) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(filename || "").trim());
  return m ? m[1].toLowerCase() : "";
}

/* ── Inline viewing vs forced download ────────────────────────────────────
   Staff open customer attachments constantly — a payment screenshot, a photo
   of a misprint, a PDF spec. Forcing every one of them to download meant a
   trip through the Downloads folder to look at a picture, and left a pile of
   customer files on disk. These open in a tab instead.

   This is the same trade the GCash screenshot already makes (see
   get-orders.js's "FORCED DOWNLOAD" note): inline is allowed ONLY after the
   file has passed the GuardDuty scan gate. Callers must still check
   NO_THREATS_FOUND before presigning — this helper decides *how* to serve a
   file that is already known clean, never *whether* to serve it.

   The allowlist is deliberately narrow and closed:
   - Images and PDF only. These are exactly the types send-message.js accepts,
     so nothing else can reach a message thread anyway.
   - SVG is NOT here and must never be added. An SVG is a script container —
     rendering one inline executes its JavaScript. `backend/lib/upload-types.js`
     already excludes it at upload time for the same reason; this is the
     second layer.
   - HTML, JS and anything unrecognised fall through to `attachment`, so an
     unexpected type can only ever be downloaded, never rendered.

   Cross-origin note: these render from the S3 presigned host, not kcmps.com,
   so even a hostile file that slipped past the scanner cannot reach the
   dashboard's session or DOM. */
const INLINE_VIEWABLE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

/* Returns the S3 presign response-header overrides for an already-scanned
   attachment. Pass the stored contentType; anything not explicitly listed
   above is served as a download. */
function contentDispositionFor(contentType, filename, { allowInline = true } = {}) {
  // Filename lands inside a quoted header value, so anything that could
  // terminate the quoting or inject a header is replaced, and the result is
  // length-capped. Deliberately an allowlist, not a blocklist of `"` and `\`.
  const safeName = String(filename || "file")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .trim()
    .slice(0, 120) || "file";
  if (allowInline && INLINE_VIEWABLE_TYPES.has(String(contentType || "").toLowerCase())) {
    return {
      ResponseContentDisposition: `inline; filename="${safeName}"`,
      // Serve the real type so the browser renders it; octet-stream would
      // force a download no matter what the disposition says.
      ResponseContentType: contentType,
    };
  }
  return {
    ResponseContentDisposition: `attachment; filename="${safeName}"`,
    ResponseContentType: "application/octet-stream",
  };
}

module.exports = {
  ALLOWED_UPLOAD_TYPES,
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS_PER_ORDER,
  INLINE_VIEWABLE_TYPES,
  resolveUploadType,
  extensionOf,
  contentDispositionFor,
};
