const test = require("node:test");
const assert = require("node:assert/strict");
const { approvalState, hasApproved, approvalSnapshot } = require("./approval");

const ana = { sub: "sub-ana", name: "Ana" };
const ken = { sub: "sub-ken", name: "Ken" };

test("empty admin set never completes (fail closed)", () => {
  const s = approvalState({ "sub-ana": { name: "Ana", at: "t" } }, []);
  assert.equal(s.complete, false);
  assert.equal(s.requiredCount, 0);
});

test("single admin: their one approval completes immediately (no deadlock)", () => {
  const s = approvalState({ "sub-ana": { name: "Ana", at: "t", via: "submit" } }, [ana]);
  assert.equal(s.complete, true);
  assert.equal(s.approvedCount, 1);
  assert.equal(s.requiredCount, 1);
  assert.deepEqual(s.outstanding, []);
});

test("two admins, one approval: incomplete, names the outstanding admin", () => {
  const s = approvalState({ "sub-ana": { name: "Ana", at: "t" } }, [ana, ken]);
  assert.equal(s.complete, false);
  assert.equal(s.approvedCount, 1);
  assert.deepEqual(s.outstanding, [ken]);
});

test("two admins, both approved: complete", () => {
  const s = approvalState({ "sub-ana": { at: "t" }, "sub-ken": { at: "t" } }, [ana, ken]);
  assert.equal(s.complete, true);
});

test("admin added mid-queue re-opens the set", () => {
  const approvals = { "sub-ana": { at: "t" } };
  assert.equal(approvalState(approvals, [ana]).complete, true);
  assert.equal(approvalState(approvals, [ana, ken]).complete, false);
});

test("removed admin's recorded approval is ignored in the count", () => {
  const approvals = { "sub-ghost": { at: "t" }, "sub-ana": { at: "t" } };
  const s = approvalState(approvals, [ana, ken]);
  assert.equal(s.approvedCount, 1); // ghost's approval does not count
  assert.equal(s.complete, false);
  const done = approvalState(approvals, [ana]);
  assert.equal(done.complete, true); // and it doesn't block, either
});

test("null/undefined approvals map treated as empty", () => {
  const s = approvalState(null, [ana]);
  assert.equal(s.complete, false);
  assert.equal(s.approvedCount, 0);
});

test("hasApproved is a plain membership check", () => {
  assert.equal(hasApproved({ "sub-ana": { at: "t" } }, "sub-ana"), true);
  assert.equal(hasApproved({ "sub-ana": { at: "t" } }, "sub-ken"), false);
  assert.equal(hasApproved(null, "sub-ana"), false);
  assert.equal(hasApproved({ "sub-ana": {} }, ""), false);
});

test("prototype keys never read as approvals", () => {
  assert.equal(hasApproved({}, "constructor"), false);
  const s = approvalState({}, [{ sub: "constructor", name: "Evil" }]);
  assert.equal(s.approvedCount, 0);
  assert.equal(s.complete, false);
});

test("approvalSnapshot marks approved vs outstanding, display-only shape", () => {
  const snap = approvalSnapshot({ "sub-ana": { at: "t" } }, [ana, ken]);
  assert.equal(snap.requiredCount, 2);
  assert.equal(snap.approvedCount, 1);
  assert.deepEqual(snap.approvers, [
    { sub: "sub-ana", name: "Ana", approved: true },
    { sub: "sub-ken", name: "Ken", approved: false },
  ]);
});
