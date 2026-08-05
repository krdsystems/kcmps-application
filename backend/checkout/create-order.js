/* ============================================================
   KCMPS Checkout (Module 1 — Sales & Order) — POST /orders
   ============================================================
   The Lambda `docs/roadmap.md` 1.1 calls out as missing: "New
   customer-facing Lambda createOrder ... Splits the cart: writes
   ORDER#<id> META + one LINEITEM#<id> per line; sku items -> Order
   Placed, custom items -> Quoted." sku items start at Order Placed, NOT
   Pending Payment Verification — the customer hasn't submitted any GCash
   proof yet at this point, so tagging them as "pending verification"
   before there's anything to verify misrepresents the state machine.
   submit-payment-proof.js is the only place that ever writes Pending
   Payment Verification, once real proof exists.

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

const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const { STATUS, baseItem, buildEvent, orderPk, metaSk, lineItemSk, idempotencyPk, activeStatusAttrs, deriveOrderStatus, MAX_UPLOADS_PER_ORDER } = require("../lib");

const TABLE = process.env.TABLE_NAME;
// Only used to validate the shape of design-file refs the client sends
// back (see normalizeDesignFiles) — this Lambda never touches S3 itself.
const UPLOADS_BUCKET = process.env.UPLOADS_BUCKET;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;
// Same FROM_EMAIL gate as submit-payment-proof.js/verify-payment.js — unset
// disables sending entirely, best-effort, never blocks the actual checkout.
const FROM_EMAIL = process.env.FROM_EMAIL;
const ses = new SESClient({});
// 1 order + 2 items/line (LINEITEM# + EVENT#) + 1 optional idempotency
// record must stay under TransactWriteItems' hard 100-item ceiling.
const MAX_CART_LINES = 45;
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

  const { customerName, fulfillment, shipping, notes, cart } = body;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const messenger = typeof body.messenger === "string" ? body.messenger.trim() : "";
  const otherContact = typeof body.otherContact === "string" ? body.otherContact.trim() : "";
  if (!customerName) {
    return response(400, { error: "customerName is required" });
  }
  if (!email && !phone && !messenger && !otherContact) {
    return response(400, { error: "At least one contact method (email, phone, messenger, or other) is required" });
  }
  if (!Array.isArray(cart) || !cart.length) {
    return response(400, { error: "cart must be a non-empty array" });
  }
  if (cart.length > MAX_CART_LINES) {
    return response(400, { error: `A single order can have at most ${MAX_CART_LINES} line items — please split this into more than one order.` });
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

  // Design files the customer attached at checkout (upload-design-file.js
  // already presigned + uploaded them; these are just the resulting refs).
  // Order-level, alongside `notes` — the checkout upload zone sits next to
  // the notes textarea and isn't scoped to one cart line, unlike the
  // per-line designRef/designName that a pre-made-design pick carries.
  const designFiles = normalizeDesignFiles(body.designFiles);
  if (designFiles === null) {
    return response(400, { error: `designFiles must be an array of at most ${MAX_UPLOADS_PER_ORDER} uploaded file references` });
  }

  // Optional — the storefront generates one per checkout attempt and
  // resends the same value on a retry (e.g. after a network error or a
  // lost response), so a customer clicking "Place order" twice on the
  // same cart can't create two orders for one GCash payment. Absent for
  // any caller that doesn't send it (curl, an older cached bundle) — the
  // ConditionExpression on the order Put below still guards against a
  // raw orderId collision either way.
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim().slice(0, 100) : null;
  if (idempotencyKey) {
    const existing = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { PK: idempotencyPk(idempotencyKey), SK: metaSk() } }));
    if (existing.Item) return response(200, existing.Item.response);
  }

  const customerSub = await tryGetSub(event);
  const now = new Date().toISOString();
  // 10 hex chars off a real UUID (40 bits) — the prior 6-char base36
  // Math.random() id (~31 bits, non-cryptographic) needs the
  // ConditionExpression below as a backstop; this widens the space so
  // that backstop should in practice never actually fire.
  const orderId = "ORD-" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
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

    const status = type === "custom" ? STATUS.QUOTED : STATUS.ORDER_PLACED;
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
    orderId, customerSub, customerName,
    email: email || null, phone: phone || null, messenger: messenger || null, otherContact: otherContact || null,
    fulfillment: isDelivery ? "Delivery" : "Pickup",
    shipping: isDelivery ? { courier: shipping.courier, address: shipping.address, landmark: shipping.landmark || null } : null,
    orderStatus, originalPromisedDate,
    payment: null, // submitPaymentProof.js attaches this once the customer submits GCash proof
    designFiles,
    correspondenceLog: [],
  };
  // attribute_not_exists(PK) is a backstop against the (now vanishingly
  // unlikely, but not impossible) orderId collision above silently
  // overwriting an existing order's META in place.
  transactItems.unshift({ Put: { TableName: TABLE, Item: orderItem, ConditionExpression: "attribute_not_exists(PK)" } });

  const responseBody = {
    orderId, orderStatus, payNowTotal,
    lineItems: lineItemsOut.map((li) => ({ lineItemId: li.lineItemId, type: li.type, status: li.status, amount: li.amount })),
  };

  // Index of the idempotency Put within transactItems, if present — used
  // below to tell "this exact retry already succeeded" apart from a
  // genuine orderId collision when the transaction is cancelled.
  let idempotencyItemIndex = -1;
  if (idempotencyKey) {
    idempotencyItemIndex = transactItems.length;
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: { PK: idempotencyPk(idempotencyKey), SK: metaSk(), orderId, createdAt: now, response: responseBody },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
  }

  let conflict = false;
  let conflictReasons = [];
  await dynamo.send(new TransactWriteCommand({ TransactItems: transactItems })).catch((err) => {
    if (err.name === "TransactionCanceledException") { conflict = true; conflictReasons = err.CancellationReasons || []; return; }
    throw err;
  });
  if (conflict) {
    // A concurrent duplicate of this exact retry won the race and
    // already committed — the idempotency Put is the one that failed
    // its condition, not the order Put. Return its cached response
    // instead of a spurious conflict.
    if (idempotencyItemIndex >= 0 && conflictReasons[idempotencyItemIndex]?.Code === "ConditionalCheckFailed") {
      const existing = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { PK: idempotencyPk(idempotencyKey), SK: metaSk() } }));
      if (existing.Item) return response(200, existing.Item.response);
    }
    return response(409, { error: "Could not create the order — please retry." });
  }

  // First of the 4 happy-path customer notifications (Order Placed ->
  // Payment Confirm [verify-payment.js] -> Ready to ship out / Shipped out
  // or Pickup ready [advance-line-item.js]). Order-level, not per-line-item
  // — fires once per checkout regardless of how many lines/types are in
  // the cart, since from the customer's view they placed one order.
  if (FROM_EMAIL && email) {
    await sendOrderPlacedEmail({ customerName, email }, orderId).catch((err) => {
      console.error("createOrder: SES send failed (order placed):", err.message);
    });
  }

  return response(201, responseBody);
};

async function sendOrderPlacedEmail(order, orderId) {
  await ses.send(new SendEmailCommand({
    Source: FROM_EMAIL,
    // Bcc admin@kcmps.com — same "the Bcc is the sent-log" reasoning as
    // submit-payment-proof.js, so dashboard/email.html sees this too.
    Destination: { ToAddresses: [order.email], BccAddresses: ["admin@kcmps.com"] },
    Message: {
      Subject: { Data: `Order ${orderId} placed` },
      Body: { Text: { Data:
        `Hi ${order.customerName},\n\n` +
        `Thanks for your order — ${orderId} has been placed. We'll email you again once payment is confirmed.\n\n` +
        `— KCMPS`
      } },
    },
  }));
  // Surfaces in job-detail.html's "Customer correspondence" card so staff
  // can see at a glance that this touchpoint's email actually went out —
  // best-effort and separate from the send above (a log-write failure
  // must never look like the email itself failed).
  await logCorrespondence(orderPk(orderId), "Emailed customer: order placed").catch((err) => {
    console.error("createOrder: correspondence log failed:", err.message);
  });
}

async function logCorrespondence(pk, note) {
  await dynamo.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk, SK: metaSk() },
    UpdateExpression: "SET correspondenceLog = list_append(correspondenceLog, :entry)",
    ExpressionAttributeValues: { ":entry": [{ at: new Date().toISOString(), note, actorName: "System (auto-email)" }] },
  }));
}

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

// Design-file refs arrive from the client after upload-design-file.js
// presigned them — but this endpoint is public and guest-friendly, so the
// refs themselves are attacker-controlled input like everything else in
// the body. Returns a sanitized array, or null if the input is malformed
// (caller turns that into a 400).
//
// The `design-uploads/` prefix check is the load-bearing one: without it a
// caller could attach `s3://<uploads-bucket>/payments/<someone-else>.jpg`
// to their own throwaway order and have staff-api/get-orders.js happily
// presign a GET for another customer's GCash payment proof. Uploads and
// payment screenshots share one bucket, so the prefix is the only thing
// separating them. Same reason the bucket name must match ours exactly —
// a foreign `s3://attacker-bucket/...` ref would otherwise be presigned
// (and fail confusingly) or, worse, point staff at content we don't own.
function normalizeDesignFiles(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) return null;
  if (input.length > MAX_UPLOADS_PER_ORDER) return null;

  const expectedPrefix = `s3://${UPLOADS_BUCKET}/design-uploads/`;
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const ref = typeof raw.ref === "string" ? raw.ref.trim() : "";
    if (!ref.startsWith(expectedPrefix)) return null;
    // No traversal segments past the prefix, and a plain single-segment key.
    const keyTail = ref.slice(expectedPrefix.length);
    if (!/^[A-Za-z0-9._-]+$/.test(keyTail)) return null;

    out.push({
      ref,
      // Display-only. Re-sanitized here rather than trusted from the
      // client's echo of what upload-design-file.js returned, and escaped
      // again at render time by job-detail.html's escapeHtml().
      filename: typeof raw.filename === "string"
        ? raw.filename.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[/\\]/g, "_").trim().slice(0, 150) || "design-file"
        : "design-file",
      contentType: typeof raw.contentType === "string" ? raw.contentType.slice(0, 120) : "",
      size: Number.isFinite(Number(raw.size)) ? Math.max(0, Math.floor(Number(raw.size))) : null,
      uploadedAt: new Date().toISOString(),
    });
  }
  return out;
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
