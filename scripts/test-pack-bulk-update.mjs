// Bulk-update branches (add-pack-bulk-update 2.3 / 2.4 / 1.1).
//
// The web package has no test runner, so the outcome rules were split into a
// pure module (web/src/lib/pack-bulk-update.ts) that this harness can import.
// Every branch the UI depends on is pinned here — including the two the
// production acceptance run could not produce (a failure, and a pack that
// reaches "latest" between listing and execution).
//
// Run: node --test scripts/test-pack-bulk-update.mjs

import test from "node:test";
import assert from "node:assert/strict";

// Node 26 strips TypeScript types natively, so the module is imported as-is —
// no regex-based type stripping (which silently rots when an annotation shape
// changes, and did: it left `latest: object,` behind).
const { updatablesFrom, runBulkUpdate } = await import("../web/src/lib/pack-bulk-update.ts");

const pack = (packId, name, version) => ({ packId, name, version });

// ── 1.1 one derivation ──────────────────────────────────────────────────────

test("updatablesFrom picks exactly the packs whose market version is newer", () => {
  const packs = [pack("a", "A", 1), pack("b", "B", 3), pack("c", "C", 5)];
  const latest = { a: 2, b: 3, c: 4 };
  assert.deepEqual(updatablesFrom(packs, latest).map((p) => p.packId), ["a"]);
});

test("a pack absent from the market map is never treated as updatable", () => {
  // Partially readable market: we must not invent an upgrade for a pack whose
  // latest version we do not know.
  const packs = [pack("unknown", "U", 1)];
  assert.deepEqual(updatablesFrom(packs, {}), []);
});

test("equal version is not an update", () => {
  assert.deepEqual(updatablesFrom([pack("a", "A", 2)], { a: 2 }), []);
});

// ── 2.4 already-latest ──────────────────────────────────────────────────────

test("a pack that became latest before execution reports already-latest, not failed", async () => {
  let installed = false;
  const results = await runBulkUpdate([pack("a", "A", 2)], {
    // Market now says 2 — the same version we already have.
    subscribe: async () => ({ packId: "a", version: 2 }),
    install: async () => {
      installed = true;
    },
  });
  assert.deepEqual(results, [{ packId: "a", name: "A", status: "already-latest" }]);
  assert.equal(installed, false, "must not reinstall the same version");
});

test("a missing subscription record reports already-latest", async () => {
  const results = await runBulkUpdate([pack("a", "A", 1)], {
    subscribe: async () => null,
    install: async () => {},
  });
  assert.equal(results[0].status, "already-latest");
});

// ── 2.3 failure isolation ───────────────────────────────────────────────────

test("a failure on one pack does not stop the rest", async () => {
  const calls = [];
  const results = await runBulkUpdate([pack("a", "A", 1), pack("b", "B", 1), pack("c", "C", 1)], {
    subscribe: async (id) => {
      calls.push(id);
      if (id === "b") throw new Error("market unreachable");
      return { packId: id, version: 2 };
    },
    install: async () => {},
  });
  assert.deepEqual(calls, ["a", "b", "c"], "the third pack is still attempted");
  assert.deepEqual(results.map((r) => r.status), ["updated", "failed", "updated"]);
  assert.equal(results[1].error, "market unreachable", "the failure carries its reason");
});

test("an install failure is failed, not already-latest", async () => {
  const results = await runBulkUpdate([pack("a", "A", 1)], {
    subscribe: async () => ({ packId: "a", version: 2 }),
    install: async () => {
      throw new Error("install exploded");
    },
  });
  assert.equal(results[0].status, "failed");
  assert.equal(results[0].error, "install exploded");
});

// ── 2.1 serial + progress ───────────────────────────────────────────────────

test("execution is serial and progress counts up", async () => {
  const order = [];
  const progress = [];
  await runBulkUpdate([pack("a", "A", 1), pack("b", "B", 1)], {
    subscribe: async (id) => {
      order.push(`sub:${id}`);
      await new Promise((r) => setTimeout(r, 5));
      return { packId: id, version: 2 };
    },
    install: async (id) => {
      order.push(`inst:${id}`);
    },
    onProgress: (done, total) => progress.push(`${done}/${total}`),
  });
  assert.deepEqual(order, ["sub:a", "inst:a", "sub:b", "inst:b"], "a completes before b starts");
  assert.deepEqual(progress, ["1/2", "2/2"]);
});
