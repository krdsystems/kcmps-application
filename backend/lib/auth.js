/* ============================================================
   KCMPS backend — role model & claims helpers
   ============================================================
   The 5-role model from ERP_System_Project_Knowledge.md §Part 5:
   Customer, Production, Sales, Finance, Admin. `Staff` is the pre-role-
   split group every founder is actually in today — it's a first-class
   member of STAFF_ROLES below (not a legacy bolt-on other files special-
   case), so "sees the dashboard" reads as one check everywhere. The
   finer roles (Production/Sales/Finance) are reserved in the model for
   the first non-founder hire (a group assignment then, not a rebuild);
   Admin is the founder/owner role, with everything Staff has plus
   whatever admin-only surface gets built later.

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
  STAFF: "Staff",
  PRODUCTION: "Production",
  SALES: "Sales",
  FINANCE: "Finance",
  ADMIN: "Admin",
});

// Every group that grants dashboard access — the pre-split "Staff" group
// plus every finer role it's meant to eventually split into.
const STAFF_ROLES = new Set([ROLES.STAFF, ROLES.PRODUCTION, ROLES.SALES, ROLES.FINANCE, ROLES.ADMIN]);

function extractClaims(event) {
  return (event && event.requestContext && event.requestContext.authorizer &&
    event.requestContext.authorizer.jwt && event.requestContext.authorizer.jwt.claims) || null;
}

// API Gateway's HTTP API JWT authorizer flattens a multi-value
// `cognito:groups` claim into a bracketed, SPACE-separated string —
// confirmed live: "[Staff Admin]" for two groups, "[Admin]" for one (not
// a comma-join, despite that being the more commonly-documented
// behavior). Strip one optional wrapping "[" / "]" then split on any
// run of commas/whitespace, so a plain comma-string (tests, local dev)
// still works too. A locally-constructed claims object may already hand
// it over as a real array, handled first.
function getGroups(claims) {
  const groups = claims && claims["cognito:groups"];
  if (!groups) return [];
  if (Array.isArray(groups)) return groups;
  if (typeof groups === "string") {
    const stripped = groups.replace(/^\[/, "").replace(/\]$/, "");
    return stripped.split(/[,\s]+/).map((g) => g.trim()).filter(Boolean);
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
