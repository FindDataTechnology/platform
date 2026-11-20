#!/usr/bin/env node
// ── Bench ops client + MCP tools tests (openspec: add-bench-ops-tools) ──
//
// The four hands decide whether a round can be trusted to have DONE the work it
// claims, so the tests pin what a report can lie about:
//   • an identity prefix the caller supplies (must be built from the peer's own
//     answer, never accepted from config or arguments)
//   • a refusal rendered as success (any 4xx throws, with a usable kind)
//   • "the route is not deployed" collapsed into "your credential is wrong"
//     (404 generic vs 404 naming a domain; 403 = ours is not the assignee)
//   • new vs idempotent hit conflated (created must survive the round trip)
//   • the token leaking into a message
//
// No sockets: both the client and the MCP child take a `transport` seam.
//
//   node --test scripts/test-bench-ops-client.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

const {
  OPS_REFUSALS,
  claimWorkOrder,
  completeWorkOrder,
  listWorkOrders,
  recordRun,
  resolveFleetRef,
} = await import("../lib/bench-ops-client.js");
const { REFUSALS, BenchProposalError } = await import("../lib/bench-proposal-client.js");
const {
  toolClaim, toolList, toolRunReport, toolVerdictList, toolVerdictGet, toolRulerList,
} = await import("../server/bench-ops-mcp.js");
const { listVerdicts, getVerdict, listRulers } =
  await import("../lib/bench-ops-client.js");

