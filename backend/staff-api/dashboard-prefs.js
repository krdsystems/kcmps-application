/* ============================================================
   KCMPS staff API — per-staffer dashboard UI preferences
   ============================================================
     GET   /staff/prefs  -> { data: {...} }   (empty object if none set)
     PATCH /staff/prefs  -> shallow-merge      (body: { data: {...partial} })

   Small generic key-value blob for UI-only preferences that should
   follow a staffer across devices (server-side, not localStorage) —
   first consumer is jobs.html's draggable column order. Same
   USER#<sub>-keyed pattern as staff-pin.js (see that file's header for
   the "identity is always the verified JWT sub" reasoning, which
   applies identically here), sibling SK so one GetItem-per-page-load
   habit doesn't turn into a growing list of per-feature Lambdas.

   PATCH is a shallow merge, not a replace — one feature's prefs write
   must never clobber another's. No allowlist of keys: this is UI
   preference storage, not a security boundary, so any staffer can
   stash any JSON-serializable value here for their own account. The
   only guard is a total-size cap (defense in depth against someone
   using this as a scratch data store, not a real threat model).
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { userPk, staffPrefsSk, extractClaims, isStaff, baseItem } = require("../lib");

const TABLE = process.env.TABLE_NAME;
const MAX_BYTES = 8 * 1024; // generous for UI prefs, well under the 400KB item cap

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims || !claims.sub) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Forbidden" });

  const method = event.requestContext?.http?.method || "";

  try {
    if (method === "GET") return await handleGet(claims);
    if (method === "PATCH") return await handlePatch(claims, event);
    return response(404, { error: "Not found" });
  } catch (err) {
    console.error("dashboard-prefs error:", err);
    return response(500, { error: "Something went wrong. Please try again." });
  }
};

async function handleGet(claims) {
  const res = await client.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: userPk(claims.sub), SK: staffPrefsSk() },
  }));
  const item = res.Item;
  return response(200, { data: (item && !item.deleted && item.data) || {} });
}

async function handlePatch(claims, event) {
  const body = parseBody(event);
  if (!isPlainObject(body.data)) {
    return response(400, { error: "data must be an object" });
  }

  const existing = await client.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: userPk(claims.sub), SK: staffPrefsSk() },
  }));
  const prior = existing.Item;
  const current = (prior && !prior.deleted && prior.data) || {};
  const merged = { ...current, ...body.data };

  if (Buffer.byteLength(JSON.stringify(merged), "utf8") > MAX_BYTES) {
    return response(400, { error: "Preferences payload too large" });
  }

  await client.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...baseItem({ status: "Active", createdAt: prior && prior.createdAt }),
      PK: userPk(claims.sub),
      SK: staffPrefsSk(),
      data: merged,
    },
  }));

  return response(200, { data: merged });
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseBody(event) {
  try { return JSON.parse(event.body || "{}"); } catch { return {}; }
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
