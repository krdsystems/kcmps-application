/* ============================================================
   KCMPS Ops Dashboard — DATA LAYER (mock, backend-shaped)
   ============================================================
   No backend exists yet. Everything here reads/writes a single
   localStorage blob, but every function's SIGNATURE AND RETURN
   SHAPE mirrors what the real API (API Gateway + Lambda +
   DynamoDB, see ../../ops-dashboard/infra/backend-infra-to-deploy.md) will return.

   Swapping mock -> real backend later means replacing the body of
   each exported function with a `fetch()` call — nothing that
   calls these functions (today.html, week.html, etc.) should need
   to change. This is the same "one seam" pattern already used by
   store.js for the storefront cart.

   Line-item state machine (mirrors Ops Dashboard Project Knowledge §5.1):
   Pending Payment Verification -> Confirmed -> Scheduled ->
   In Production -> QC -> Ready for Dispatch -> Dispatched -> Delivered
   Custom entry: Quoted -> Priced -> Confirmed -> [rejoins above]
   Exceptions: Quote Expired, Payment Rejected, Cancelled,
   Auto-Cancelled, Rework (loops back to In Production, sets NRFT)

   Mixed cart + GCash bridge (mirrors ../../project_knowledge/
   Payment_System_Project_Knowledge.md, "Bridge Payment Method: Manual
   GCash Verification"):
   - An order can hold BOTH `sku` (pay-now) and `custom` (pay-on-quote)
     line items at once — same orderId, independent per-line status,
     orderStatus is a derived rollup (e.g. "Partially Fulfilled: SKU
     items shipped, custom item in production" — see the seed order
     tagged MIXED-CART below for a worked example).
   - `sku` items pay together as one GCash transaction at checkout, so
     the proof (screenshot, reference number, claimed amount) and the
     verify/reject decision live on the ORDER's `payment` object, not
     per line item — see `getOrder(id).payment` and `verifyPayment` /
     `rejectPayment` below. Verifying/rejecting an order affects every
     `sku` line item currently `Pending Payment Verification` on it
     together, matching "one GCash payment for the sum of sku items."
   - `custom` items get their OWN follow-up payment link per line item
     once priced (`Priced` -> `Confirmed`) — that path stays a plain
     per-line-item transition via `advanceLineItem`, no shared
     order-level payment object involved.
   ============================================================ */

