// ── Runtime verdict writeback (openspec bind-fleet-turn-to-bench-verdict) ────
//
// The seam that closes an attempt reports to the peer on its own, so a round's
// verdict fact no longer depends on the agent calling a tool. These tests pin
// the three properties that keep that safe:
//   • never throws (a slow/absent/undeployed peer is a fact, not a crash)
//   • never guesses the outcome (interrupted ≠ failed ≠ skipped)
//   • never blocks or fails the turn (no peer configured → skip whole)
//
//   node --test scripts/test-bench-turn-writeback.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  buildWritebackArgs,
  outcomeForCloseReason,
  writebackTurnVerdict,
  RUN_OUTCOMES,
} = await import("../lib/bench-turn-writeback.js");

const ENV = {
  BENCH_URL: "http://bench.test",
  BENCH_FLEET_TOKEN: "fleet-token-000",
  BENCH_PROPOSAL_DOMAIN: "legal",
};

// The client resolves the fleet's own ref by listing work orders first, so every
// transport must answer that call before the run report.
const LIST_BODY = { domain: "legal", fleet_ref: "fleet_test", count: 0, work_orders: [] };

function recorder(runReply) {
  const sent = [];
  const transport = async (req) => {
    sent.push(req);
    if (String(req.url).endsWith("/work-orders")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(LIST_BODY) };
    }
    return runReply(req);
  };
  return { sent, transport };
}

function claimHarness() {
  const writes = [];
  return { writes, setBenchRunId: (ref, id) => { writes.push([ref, id]); return { ok: true, applied: true, bench_run_id: id }; } };
}

test("terminal reason → run outcome keeps interrupted apart from failed", () => {
  assert.equal(outcomeForCloseReason("ok"), "ok");
  assert.equal(outcomeForCloseReason("failed"), "failed");
  assert.equal(outcomeForCloseReason("skipped"), "skipped");
  // The three NOT-a-failure reasons all map to `skipped`, never `failed`.
  for (const r of ["interrupted", "cancelled", "lease_expired"]) {
    assert.equal(outcomeForCloseReason(r), "skipped", `${r} must not become failed`);
  }
  // An unknown reason is not guessed into any of the four.
  assert.equal(outcomeForCloseReason("mystery"), null);
  // Every mapped value is a real peer outcome.
  for (const r of ["ok", "failed", "skipped"]) assert.ok(RUN_OUTCOMES.includes(outcomeForCloseReason(r)));
});

test("buildWritebackArgs refuses incomplete attribution instead of guessing", () => {
  assert.equal(buildWritebackArgs({ handle: { turnRef: "t" }, post: null, role: "r", outcome: "ok" }), null);
  assert.equal(buildWritebackArgs({ handle: { turnRef: "t" }, post: "p", role: "", outcome: "ok" }), null);
  assert.equal(buildWritebackArgs({ handle: { turnRef: "t" }, post: "p", role: "r", outcome: "mystery" }), null);
});

test("buildWritebackArgs carries the turn address as the idempotency anchor", () => {
  const args = buildWritebackArgs({
    handle: { turnRef: "platform:cell:abc:turn-1" },
    post: "post_x", role: "builder", outcome: "ok",
  });
  assert.equal(args.turnRef, "platform:cell:abc:turn-1");
  assert.equal(args.post, "post_x");
  assert.equal(args.role, "builder");
  assert.equal(args.outcome, "ok");
});

test("an unconfigured peer is skipped whole, and the turn is not touched", async () => {
  const out = await writebackTurnVerdict({
    handle: { turnRef: "t" }, post: "p", role: "r", outcome: "ok",
    env: {}, // no BENCH_URL / token / domain
  });
  assert.equal(out.status, "skipped");
  assert.equal(out.reason, "not-configured");
});

test("a successful report stores the peer id on the claim and reports sent", async () => {
  const { transport } = recorder(() => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ run: { id: 41, runner_ref: "x" }, created: true }),
  }));
  const claims = claimHarness();
  const out = await writebackTurnVerdict({
    claims,
    handle: { turnRef: "t" },
    post: "p", role: "r", outcome: "ok",
    env: ENV, transport,
  });
  assert.equal(out.status, "sent");
  assert.equal(out.benchRunId, 41);
  assert.deepEqual(claims.writes, [["t", "41"]]);
});

test("a peer that accepts the run but drops the verdict is reported as sent/dropped", async () => {
  const { transport } = recorder((req) => {
    if (String(req.url).endsWith("/work-orders")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(LIST_BODY) };
    }
    if (String(req.url).endsWith("/verdicts")) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ detail: "not deployed" }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ run: { id: 41 }, created: true }) };
  });
  const out = await writebackTurnVerdict({
    claims: claimHarness(),
    handle: { turnRef: "t" },
    post: "p", role: "r", outcome: "ok",
    verdict: {
      ruler_kind: "rubric", ruler_key: "k", ruler_digest: "d".repeat(64),
      ruling_domain_path: "legal", gate: "all-pass", outcome: "pass",
    },
    env: ENV, transport,
  });
  assert.equal(out.status, "sent");
  assert.ok(["dropped", "write-face-absent"].includes(out.verdictState), `got ${out.verdictState}`);
});

test("a refused/failed report becomes an error fact, never a throw", async () => {
  const { transport } = recorder(() => ({
    ok: false, status: 404,
    text: async () => JSON.stringify({ detail: "not deployed" }),
  }));
  const out = await writebackTurnVerdict({
    handle: { turnRef: "t" }, post: "p", role: "r", outcome: "ok",
    env: ENV, transport,
  });
  assert.equal(out.status, "error");
  assert.ok(typeof out.reason === "string" && out.reason.length > 0);
});

test("incomplete attribution never reaches the network", async () => {
  const { sent, transport } = recorder(() => ({ ok: true, status: 200, text: async () => "{}" }));
  const out = await writebackTurnVerdict({
    handle: { turnRef: "t" }, post: null, role: "r", outcome: "ok",
    env: ENV, transport,
  });
  assert.equal(out.status, "skipped");
  assert.equal(sent.length, 0, "no post ⇒ no request");
});