/* ============================================================
   KCMPS Asset Library — PATCH /assets/{id} (patchDesign)
   ============================================================
   (Formerly the Design Library's PATCH /designs/{id} — the feature was
   renamed Asset Library 2026-08-07; DynamoDB's DESIGN# key prefix and the
   S3 designs/ object prefix deliberately keep their old names, see
   docs/asset-library-rebuild-plan-2026-08-06.md §5.)

   One handler for every metadata/state edit an asset can undergo after
   it's been created by publish-design.js (POST /assets):

     - metadata edit:  name / description / tags
     - archive:        soft delete; a pending_approval asset loses its
                       queue slot and its collected approvals
     - restore:        back to draft or published (pending never restores
                       to pending — it re-enters via a fresh submit)
     - submit:         draft -> pending_approval. Scan-clean is a
                       PRECONDITION of entering the queue (409 stillScanning
                       otherwise) — an admin must never approve something
                       the scanner could still veto. If the submitter is
                       themselves an Admin, submitting IS their sign-off
                       (recorded as an approve event `via: "submit"`), and
                       with a single-admin group that publishes immediately.
     - approve:        Admin-only. The approver set is ALL CURRENT members
                       of the Cognito Admin group (ListUsersInGroup on
                       every call — never snapshotted; see approval.js).
                       The FINAL approval performs the publish inline:
                       scan re-check -> public-bucket copy -> transactional
                       status flip + EVENT# -> regenerateManifest().
     - reject:         Admin-only veto, reason REQUIRED. Returns the asset
                       to draft and clears every collected approval — an
                       edit after a rejection means everyone re-reviews.
     - publish:        BREAK-GLASS direct publish. Admin-only + mandatory
                       reason, evented with breakGlass: true. Exists for
                       the day one founder is unreachable and stock needs
                       to move; the scan gate still applies in full.

   ── AUTH ───────────────────────────────────────────────────────────
   update/archive/restore/submit: requireRole(Production/Sales/Admin).
   approve/reject/publish: requireRole([ADMIN]) ONLY — the first
   Admin-exclusive writes in this feature and the point of the workflow.
   Never isStaff() anywhere here (Finance is staff but has no business
   writing to the library).

   update on a PUBLISHED asset is Admin-only too (2026-08-07 security
   review fix): approval re-reviews the image, never the name/description/
   tags next to it, so a Production/Sales edit after publish changed public
   storefront copy with zero re-review. handleUpdate() enforces this itself
   (design.status isn't known until after the GetCommand, so it can't be
   folded into the requireRole() call above) via approval.js's
   requiresAdminToEditPublished() — draft/pending_approval/archived are
   unaffected, still open to the normal Production/Sales/Admin write gate.

   ── CONCURRENCY ────────────────────────────────────────────────────
   Two admins approving simultaneously race on a ConditionExpression
   (#status = :pending_approval). The loser re-reads: if the winner's
   approval completed the set the status is already published and the
   loser returns 200 with the current state — one publish, one final
   event, never two.

   ── WHAT THIS NEVER DOES ────────────────────────────────────────────
   No hard delete, ever — that is purge-archived-designs.js's job alone.
   No scan-gate bypass, ever — approve-final and break-glass both run the
   same fail-closed checkVerdict pair as every publish path.
   ============================================================ */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, CopyObjectCommand } = require("@aws-sdk/client-s3");
