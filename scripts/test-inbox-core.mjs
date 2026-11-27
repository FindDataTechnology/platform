// Owner-inbox shared read model (openspec: owner-inbox, tasks 4.1 / 4.2).
//
// What this pins, and why each one is load-bearing:
//   • runBatch runs EVERY job even when one fails, and reports per-item
//     receipts — the same "partial failure is a business result" contract the
//     fleet batch endpoint already keeps, now on the client side.
//   • runAction refuses an endpoint the server did not offer (and any non-/api
//     path), so the dispatcher can never become a generic POST primitive.
//   • failed lanes are distinguishable from empty ones: counts come from the
//     envelope, not from summing what happened to load.
//
// Run: node --test scripts/test-inbox-core.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The shared core is authored for a bundler (extensionless relative imports);
// Node's ESM resolver needs the extension, so resolve it the same way
// test-chat-store-resync.mjs does.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
});

const { configureHttp } = await import("../packages/core/src/api/http.ts");
const { runAction, runBatch, itemsInBucket, failedLanes } = await import("../packages/core/src/inbox.ts");

function mockTransport(handler) {
  const calls = [];
  configureHttp({
    baseUrl: "",
    headers: () => ({}),
    transport: async (path, init) => {
      calls.push({ path, init });
      return handler(path, init);
    },
  });
  return calls;
}

const okResp = (body = {}) => ({ ok: true, status: 200, statusText: "OK", json: async () => body });
const errResp = (status, body) => ({ ok: false, status, statusText: "ERR", json: async () => body });

const approveAction = (id) => ({
  op: "approve",
  label: "批准",
  endpoint: `/api/fleets/f1/decisions/${id}/approve`,
  method: "POST",
  bodyShape: { choice: "string" },
  safe: false,
});

test("runBatch: one conflict does not stop the rest, and every job gets a receipt", async () => {
  mockTransport((path) => (path.includes("/b/") ? errResp(409, { error: "first resolution wins" }) : okResp({ ok: true })));
  const jobs = ["a", "b", "c"].map((id) => ({ itemRef: id, action: approveAction(id), body: { choice: "x" } }));
  const receipts = await runBatch(jobs);

  assert.equal(receipts.length, 3);
  assert.deepEqual(receipts.map((r) => r.itemRef), ["a", "b", "c"], "order matches the list order");
  assert.deepEqual(receipts.map((r) => r.ok), [true, false, true], "the middle conflict does not abort the tail");
  assert.match(receipts[1].error, /first resolution wins/);
});

test("runBatch: a throwing job is reported, not propagated", async () => {
  let n = 0;
  mockTransport(() => {
    n += 1;
    if (n === 1) throw new Error("socket died");
    return okResp();
  });
  const jobs = ["a", "b"].map((id) => ({ itemRef: id, action: approveAction(id) }));
  const receipts = await runBatch(jobs);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].ok, false);
  assert.match(receipts[0].error, /socket died/);
  assert.equal(receipts[1].ok, true, "the second job still ran");
});

test("runAction: refuses a non-/api endpoint", async () => {
  mockTransport(() => okResp());
  await assert.rejects(
    () => runAction({ op: "x", label: "x", endpoint: "https://evil.example/post", method: "POST", bodyShape: {}, safe: false }),
    /same-origin \/api path/,
  );
});

test("runAction: refuses an action the server did not offer", async () => {
  mockTransport(() => okResp());
  const offered = [approveAction("a")];
  const forged = { ...approveAction("zzz"), op: "approve" };
  await assert.rejects(() => runAction(forged, {}, offered), /not offered by the server/);
});

test("runAction: sends the JSON body and returns the parsed response", async () => {
  const calls = mockTransport(() => okResp({ ok: true, receipt: 1 }));
  const res = await runAction(approveAction("a"), { choice: "fri" }, [approveAction("a")]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { ok: true, receipt: 1 });
  assert.equal(calls[0].path, "/api/fleets/f1/decisions/a/approve");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, JSON.stringify({ choice: "fri" }));
  assert.equal(calls[0].init.headers["content-type"], "application/json");
});

test("buckets: items are read per bucket, and a failed lane is not an empty one", () => {
  const payload = {
    v: 1,
    sampledAt: 1,
    counts: { waiting: 2, inflight: 1 },
    lanes: [
      { id: "fleet-decision", label: "舰队拍板", status: "ok", items: [
        { bucket: "waiting", itemRef: "a" },
        { bucket: "inflight", itemRef: "b" },
      ] },
      { id: "skill-candidate", label: "技能候选", status: "ok", items: [{ bucket: "waiting", itemRef: "c" }] },
      { id: "persona-candidate", label: "人格修订", status: "error", error: "store down", items: [] },
    ],
  };
  assert.deepEqual(itemsInBucket(payload, "waiting").map((i) => i.itemRef), ["a", "c"]);
  assert.deepEqual(itemsInBucket(payload, "inflight").map((i) => i.itemRef), ["b"]);
  assert.deepEqual(failedLanes(payload).map((l) => l.id), ["persona-candidate"]);
  // The failed lane contributes nothing to the counts, and the envelope's own
  // numbers are what the UI shows — so a partially-read inbox can never be
  // mistaken for a smaller-but-complete one.
  assert.equal(payload.counts.waiting, 2, "counts come from the envelope, not from a client sum");
  assert.equal(itemsInBucket(null, "waiting").length, 0);
  assert.deepEqual(failedLanes(null), []);
});

test("buckets: a notification lane is surfaced first, and nothing else is reordered", () => {
  // Found live 2026-11-24: fleet-decision can hold hundreds of items, and a
  // broadcast notice appended after them rendered at position 35 of 37 even
  // though the API returned it.
  const payload = {
    v: 1, sampledAt: 1, counts: { waiting: 3, inflight: 0 },
    lanes: [
      { id: "fleet-decision", label: "舰队拍板", status: "ok", items: [
        { bucket: "waiting", itemRef: "d1" }, { bucket: "waiting", itemRef: "d2" } ] },
      { id: "skill-candidate", label: "技能候选", status: "ok", items: [{ bucket: "waiting", itemRef: "s1" }] },
      { id: "notification", label: "消息通知", status: "ok", items: [
        { bucket: "waiting", itemRef: "n1" }, { bucket: "waiting", itemRef: "n2" } ] },
    ],
  };
  assert.deepEqual(itemsInBucket(payload, "waiting").map((i) => i.itemRef), ["n1", "n2", "d1", "d2", "s1"]);
  assert.equal(payload.lanes[0].id, "fleet-decision", "read-side ordering, not a mutation");
});
