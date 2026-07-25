/* ============================================================
   KCMPS backend — GSI1 sparse-index hygiene helpers
   ============================================================
   ops-dashboard/infra/backend-infra-to-deploy.md §2.3/§2.6:
   GSI1PK/GSI1SK must exist ONLY on line items in an active status
   (ACTIVE_STATUSES, constants.js). The moment a line item reaches a
   terminal status, the attributes must be REMOVEd from the item — a
   `REMOVE` in the UpdateExpression, never `SET ... = null` — so completed
   work drops out of every staff action queue automatically instead of
   lingering as a null-valued index entry.
   ============================================================ */

const { ACTIVE_STATUSES, TERMINAL_STATUSES } = require("./constants");
const { statusPk, statusSk } = require("./keys");

// Returns { GSI1PK, GSI1SK } when `status` is active, or null when it
// isn't — callers should only SET these attributes in the null case's
// opposite (i.e. only write them when this returns non-null); for a
// terminal status, use attrsToRemoveOnTerminal() instead of writing null.
function activeStatusAttrs(status, enteredAtIso) {
  if (!ACTIVE_STATUSES.has(status)) return null;
  return { GSI1PK: statusPk(status), GSI1SK: statusSk(enteredAtIso) };
}

// Returns the attribute names to REMOVE from a line item's
// UpdateExpression when `status` is terminal (e.g.
// `REMOVE ${attrsToRemoveOnTerminal(status).join(", ")}`), or an empty
// array when `status` isn't terminal (nothing to remove).
function attrsToRemoveOnTerminal(status) {
  return TERMINAL_STATUSES.has(status) ? ["GSI1PK", "GSI1SK"] : [];
}

module.exports = { activeStatusAttrs, attrsToRemoveOnTerminal };