const { CognitoIdentityProviderClient, ListUsersInGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");
const {
  designPk, metaSk, eventSk, buildEvent,
  extractClaims, getGroups, requireRole, ROLES,
} = require("../lib");
const { parseDesignKey } = require("./design-types");
const { checkVerdict } = require("./scan-verdict");
const { regenerateManifest } = require("./manifest");
const { approvalState, hasApproved, approvalSnapshot, requiresAdminToEditPublished } = require("./approval");

const PUBLIC_IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const TABLE = process.env.TABLE_NAME;
const DESIGN_ORIGINALS_BUCKET = process.env.DESIGN_ORIGINALS_BUCKET;
const PUBLIC_ASSETS_BUCKET = process.env.PUBLIC_ASSETS_BUCKET;
const PUBLIC_ASSETS_KEY_PREFIX = process.env.PUBLIC_ASSETS_KEY_PREFIX || "assets/designs/";
const PUBLIC_ASSETS_PATH = process.env.PUBLIC_ASSETS_PATH || "assets/designs/";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;

const MAX_NAME = 120;
const MAX_DESCRIPTION = 2000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const MAX_REASON = 1000;
const WRITE_ROLES = [ROLES.PRODUCTION, ROLES.SALES, ROLES.ADMIN];
const ADMIN_ONLY = [ROLES.ADMIN];
const ACTIONS = new Set(["update", "archive", "restore", "publish", "submit", "approve", "reject"]);

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  const claims = extractClaims(event);
  if (!claims) return response(401, { error: "Unauthorized" });

  const designId = event.pathParameters && event.pathParameters.id;
  if (!designId) return response(400, { error: "Missing asset id in path" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return response(400, { error: "Invalid JSON body" }); }

  const action = str(body.action) || "update";
  if (!ACTIONS.has(action)) {
    return response(400, { error: `action must be one of: ${[...ACTIONS].join(", ")}` });
  }

  // approve / reject / break-glass publish are Admin-exclusive; everything
  // else takes the standard Production/Sales/Admin write gate.
  const adminAction = action === "approve" || action === "reject" || action === "publish";
  const denied = requireRole(claims, adminAction ? ADMIN_ONLY : WRITE_ROLES);
  if (denied) {
    return response(403, {
      error: adminAction
        ? "Forbidden — approving, rejecting or force-publishing an asset requires the Admin role."
        : "Forbidden — editing assets requires the Production, Sales or Admin role.",
      requiredRoles: denied.requiredRoles,
    });
  }

  const pk = designPk(designId);
  const existing = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  if (!existing.Item) return response(404, { error: "Asset not found" });
  const design = existing.Item;

  const actor = {
    sub: claims.sub,
    name: claims.name || claims.email || null,
    isAdmin: getGroups(claims).includes(ROLES.ADMIN),
  };
  const now = new Date().toISOString();

  if (action === "archive") return handleArchive(design, pk, actor, now);
  if (action === "restore") return handleRestore(design, pk, actor, now);
  if (action === "submit") return handleSubmit(design, pk, actor, now);
  if (action === "approve") return handleApprove(design, pk, actor, now);
  if (action === "reject") return handleReject(design, pk, body, actor, now);
  if (action === "publish") return handleBreakGlassPublish(design, pk, body, actor, now);
  return handleUpdate(design, pk, body, actor, now);
};

// ---- metadata-only edit: name / description / tags. Never touches
// status/deletedAt/approvals/S3 — those go through the dedicated actions
// above so each state transition has exactly one code path. ----
async function handleUpdate(design, pk, body, actor, now) {
  if (requiresAdminToEditPublished(design.status, actor.isAdmin)) {
    return response(403, {
      error: "Published assets can only be edited by Admin — re-submit for approval if this needs a content change.",
    });
  }

  const sets = [];
  const names = {};
  const values = {};

  if (body.name !== undefined) {
    const name = str(body.name).slice(0, MAX_NAME);
    if (!name) return response(400, { error: "name cannot be empty" });
    sets.push("#name = :name"); names["#name"] = "name"; values[":name"] = name;
  }
  if (body.description !== undefined) {
    sets.push("description = :description"); values[":description"] = str(body.description).slice(0, MAX_DESCRIPTION);
  }
  if (body.tags !== undefined) {
    const tags = normalizeTags(body.tags);
    if (tags === null) return response(400, { error: `tags must be an array of at most ${MAX_TAGS} strings, each ${MAX_TAG_LENGTH} characters or fewer` });
    sets.push("tags = :tags"); values[":tags"] = tags;
  }
  if (!sets.length) return response(400, { error: "Nothing to update — provide name, description, and/or tags" });

  sets.push("updatedAt = :now"); values[":now"] = now;

  const res = await client.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: pk, SK: metaSk() },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
    ExpressionAttributeValues: values,
    ReturnValues: "ALL_NEW",
  }));

  return response(200, { design: res.Attributes });
}

