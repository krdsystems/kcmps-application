/* ============================================================
   KCMPS backend — base item stamp
   ============================================================
   Every item written to the table goes through baseItem() first so the
   ERP's launch-blocking conventions (ERP_System_Project_Knowledge.md
   §2.3) are applied by construction, not by remembering to add them on
   every write path:
     - tenantId / siteId  — reserved multi-site dimension, one value today
     - schemaVersion       — lets records evolve without a big-bang migration
     - createdAt / updatedAt — ISO-8601 timestamps
     - deleted: false      — soft-delete only, never hard-delete

   Usage — callers spread their own PK/SK and item-specific fields on top:

     const orderItem = {
       ...baseItem({ status: STATUS.QUOTED }),
       PK: orderPk(orderId),
       SK: metaSk(),
       customerSub,
     };
   ============================================================ */

const { SITE_ID, SCHEMA_VERSION } = require("./constants");

function baseItem({ status, createdAt } = {}) {
  const now = new Date().toISOString();
  return {
    tenantId: SITE_ID,
    siteId: SITE_ID,
    schemaVersion: SCHEMA_VERSION,
    createdAt: createdAt || now,
    updatedAt: now,
    status,
    deleted: false,
  };
}

module.exports = { baseItem };
