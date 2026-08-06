/* ============================================================
   KCMPS Asset Library — approval-set math (pure, unit-tested)
   ============================================================
   The "all current Admin-group members must approve" rule, factored out
   of patch-design.js so the completeness decision — the thing that
   triggers an irreversible publish — is a pure function under
   `node --test`, not logic buried in a Lambda handler.

   THE RULE (docs/asset-library-rebuild-plan-2026-08-06.md §4):
   - The approver set is "all CURRENT members of the Admin group",
     re-evaluated from Cognito ListUsersInGroup on every approve call —
     never snapshotted at submission. An admin added mid-queue must also
     approve; a removed admin's recorded approval is ignored in the count
     (but kept in the audit trail).
   - An EMPTY admin set can never complete. Publishing on "nobody has to
     approve" would turn a Cognito misconfiguration into an auto-publish
     primitive — fail closed instead, same stance as the scan gate.
   - Single-admin case: their one approval (including the auto-approval
     recorded when an Admin submits their own asset) completes the set
     immediately — no deadlock waiting for a second founder who doesn't
     exist.
   ============================================================ */

// approvals: the `approvals` map stored on the DESIGN# META item —
//   { [sub]: { name, at, via? } }
// adminUsers: current Admin-group members from ListUsersInGroup —
//   [ { sub, name } ]
//
// Returns:
//   {
//     requiredCount,             // number of current admins
//     approvedCount,             // current admins who have approved
//     complete,                  // true only when every current admin approved
//     outstanding: [{sub,name}], // current admins still to approve
//     approvedBy:  [{sub,name}], // current admins who have approved
//   }
function approvalState(approvals, adminUsers) {
  const map = approvals && typeof approvals === "object" ? approvals : {};
  const admins = Array.isArray(adminUsers) ? adminUsers.filter((u) => u && typeof u.sub === "string" && u.sub) : [];
  const approvedBy = [];
  const outstanding = [];
  for (const admin of admins) {
    if (Object.prototype.hasOwnProperty.call(map, admin.sub)) approvedBy.push(admin);
    else outstanding.push(admin);
  }
  return {
    requiredCount: admins.length,
    approvedCount: approvedBy.length,
    // Empty admin set NEVER completes — fail closed (see header).
    complete: admins.length > 0 && outstanding.length === 0,
    outstanding,
    approvedBy,
  };
}

// True when this sub's approval is already recorded (idempotent-click check).
function hasApproved(approvals, sub) {
  return !!(approvals && typeof approvals === "object" && sub &&
    Object.prototype.hasOwnProperty.call(approvals, sub));
}

// Display-only snapshot stored on the item so the dashboard can render
// "1 of 2 · waiting on Ken" without its own Cognito access. NEVER used
// for the completeness decision — approvalState() re-evaluates against
// live membership on every approve.
function approvalSnapshot(approvals, adminUsers) {
  const state = approvalState(approvals, adminUsers);
  return {
    requiredCount: state.requiredCount,
    approvedCount: state.approvedCount,
    approvers: [
      ...state.approvedBy.map((u) => ({ sub: u.sub, name: u.name || null, approved: true })),
      ...state.outstanding.map((u) => ({ sub: u.sub, name: u.name || null, approved: false })),
    ],
  };
}

module.exports = { approvalState, hasApproved, approvalSnapshot };