// ---- archive: soft delete only. A pending_approval asset loses its
// queue slot: collected approvals are cleared so a later restore+resubmit
// starts a fresh review rather than resurrecting stale sign-offs. ----
async function handleArchive(design, pk, actor, now) {
  if (design.status === "archived") return response(200, { design });

  const auditEvent = buildDesignEvent(pk, design.designId, design.status, "archived", actor, now, { reason: "archived via dashboard" });
  const wasPending = design.status === "pending_approval";

  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: pk, SK: metaSk() },
          // Remember what the status was before archiving so restore()
          // can put it back (published stays published; draft and
          // pending_approval both come back as draft).
          UpdateExpression: "SET preArchiveStatus = #status, #status = :archived, deletedAt = :now, updatedAt = :now"
            + (wasPending ? " REMOVE approvals, approvalSnapshot, submittedAt, submittedBy, submittedByName" : ""),
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":archived": "archived", ":now": now },
        },
      },
      { Put: { TableName: TABLE, Item: auditEvent } },
    ],
  }));

  let manifest = null;
  if (design.status === "published") {
    manifest = await regenerateManifest({
      tableName: TABLE, bucket: PUBLIC_ASSETS_BUCKET,
      keyPrefix: PUBLIC_ASSETS_KEY_PREFIX, publicPrefix: PUBLIC_ASSETS_PATH,
    });
  }

  return response(200, {
    design: { ...design, status: "archived", preArchiveStatus: design.status, deletedAt: now, updatedAt: now },
    manifest: manifest ? { key: manifest.key, count: manifest.count } : null,
  });
}

// ---- restore: clears the archive. published comes back published (its
// public S3 object was never touched); everything else — including a
// formerly pending_approval asset — comes back as a plain draft. ----
async function handleRestore(design, pk, actor, now) {
  if (design.status !== "archived") return response(200, { design });

  const restoredStatus = design.preArchiveStatus === "published" ? "published" : "draft";
  const auditEvent = buildDesignEvent(pk, design.designId, "archived", restoredStatus, actor, now, { reason: "restored from recycle bin" });

  await client.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: TABLE,
          Key: { PK: pk, SK: metaSk() },
          UpdateExpression: "SET #status = :status, updatedAt = :now REMOVE deletedAt, preArchiveStatus",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":status": restoredStatus, ":now": now },
        },
      },
      { Put: { TableName: TABLE, Item: auditEvent } },
    ],
  }));

  let manifest = null;
  if (restoredStatus === "published") {
    manifest = await regenerateManifest({
      tableName: TABLE, bucket: PUBLIC_ASSETS_BUCKET,
      keyPrefix: PUBLIC_ASSETS_KEY_PREFIX, publicPrefix: PUBLIC_ASSETS_PATH,
    });
  }

  const { deletedAt, preArchiveStatus, ...rest } = design;
  return response(200, {
    design: { ...rest, status: restoredStatus, updatedAt: now },
    manifest: manifest ? { key: manifest.key, count: manifest.count } : null,
  });
}

