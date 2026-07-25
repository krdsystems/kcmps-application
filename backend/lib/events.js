/* ============================================================
   KCMPS backend — append-only event record builder
   ============================================================
   Shape matches ops-dashboard/infra/backend-infra-to-deploy.md §2.2
   (Part 5.2 of the Ops Dashboard Project Knowledge file) EXACTLY:

     {
       "PK": "ORDER#1234",
       "SK": "EVENT#2026-07-24T09:14:00Z#L2",
       "lineItemId": "L2",
       "from": "Scheduled",
       "to": "In Production",
       "actorSub": "<cognito-sub>",
       "station": "PRESS-01",
       "at": "2026-07-24T09:14:00Z",
       "meta": { "setupMinutes": 22 }
     }

   Pure function — building the record is separate from writing it, so a
   caller can put this alongside a line-item Update inside one
   TransactWriteItems call (see api-advance-line-item.js's pattern) instead
   of this module reaching into the DynamoDB client itself.
   ============================================================ */

const { orderPk, eventSk } = require("./keys");

function buildEvent({ orderId, lineItemId, from, to, actorSub, actorName, station, meta, at }) {
  if (!orderId || !lineItemId || !to) {
    throw new TypeError("buildEvent requires orderId, lineItemId, and to");
  }
  const ts = at || new Date().toISOString();
  return {
    PK: orderPk(orderId),
    SK: eventSk(ts, lineItemId),
    lineItemId,
    from: from || null,
    to,
    actorSub: actorSub || null,
    actorName: actorName || null,
    station: station || null,
    at: ts,
    meta: meta || {},
  };
}

module.exports = { buildEvent };
