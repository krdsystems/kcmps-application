/* ============================================================
   KCMPS staff API — the idle-screen PIN (one Lambda, four routes)
   ============================================================
     GET    /staff/pin         -> { pinSet }
     PUT    /staff/pin         -> set/replace the PIN   (body: { pin })
     DELETE /staff/pin         -> remove the PIN
     POST   /staff/pin/verify  -> { ok, ... }           (body: { pin })

   Server side of dashboard-shell.js's SESSION_GUARD idle privacy
   screen. One Lambda with a method/path branch rather than four
   functions — same precedent as verify-payment.js serving both
   /verify-payment and /set-on-hold.

   THREAT MODEL (be honest — see lib/pin.js's header for the long form):
   this defends against a passer-by at an unattended screen and against
   the old client-side scheme, where the salt+SHA-256 sat in
   localStorage and fell to offline brute force instantly. It is NOT a
   defence against the authenticated staffer themselves — the Cognito
   JWT this route's authorizer verifies is the real boundary, and
   someone with devtools can still remove the overlay DOM and read what
   the page already loaded. What they can never do any more is learn,
   extract, or online-brute-force the PIN.

   Identity: the record key is ALWAYS the verified JWT's claims.sub
   (extractClaims on the authorizer-populated event) — a sub in the
   request body is ignored by construction, so no staffer can touch
   another's PIN record.

   Rate limiting (the part that makes a 4-6 digit PIN survivable
   online): attempt counting + exponential lockout live ON THE RECORD
   (failedCount / lockedUntil), not in Lambda memory — instances don't
   share memory and are recycled. The wrong-attempt increment is an
   atomic ADD (two racing guesses both count), the lock check runs
   BEFORE the scrypt compare, and a locked record returns 429 without
   ever evaluating the guess. Schedule: 4 free wrong attempts, the 5th
   locks 30 s, doubling per subsequent wrong attempt, capped 15 min —
   lib/pin.js's lockDurationMs(), unit-tested in pin.test.js.

   Storage: PK USER#<sub> / SK "PIN" (lib/keys.js's userPk/staffPinSk).
   scrypt N=16384,r=8,p=1 with per-set random salt; params stored on the
   record so they can be raised later without invalidating old PINs.
   DELETE soft-deletes (deleted: true, per this repo's convention) but
   REMOVEs salt/hash outright — a credential hash for a removed PIN is
   pure liability, and set/clear each append an EVENT# audit item under
   the same PK. buildEvent() (lib/events.js) is order-shaped (requires
   orderId/lineItemId), so these audit items are built inline with the
   same tenant/schema stamps instead of forcing that helper to lie.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { userPk, staffPinSk, extractClaims, isStaff, baseItem } = require("../lib");
const { SITE_ID, SCHEMA_VERSION } = require("../lib/constants");
const pinLib = require("../lib/pin");

const TABLE = process.env.TABLE_NAME;

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims || !claims.sub) return response(401, { error: "Unauthorized" });
  // Any dashboard-capable group — the PIN gates the dashboard's idle
  // screen, so eligibility is exactly "may open the dashboard" (isStaff),
  // not one of the finer write-capability roles.
  if (!isStaff(claims)) return response(403, { error: "Forbidden" });

  const method = event.requestContext?.http?.method || "";
  const path = event.rawPath || "";
  const isVerify = path.endsWith("/verify");

  try {
    if (method === "POST" && isVerify) return await handleVerify(claims, event);
    if (isVerify) return response(404, { error: "Not found" });
    if (method === "GET") return await handleStatus(claims);
    if (method === "PUT") return await handleSet(claims, event);
    if (method === "DELETE") return await handleClear(claims);
    return response(404, { error: "Not found" });
  } catch (err) {
    console.error("staff-pin error:", err);
    return response(500, { error: "Something went wrong. Please try again." });
  }
};

async function loadRecord(sub) {
  const res = await client.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: userPk(sub), SK: staffPinSk() },
  }));
  const item = res.Item;
  if (!item || item.deleted || !item.salt || !item.hash) return null;
  return item;
}

async function handleStatus(claims) {
  const record = await loadRecord(claims.sub);
  return response(200, { pinSet: !!record });
}

async function handleSet(claims, event) {
  const body = parseBody(event);
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  if (!pinLib.isValidPin(pin)) {
    return response(400, { error: "PIN must be 4-6 digits." });
  }
  const fields = await pinLib.newPinFields(pin);
  const now = new Date().toISOString();
  await client.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...baseItem({ status: "Active" }),
      PK: userPk(claims.sub),
      SK: staffPinSk(),
      ...fields,          // salt, hash, scryptParams
      failedCount: 0,
      lockedUntil: null,
    },
  }));
  await appendAudit(claims, "PIN set", now);
  return response(200, { pinSet: true });
}

async function handleClear(claims) {
  const now = new Date().toISOString();
  // Soft-delete the record but REMOVE the credential material — keeping
  // a hash of a "removed" PIN around would only ever help an attacker.
  await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: userPk(claims.sub), SK: staffPinSk() },
    UpdateExpression: "SET deleted = :true, updatedAt = :now, failedCount = :zero, lockedUntil = :null REMOVE salt, #h, scryptParams",
    ExpressionAttributeNames: { "#h": "hash" },
    ExpressionAttributeValues: { ":true": true, ":now": now, ":zero": 0, ":null": null },
  }));
  await appendAudit(claims, "PIN removed", now);
  return response(200, { pinSet: false });
}

async function handleVerify(claims, event) {
  const body = parseBody(event);
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";

  const record = await loadRecord(claims.sub);
  // No PIN on file: nothing to verify. ok:true would be misleading —
  // the client treats pinSet:false as "unlock, and refresh your cached
  // status" (dashboard-data.js's verifyStaffPin).
  if (!record) return response(200, { ok: false, pinSet: false });

  // Lock check comes BEFORE the guess is ever evaluated.
  const lock = pinLib.lockoutState(record);
  if (lock.locked) return lockedResponse(lock.retryAfterMs);

  if (await pinLib.verifyPin(pin, record)) {
    // Correct — reset the counter so old failures don't haunt the next slip.
    if (record.failedCount || record.lockedUntil) {
      await client.send(new UpdateCommand({
        TableName: TABLE,
        Key: { PK: userPk(claims.sub), SK: staffPinSk() },
        UpdateExpression: "SET failedCount = :zero, lockedUntil = :null, updatedAt = :now",
        ExpressionAttributeValues: { ":zero": 0, ":null": null, ":now": new Date().toISOString() },
      }));
    }
    return response(200, { ok: true, pinSet: true });
  }

  // Wrong — atomic increment (racing guesses both count), then apply
  // whatever lock the NEW cumulative count earns.
  const inc = await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: userPk(claims.sub), SK: staffPinSk() },
    UpdateExpression: "ADD failedCount :one SET updatedAt = :now",
    ExpressionAttributeValues: { ":one": 1, ":now": new Date().toISOString() },
    ReturnValues: "ALL_NEW",
  }));
  const failedCount = (inc.Attributes && inc.Attributes.failedCount) || 0;
  const lockMs = pinLib.lockDurationMs(failedCount);
  if (lockMs > 0) {
    const lockedUntil = new Date(Date.now() + lockMs).toISOString();
    await client.send(new UpdateCommand({
      TableName: TABLE,
      Key: { PK: userPk(claims.sub), SK: staffPinSk() },
      UpdateExpression: "SET lockedUntil = :until",
      ExpressionAttributeValues: { ":until": lockedUntil },
    }));
    return lockedResponse(lockMs);
  }
  return response(200, { ok: false, pinSet: true });
}

function lockedResponse(retryAfterMs) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return response(429, {
    ok: false,
    locked: true,
    retryAfterSeconds,
    error: `Too many wrong attempts — try again in ${retryAfterSeconds}s, or log out.`,
  });
}

// Append-only audit item under the same USER# partition. Inline (not
// lib/events.js's buildEvent, which is order-shaped) — same
// tenant/schema stamps, see the header.
async function appendAudit(claims, action, at) {
  await client.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: userPk(claims.sub),
      SK: `EVENT#${at}#PIN`,
      tenantId: SITE_ID,
      siteId: SITE_ID,
      schemaVersion: SCHEMA_VERSION,
      to: action,
      actorSub: claims.sub,
      actorName: claims.name || claims.email || null,
      at,
      meta: {},
    },
  }));
}

function parseBody(event) {
  try { return JSON.parse(event.body || "{}"); } catch { return {}; }
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