// ---- submit: draft -> pending_approval (or straight to published when
// the submitter is the only Admin — see approval.js's single-admin rule).
// Scan-clean is a precondition of entering the queue. ----
async function handleSubmit(design, pk, actor, now) {
  if (design.status === "pending_approval") return response(200, { design }); // idempotent re-click
  if (design.status !== "draft") {
    return response(409, { error: `Only a draft can be submitted for approval (this asset is ${design.status}).` });
  }

  const gate = await scanGate(design);
  if (gate) return gate;

  const admins = await listAdminUsers();
  if (!admins.length) {
    // Fail closed: an empty Admin group must never mean "nobody has to
    // approve". This is a misconfiguration to surface, not a fast path.
    return response(409, { error: "No Admin users found in the user pool — cannot submit for approval. Check the Cognito Admin group." });
  }

  const approvals = {};
  const events = [buildDesignEvent(pk, design.designId, "draft", "pending_approval", actor, now, {})];
  if (actor.isAdmin) {
    // Submitting IS the submitter-admin's sign-off; recording it explicitly
    // means with two founders one other click publishes, and with one
    // founder the submit publishes immediately.
    approvals[actor.sub] = { name: actor.name, at: now, via: "submit" };
    const st = approvalState(approvals, admins);
    events.push(buildDesignEvent(pk, design.designId, "pending_approval", "pending_approval", actor, plusMs(now, 1), {
      action: "approve", via: "submit", approvedCount: st.approvedCount, requiredCount: st.requiredCount,
    }));
  }

  const state = approvalState(approvals, admins);
  if (state.complete) {
    // Single-admin group and the submitter is that admin: publish inline.
    return finalizePublish(design, pk, actor, now, {
      approvals, admins, priorStatus: "draft", extraEvents: events,
      finalEventMeta: { action: "approve", via: "submit", approvedCount: state.approvedCount, requiredCount: state.requiredCount },
    });
  }

  const snapshot = approvalSnapshot(approvals, admins);
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { PK: pk, SK: metaSk() },
            ConditionExpression: "#status = :draft",
            UpdateExpression: "SET #status = :pending, approvals = :approvals, approvalSnapshot = :snapshot, "
              + "submittedAt = :now, submittedBy = :sub, submittedByName = :name, updatedAt = :now REMOVE rejection",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":draft": "draft", ":pending": "pending_approval",
              ":approvals": approvals, ":snapshot": snapshot,
              ":now": now, ":sub": actor.sub, ":name": actor.name,
            },
          },
        },
        ...events.map((e) => ({ Put: { TableName: TABLE, Item: e } })),
      ],
    }));
  } catch (err) {
    if (isConditionFailure(err)) return refetchAndReturn(pk);
    throw err;
  }

  const { rejection, ...rest } = design;
  return response(200, {
    design: {
      ...rest, status: "pending_approval", approvals, approvalSnapshot: snapshot,
      submittedAt: now, submittedBy: actor.sub, submittedByName: actor.name, updatedAt: now,
    },
  });
}

// ---- approve: Admin-only. Records this admin's approval; the approval
// that completes the CURRENT admin set performs the publish inline. ----
async function handleApprove(design, pk, actor, now) {
  if (design.status === "published") return response(200, { design, published: true }); // race loser / re-click
  if (design.status !== "pending_approval") {
    return response(409, { error: `Only an asset awaiting approval can be approved (this asset is ${design.status}).` });
  }

  const admins = await listAdminUsers();
  if (!admins.length) {
    return response(409, { error: "No Admin users found in the user pool — cannot evaluate approvals. Check the Cognito Admin group." });
  }

  const approvals = { ...(design.approvals || {}) };
  const already = hasApproved(approvals, actor.sub);
  if (!already) approvals[actor.sub] = { name: actor.name, at: now };

  const state = approvalState(approvals, admins);

  if (state.complete) {
    return finalizePublish(design, pk, actor, now, {
      approvals, admins, priorStatus: "pending_approval", extraEvents: [],
      finalEventMeta: { action: "approve", approvedCount: state.approvedCount, requiredCount: state.requiredCount },
    });
  }

  if (already) {
    // Idempotent second click by the same admin: nothing new to record.
    return response(200, { design: { ...design, approvalSnapshot: approvalSnapshot(approvals, admins) } });
  }

  const snapshot = approvalSnapshot(approvals, admins);
  const auditEvent = buildDesignEvent(pk, design.designId, "pending_approval", "pending_approval", actor, now, {
    action: "approve", approvedCount: state.approvedCount, requiredCount: state.requiredCount,
  });

  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { PK: pk, SK: metaSk() },
            ConditionExpression: "#status = :pending",
            UpdateExpression: "SET approvals.#sub = :approval, approvalSnapshot = :snapshot, updatedAt = :now",
            ExpressionAttributeNames: { "#status": "status", "#sub": actor.sub },
            ExpressionAttributeValues: {
              ":pending": "pending_approval",
              ":approval": approvals[actor.sub],
              ":snapshot": snapshot,
              ":now": now,
            },
          },
        },
        { Put: { TableName: TABLE, Item: auditEvent } },
      ],
    }));
  } catch (err) {
    if (isConditionFailure(err)) return refetchAndReturn(pk);
    throw err;
  }

  return response(200, {
    design: { ...design, approvals, approvalSnapshot: snapshot, updatedAt: now },
  });
}

