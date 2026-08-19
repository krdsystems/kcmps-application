/* ============================================================
   KCMPS staff API — production stations config
   ============================================================
     GET /stations  -> { stations: [...] }   any staffer (isStaff)
     PUT /stations  -> { stations: [...] }   Admin only

   ONE item: PK: CONFIG#STATIONS, SK: META (keys.js's configPk()/metaSk()),
   the same shape business-hours.js's CONFIG#OPERATING_HOURS uses. Absent
   item = backend/lib/stations.js's DEFAULT_STATIONS, so introducing this
   route needed no migration and no backfill: every existing station id
   keeps resolving from the default list until someone saves in Settings.

   ---- Why the read is looser than the write ----

   Every staffer needs to READ the list — it populates the station picker
   on job-detail.html's Confirmed -> Scheduled and Scheduled -> In
   Production transitions, which Production staff perform constantly. So
   GET is isStaff(), matching get-orders.js.

   Writing is Admin-only (owner's call, 2026-08-19). Retiring a station
   silently removes it from every scheduler's picker and changes the Week
   view's capacity denominator — a shop-wide configuration change, not a
   per-staffer preference, so it sits with the other Admin-gated writes
   rather than the dashboard-prefs.js tier.

   ---- The invariant this route exists to protect ----

   Station ids are already written onto line items AND stamped into
   append-only EVENT# audit records by advance-line-item.js. They are
   therefore create-only: validateStationsPayload() refuses to drop or
   rename an existing id and makes callers express removal as
   `retired: true` instead. See lib/stations.js's header for the full
   reasoning — do not relax that check here.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { configPk, metaSk, eventSk, extractClaims, isStaff, requireRole, ROLES, baseItem } = require("../lib");
const { normalizeStations, validateStationsPayload } = require("../lib/stations");

const TABLE = process.env.TABLE_NAME;
const CONFIG_ID = "STATIONS";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims || !claims.sub) return response(401, { error: "Unauthorized" });
  if (!isStaff(claims)) return response(403, { error: "Forbidden" });

  const method = event.requestContext?.http?.method || "";

  try {
    if (method === "GET") return await handleGet();
    if (method === "PUT") {
      // requireRole returns null when ALLOWED, a 403-shaped object when not.
      if (requireRole(claims, [ROLES.ADMIN])) {
        return response(403, { error: "Only an admin can change stations." });
      }
      return await handlePut(claims, event);
    }
    return response(404, { error: "Not found" });
  } catch (err) {
    console.error("stations error:", err);
    return response(500, { error: "Something went wrong. Please try again." });
  }
};

async function readStored() {
  const res = await client.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: configPk(CONFIG_ID), SK: metaSk() },
  }));
  const item = res.Item;
  return {
    prior: item && !item.deleted ? item.stations : null,
    createdAt: item && item.createdAt,
  };
}

async function handleGet() {
  const { prior } = await readStored();
  // normalizeStations() is what makes a missing OR malformed config item a
  // non-event — the picker always receives a usable list.
  return response(200, { stations: normalizeStations(prior) });
}

async function handlePut(claims, event) {
  const body = parseBody(event);
  const { prior, createdAt } = await readStored();

  const check = validateStationsPayload(body.stations, prior);
  if (!check.ok) return response(400, { error: check.error });

  const at = new Date().toISOString();

  await client.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...baseItem({ status: "Active", createdAt }),
      PK: configPk(CONFIG_ID),
      SK: metaSk(),
      stations: check.stations,
      updatedBy: claims.sub,
      updatedByName: claims.name || claims.email || claims["cognito:username"] || null,
    },
  }));

  // Audit record, same EVENT#<ISO>#<suffix> convention orders and the
  // staff PIN use. A shop-wide setting change should be answerable later
  // with "who retired that station, and when" — the config item itself
  // only carries the latest writer.
  await client.send(new PutCommand({
    TableName: TABLE,
    Item: {
      ...baseItem({ status: "Active" }),
      PK: configPk(CONFIG_ID),
      SK: eventSk(at, "STATIONS"),
      actorSub: claims.sub,
      actorName: claims.name || claims.email || claims["cognito:username"] || null,
      at,
      stations: check.stations,
    },
  }));

  return response(200, { stations: check.stations });
}

function parseBody(event) {
  try { return JSON.parse(event.body || "{}"); } catch { return {}; }
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
