/* ============================================================
   KCMPS backend — role model & claims helpers
   ============================================================
   The 5-role model from ERP_System_Project_Knowledge.md §Part 5:
   Customer, Production, Sales, Finance, Admin. Only `Staff` is enforced
   in Cognito today (see ops-dashboard/infra/logic-inputs/*.js) — these
   finer roles are reserved in the model now so the first hire is a group
   assignment, not a rebuild.

   IMPORTANT: client-decoded JWT claims (e.g. from the storefront's
   jwt-decode-in-the-browser pattern, see the main README's "Client-side
   JWT decoding is for display only" section) are UI-only. Every function
   in this file is meant to run server-side, inside a Lambda, on the
   `event.requestContext.authorizer.jwt.claims` object that API Gateway's
   JWT authorizer has ALREADY verified against Cognito's JWKS — never on
   a claims object decoded from a client-supplied token directly.
   ============================================================ */

const ROLES = Object.freeze({
  CUSTOMER: "Customer",
  PRODUCTION: "Production",
  SALES: "Sales",
  FINANCE: "Finance",
  ADMIN: "Admin",
});

// Every role except Customer — mirrors the existing single "Staff" group
// this splits into.
const STAFF_ROLES = new Set([ROLES.PRODUCTION, ROLES.SALES, ROLES.FINANCE, ROLES.ADMIN]);

function extractClaims(event) {
  return (event && event.requestContext && event.requestContext.authorizer &&
    event.requestContext.authorizer.jwt && event.requestContext.authorizer.jwt.claims) || null;
}

// API Gateway's JWT authorizer flattens multi-value `cognito:groups` into a
// comma-joined string; a locally-constructed claims object (tests, local
// dev) may already hand it over as an array. Handle both, like
// api-verify-payment.js / api-get-orders.js already do inline.
function getGroups(claims) {
  const groups = claims && claims["cognito:groups"];
  if (!groups) return [];
  if (Array.isArray(groups)) return groups;
  if (typeof groups === "string") {
    return groups.split(",").map((g) => g.trim()).filter(Boolean);
  }
  return [];
}

function hasRole(claims, role) {
  return getGroups(claims).includes(role);
}

// Any role except Customer — the "sees staff-only views" check used
// throughout the dashboard Lambdas.
function isStaff(claims) {
  return getGroups(claims).some((g) => STAFF_ROLES.has(g));
}

// Returns null if the caller has at least one of `roles`; otherwise a
// 403-shaped error object the caller can return directly as an API
// Gateway response body (or throw/wrap as needed).
function requireRole(claims, roles) {
  const required = Array.isArray(roles) ? roles : [roles];
  const groups = getGroups(claims);
  const allowed = required.some((r) => groups.includes(r));
  if (allowed) return null;
  return { statusCode: 403, error: "Forbidden", requiredRoles: required };
}

module.exports = { ROLES, STAFF_ROLES, extractClaims, getGroups, hasRole, isStaff, requireRole };
