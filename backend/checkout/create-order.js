/* ============================================================
   KCMPS Checkout (Module 1 — Sales & Order) — POST /orders
   ============================================================
   The Lambda `docs/roadmap.md` 1.1 calls out as missing: "New
   customer-facing Lambda createOrder ... Splits the cart: writes
   ORDER#<id> META + one LINEITEM#<id> per line; sku items -> Pending
   Payment Verification, custom items -> Quoted."

   Replaces the storefront's mailto: checkout (website/store.js
   submitOrder(), ~line 1533) behind the existing KCMPS_STORE seam — this
   Lambda is the one thing that changes; no .html edits (roadmap 1.1).

   GUEST CHECKOUT IS ALLOWED. The storefront has never required login to
   check out — the cart, name, and contact fields work with no Cognito
   session (see store.js). Requiring login here would be a checkout UX
   change this Lambda has no business making unilaterally, so a Bearer
   token is accepted and verified IF present, but its absence never
   blocks the order — customerSub is simply null (mirrors how
   dashboard.js's manual-order path already records staff-entered orders
   with no customer account: website/dashboard/dashboard-data.js's
   createManualOrder()).

   NOT sending GCash payment proof here — that's submitPaymentProof.js
   (roadmap 1.2), a separate customer action after the popup shown post-
   checkout. This Lambda only creates the order in the right starting
   statuses; order.payment stays null until the customer submits proof.

   MONEY: kept as peso floats (not backend/lib/money.js's integer
   centavos) to match every other currently-drafted Lambda
   (ops-dashboard/infra/logic-inputs/streams-handler.js sums li.amount as
   a raw peso number) and the existing mock/frontend shapes verbatim.
   Converting only this Lambda to centavos while streams-handler.js,
   api-get-orders.js, and every dashboard .html still assume pesos would
   silently corrupt every downstream metric by 100x — the centavo
   migration checklist item in docs/roadmap.md 1.0 needs a coordinated
   pass across all money fields at once, not a partial one started here.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const { STATUS, baseItem, buildEvent, orderPk, metaSk, lineItemSk, activeStatusAttrs, deriveOrderStatus } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
// Matches the "2-3 day turnaround" headline copy on the storefront (see
// index.html's hero). A courtesy estimate, not a per-product SLA engine —
// the cart payload carries no per-line softCap/lead-time data today (that
// lives only in products.js on the frontend), so this is one flat business-
// day offset for the whole order rather than a per-product calculation.
// Refine if/when lead-time data starts flowing through checkout.
const BASE_LEAD_BUSINESS_DAYS = 3;

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const verifier = USER_POOL_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, tokenUse: "id", clientId: CLIENT_ID })
  : null;

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  const { customerName, customerContact, fulfillment, shipping, notes, cart } = body;
  if (!customerName || !customerContact) {
    return response(400, { error: "customerName and customerContact are required" });
  }
  if (!Array.isArray(cart) || !cart.length) {
    return response(400, { error: "cart must be a non-empty array" });
  }
  const isDelivery = fulfillment === "Delivery";
  if (isDelivery && (!shipping || !shipping.courier || !shipping.address)) {
    return response(400, { error: "shipping.courier and shipping.address are required when fulfillment is Delivery" });
  }
  for (const raw of cart) {
    if (!raw || !raw.name || !(raw.qty > 0)) {
      return response(400, { error: "Every cart line needs a name and a qty > 0" });
    }
  }

  const customerSub = await tryGetSub(event);
  const now = new Date().toISOString();
  const orderId = "ORD-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const pk = orderPk(orderId);

  let payNowTotal = 0;
  const transactItems = [];
  const lineItemsOut = [];

  cart.forEach((raw, idx) => {
    const type = raw.type === "custom" ? "custom" : "sku";
    const qty = Math.max(1, parseInt(raw.qty, 10) || 1);
    const unitPrice = type === "sku" ? (Number(raw.unitPrice) || 0) : null;
    const amount = unitPrice != null ? Math.round(unitPrice * qty * 100) / 100 : 0;
    if (type === "sku") payNowTotal = Math.round((payNowTotal + amount) * 100) / 100;

    const status = type === "custom" ? STATUS.QUOTED : STATUS.PENDING_PAYMENT_VERIFICATION;
    const lineItemId = "L" + (idx + 1) + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

    const lineItem = {
      ...baseItem({ status, createdAt: now }),
      PK: pk, SK: lineItemSk(lineItemId),
      lineItemId, orderId, type,
      sku: raw.sku || null,
      name: raw.name, variantLabel: raw.variantLabel || null,
      shirt: !!raw.shirt, shirtColor: raw.shirtColor || null,
      designRef: raw.designRef || null, designName: raw.designName || null,
      qty, priceEach: unitPrice, amount,
      station: null, setupMinutes: null, spoilage: [],
      enteredStatusAt: now,
      // Custom-item detail notes travel on the line item that needs
      // pricing; sku lines don't carry the shared checkout notes field.
      notes: type === "custom" ? (notes || "") : "",
      ...(activeStatusAttrs(status, now) || {}),
    };
    lineItemsOut.push(lineItem);

    transactItems.push({ Put: { TableName: TABLE, Item: lineItem } });
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: buildEvent({
          orderId, lineItemId, from: null, to: status,
          actorSub: customerSub, actorName: customerName,
          meta: { via: "createOrder" }, at: now,
        }),
      },
    });
  });

  const orderStatus = deriveOrderStatus(lineItemsOut.map((li) => li.status));
  // originalPromisedDate is frozen at creation and never overwritten by any
  // later Lambda (see project_knowledge/ERP_System_Project_Knowledge.md —
  // OTIF is measured against the ORIGINAL promise, not a revised one). Left
  // null for orders containing any custom line — those have no price or
  // production slot yet, so there's nothing to promise a date against until
  // staff quote them.
  const allSku = lineItemsOut.every((li) => li.type === "sku");
  const originalPromisedDate = allSku ? addBusinessDays(now, BASE_LEAD_BUSINESS_DAYS) : null;
  const orderItem = {
    ...baseItem({ status: orderStatus, createdAt: now }),
    PK: pk, SK: metaSk(),
    orderId, customerSub, customerName, customerContact,
    fulfillment: isDelivery ? "Delivery" : "Pickup",
    shipping: isDelivery ? { courier: shipping.courier, address: shipping.address, landmark: shipping.landmark || null } : null,
    orderStatus, originalPromisedDate,
    payment: null, // submitPaymentProof.js attaches this once the customer submits GCash proof
    correspondenceLog: [],
  };
  transactItems.unshift({ Put: { TableName: TABLE, Item: orderItem } });

  await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems })).catch((err) => {
    if (err.name === "TransactionCanceledException") {
      throw Object.assign(new Error("Could not create the order — please retry."), { statusCode: 409 });
    }
    throw err;
  });

  return response(201, {
    orderId, orderStatus, payNowTotal,
    lineItems: lineItemsOut.map((li) => ({ lineItemId: li.lineItemId, type: li.type, status: li.status, amount: li.amount })),
  });
};

// Verifies a Bearer token IF one was sent; returns null (guest) on any
// absence/failure rather than throwing — see the header note on why a
// missing/invalid token must never block checkout.
async function tryGetSub(event) {
  if (!verifier) return null;
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  try {
    const payload = await verifier.verify(token);
    return payload.sub || null;
  } catch (err) {
    console.warn("createOrder: ignoring unverifiable token, proceeding as guest:", err.message);
    return null;
  }
}

function addBusinessDays(fromIso, days) {
  const d = new Date(fromIso);
  let remaining = days;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) remaining--;
  }
  return d.toISOString();
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