(function (global) {
  const STORAGE_KEY = "kcmps_dashboard_mock_v1";
  const STATIONS = ["PRESS-01", "DIGITAL-01", "3DPRINT-01", "HEATPRESS-01", "FINISHING-01"];
  const STATION_LABELS = {
    "PRESS-01": "Silkscreen Press",
    "DIGITAL-01": "Digital / Large Format",
    "3DPRINT-01": "3D Printing",
    "HEATPRESS-01": "Heat Press / Apparel",
    "FINISHING-01": "Finishing / Packing",
  };
  const PLANNED_HOURS_PER_WEEK = { "PRESS-01": 40, "DIGITAL-01": 32, "3DPRINT-01": 60, "HEATPRESS-01": 36, "FINISHING-01": 30 };
  const SPOILAGE_REASONS = [
    { code: "registration", label: "Registration / misalignment" },
    { code: "ink", label: "Ink / colour" },
    { code: "material", label: "Material defect" },
    { code: "operator", label: "Operator error" },
    { code: "prepress", label: "File / prepress error" },
    { code: "machine", label: "Machine fault" },
  ];

  function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }
  function isoMonth(d) { return new Date(d).toISOString().slice(0, 7); }
  function nowIso() { return new Date().toISOString(); }
  function hoursAgo(n) { return new Date(Date.now() - n * 3600 * 1000).toISOString(); }
  function daysAgo(n) { return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString(); }
  function daysFromNow(n) { return new Date(Date.now() + n * 24 * 3600 * 1000).toISOString(); }
  function uid(prefix) { return prefix + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(); }

  /* ---- seed data: representative of a small Manila print/merch shop ---- */
  function buildSeed() {
    const clients = [
      { id: "C-001", name: "Ateneo Dev Society", type: "B2B", totalRevenue: 48200, lastOrderAt: daysAgo(3), reorderIntervalDays: 30 },
      { id: "C-002", name: "Miguel Santos", type: "B2C", totalRevenue: 1450, lastOrderAt: daysAgo(1), reorderIntervalDays: null },
      { id: "C-003", name: "Grind Coffee Co.", type: "B2B", totalRevenue: 91300, lastOrderAt: daysAgo(52), reorderIntervalDays: 30 },
      { id: "C-004", name: "Bea Fernandez", type: "B2C", totalRevenue: 890, lastOrderAt: daysAgo(9), reorderIntervalDays: null },
      { id: "C-005", name: "QC South Barangay Sports Fest", type: "B2B", totalRevenue: 22100, lastOrderAt: daysAgo(14), reorderIntervalDays: 90 },
      { id: "C-006", name: "JM Studio Design", type: "B2B", totalRevenue: 15600, lastOrderAt: daysAgo(61), reorderIntervalDays: 45 },
    ];

    const inventory = [
      { sku: "INV-DTFROLL", name: "DTF film roll (30cm)", qty: 4, reorderPoint: 5, unit: "roll", avgDailyUse: 0.6 },
      { sku: "INV-INKWHT", name: "White DTF ink (L)", qty: 2.4, reorderPoint: 3, unit: "L", avgDailyUse: 0.35 },
      { sku: "INV-SHIRTBLK-M", name: "Blank shirt — Black, M", qty: 38, reorderPoint: 24, unit: "pc", avgDailyUse: 3.1 },
      { sku: "INV-SHIRTWHT-L", name: "Blank shirt — White, L", qty: 12, reorderPoint: 24, unit: "pc", avgDailyUse: 2.8 },
      { sku: "INV-PLA-BLK", name: "PLA filament — Black (kg)", qty: 6.2, reorderPoint: 4, unit: "kg", avgDailyUse: 0.4 },
      { sku: "INV-PETG-WHT", name: "PETG filament — White (kg)", qty: 1.1, reorderPoint: 3, unit: "kg", avgDailyUse: 0.3 },
      { sku: "INV-LAMFILM", name: "Lamination film (roll)", qty: 7, reorderPoint: 4, unit: "roll", avgDailyUse: 0.2 },
      { sku: "INV-USB32", name: "Flash drive 32GB (blank)", qty: 46, reorderPoint: 20, unit: "pc", avgDailyUse: 1.5 },
    ];

    let orders = [];
    let events = [];
    let lineSeq = 1;

    function pushEvent(orderId, lineItemId, from, to, station, meta, at) {
      events.push({
        pk: "ORDER#" + orderId, sk: "EVENT#" + (at || nowIso()) + "#" + lineItemId,
        orderId, lineItemId, from, to, actorSub: "seed-actor", actorName: "System (seed)",
        station: station || null, at: at || nowIso(), meta: meta || {},
      });
    }

    function makeOrder(opts) {
      const orderId = opts.orderId || uid("ORD");
      const client = opts.client;
      const createdAt = opts.createdAt || daysAgo(1);
      const originalPromisedDate = opts.originalPromisedDate;
      const lineItems = opts.lineItems.map((li) => {
        const lineItemId = "L" + lineSeq++;
        return Object.assign({
          lineItemId, orderId,
          type: "sku", qty: 1, priceEach: 0, amount: 0,
          spoilage: [], setupMinutes: null, station: null,
          enteredStatusAt: createdAt, notes: "",
        }, li, { lineItemId });
      });
      const order = {
        orderId, client, customerSub: opts.customerSub || uid("sub"),
        createdAt, originalPromisedDate, lineItems,
        payment: opts.payment || null, // order-level GCash bridge payment — see header note
        correspondenceLog: [], // manual order↔email linking notes — see docs/roadmap.md "Order↔email linking"
      };
      order.orderStatus = deriveOrderStatus(order);
      orders.push(order);
      return order;
    }

    // Shapes the order.payment.submittedAt/claimedAmount/gcashRefNumber/
    // screenshotRef/verifiedBy/verifiedAt/rejectionReason fields exactly as
    // specified in the Payment System file's "Data Model Addition" section.
    function gcashProof(claimedAmount, gcashRefNumber, submittedAt, opts) {
      opts = opts || {};
      return {
        method: "gcash_manual", claimedAmount, gcashRefNumber,
        screenshotRef: opts.screenshotRef || `s3://kcmps-uploads/payments/${gcashRefNumber}.jpg`,
        submittedAt,
        verifiedBy: opts.verifiedBy || null,
        verifiedAt: opts.verifiedAt || null,
        rejectionReason: opts.rejectionReason || null,
      };
    }

    // 1) Pending Payment Verification — GCash proof submitted, aging.
    //    The proof lives on order.payment (one GCash transaction can cover
    //    several sku line items on the same order); each affected line
    //    item just carries the status + its own enteredStatusAt for aging.
    makeOrder({
      client: clients[1], createdAt: hoursAgo(6), originalPromisedDate: daysFromNow(2),
      payment: gcashProof(350, "GC-88213", hoursAgo(6)),
      lineItems: [{ description: "Custom shirt — 'Barkada Trip 2026' design, size M", type: "sku", sku: "PRINT-DTF-SHIRT", qty: 1, priceEach: 350, amount: 350, status: "Pending Payment Verification", enteredStatusAt: hoursAgo(6) }],
    });
    makeOrder({
      client: clients[3], createdAt: hoursAgo(3), originalPromisedDate: daysFromNow(1),
      payment: gcashProof(840, "GC-88240", hoursAgo(3)),
      lineItems: [{ description: "3 pcs 32GB custom-printed flash drive", type: "sku", sku: "MERCH-USB32", qty: 3, priceEach: 280, amount: 840, status: "Pending Payment Verification", enteredStatusAt: hoursAgo(3) }],
    });
    // one that's over-SLA (past 4 working hours) to show red state
    makeOrder({
      client: clients[4], createdAt: hoursAgo(9), originalPromisedDate: daysFromNow(3),
      payment: gcashProof(2600, "GC-88190", hoursAgo(9)),
      lineItems: [{ description: "40 pcs event lanyard + ID print", type: "sku", sku: "PRINT-LANYARD", qty: 40, priceEach: 65, amount: 2600, status: "Pending Payment Verification", enteredStatusAt: hoursAgo(9) }],
    });

    // 2) Awaiting Quote — custom items at 'Quoted'
    makeOrder({
      client: clients[2], createdAt: hoursAgo(20), originalPromisedDate: daysFromNow(5),
      lineItems: [{ description: "Custom: 60 branded ceramic mugs w/ logo — spec TBD", type: "custom", status: "Quoted", enteredStatusAt: hoursAgo(20), notes: "Client sent vector logo, needs mug sourcing quote." }],
    });
    makeOrder({
      client: clients[5], createdAt: hoursAgo(2), originalPromisedDate: daysFromNow(6),
      lineItems: [{ description: "Custom: 3D-printed award trophies x12, PLA gold finish", type: "custom", status: "Quoted", enteredStatusAt: hoursAgo(2), notes: "Awaiting material cost check for gold PLA." }],
    });

    // 3) Awaiting Customer Payment — Priced, link sent
    makeOrder({
      client: clients[0], createdAt: daysAgo(3), originalPromisedDate: daysFromNow(4),
      lineItems: [{ description: "Org shirts — 80 pcs DTF front+back, mixed sizes", type: "custom", status: "Priced", enteredStatusAt: hoursAgo(50), priceEach: 320, qty: 80, amount: 25600, notes: "Payment link sent 07-22." }],
    });

    // 4) Ready to Produce — Confirmed, not yet started
    makeOrder({
      client: clients[1], createdAt: daysAgo(1), originalPromisedDate: daysFromNow(2),
      lineItems: [{ description: "Custom shirt — 'Coffee Run' design, size L", type: "sku", sku: "PRINT-DTF-SHIRT", qty: 1, priceEach: 350, amount: 350, status: "Confirmed", enteredStatusAt: hoursAgo(14) }],
    });

    // 5) In Production — some due today at risk, some on track
    makeOrder({
      client: clients[0], createdAt: daysAgo(2), originalPromisedDate: daysFromNow(0),
      lineItems: [{ description: "Org shirts batch A — 40 pcs DTF, size run", type: "custom", status: "In Production", station: "HEATPRESS-01", enteredStatusAt: hoursAgo(5), priceEach: 300, qty: 40, amount: 12000, setupMinutes: 18 }],
    });
    makeOrder({
      client: clients[4], createdAt: daysAgo(4), originalPromisedDate: daysFromNow(3),
      lineItems: [{ description: "Sports fest medals — 3D print, 25 pcs", type: "custom", status: "In Production", station: "3DPRINT-01", enteredStatusAt: hoursAgo(30), priceEach: 95, qty: 25, amount: 2375, setupMinutes: 12 }],
    });

    // 6) QC Hold / Rework — always red
    makeOrder({
      client: clients[2], createdAt: daysAgo(5), originalPromisedDate: daysAgo(1),
      lineItems: [{ description: "Café menu boards — laminated A2, 10 pcs", type: "custom", status: "Rework", station: "FINISHING-01", enteredStatusAt: hoursAgo(4), priceEach: 220, qty: 10, amount: 2200, notes: "Lamination bubbling on 3 boards — reprint queued." }],
    });

    // 7) Ready for Dispatch
    makeOrder({
      client: clients[3], createdAt: daysAgo(2), originalPromisedDate: daysFromNow(1),
      lineItems: [{ description: "Custom tumbler print x2", type: "sku", sku: "MERCH-TUMBLER", qty: 2, priceEach: 260, amount: 520, status: "Ready for Dispatch", enteredStatusAt: hoursAgo(2) }],
    });

    // 8) Mixed cart — the exact worked example from the Payment System file's
    //    "Core Design: One Cart, Two Item Types" section: one paid-and-shipped
    //    sku item plus one in-progress custom item, same orderId. orderStatus
    //    derives to "Partially Fulfilled" — never set by hand (§5.1 Ops
    //    Dashboard file: "orderStatus is a derived rollup, never set directly").
    makeOrder({
      client: clients[3], createdAt: daysAgo(4), originalPromisedDate: daysFromNow(2),
      payment: gcashProof(150, "GC-88055", daysAgo(4), { verifiedBy: "Ken", verifiedAt: daysAgo(4) }),
      lineItems: [
        { description: "3D-Printed Cup Holder", type: "sku", sku: "SKU-CUPHOLDER-01", qty: 1, priceEach: 150, amount: 150, status: "Delivered", station: "3DPRINT-01", enteredStatusAt: daysAgo(1), setupMinutes: 8 },
        { description: "Custom 3D Print — client STL, PLA, qty 5", type: "custom", station: "3DPRINT-01", qty: 5, priceEach: 180, amount: 900, status: "In Production", enteredStatusAt: hoursAgo(7), setupMinutes: 20, notes: "Client-provided dimensions; fileRef s3://kcmps-uploads/custom-001.stl" },
      ],
    });

    // 9) Delivered yesterday (for "output yesterday" + cash collected metrics)
    makeOrder({
      client: clients[0], createdAt: daysAgo(3), originalPromisedDate: daysAgo(1),
      lineItems: [{ description: "Org shirts — 30 pcs DTF", type: "custom", status: "Delivered", station: "HEATPRESS-01", enteredStatusAt: daysAgo(1), priceEach: 300, qty: 30, amount: 9000, setupMinutes: 15 }],
    });
    makeOrder({
      client: clients[1], createdAt: daysAgo(2), originalPromisedDate: daysAgo(1),
      lineItems: [{ description: "Custom shirt — 'Solo Trip' design, size S", type: "sku", sku: "PRINT-DTF-SHIRT", qty: 1, priceEach: 350, amount: 350, status: "Delivered", station: "HEATPRESS-01", enteredStatusAt: daysAgo(1), setupMinutes: 10 }],
    });

    // build event history for the two Delivered + one Rework line so cycle-time / spoilage aren't empty
    const delivered1 = orders[orders.length - 2].lineItems[0];
    pushEvent(delivered1.orderId, delivered1.lineItemId, null, "Confirmed", null, {}, daysAgo(3));
    pushEvent(delivered1.orderId, delivered1.lineItemId, "Confirmed", "In Production", "HEATPRESS-01", { setupMinutes: 15 }, daysAgo(2));
    pushEvent(delivered1.orderId, delivered1.lineItemId, "In Production", "QC", "HEATPRESS-01", {}, hoursAgo(30));
    pushEvent(delivered1.orderId, delivered1.lineItemId, "QC", "Ready for Dispatch", "HEATPRESS-01", {}, hoursAgo(28));
    pushEvent(delivered1.orderId, delivered1.lineItemId, "Ready for Dispatch", "Delivered", "HEATPRESS-01", {}, daysAgo(1));

    const reworkLi = orders.find((o) => o.lineItems.some((li) => li.status === "Rework")).lineItems[0];
    pushEvent(reworkLi.orderId, reworkLi.lineItemId, "In Production", "QC", "FINISHING-01", {}, hoursAgo(6));
    pushEvent(reworkLi.orderId, reworkLi.lineItemId, "QC", "Rework", "FINISHING-01", { spoilageUnits: 3, spoilageReason: "material", spoilageValue: 660 }, hoursAgo(4));
    reworkLi.spoilage.push({ units: 3, reasonCode: "material", valuePhp: 660, at: hoursAgo(4) });

    orders.forEach((o) => { o.orderStatus = deriveOrderStatus(o); });

    // metrics rollups — mirrors METRIC#DAY# / METRIC#MONTH# items from the Streams handler
    const today = isoDay(nowIso());
    const yesterday = isoDay(daysAgo(1));
    const thisMonth = isoMonth(nowIso());
    const metrics = {
      day: {
        [yesterday]: { jobsCompleted: 2, unitsOut: 31, spoilageUnits: 0, spoilageValue: 0, reworkOpened: 0, cashCollected: 9350, quotesSent: 3, quotesAccepted: 1, otifHits: 2, otifMisses: 0 },
        [today]: { jobsCompleted: 0, unitsOut: 0, spoilageUnits: 3, spoilageValue: 660, reworkOpened: 1, cashCollected: 0, quotesSent: 1, quotesAccepted: 0, otifHits: 0, otifMisses: 0 },
      },
      station: {
        [yesterday]: {
          "HEATPRESS-01": { productionMinutes: 260, setupMinutes: 25, jobsRun: 2 },
          "3DPRINT-01": { productionMinutes: 420, setupMinutes: 12, jobsRun: 1 },
        },
        [today]: {
          "HEATPRESS-01": { productionMinutes: 90, setupMinutes: 18, jobsRun: 1 },
          "3DPRINT-01": { productionMinutes: 180, setupMinutes: 12, jobsRun: 1 },
          "FINISHING-01": { productionMinutes: 60, setupMinutes: 8, jobsRun: 1 },
        },
      },
      month: {
        [thisMonth]: {
          summary: { revenue: 214800, materialCost: 68300, laborCost: 41200, jobCount: 46, estimatedCost: 105000, actualCost: 109500, otifHits: 41, otifMisses: 5, nrftCount: 4, spoilageValue: 4200, cashCollected: 189000, cashOutstanding: 25800 },
          pillar: {
            PRINT: { revenue: 128400, materialCost: 41200, laborCost: 22800, jobCount: 30, estimatedCost: 60000, actualCost: 63000 },
            STUDIO: { revenue: 36600, materialCost: 4100, laborCost: 12400, jobCount: 8, estimatedCost: 15000, actualCost: 16200 },
            HARDWARE: { revenue: 49800, materialCost: 23000, laborCost: 6000, jobCount: 8, estimatedCost: 30000, actualCost: 30300 },
          },
        },
      },
    };

    const blockers = [
      { id: uid("BLK"), text: "White DTF ink running low mid-batch — had to pause a job", owner: "Ken", dueDate: isoDay(daysFromNow(1)), tag: "ink-supply", createdAt: hoursAgo(20), resolved: false },
      { id: uid("BLK"), text: "White DTF ink ran out again on second station", owner: "Ken", dueDate: isoDay(daysFromNow(0)), tag: "ink-supply", createdAt: hoursAgo(3), resolved: false },
      { id: uid("BLK"), text: "Heat press #2 thermostat reading inconsistent", owner: "Mikko", dueDate: isoDay(daysFromNow(2)), tag: "heatpress-maintenance", createdAt: hoursAgo(10), resolved: false },
    ];

    const mailboxes = seedMailboxes();
    const emails = seedEmails(orders);

    return { orders, events, metrics, blockers, inventory, clients, mailboxes, emails, stations: STATIONS, seededAt: nowIso() };
  }

  /* ---- seed data: staff mailboxes + mock mail ----
     Shapes mirror an IMAP FETCH deliberately (see the "mail" section further
     down) so swapping these mock functions for real Lambda calls is a
     function-body change with no caller/UI change.

     NOTE: this file must stay identity-free. It loads BEFORE
     dashboard-shell.js, so it cannot read Cognito claims — the personal
     mailbox is seeded with a fixed address and email.html overrides only its
     display label from the signed-in claims. ---- */
  function seedMailboxes() {
    return [
      { id: "order@kcmps.com", address: "order@kcmps.com", label: "Orders", kind: "shared", canSend: true },
      { id: "info@kcmps.com", address: "info@kcmps.com", label: "General enquiries", kind: "shared", canSend: true },
      { id: "me@kcmps.com", address: "me@kcmps.com", label: "My mailbox", kind: "personal", canSend: true },
    ];
  }

  function seedEmails(orders) {
    const ord = (i) => (orders && orders[i] ? orders[i].orderId : null);
    const threadA = uid("THR");
    const msg = (o) => Object.assign({
      messageId: uid("MSG"), uid: 0, folder: "INBOX", threadId: uid("THR"),
      to: [{ name: "", address: o.mailboxId }], cc: [],
      snippet: "", hasHtmlPart: false, attachments: [],
      flags: { seen: true, answered: false, flagged: false }, relatedOrderId: null,
    }, o, { snippet: (o.snippet || o.bodyText || "").replace(/\s+/g, " ").slice(0, 140) });

    let n = 10400;
    const withUid = (m) => Object.assign(m, { uid: n++ });

    return [
      /* — order@kcmps.com — */
      withUid(msg({
        mailboxId: "order@kcmps.com", threadId: threadA,
        from: { name: "Mika Reyes", address: "mika.reyes@gmail.com" },
        subject: "Follow up po sa 30 pcs DTF shirts",
        date: hoursAgo(2), relatedOrderId: ord(0),
        flags: { seen: false, answered: false, flagged: false },
        bodyText: "Hi KCMPS!\n\nNag-place po ako ng order kahapon for 30 pcs DTF shirts, black.\nNakapag-GCash na po ako kaninang umaga. Pwede po bang ma-confirm kung na-receive niyo na?\n\nSalamat po!\nMika",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com",
        from: { name: "GCash", address: "no-reply@gcash.com" },
        subject: "You have received PHP 9,000.00",
        date: hoursAgo(3),
        flags: { seen: false, answered: false, flagged: false },
        bodyText: "You have received PHP 9,000.00 from MIKA R.\nReference No. 8017 442 99331\nDate: today\n\nThis is an automated notification. Do not reply to this message.",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com",
        from: { name: "Ateneo Dev Society", address: "events@ateneodev.org" },
        subject: "Pwede pa bang mag-add ng 10 pcs?",
        date: hoursAgo(7), relatedOrderId: ord(1),
        flags: { seen: false, answered: false, flagged: false },
        bodyText: "Good afternoon,\n\nMay we add 10 more pieces to our existing order? Same design, sizes L and XL.\nIf it delays the schedule we can also do it as a separate batch.\n\nThank you,\nPaolo",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com",
        from: { name: "Bea Fernandez", address: "bea.fernandez@yahoo.com" },
        subject: "Ready na po ba for pickup?",
        date: daysAgo(1),
        bodyText: "Hello po, tanong ko lang kung pwede na po ma-pickup yung tote bags ko this week? Salamat!",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com",
        from: { name: "GCash", address: "no-reply@gcash.com" },
        subject: "You have received PHP 2,450.00",
        date: daysAgo(1),
        bodyText: "You have received PHP 2,450.00 from BEA F.\nReference No. 8017 118 20044\n\nThis is an automated notification. Do not reply to this message.",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com",
        from: { name: "Grind Coffee Co.", address: "ops@grindcoffee.ph" },
        subject: "Reorder — 50 pcs staff aprons",
        date: daysAgo(2),
        bodyText: "Hi team,\n\nSame spec as our last run — 50 pcs, embroidered logo, charcoal.\nPlease send a quote and we'll process payment right away.\n\nRegards,\nDenise",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com", threadId: threadA,
        from: { name: "KCMPS Orders", address: "order@kcmps.com" },
        subject: "Re: Follow up po sa 30 pcs DTF shirts",
        folder: "SENT", date: hoursAgo(26),
        bodyText: "Hi Mika,\n\nReceived po ang order niyo. Under verification pa po ang payment — we'll confirm within 24 hours.\n\nSalamat po!\nKCMPS",
      })),
      withUid(msg({
        mailboxId: "order@kcmps.com", threadId: threadA,
        from: { name: "Mika Reyes", address: "mika.reyes@gmail.com" },
        subject: "Re: Follow up po sa 30 pcs DTF shirts",
        date: hoursAgo(28),
        bodyText: "Sending po the GCash screenshot. Reference number is 8017 442 99331.\n\nThanks!",
        attachments: [{ filename: "gcash-receipt.jpg", sizeBytes: 284310, mimeType: "image/jpeg" }],
      })),

      /* — info@kcmps.com — */
      withUid(msg({
        mailboxId: "info@kcmps.com",
        from: { name: "Sunrise Ink Supply", address: "sales@sunriseink.com.ph" },
        subject: "Quotation — DTF film & white ink (Q3 pricing)",
        date: hoursAgo(5),
        flags: { seen: false, answered: false, flagged: false },
        bodyText: "Good day KCMPS,\n\nAttached is our updated quotation for DTF film rolls and white ink.\nPrices are valid for 30 days. Free delivery within Metro Manila for orders over PHP 15,000.\n\nBest regards,\nArnel Cruz\nSunrise Ink Supply",
        attachments: [{ filename: "sunrise-quotation-q3.pdf", sizeBytes: 141882, mimeType: "application/pdf" }],
      })),
      withUid(msg({
        mailboxId: "info@kcmps.com",
        from: { name: "HeatPro Parts", address: "support@heatpro.asia" },
        subject: "Backorder notice — thermostat assembly",
        date: daysAgo(2),
        bodyText: "Dear customer,\n\nThe thermostat assembly you ordered is on backorder until the 18th.\nWe can ship the rest of your order now, or hold it complete. Please advise.\n\nHeatPro Parts",
      })),
      withUid(msg({
        mailboxId: "info@kcmps.com",
        from: { name: "PrintTech Expo", address: "news@printtechexpo.com" },
        subject: "Last call: exhibitor booths for 2026",
        date: daysAgo(4), hasHtmlPart: true,
        bodyText: "View this email in your browser. Book your booth before slots run out.",
      })),
      withUid(msg({
        mailboxId: "info@kcmps.com",
        from: { name: "QC South Barangay", address: "sportsfest@qcsouth.gov.ph" },
        subject: "Request for quotation — 200 pcs event shirts",
        date: daysAgo(5),
        bodyText: "Magandang araw,\n\nWe are canvassing suppliers for 200 pcs event shirts for our sports fest.\nKindly send your quotation with unit price and lead time.\n\nSalamat,\nBarangay QC South",
      })),

      /* — personal — */
      withUid(msg({
        mailboxId: "me@kcmps.com",
        from: { name: "Mikko Dela Cruz", address: "mikko@kcmps.com" },
        subject: "Heat press #2 — still inconsistent",
        date: hoursAgo(9),
        flags: { seen: false, answered: false, flagged: false },
        bodyText: "Boss, yung heat press #2 pa rin. Nag-vary ng 15 degrees kanina mid-run.\nBaka kailangan na talaga i-replace yung thermostat. Nag-email na ako sa HeatPro.\n\n- Mikko",
      })),
      withUid(msg({
        mailboxId: "me@kcmps.com",
        from: { name: "Spaceship Billing", address: "billing@spaceship.com" },
        subject: "Your invoice is ready",
        date: daysAgo(6),
        bodyText: "Your monthly invoice for kcmps.com services is now available in your account dashboard.",
      })),
    ];
  }

  function deriveOrderStatus(order) {
    const statuses = order.lineItems.map((li) => li.status);
    if (statuses.every((s) => s === "Delivered")) return "Delivered";
    if (statuses.some((s) => s === "Delivered") && statuses.some((s) => s !== "Delivered" && !["Cancelled", "Quote Expired"].includes(s))) return "Partially Fulfilled";
    if (statuses.some((s) => s === "Pending Payment Verification")) return "Pending Payment Verification";
    if (statuses.some((s) => s === "Rework")) return "Rework";
    if (statuses.some((s) => s === "In Production")) return "In Production";
    if (statuses.some((s) => s === "Quoted")) return "Awaiting Quote";
    if (statuses.some((s) => s === "Priced")) return "Awaiting Payment";
    return statuses[0] || "Unknown";
  }

  /* ---- persistence ----
     ADDITIVE MIGRATION, not a key bump. When a new top-level collection is
     added to buildSeed(), anyone with an existing STORAGE_KEY blob would read
     it as `undefined`. Bumping STORAGE_KEY would fix that by throwing away
     every tester's in-progress mock state (advanced jobs, logged spoilage,
     blockers) for a feature that has nothing to do with orders — so instead
     ensureCollections() backfills just the missing collection and saves.
     Follow this pattern for the next collection (Design Library), and keep
     the backfill's related collections under ONE guard so a partial blob
     can't produce e.g. mailboxes-without-messages. ---- */
  function ensureCollections(state) {
    let dirty = false;
    if (!Array.isArray(state.mailboxes) || !Array.isArray(state.emails)) {
      state.mailboxes = seedMailboxes();
      state.emails = seedEmails(state.orders);
      dirty = true;
    }
    state.orders.forEach((o) => {
      if (!Array.isArray(o.correspondenceLog)) { o.correspondenceLog = []; dirty = true; }
    });
    if (dirty) save(state);
    return state;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // ensureCollections runs ONLY here, never in buildSeed() — buildSeed
      // already includes every collection, so calling it there double-seeds.
      if (raw) return ensureCollections(JSON.parse(raw));
    } catch (e) { console.warn("[dash-data] corrupt state, reseeding", e); }
    const seed = buildSeed();
    save(seed);
    return seed;
  }
  function save(state) { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function resetSeed() { const seed = buildSeed(); save(seed); return seed; }

  /* ---- derived helpers ---- */
  function allLineItems(state) {
    const out = [];
    state.orders.forEach((o) => o.lineItems.forEach((li) => out.push(Object.assign({ order: o }, li))));
    return out;
  }
  function agingHours(li) { return (Date.now() - new Date(li.enteredStatusAt).getTime()) / 3600000; }
  function sortByAging(list) { return list.slice().sort((a, b) => new Date(a.enteredStatusAt) - new Date(b.enteredStatusAt)); }

  const SLA_HOURS = {
    "Pending Payment Verification": { warn: 2, red: 4, expire: 48 },
    "Quoted": { warn: 12, red: 18, expire: 24 },
    "Priced": { warn: 36, red: 48, expire: 168 },
  };

  function getQueues() {
    const state = load();
    const items = allLineItems(state);
    const q = {
      pendingPaymentVerification: items.filter((li) => li.status === "Pending Payment Verification"),
      awaitingQuote: items.filter((li) => li.type === "custom" && li.status === "Quoted"),
      awaitingCustomerPayment: items.filter((li) => li.status === "Priced"),
      readyToProduce: items.filter((li) => li.status === "Confirmed"),
      inProduction: items.filter((li) => li.status === "In Production"),
      qcHoldRework: items.filter((li) => li.status === "Rework" || li.status === "QC"),
      readyForDispatch: items.filter((li) => li.status === "Ready for Dispatch"),
    };
    Object.keys(q).forEach((k) => { q[k] = sortByAging(q[k]).map(decorateLineItem); });
    return q;
  }

  function decorateLineItem(li) {
    const hrs = agingHours(li);
    const sla = SLA_HOURS[li.status];
    let slaState = "ok";
    if (sla) {
      if (hrs >= sla.red) slaState = "red";
      else if (hrs >= sla.warn) slaState = "warn";
    }
    const dueDate = li.order.originalPromisedDate;
    const dueInDays = dueDate ? Math.ceil((new Date(dueDate) - Date.now()) / 86400000) : null;
    return Object.assign({}, li, {
      agingHours: Math.round(hrs * 10) / 10,
      slaState,
      dueDate,
      dueInDays,
      dueRisk: dueInDays !== null && dueInDays <= 2 && !["Delivered", "Ready for Dispatch", "Dispatched"].includes(li.status),
      // Payment System file's staff-dashboard spec: "New queue: Pending
      // Verification — shows screenshot, reference number, claimed amount,
      // order ID, timestamp." Lives on order.payment (§ header note above),
      // surfaced here so the queue card doesn't need a second lookup.
      payment: li.status === "Pending Payment Verification" ? li.order.payment : null,
    });
  }

  function getTodayNumbers() {
    const state = load();
    const items = allLineItems(state);
    const todayKey = isoDay(nowIso());
    const yestKey = isoDay(daysAgo(1));
    const dayY = state.metrics.day[yestKey] || { jobsCompleted: 0, unitsOut: 0, spoilageUnits: 0, spoilageValue: 0, reworkOpened: 0, cashCollected: 0 };
    const dayT = state.metrics.day[todayKey] || { spoilageUnits: 0, spoilageValue: 0, reworkOpened: 0 };
    const dueToday = items.filter((li) => li.dueDate ? isoDay(li.order.originalPromisedDate) === todayKey : isoDay(li.order.originalPromisedDate) <= todayKey);
    const dueTodayList = items.filter((li) => isoDay(li.order.originalPromisedDate) <= todayKey && !["Delivered", "Dispatched", "Cancelled", "Quote Expired"].includes(li.status));
    const atRisk = dueTodayList.filter((li) => !["In Production", "QC", "Ready for Dispatch"].includes(li.status));
    const wipStatuses = ["Confirmed", "Scheduled", "In Production", "QC", "Rework", "Ready for Dispatch"];
    const wip = items.filter((li) => wipStatuses.includes(li.status));
    return {
      dueToday: dueTodayList.length,
      dueTodayAtRisk: atRisk.length,
      outputYesterdayUnits: dayY.unitsOut, outputYesterdayJobs: dayY.jobsCompleted,
      spoilageYesterdayUnits: dayY.spoilageUnits, spoilageYesterdayValue: dayY.spoilageValue,
      reworkOpenedYesterday: dayY.reworkOpened,
      cashCollectedYesterday: dayY.cashCollected,
      spoilageTodayUnits: dayT.spoilageUnits, spoilageTodayValue: dayT.spoilageValue,
      wipCount: wip.length,
    };
  }

  function getLowStock() {
    const state = load();
    return state.inventory.map((i) => Object.assign({}, i, {
      lowStock: i.qty <= i.reorderPoint,
      daysOfCover: i.avgDailyUse > 0 ? Math.floor(i.qty / i.avgDailyUse) : null,
    })).filter((i) => i.lowStock).sort((a, b) => a.daysOfCover - b.daysOfCover);
  }

  function getBlockers(includeResolved) {
    const state = load();
    let list = state.blockers.slice();
    if (!includeResolved) list = list.filter((b) => !b.resolved);
    // recurring tag detection: same tag 3+ times in 30 days (across resolved+open)
    const cutoff = Date.now() - 30 * 86400000;
    const tagCounts = {};
    state.blockers.forEach((b) => { if (new Date(b.createdAt).getTime() >= cutoff) tagCounts[b.tag] = (tagCounts[b.tag] || 0) + 1; });
    return list
      .map((b) => Object.assign({}, b, { recurring: b.tag ? tagCounts[b.tag] >= 3 : false }))
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  function addBlocker({ text, owner, dueDate, tag }) {
    const state = load();
    if (!text || !owner || !dueDate) throw new Error("Blocker requires text, owner, and dueDate.");
    state.blockers.push({ id: uid("BLK"), text, owner, dueDate, tag: tag || "", createdAt: nowIso(), resolved: false });
    save(state);
    return getBlockers();
  }
  function resolveBlocker(id) {
    const state = load();
    const b = state.blockers.find((x) => x.id === id);
    if (b) b.resolved = true;
    save(state);
    return getBlockers();
  }

  /* ---- line item transitions (mirrors the Streams-derived event write) ---- */
  const NEXT_STATUS = {
    "Pending Payment Verification": "Confirmed",
    "Quoted": "Priced",
    "Priced": "Confirmed",
    "Confirmed": "Scheduled",
    "Scheduled": "In Production",
    "In Production": "QC",
    "QC": "Ready for Dispatch",
    "Ready for Dispatch": "Dispatched",
    "Dispatched": "Delivered",
  };

  function advanceLineItem(orderId, lineItemId, opts) {
    opts = opts || {};
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    const li = order && order.lineItems.find((x) => x.lineItemId === lineItemId);
    if (!li) throw new Error("Line item not found: " + orderId + "/" + lineItemId);
    const from = li.status;
    const to = opts.to || NEXT_STATUS[from];
    if (!to) throw new Error("No default next status from '" + from + "' — pass opts.to explicitly.");
    li.status = to;
    li.enteredStatusAt = nowIso();
    if (opts.station) li.station = opts.station;
    if (opts.setupMinutes != null) li.setupMinutes = opts.setupMinutes;
    state.events.push({
      pk: "ORDER#" + orderId, sk: "EVENT#" + nowIso() + "#" + lineItemId,
      orderId, lineItemId, from, to, actorSub: "current-user", actorName: opts.actorName || "You",
      station: li.station || null, at: nowIso(), meta: opts.meta || {},
    });
    order.orderStatus = deriveOrderStatus(order);
    bumpTodayMetric(state, to, li);
    save(state);
    return li;
  }

  /* ---- GCash bridge verify/reject (order-level — see header note) ----
     Mirrors the Payment System file's verifyPayment / rejectPayment
     Lambdas: one GCash transaction verified/rejected together advances
     (or rejects) every `sku` line item on that order still sitting in
     `Pending Payment Verification`, and stamps the audit fields on
     order.payment (verifiedBy/verifiedAt, or rejectionReason). ---- */
  function verifyPayment(orderId, staffName) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    if (!order) throw new Error("Order not found: " + orderId);
    if (!order.payment) throw new Error("Order has no GCash payment proof on file: " + orderId);
    const pending = order.lineItems.filter((li) => li.status === "Pending Payment Verification");
    if (!pending.length) throw new Error("No line items on this order are awaiting verification.");
    const now = nowIso();
    pending.forEach((li) => {
      const from = li.status;
      li.status = "Confirmed";
      li.enteredStatusAt = now;
      state.events.push({
        pk: "ORDER#" + orderId, sk: "EVENT#" + now + "#" + li.lineItemId,
        orderId, lineItemId: li.lineItemId, from, to: "Confirmed",
        actorSub: "current-user", actorName: staffName || "You",
        station: li.station || null, at: now, meta: { via: "verifyPayment" },
      });
      bumpTodayMetric(state, "Confirmed", li);
    });
    order.payment.verifiedBy = staffName || "You";
    order.payment.verifiedAt = now;
    order.payment.rejectionReason = null;
    order.orderStatus = deriveOrderStatus(order);
    save(state);
    return order;
  }

  function rejectPayment(orderId, rejectionReason, staffName) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    if (!order) throw new Error("Order not found: " + orderId);
    if (!rejectionReason) throw new Error("A rejection reason is required.");
    const pending = order.lineItems.filter((li) => li.status === "Pending Payment Verification");
    if (!pending.length) throw new Error("No line items on this order are awaiting verification.");
    const now = nowIso();
    pending.forEach((li) => {
      const from = li.status;
      li.status = "Payment Rejected";
      li.enteredStatusAt = now;
      state.events.push({
        pk: "ORDER#" + orderId, sk: "EVENT#" + now + "#" + li.lineItemId,
        orderId, lineItemId: li.lineItemId, from, to: "Payment Rejected",
        actorSub: "current-user", actorName: staffName || "You",
        station: li.station || null, at: now, meta: { via: "rejectPayment", rejectionReason },
      });
    });
    if (order.payment) {
      order.payment.rejectionReason = rejectionReason;
      order.payment.verifiedBy = null;
      order.payment.verifiedAt = null;
    }
    order.orderStatus = deriveOrderStatus(order);
    save(state);
    return order;
  }

  function sendToRework(orderId, lineItemId, spoilage) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    const li = order.lineItems.find((x) => x.lineItemId === lineItemId);
    const from = li.status;
    li.status = "Rework";
    li.enteredStatusAt = nowIso();
    if (spoilage && spoilage.units) {
      li.spoilage.push({ units: spoilage.units, reasonCode: spoilage.reasonCode, valuePhp: spoilage.valuePhp || 0, at: nowIso() });
    }
    state.events.push({ pk: "ORDER#" + orderId, sk: "EVENT#" + nowIso() + "#" + lineItemId, orderId, lineItemId, from, to: "Rework", actorSub: "current-user", actorName: "You", station: li.station, at: nowIso(), meta: { spoilage } });
    order.orderStatus = deriveOrderStatus(order);
    const todayKey = isoDay(nowIso());
    const d = state.metrics.day[todayKey] || (state.metrics.day[todayKey] = { jobsCompleted: 0, unitsOut: 0, spoilageUnits: 0, spoilageValue: 0, reworkOpened: 0, cashCollected: 0, quotesSent: 0, quotesAccepted: 0, otifHits: 0, otifMisses: 0 });
    d.reworkOpened += 1;
    if (spoilage && spoilage.units) { d.spoilageUnits += spoilage.units; d.spoilageValue += (spoilage.valuePhp || 0); }
    save(state);
    return li;
  }

  function bumpTodayMetric(state, toStatus, li) {
    const todayKey = isoDay(nowIso());
    const d = state.metrics.day[todayKey] || (state.metrics.day[todayKey] = { jobsCompleted: 0, unitsOut: 0, spoilageUnits: 0, spoilageValue: 0, reworkOpened: 0, cashCollected: 0, quotesSent: 0, quotesAccepted: 0, otifHits: 0, otifMisses: 0 });
    if (toStatus === "Quoted") d.quotesSent += 1;
    // Only a custom item's Priced -> Confirmed transition is a quote
    // acceptance. A sku item's Pending Payment Verification -> Confirmed
    // (via verifyPayment) is a GCash verification, not a quote — counting
    // it here would inflate the Week view's quote-conversion rate.
    if (toStatus === "Confirmed" && li.type === "custom") d.quotesAccepted += 1;
    if (toStatus === "Delivered") {
      d.jobsCompleted += 1; d.unitsOut += (li.qty || 1); d.cashCollected += (li.amount || 0);
      const onTime = new Date() <= new Date(li.order.originalPromisedDate || li.order.createdAt);
      if (onTime) d.otifHits += 1; else d.otifMisses += 1;
    }
    if (toStatus === "In Production" && li.station) {
      const stationDay = state.metrics.station[todayKey] || (state.metrics.station[todayKey] = {});
      const st = stationDay[li.station] || (stationDay[li.station] = { productionMinutes: 0, setupMinutes: 0, jobsRun: 0 });
      st.setupMinutes += (li.setupMinutes || 0);
      st.jobsRun += 1;
    }
  }

  function setSetupMinutes(orderId, lineItemId, minutes, station) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    const li = order.lineItems.find((x) => x.lineItemId === lineItemId);
    li.setupMinutes = minutes;
    if (station) li.station = station;
    save(state);
    return li;
  }

  /* ---- week view ---- */
  function getWeekData() {
    const state = load();
    const items = allLineItems(state);
    const stationAgg = {};
    STATIONS.forEach((s) => { stationAgg[s] = { station: s, label: STATION_LABELS[s], plannedHours: PLANNED_HOURS_PER_WEEK[s], productionMinutes: 0, setupMinutes: 0, jobsRun: 0, wip: 0, jobs: [] }; });
    items.filter((li) => li.station && ["In Production", "QC", "Rework", "Scheduled"].includes(li.status)).forEach((li) => {
      const agg = stationAgg[li.station];
      if (!agg) return;
      agg.wip += 1;
      agg.jobs.push(li);
    });
    // fold in this-week's completed minutes from the metric rollup (last 7 days)
    Object.keys(state.metrics.station || {}).forEach((dateKey) => {
      const dayAgo = (Date.now() - new Date(dateKey).getTime()) / 86400000;
      if (dayAgo > 7) return;
      Object.entries(state.metrics.station[dateKey]).forEach(([st, v]) => {
        if (!stationAgg[st]) return;
        stationAgg[st].productionMinutes += v.productionMinutes;
        stationAgg[st].setupMinutes += v.setupMinutes;
        stationAgg[st].jobsRun += v.jobsRun;
      });
    });
    const stations = Object.values(stationAgg).map((s) => {
      const committedHours = Math.round((s.productionMinutes / 60) * 10) / 10;
      const utilizationPct = s.plannedHours ? Math.round((committedHours / s.plannedHours) * 1000) / 10 : 0;
      const bookableHours = Math.max(0, Math.round((s.plannedHours - committedHours) * 10) / 10);
      const committedPct = s.plannedHours ? Math.round((committedHours / s.plannedHours) * 1000) / 10 : 0;
      return Object.assign(s, { committedHours, utilizationPct, bookableHours, committedPct, overThreshold: committedPct > 85, throughput: s.jobsRun });
    });

    // batching suggestions: group queued/ready items sharing station + a material keyword
    const queueable = items.filter((li) => ["Confirmed", "Scheduled"].includes(li.status));
    const groups = {};
    queueable.forEach((li) => {
      const key = (li.sku || guessMaterial(li.description)) + "|" + (li.station || "unassigned");
      (groups[key] = groups[key] || []).push(li);
    });
    const batching = Object.entries(groups).filter(([, arr]) => arr.length > 1).map(([key, arr]) => ({
      key, count: arr.length, items: arr, estimatedSetupSavedMinutes: (arr.length - 1) * 15,
    }));

    // quote conversion this week
    const last7 = Object.keys(state.metrics.day).filter((d) => (Date.now() - new Date(d).getTime()) / 86400000 <= 7);
    let quotesSent = 0, quotesAccepted = 0;
    last7.forEach((d) => { quotesSent += state.metrics.day[d].quotesSent || 0; quotesAccepted += state.metrics.day[d].quotesAccepted || 0; });

    return {
      stations,
      batching,
      quoteConversion: { quotesSent, quotesAccepted, rate: quotesSent ? Math.round((quotesAccepted / quotesSent) * 100) : null },
      recurringBlockers: getBlockers().filter((b) => b.recurring),
    };
  }
  function guessMaterial(desc) {
    const d = (desc || "").toLowerCase();
    if (d.includes("shirt")) return "shirt-dtf";
    if (d.includes("mug")) return "mug";
    if (d.includes("3d") || d.includes("print") && d.includes("pla")) return "3d-pla";
    if (d.includes("lanyard")) return "lanyard";
    return "misc";
  }

  /* ---- month view ---- */
  function getMonthData() {
    const state = load();
    const key = isoMonth(nowIso());
    const m = state.metrics.month[key] || { summary: {}, pillar: {} };
    const s = m.summary;
    const otifPct = (s.otifHits + s.otifMisses) ? Math.round((s.otifHits / (s.otifHits + s.otifMisses)) * 1000) / 10 : null;
    const nrftPct = s.jobCount ? Math.round((s.nrftCount / s.jobCount) * 1000) / 10 : null;
    const spoilageRate = s.revenue ? Math.round((s.spoilageValue / s.revenue) * 10000) / 100 : null;
    const marginPct = (pillar) => pillar.revenue ? Math.round(((pillar.revenue - pillar.materialCost - pillar.laborCost) / pillar.revenue) * 1000) / 10 : null;
    const pillars = Object.entries(m.pillar || {}).map(([name, p]) => Object.assign({ name }, p, {
      grossMargin: p.revenue - p.materialCost - p.laborCost,
      marginPct: marginPct(p),
      costVariance: p.actualCost - p.estimatedCost,
      costVariancePct: p.estimatedCost ? Math.round(((p.actualCost - p.estimatedCost) / p.estimatedCost) * 1000) / 10 : null,
    }));
    const quietClients = state.clients.filter((c) => c.reorderIntervalDays && (Date.now() - new Date(c.lastOrderAt).getTime()) / 86400000 > c.reorderIntervalDays);
    const topClients = state.clients.slice().sort((a, b) => b.totalRevenue - a.totalRevenue).slice(0, 10);
    const repeatRevenue = state.clients.filter((c) => c.type === "B2B").reduce((sum, c) => sum + c.totalRevenue, 0);
    const repeatRatePct = s.revenue ? Math.round((repeatRevenue / s.revenue) * 1000) / 10 : null;
    return {
      monthKey: key, summary: s, otifPct, nrftPct, spoilageRate, pillars,
      quietClients, topClients, repeatRatePct,
      cashOutstanding: s.cashOutstanding, cashCollected: s.cashCollected,
    };
  }

  function getStations() { return STATIONS.map((s) => ({ id: s, label: STATION_LABELS[s] })); }
  function getSpoilageReasons() { return SPOILAGE_REASONS.slice(); }
  function getClients() { return load().clients.slice(); }
  function getInventoryAll() { return load().inventory.slice(); }
  function adjustInventory(sku, qty) {
    const state = load();
    const item = state.inventory.find((i) => i.sku === sku);
    if (item) item.qty = qty;
    save(state);
    return state.inventory;
  }
  function getOrder(orderId) { return load().orders.find((o) => o.orderId === orderId); }
  function getAllOrders() { return load().orders.slice(); }
  function getEventsFor(orderId) { return load().events.filter((e) => e.orderId === orderId).sort((a, b) => new Date(a.at) - new Date(b.at)); }

  // Manual order↔email linking: staff log a note referencing a Spacemail
  // thread (never the email body itself — no mail content is stored here).
  // See docs/roadmap.md "Order↔email linking" for why this replaced the
  // SES-relay/Google-Workspace approach.
  function addCorrespondenceLog(orderId, note, actorName) {
    const state = load();
    const order = state.orders.find((o) => o.orderId === orderId);
    if (!order) throw new Error("Order not found: " + orderId);
    if (!note || !note.trim()) throw new Error("A note is required.");
    if (!Array.isArray(order.correspondenceLog)) order.correspondenceLog = [];
    order.correspondenceLog.push({ at: nowIso(), note: note.trim(), actorName: actorName || "—" });
    save(state);
    return order.correspondenceLog;
  }

  /* ============================================================
     MAIL — staff email panel (mock; see docs/roadmap.md "Parallel track —
     Staff email panel")
     ============================================================
     Every shape here is chosen to be directly derivable from a real IMAP
     response, so the eventual swap to getInboxMessages/sendEmail Lambdas is a
     function-BODY change only:

       messageId  <- RFC822 Message-ID      uid       <- IMAP UID (stable cursor)
       from/to/cc <- ENVELOPE               date      <- INTERNALDATE
       snippet    <- BODY.PEEK[1]<0.200>    bodyText  <- text/plain part
       flags      <- \Seen \Answered \Flagged
       hasHtmlPart / attachments <- BODYSTRUCTURE

     The envelope/body split is deliberate: real IMAP fetches the list
     (ENVELOPE) and the body (BODY[]) in two round-trips, so getMessages()
     omits bodyText/attachments and getMessage() adds them. Mirroring that now
     means the list view never has to change shape later.
     ============================================================ */

  function findMailbox(state, mailboxId) {
    const mb = state.mailboxes.find((m) => m.id === mailboxId);
    if (!mb) throw new Error("Unknown mailbox: " + mailboxId);
    return mb;
  }
  function isInbox(m) { return m.folder === "INBOX"; }
  function envelopeOf(m) {
    // strip the body-only fields — the list must not depend on them
    const e = Object.assign({}, m);
    delete e.bodyText;
    delete e.attachments;
    return e;
  }

  function getMailboxes() {
    const state = load();
    return state.mailboxes.map((mb) => {
      const mine = state.emails.filter((m) => m.mailboxId === mb.id && isInbox(m));
      return Object.assign({}, mb, {
        total: mine.length,
        unreadCount: mine.filter((m) => !m.flags.seen).length,
      });
    });
  }

  function getMessages(mailboxId, opts) {
    const o = opts || {};
    const folder = o.folder || "INBOX";
    const limit = o.limit || 50;
    const search = (o.search || "").trim().toLowerCase();
    const state = load();
    findMailbox(state, mailboxId);

    let rows = state.emails.filter((m) => m.mailboxId === mailboxId && m.folder === folder);
    const total = rows.length;
    const unreadCount = rows.filter((m) => !m.flags.seen).length;
    if (search) {
      rows = rows.filter((m) =>
        (m.subject || "").toLowerCase().includes(search) ||
        (m.from.name || "").toLowerCase().includes(search) ||
        (m.from.address || "").toLowerCase().includes(search) ||
        (m.snippet || "").toLowerCase().includes(search)
      );
    }
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    const page = rows.slice(0, limit);
    return {
      mailboxId, folder, total, unreadCount,
      messages: page.map(envelopeOf),
      // real backend: lowest UID in the page, fed back as opts.cursor
      nextCursor: rows.length > limit ? page[page.length - 1].uid : null,
    };
  }

  function getMessage(mailboxId, messageId) {
    const state = load();
    findMailbox(state, mailboxId);
    return state.emails.find((m) => m.mailboxId === mailboxId && m.messageId === messageId);
  }

  function getThread(mailboxId, threadId) {
    const state = load();
    findMailbox(state, mailboxId);
    return state.emails
      .filter((m) => m.mailboxId === mailboxId && m.threadId === threadId)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  function markMessageRead(mailboxId, messageId, seen) {
    const state = load();
    findMailbox(state, mailboxId);
    const m = state.emails.find((x) => x.mailboxId === mailboxId && x.messageId === messageId);
    if (!m) throw new Error("Unknown message: " + messageId);
    m.flags.seen = seen !== false;
    save(state);
    return getMessages(mailboxId);
  }

  function sendReply(mailboxId, messageId, payload) {
    const p = payload || {};
    const bodyText = (p.bodyText || "").trim();
    if (!bodyText) throw new Error("Reply body cannot be empty.");
    const state = load();
    const mb = findMailbox(state, mailboxId);
    if (!mb.canSend) throw new Error("This mailbox is read-only.");
    const original = state.emails.find((x) => x.mailboxId === mailboxId && x.messageId === messageId);
    if (!original) throw new Error("Unknown message: " + messageId);

    const subject = /^re:/i.test(original.subject) ? original.subject : "Re: " + original.subject;
    const sent = {
      messageId: uid("MSG"),
      uid: Math.max.apply(null, state.emails.map((m) => m.uid)) + 1,
      mailboxId, folder: "SENT", threadId: original.threadId,
      from: { name: "KCMPS", address: mb.address },
      to: [original.from], cc: p.cc || [],
      subject, date: nowIso(),
      snippet: bodyText.replace(/\s+/g, " ").slice(0, 140),
      bodyText, hasHtmlPart: false, attachments: [],
      flags: { seen: true, answered: false, flagged: false },
      relatedOrderId: original.relatedOrderId || null,
    };
    // The three side effects a real send performs: SMTP send, IMAP APPEND to
    // Sent, and STORE +FLAGS (\Answered) on the original.
    state.emails.push(sent);
    original.flags.answered = true;
    original.flags.seen = true;
    save(state);
    return { sent, list: getMessages(mailboxId) };
  }

  global.KCMPS_DASH = {
    STORAGE_KEY, STATIONS, STATION_LABELS,
    getMailboxes, getMessages, getMessage, getThread, markMessageRead, sendReply,
    getQueues, getTodayNumbers, getLowStock, getBlockers, addBlocker, resolveBlocker,
    advanceLineItem, sendToRework, setSetupMinutes, verifyPayment, rejectPayment,
    getWeekData, getMonthData,
    getStations, getSpoilageReasons, getClients, getInventoryAll, adjustInventory,
    getOrder, getAllOrders, getEventsFor, addCorrespondenceLog,
    resetSeed,
  };
})(window);
