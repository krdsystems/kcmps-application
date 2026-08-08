/* ============================================================
   KCMPS backend — shared conventions library
   ============================================================
   Single entry point: `const lib = require("../lib");` (or
   `require("../lib/money")` etc. directly for a smaller require graph in
   a cold-start-sensitive Lambda). See backend/CLAUDE.md.
   ============================================================ */

module.exports = {
  ...require("./constants"),
  ...require("./money"),
  ...require("./keys"),
  ...require("./item"),
  ...require("./events"),
  ...require("./auth"),
  ...require("./gsi"),
  ...require("./order-status"),
  ...require("./customer-view"),
  ...require("./upload-types"),
  ...require("./threat-descriptions"),
  ...require("./magic-bytes"),
  ...require("./mail"),
  ...require("./tags"),
};
// NOTE: ./business-hours and ./pin are deliberately NOT spread here —
// require them directly (require("../lib/business-hours") /
// require("../lib/pin")) for a smaller require graph, same as
// staff-api/verify-payment.js does for business-hours.