// ---- reject: Admin-only veto. Reason required. Back to draft, ALL
// collected approvals cleared — an edit after a rejection means everyone
// re-reviews. ----
async function handleReject(design, pk, body, actor, now) {
  if (design.status !== "pending_approval") {
    return response(409, { error: `Only an asset awaiting approval can be rejected (this asset is ${design.status}).` });
  }
  const reason = str(body.reason).slice(0, MAX_REASON);
  if (!reason) return response(400, { error: "A rejection reason is required." });

  const rejection = { reason, by: actor.sub, byName: actor.name, at: now };
  const auditEvent = buildDesignEvent(pk, design.designId, "pending_approval", "draft", actor, now, { action: "reject", reason });

  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { PK: pk, SK: metaSk() },
            ConditionExpression: "#status = :pending",
            UpdateExpression: "SET #status = :draft, rejection = :rejection, updatedAt = :now "
              + "REMOVE approvals, approvalSnapshot, submittedAt, submittedBy, submittedByName",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":pending": "pending_approval", ":draft": "draft", ":rejection": rejection, ":now": now },
          },
        },
        { Put: { TableName: TABLE, Item: auditEvent } },
      ],
    }));
  } catch (err) {
    if (isConditionFailure(err)) return refetchAndReturn(pk);
    throw err;
  }

  const { approvals, approvalSnapshot: snap, submittedAt, submittedBy, submittedByName, ...rest } = design;
  return response(200, { design: { ...rest, status: "draft", rejection, updatedAt: now } });
}

// ---- break-glass direct publish: Admin-only, mandatory reason, evented
// with breakGlass: true. The scan gate applies in full — break-glass
// skips the OTHER admins, never the scanner. ----
async function handleBreakGlassPublish(design, pk, body, actor, now) {
  if (design.status === "archived") return response(409, { error: "Cannot publish an archived asset — restore it first." });
  if (design.status === "published") return response(200, { design, published: true, manifest: null });
  const reason = str(body.reason).slice(0, MAX_REASON);
  if (!reason) return response(400, { error: "A reason is required to force-publish without the full approval set." });

  return finalizePublish(design, pk, actor, now, {
    approvals: design.approvals || {}, admins: null, priorStatus: design.status, extraEvents: [],
    finalEventMeta: { action: "publish", breakGlass: true, reason },
  });
}

// ---- the ONE publish core, shared by approve-final, single-admin submit
// and break-glass. Same fail-closed scan gate + copy-before-write ordering
// as publish-design.js — do not fork this logic. ----
async function finalizePublish(design, pk, actor, now, { approvals, admins, priorStatus, extraEvents, finalEventMeta }) {
  const gate = await scanGate(design);
  if (gate) return gate;

  const web = parseDesignKey(design.s3KeyWeb, "web");
  if (!web) return response(500, { error: "Asset record has an invalid stored S3 key and cannot be published." });

  // Copy to public BEFORE the DynamoDB write (see publish-design.js's
  // header for the failure-mode reasoning).
  const publicKey = `${PUBLIC_ASSETS_KEY_PREFIX}${design.designId}.${web.ext}`;
  await s3.send(new CopyObjectCommand({
    Bucket: PUBLIC_ASSETS_BUCKET,
    Key: publicKey,
    CopySource: `/${DESIGN_ORIGINALS_BUCKET}/${design.s3KeyWeb}`,
    MetadataDirective: "REPLACE",
    ContentType: contentTypeFor(web.ext),
    CacheControl: PUBLIC_IMAGE_CACHE_CONTROL,
    TaggingDirective: "REPLACE",
    Tagging: "",
  }));

  const snapshot = admins ? approvalSnapshot(approvals, admins) : (design.approvalSnapshot || null);
  const finalEvent = buildDesignEvent(pk, design.designId, priorStatus, "published", actor, plusMs(now, (extraEvents || []).length + 1), finalEventMeta);

  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE,
            Key: { PK: pk, SK: metaSk() },
            ConditionExpression: "#status = :prior",
            UpdateExpression: "SET #status = :published, publishedAt = :now, updatedAt = :now, webExt = :ext, "
              + "approvals = :approvals" + (snapshot ? ", approvalSnapshot = :snapshot" : "") + " REMOVE rejection",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":prior": priorStatus, ":published": "published", ":now": now, ":ext": web.ext,
              ":approvals": approvals, ...(snapshot ? { ":snapshot": snapshot } : {}),
            },
          },
        },
        ...(extraEvents || []).map((e) => ({ Put: { TableName: TABLE, Item: e } })),
        { Put: { TableName: TABLE, Item: finalEvent } },
      ],
    }));
  } catch (err) {
    // Race loser: someone else's final approval already published (or the
    // state moved). Re-read and report the truth instead of failing.
    if (isConditionFailure(err)) return refetchAndReturn(pk);
    throw err;
  }

  const manifest = await regenerateManifest({
    tableName: TABLE, bucket: PUBLIC_ASSETS_BUCKET,
    keyPrefix: PUBLIC_ASSETS_KEY_PREFIX, publicPrefix: PUBLIC_ASSETS_PATH,
  });

  const { rejection, ...rest } = design;
  return response(200, {
    design: {
      ...rest, status: "published", publishedAt: now, updatedAt: now, webExt: web.ext,
      approvals, ...(snapshot ? { approvalSnapshot: snapshot } : {}),
    },
    published: true,
    manifest: { key: manifest.key, count: manifest.count },
  });
}