const TOKEN = "bench-consumer-token-value-0123456789";
//: Both credentials are present on purpose: they belong to two different faces
//: (machine = X-Consumer-Token, proposal = api key/JWT). The header tests below
//: prove the client reads the right one rather than the first that exists.
const PROPOSAL_TOKEN = "lbk_proposal_face_only_0000000000";
const ENV = {
  BENCH_URL: "http://bench.test",
  BENCH_FLEET_TOKEN: TOKEN,
  BENCH_CONSUMER_TOKEN: PROPOSAL_TOKEN,
  BENCH_PROPOSAL_DOMAIN: "legal",
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function recorder(reply) {
  const sent = [];
  const transport = async (req) => {
    sent.push(req);
    return typeof reply === "function" ? reply(req) : reply;
  };
  return { sent, transport };
}

const LIST_BODY = {
  domain: "legal",
  fleet_ref: "fleet_1794335712751_wfa3ww",
  count: 1,
  work_orders: [
    {
      id: 12,
      target_kind: "domain",
      target_key: "legal",
      title: "补三条主体",
      detail: null,
      status: "pending",
      created_at: "2026-11-14T00:00:00Z",
      claimed_by: null,
    },
  ],
};

// ── identity comes from the peer ─────────────────────────────────────────────

test("list reads the fleet's own ref from the peer's answer", async () => {
  const { sent, transport } = recorder(jsonResponse(200, LIST_BODY));
  const out = await listWorkOrders({ env: ENV, transport });
  assert.equal(out.fleetRef, "fleet_1794335712751_wfa3ww");
  assert.equal(out.count, 1);
  assert.equal(out.workOrders[0].id, 12);
  assert.equal(sent[0].method, "GET");
  assert.equal(sent[0].url, "http://bench.test/api/v1/distribution/legal/work-orders");
  assert.deepEqual(sent[0].body, undefined, "a list must not send a body");
});

test("a list answer without fleet_ref refuses to invent one", async () => {
  const { transport } = recorder(jsonResponse(200, { domain: "legal", work_orders: [] }));
  await assert.rejects(
    () => resolveFleetRef({ env: ENV, transport }),
    (err) => err instanceof BenchProposalError && err.kind === REFUSALS.CONFIG,
  );
});

test("runner_ref is built from the peer's ref and the turn's post, never accepted", async () => {
  const { sent, transport } = recorder((req) =>
    req.method === "GET"
      ? jsonResponse(200, LIST_BODY)
      : taskEnvelope({ id: 7, status: "in_progress" }, true),
  );
  const out = await recordRun(
    { post: "post_deployer", round: 2, role: "concept", outcome: "ok", counts: { drafts: 3 } },
    { env: ENV, transport },
  );
  assert.equal(out.runnerRef, "fleet:fleet_1794335712751_wfa3ww/post_deployer#2");
  const post = sent.at(-1);
  assert.equal(post.body.runner_ref, out.runnerRef);
  assert.equal(post.body.role, "concept");
  assert.deepEqual(post.body.counts, { drafts: 3 });
  assert.equal(sent.length, 2, "one list to learn the ref, then the report");
});

test("a post with whitespace is refused before anything is sent", async () => {
  const { sent, transport } = recorder(jsonResponse(200, LIST_BODY));
  await assert.rejects(
    () => recordRun({ post: "a b", round: 1, role: "r", outcome: "ok" }, { env: ENV, transport }),
    (err) => err instanceof BenchProposalError && err.kind === REFUSALS.CONFIG,
  );
  assert.equal(sent.length, 0, "nothing may be sent for a malformed identity");
});

// ── 404: "not deployed" vs "that thing is missing" ───────────────────────────

test("a generic 404 is reported as the surface not being deployed", async () => {
  const { transport } = recorder(jsonResponse(404, { detail: "Not Found" }));
  await assert.rejects(
    () => listWorkOrders({ env: ENV, transport }),
    (err) => {
      assert.equal(err.kind, OPS_REFUSALS.NOT_DEPLOYED);
      assert.match(err.message, /not deployed/);
      assert.match(err.message, /BENCH_URL/, "the remedy must be in the message");
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("a 404 that names a domain is a missing thing, not a missing route", async () => {
  const { transport } = recorder(jsonResponse(404, { detail: "域 'nope' 不存在" }));
  await assert.rejects(
    () => listWorkOrders({ env: ENV, transport }),
    (err) => {
      assert.equal(err.kind, OPS_REFUSALS.NOT_FOUND);
      assert.ok(!/not deployed/.test(err.message));
      return true;
    },
  );
});

// ── refusals are usable, and never machine-retried ───────────────────────────

test("409 is a conflict and is not retryable", async () => {
  const { transport } = recorder(jsonResponse(409, { detail: "该工单已被其它舰队认领" }));
  await assert.rejects(
    () => claimWorkOrder(12, { env: ENV, transport }),
    (err) => {
      assert.equal(err.kind, OPS_REFUSALS.CONFLICT);
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("403 keeps the peer's words and is not retryable", async () => {
  const { transport } = recorder(jsonResponse(403, { detail: "该工单不是派给舰队 'x' 的" }));
  await assert.rejects(
    () => claimWorkOrder(12, { env: ENV, transport }),
    (err) => {
      assert.equal(err.kind, REFUSALS.FORBIDDEN);
      assert.match(err.message, /派给舰队/);
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test("422 is an invalid body, 5xx is retryable", async () => {
  const bad = recorder(jsonResponse(422, { detail: "outcome 不在四态内" }));
  await assert.rejects(
    () => recordRun({ post: "p", round: 1, role: "r", outcome: "weird" }, { env: ENV, transport: bad.transport }),
    (err) => err.kind === OPS_REFUSALS.INVALID && err.retryable === false,
  );

  const down = recorder((req) =>
    req.method === "GET" ? jsonResponse(200, LIST_BODY) : jsonResponse(503, { detail: "unavailable" }),
  );
  await assert.rejects(
    () => recordRun({ post: "p", round: 1, role: "r", outcome: "ok" }, { env: ENV, transport: down.transport }),
    (err) => err.kind === REFUSALS.SERVER && err.retryable === true,
  );
});

test("only one auth header is sent, chosen by the token's prefix", async () => {
  const { sent, transport } = recorder(jsonResponse(200, LIST_BODY));
  await listWorkOrders({ env: ENV, transport });
  // The transport receives the bare token; the header choice lives in
  // authHeaders(), which the proposal client's tests already pin. What matters
  // here is that we did not send two credentials.
  assert.equal(sent[0].token, TOKEN);
  const { authHeaders } = await import("../lib/bench-proposal-client.js");
  assert.deepEqual(authHeaders("lbk_abc123"), { "x-api-key": "lbk_abc123" });
  assert.deepEqual(authHeaders("eyJhbGciOi"), { authorization: "Bearer eyJhbGciOi" });
});

test("the token never appears in an error message", async () => {
  const { transport } = recorder(jsonResponse(403, { detail: `token ${TOKEN} is not a fleet` }));
  await assert.rejects(
    () => listWorkOrders({ env: ENV, transport }),
    (err) => {
      assert.ok(!err.message.includes(TOKEN), "the credential leaked into an error");
      return true;
    },
  );
});

// ── idempotency survives the round trip ─────────────────────────────────────

//: The peer's write answers are ENVELOPED — `{task, created}` for claim/complete,
//: `{run, created}` for the run report. These fixtures are copied from the routes
//: (`src/web/routes/distribution.py`), not from what this module would like them
//: to be: the first version of these tests replied flat, so they happily pinned a
//: mapping that returned `status: ""` and `id: null` against the real peer.
function taskEnvelope(task, created, extra = {}) {
  return jsonResponse(200, { task, created, ...extra });
}
function runEnvelope(run, created) {
  return jsonResponse(200, { run, created });
}

test("created=false is preserved for repeat claim / complete / report", async () => {
  const { transport } = recorder((req) =>
    req.method === "GET"
      ? jsonResponse(200, LIST_BODY)
      : req.url.endsWith("/runs")
        ? runEnvelope({ id: 9, runner_ref: "fleet:x/p#1", created: false }, false)
        : taskEnvelope({ id: 1, status: "in_progress" }, false),
  );
  assert.equal((await claimWorkOrder(12, { env: ENV, transport })).created, false);
  assert.equal((await completeWorkOrder(12, { note: "done" }, { env: ENV, transport })).created, false);
  assert.equal(
    (await recordRun({ post: "p", round: 1, role: "r", outcome: "ok" }, { env: ENV, transport })).created,
    false,
  );
});

test("the envelope is unwrapped: status / id / claimed_by come from the task row", async () => {
  // A claim that worked but reports `status: ""` is indistinguishable from a
  // half-applied one, and the fleet's round report has to say which seat holds
  // the order. So the fields must come from inside `task`, not from the envelope.
  const { transport } = recorder((req) => {
    if (req.method === "GET") return jsonResponse(200, LIST_BODY);
    if (req.url.endsWith("/runs")) {
      return runEnvelope(
        { id: 41, runner_ref: "fleet:fleet_1794335712751_wfa3ww/p#1", created_at: "x" },
        true,
      );
    }
    return taskEnvelope(
      { id: 3, status: "in_progress", assignee_ref: "fleet_1794335712751_wfa3ww" },
      true,
      { claimed_by: "fleet_1794335712751_wfa3ww" },
    );
  });

  const claimed = await claimWorkOrder(3, { env: ENV, transport });
  assert.deepEqual(
    { id: claimed.id, status: claimed.status, claimedBy: claimed.claimedBy, created: claimed.created },
    { id: 3, status: "in_progress", claimedBy: "fleet_1794335712751_wfa3ww", created: true },
  );

  const completed = await completeWorkOrder(3, { note: "ok" }, { env: ENV, transport });
  assert.equal(completed.id, 3);
  assert.equal(completed.status, "in_progress");
  assert.equal(completed.created, true);

  const run = await recordRun({ post: "p", round: 1, role: "r", outcome: "ok" }, { env: ENV, transport });
  assert.equal(run.id, 41, "the run id lives inside `run`");
  assert.equal(run.runnerRef, "fleet:fleet_1794335712751_wfa3ww/p#1");
});


// ── the MCP shell ───────────────────────────────────────────────────────────

test("tool list / claim / report shape their answers for a round report", async () => {
  const { transport } = recorder((req) =>
    req.method === "GET"
      ? jsonResponse(200, LIST_BODY)
      : taskEnvelope({ id: 3, status: "in_progress" }, true),
  );
  const listed = await toolList({}, { env: ENV, transport });
  const payload = JSON.parse(listed.content[0].text);
  assert.equal(payload.fleet_ref, "fleet_1794335712751_wfa3ww");
  assert.equal(payload.count, 1);

  const claimed = await toolClaim({ task_id: 12 }, { env: ENV, transport });
  assert.equal(JSON.parse(claimed.content[0].text).result, "已认领");

  const reported = await toolRunReport(
    { post: "post_x", round: 1, role: "concept", outcome: "ok" },
    { env: ENV, transport },
  );
  const rep = JSON.parse(reported.content[0].text);
  assert.equal(rep.runnerRef, "fleet:fleet_1794335712751_wfa3ww/post_x#1");
  assert.equal(rep.result, "已记入台账");
});

test("a tool failure is isError with the kind spelled out (never a silent empty list)", async () => {
  const { transport } = recorder(jsonResponse(404, { detail: "Not Found" }));
  const out = await toolList({}, { env: ENV, transport });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /not_deployed/);
});

// ── verdict ledger reads (add-bench-verdict-read-face) ──────────────────────

const VERDICT_ROW = {
  id: 41,
  subject_kind: "pack",
  subject_key: "ontology-builder",
  subject_version: "v4",
  ruler_kind: "rubric",
  ruler_key: "contract_sale_v1",
  ruler_digest: "a".repeat(64),
  gate: "all-pass",
  outcome: "pass",
  provisional: true,
  baseline_run_id: null,
};

const VERDICT_BODY = { domain: "legal", count: 1, verdicts: [VERDICT_ROW] };

test("verdict list passes outcome and provisional through untouched", async () => {
  const { sent, transport } = recorder(jsonResponse(200, VERDICT_BODY));
  const out = await listVerdicts({}, { env: ENV, transport });
  assert.equal(out.count, 1);
  assert.equal(out.verdicts[0].outcome, "pass");
  assert.equal(out.verdicts[0].provisional, true, "provisional is the peer's call, not ours");
  assert.equal(sent[0].url, "http://bench.test/api/v1/distribution/legal/verdicts");
});

test("inconclusive is never folded into pass or fail", async () => {
  const body = { ...VERDICT_BODY, verdicts: [{ ...VERDICT_ROW, outcome: "inconclusive" }] };
  const { transport } = recorder(jsonResponse(200, body));
  const out = await listVerdicts({}, { env: ENV, transport });
  assert.equal(out.verdicts[0].outcome, "inconclusive");
});

test("filters reach the peer as query params, unknown gate refused locally", async () => {
  const { sent, transport } = recorder(jsonResponse(200, VERDICT_BODY));
  await listVerdicts(
    { subjectKind: "pack", subjectKey: "ontology-builder", gate: "calibrated", outcome: "pass" },
    { env: ENV, transport },
  );
  const url = new URL(sent[0].url);
  assert.equal(url.searchParams.get("subject_kind"), "pack");
  assert.equal(url.searchParams.get("subject_key"), "ontology-builder");
  assert.equal(url.searchParams.get("gate"), "calibrated");
  assert.equal(url.searchParams.get("outcome"), "pass");

  await assert.rejects(
    () => listVerdicts({ gate: "better-than" }, { env: ENV, transport: async () => { throw new Error("must not reach the socket"); } }),
    /better-than/,
  );
});

test("a 404 on the verdict route is not_deployed, never an empty list", async () => {
  const { transport } = recorder(jsonResponse(404, {}));
  await assert.rejects(
    () => listVerdicts({}, { env: ENV, transport }),
    (e) => e.kind === OPS_REFUSALS.NOT_DEPLOYED,
  );
});

test("an empty ledger is a real, distinct answer", async () => {
  const { transport } = recorder(jsonResponse(200, { domain: "legal", count: 0, verdicts: [] }));
  const out = await listVerdicts({}, { env: ENV, transport });
  assert.equal(out.count, 0);
  assert.deepEqual(out.verdicts, []);
});

test("verdict get returns the per-criterion evidence", async () => {
  const detail = {
    ...VERDICT_ROW,
    criteria_results: [{ criterion_id: "c1", verdict: "pass", reasoning: "ok" }],
  };
  const { sent, transport } = recorder(jsonResponse(200, { verdict: detail }));
  const v = await getVerdict(41, { env: ENV, transport });
  assert.equal(v.criteria_results.length, 1);
  assert.equal(sent[0].url, "http://bench.test/api/v1/distribution/legal/verdicts/41");
});

test("rulers list answers with digests", async () => {
  const rulers = [{ kind: "rubric", key: "contract_sale_v1", digest: "b".repeat(64) }];
  const { transport } = recorder(jsonResponse(200, { domain: "legal", count: 1, rulers }));
  const out = await listRulers({ env: ENV, transport });
  assert.equal(out.rulers[0].digest.length, 64);
});

test("the run outcome and the verdict outcome are different vocabularies", async () => {
  // This is the bug the first draft of the read face introduced: both payloads
  // had a field called `outcome`, so a run's "ok" was validated against the
  // ledger's pass/fail/inconclusive set and every plain report started failing.
  const { sent, transport } = recorder(
    (req) =>
      req.url.endsWith("/work-orders")
        ? jsonResponse(200, LIST_BODY)
        : jsonResponse(200, { id: 7, created: true }),
  );
  await recordRun({ post: "builder", round: 1, role: "builder", outcome: "ok" }, { env: ENV, transport });
  const body = sent.find((r) => r.url.endsWith("/runs")).body;
  assert.equal(body.outcome, "ok", "run outcome keeps its own four-state vocabulary");
  assert.equal(body.verdict, undefined, "no verdict was reported, so none is sent");
});

test("verdict identity under recordRun is all-or-nothing", async () => {
  const { transport } = recorder(jsonResponse(200, LIST_BODY));
  await assert.rejects(
    () =>
      recordRun(
        {
          post: "builder", round: 1, role: "builder", outcome: "ok",
          verdict: { ruler_kind: "rubric", ruler_key: "r", ruler_digest: "d".repeat(64), gate: "all-pass" },
        },
        { env: ENV, transport },
      ),
    /outcome/,
  );
});

test("a complete verdict rides the run report under its own key", async () => {
  const { sent, transport } = recorder(
    (req) =>
      req.url.endsWith("/work-orders")
        ? jsonResponse(200, LIST_BODY)
        : jsonResponse(200, { id: 8, created: true }),
  );
  await recordRun(
    {
      post: "builder", round: 2, role: "builder", outcome: "ok",
      verdict: {
        ruler_kind: "rubric", ruler_key: "contract_sale_v1",
        ruler_digest: "c".repeat(64), gate: "all-pass", outcome: "inconclusive",
      },
    },
    { env: ENV, transport },
  );
  const body = sent.find((r) => r.url.endsWith("/runs")).body;
  assert.equal(body.verdict.outcome, "inconclusive");
  assert.equal(body.verdict.gate, "all-pass");
  assert.equal(body.outcome, "ok", "the two vocabularies never merge");
});

test("the three read tools answer with JSON, not an error", async () => {
  const listOut = await toolVerdictList(
    {}, { env: ENV, transport: recorder(jsonResponse(200, VERDICT_BODY)).transport },
  );
  assert.equal(listOut.isError, undefined);
  assert.equal(JSON.parse(listOut.content[0].text).count, 1);

  const getOut = await toolVerdictGet(
    { run_id: 41 }, { env: ENV, transport: recorder(jsonResponse(200, { verdict: VERDICT_ROW })).transport },
  );
  assert.equal(getOut.isError, undefined);
  assert.equal(JSON.parse(getOut.content[0].text).verdict.id, 41);

  const rulers = [{ kind: "rubric", key: "r", digest: "b".repeat(64) }];
  const rulerOut = await toolRulerList(
    {}, { env: ENV, transport: recorder(jsonResponse(200, { count: 1, rulers })).transport },
  );
  assert.equal(rulerOut.isError, undefined);
});

test("a config error surfaces the missing env var, never an empty list", async () => {
  const out = await toolVerdictList({}, { env: {}, transport: async () => jsonResponse(200, VERDICT_BODY) });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /config|BENCH/i);
});

// ── the credential channel (the defect these tests exist for) ───────────────
//
// `/api/v1/distribution/*` authenticates on X-Consumer-Token and nothing else.
// The first version of this client reused the proposal face's `authHeaders()`,
// so an `lbk_` value rode X-API-Key and anything else rode Bearer — every call
// 401'd on the wire while all 14 tests were green, because each one injected
// `transport` and none inspected the headers it was handed.

test("the machine faces ride X-Consumer-Token — and no other auth header", async () => {
  const { sent, transport } = recorder(jsonResponse(200, LIST_BODY));
  await listWorkOrders({ env: ENV, transport });
  await claimWorkOrder(12, { env: ENV, transport });
  await recordRun({ post: "p", round: 1, role: "r", outcome: "ok" }, { env: ENV, transport });

  for (const req of sent) {
    assert.equal(req.headers["x-consumer-token"], TOKEN);
    assert.equal(req.headers["x-api-key"], undefined, "X-API-Key is the proposal face's channel");
    assert.equal(req.headers.authorization, undefined, "Bearer is the proposal face's channel");
  }
});

test("a token that LOOKS like an api key is still sent as X-Consumer-Token", async () => {
  // The regression guard for re-importing authHeaders(): a prefix branch that
  // came back would put this value on X-API-Key and 401 every call.
  const { sent, transport } = recorder(jsonResponse(200, LIST_BODY));
  await listWorkOrders({ env: { ...ENV, BENCH_FLEET_TOKEN: "lbk_looks_like_a_key" }, transport });
  assert.equal(sent[0].headers["x-consumer-token"], "lbk_looks_like_a_key");
  assert.equal(sent[0].headers["x-api-key"], undefined);
});

test("the proposal credential cannot stand in for the fleet token", async () => {
  // Only BENCH_CONSUMER_TOKEN is set: a fallback would send the proposal api
  // key to the machine face, whose 403 「未登记」 reads as "the fleet was
  // deleted". So this must be a config error that names the missing var, and it
  // must happen before any socket is opened.
  const { BENCH_FLEET_TOKEN: _drop, ...noFleetToken } = ENV;
  const { sent, transport } = recorder(jsonResponse(200, LIST_BODY));
  await assert.rejects(
    () => listWorkOrders({ env: noFleetToken, transport }),
    (err) => {
      assert.equal(err.kind, REFUSALS.CONFIG);
      assert.match(err.message, /BENCH_FLEET_TOKEN/);
      assert.match(err.message, /BENCH_CONSUMER_TOKEN/);
      return true;
    },
  );
  assert.equal(sent.length, 0, "a config error must not reach the network");
});

test("the MCP shell reports the missing fleet token as a config error, not a crash", async () => {
  const { BENCH_FLEET_TOKEN: _drop, ...noFleetToken } = ENV;
  const out = await toolList({}, { env: noFleetToken, transport: async () => jsonResponse(200, {}) });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /BENCH_FLEET_TOKEN/);
});

test("the example row forwards the fleet credential (and never the proposal one)", async () => {
  // Same failure family as the bench-proposal row's drift test: dsh scrubs
  // credential-shaped names from MCP children, so a var that is not in envRefs
  // never arrives and the tools degrade to "target not configured" in
  // production while the manifest looks correct. The second half is the half
  // that was wrong: forwarding BENCH_CONSUMER_TOKEN here would hand the machine
  // face an api key, i.e. a guaranteed 401 dressed as a wiring problem.
  const { readFileSync } = await import("node:fs");
  const raw = JSON.parse(readFileSync(new URL("../mcp.example.json", import.meta.url), "utf8"));
  const row = raw.mcpServers["bench-ops"];
  assert.ok(row, "mcp.example.json must carry the bench-ops row");
  assert.deepEqual(row.args, ["server/bench-ops-mcp.js"]);
  const refs = row.envRefs ?? [];
  for (const name of ["BENCH_URL", "BENCH_FLEET_TOKEN", "BENCH_PROPOSAL_DOMAIN"]) {
    assert.ok(refs.includes(name), `${name} must be forwarded via envRefs`);
  }
  assert.ok(
    !refs.includes("BENCH_CONSUMER_TOKEN"),
    "BENCH_CONSUMER_TOKEN is the proposal face's credential and must not be forwarded here",
  );
  assert.ok(!/lbk_[A-Za-z0-9_-]{6,}/.test(JSON.stringify(row)), "no credential in the example");
});