// The same fail-closed pair every publish path gates on. Returns a 409
// response when either file is not verifiably clean, else null.
async function scanGate(design) {
  const [ov, wv] = await Promise.all([
    checkVerdict(TABLE, design.originalRef),
    checkVerdict(TABLE, design.webRef),
  ]);
  const bad = [ov, wv].filter((v) => !v.ok);
  if (!bad.length) return null;
  const pending = bad.every((v) => v.pending);
  return response(409, {
    error: pending
      ? "Still scanning for malware — this unlocks automatically once the scan finishes."
      : "One or both files failed the malware scan and cannot be published.",
    stillScanning: pending,
    scan: bad.map((v) => ({ ref: v.ref, status: v.status, threats: v.threats || [], threatInfo: v.threatInfo || null })),
  });
}

// All current Admin-group members, paged. `sub` from Attributes; display
// name from name/given+family/email, best-effort.
async function listAdminUsers() {
  const users = [];
  let NextToken;
  do {
    const res = await cognito.send(new ListUsersInGroupCommand({
      UserPoolId: USER_POOL_ID, GroupName: ROLES.ADMIN, NextToken,
    }));
    for (const u of res.Users || []) {
      const attrs = {};
      for (const a of u.Attributes || []) attrs[a.Name] = a.Value;
      if (!attrs.sub) continue;
      const name = attrs.name
        || [attrs.given_name, attrs.family_name].filter(Boolean).join(" ")
        || attrs.email || u.Username || null;
      users.push({ sub: attrs.sub, name });
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return users;
}

async function refetchAndReturn(pk) {
  const res = await client.send(new GetCommand({ TableName: TABLE, Key: { PK: pk, SK: metaSk() } }));
  if (!res.Item) return response(404, { error: "Asset not found" });
  return response(200, { design: res.Item, published: res.Item.status === "published" || undefined });
}

function isConditionFailure(err) {
  if (!err) return false;
  if (err.name === "ConditionalCheckFailedException") return true;
  return err.name === "TransactionCanceledException"
    && Array.isArray(err.CancellationReasons)
    && err.CancellationReasons.some((r) => r && r.Code === "ConditionalCheckFailed");
}

// EVENT# SKs embed the timestamp; two events written in one action need
// distinct SKs, so later events get a +Nms nudge.
function plusMs(iso, n) {
  return new Date(new Date(iso).getTime() + n).toISOString();
}

// buildEvent() is order-shaped (its PK is ORDER#<orderId>) — overridden
// to DESIGN#<id> here, same trick publish-design.js uses, so the EVENT#
// convention/field names/tenant stamping stay identical across item
// types rather than inventing a second audit shape for this feature.
function buildDesignEvent(pk, designId, from, to, actor, at, meta) {
  return {
    ...buildEvent({ orderId: designId, lineItemId: "DESIGN", from: from || null, to, actorSub: actor.sub, actorName: actor.name, at, meta }),
    PK: pk,
    SK: eventSk(at, "DESIGN"),
  };
}

function contentTypeFor(ext) {
  return { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext] || "application/octet-stream";
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeTags(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_TAGS) return null;
  const out = [];
  for (const t of raw) {
    if (typeof t !== "string") return null;
    const tag = t.trim().toLowerCase();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) return null;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

function response(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
