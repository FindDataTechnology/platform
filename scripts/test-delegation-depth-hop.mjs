// Delegation depth, hop by hop (openspec: add-team-as-a2a-agent, group 1).
//
// The depth header is the only thing standing between a delegation chain and a
// cross-request cycle. It has to hold in three places at once, and each of them
// has a wrong version that looks fine:
//
//   inbound   — a request at/over the cap is refused BEFORE any turn starts.
//               Refusing after the spawn still burns a slot and writes rows, so
//               the "refused" chain leaves a trail that says it ran.
//   hand-off  — the inbound depth must reach the turn verbatim. A dropped value
//               silently resets every chain to 0.
//   outbound  — the header must be inbound + 1. It now IS: all three outbound
//               lanes (cron, the agent chat, team dispatch) go through
//               `outboundDelegationDepth`, and the tests below assert the value
//               that reaches the wire — not the argument at the call site.
//               Note the interaction with the cap: inbound 2 derives 3, which is
//               DELEGATION_DEPTH_BOUND, so that hop is refused before it leaves
//               the process. That is why task 1.4 (the real depth distribution
//               in production) gates shipping this wiring.
//
//   node --test scripts/test-delegation-depth-hop.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAgentApp } from "../agent-runner/a2a.js";
import { runA2aTurn, DELEGATION_DEPTH_BOUND, outboundDelegationDepth } from "../server/a2a-client.js";
import { buildTurnRequest } from "../server/turn-request.js";

const ENTRY = { path: "/packs/p/analyst", name: "分析师", ref: "pack:analyst" };

/**
 * Every listener this file opens, closed once at the end.
 *
 * Per-test `close()` is not enough: a failing assertion throws BEFORE it runs,
 * the server keeps the event loop alive, and the runner waits forever — so a
 * regression shows up as a 3-minute hang instead of one red line. (Learned the
 * hard way while proving this file's own gate.)
 */
const OPEN = [];
test.after(() => Promise.all(OPEN.map((srv) => new Promise((r) => srv.close(r)))));

/** Boot the real adapter with a manager that records every turn. */
async function boot({ delegationDepthMax = 3, paused = false } = {}) {
  const turns = [];
  const manager = {
    isPaused: () => paused,
    turn: async (_entry, _sessionId, text, opts) => {
      turns.push({ text, opts });
      return { text: `（答复）${text}` };
    },
  };
  const app = createAgentApp({
    entry: ENTRY,
    manager,
    config: { backendToken: "", registryUrl: "http://registry.test", delegationDepthMax },
    log: { log() {}, warn() {}, error() {} },
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  OPEN.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (text, headers = {}) =>
    fetch(`${base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "message/send",
        params: { message: { parts: [{ kind: "text", text }] } },
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { call, turns, manager, close: () => srv.close() };
}

// ── 1.3 the refusal precedes every turn ───────────────────────────────────

test("1.3 a chained call at the cap is refused with a structured depth error", async () => {
  const { call, turns, close } = await boot({ delegationDepthMax: 3 });
  const out = await call("继续委派", { "x-delegation-depth": "3" });

  assert.equal(out.status, 200, "JSON-RPC errors ride a 200");
  assert.equal(out.body.error?.code, -32011, "a named code, not a generic failure");
  assert.match(out.body.error.message, /delegation depth bound \(3\)/);
  assert.equal(turns.length, 0, "no turn started — which is what 'zero new rows' means at the source");
  close();
});

test("1.3 over the cap is refused the same way, and a top-level call is not touched", async () => {
  const { call, turns, close } = await boot({ delegationDepthMax: 3 });
  const over = await call("继续委派", { "x-delegation-depth": "9" });
  assert.equal(over.body.error?.code, -32011);
  assert.equal(turns.length, 0);

  // The bound must not leak into ordinary traffic.
  const plain = await call("你好");
  assert.equal(plain.body.error, undefined);
  assert.equal(turns.length, 1);
  close();
});

test("1.3 a paused agent answers before the depth check without starting a turn", async () => {
  const { call, turns, close } = await boot({ paused: true });
  const out = await call("你好", { "x-delegation-depth": "1" });
  assert.equal(out.body.error?.code, -32010, "paused is its own code");
  assert.equal(turns.length, 0);
  close();
});

// ── 1.1 the inbound value reaches the turn verbatim ────────────────────────

test("1.1 the inbound depth reaches the turn unchanged", async () => {
  const { call, turns, close } = await boot({ delegationDepthMax: 5 });
  for (const depth of [0, 1, 2, 4]) {
    await call(`深度 ${depth}`, depth === 0 ? {} : { "x-delegation-depth": String(depth) });
  }
  assert.deepEqual(
    turns.map((t) => t.opts.delegationDepth),
    [0, 1, 2, 4],
    "a dropped or re-derived value resets the chain to 0",
  );
  assert.equal(
    turns.every((t) => t.opts.kind === "message"),
    true,
    "kind is untouched by the depth plumbing",
  );
  close();
});

test("1.1 a junk depth header reads as 0 instead of poisoning the chain", async () => {
  const { call, turns, close } = await boot({ delegationDepthMax: 5 });
  await call("乱码", { "x-delegation-depth": "abc" });
  await call("负数", { "x-delegation-depth": "-4" });
  assert.deepEqual(turns.map((t) => t.opts.delegationDepth), [0, 0]);
  close();
});

// ── 1.1 / 1.2 the outbound value is inbound + 1, asserted on the header ────
//
// The section above stops at the client's CAPABILITY. These assert the value
// that actually goes on the wire, and pin all three outbound lanes to one rule.
// Before this, each lane shipped a constant (cron 1, chat nothing, team 1), so a
// second hop looked exactly like a first one and the bound could never trip.

test("1.1/1.2 出站深度 = 入站 + 1；无入站时按车道基线（cron 1 / 人聊 0）", async () => {
  const table = [
    // [inbound, topLevel, expected header]
    [undefined, 1, "1"], // 顶层 cron：仍是委托流量，发 1（与改造前逐字相同）
    [0, 1, "1"],
    [1, 1, "2"], // 入站 1 → 出站 2
    [undefined, 0, undefined], // 人聊：不发头（与改造前逐字相同）
    [0, 0, undefined],
    [1, 0, "2"], // 由委托引发的回合继续这条链
  ];
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(init.headers);
    throw new Error("stop-after-headers");
  };
  try {
    for (const [inbound, topLevel, expected] of table) {
      const depth = outboundDelegationDepth(inbound, { topLevel });
      await assert.rejects(() => runA2aTurn("http://agent.test/", "干活", { depth, gatewayToken: "g", agentToken: "a" }));
      assert.equal(
        sent.at(-1)["X-Delegation-Depth"],
        expected,
        `inbound=${inbound} topLevel=${topLevel} → 头应为 ${expected}`,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("1.2 入站 2 推出 3，而界正是 3：这一跳必须被拒且请求不出进程", async () => {
  // The task asks for "入站 2 → 出站 3". With DELEGATION_DEPTH_BOUND = 3 that
  // value can never reach the wire — the client refuses first. That is the bound
  // working, not a gap, and it is exactly why task 1.4 (the real depth
  // distribution) gates shipping this wiring. Pinned as an assertion so nobody
  // "fixes" the refusal away.
  assert.equal(outboundDelegationDepth(2, { topLevel: 0 }), 3, "推导值确实是 3");
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(init.headers);
    throw new Error("stop-after-headers");
  };
  try {
    await assert.rejects(
      () => runA2aTurn("http://agent.test/", "干活", { depth: outboundDelegationDepth(2, { topLevel: 0 }), gatewayToken: "g", agentToken: "a" }),
      /depth bound \(3\)/,
    );
    assert.equal(sent.length, 0, "第三跳根本不出进程");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("1.1/1.2 三条出站车道共用同一条规则，写死的常量已清零", async () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const sites = [
    ["server/cron-runner.js", /depth: outboundDelegationDepth\(job\?\.origin\?\.fleet\?\.depth, \{ topLevel: 1 \}\)/],
    ["server/agent-session.js", /depth: outboundDelegationDepth\(ctx\.turnStateFor\(sessionId\)\.origin\?\.fleet\?\.depth, \{ topLevel: 0 \}\)/],
    ["server/team-dispatch.js", /const outboundDepth = outboundDelegationDepth\(depth, \{ topLevel: 1 \}\)/],
  ];
  for (const [file, re] of sites) {
    assert.match(read(file), re, `${file} 必须用 outboundDelegationDepth，不得再写常量`);
  }
  const hardcoded = [
    ["server/cron-runner.js", /depth: 1,/],
    ["server/team-dispatch.js", /Math\.max\(0, Number\(depth\) \|\| 0\) \+ 1/],
  ];
  for (const [file, re] of hardcoded) {
    assert.ok(!re.test(read(file)), `${file} 里不应再有写死的出站深度`);
  }
});

// ── the coordinate system: one hop, not two ───────────────────────────────
//
// The cheapest way to ship a double count here is to mistake `origin.fleet.depth`
// for the INBOUND depth. It is not: `server/routes/fleets.js` stamps depth 1 for
// a member dispatching to another post of the same fleet — i.e. "this task is
// hop 1", not "the caller was at 1". So the outbound call made BY that turn is
// hop 2, and the invariant is `outbound === turn.depth + 1` — never + 2.
test("坐标系一致：任务自身的位置是 hop N，它发出的 a2a 就是 hop N+1（不是 +2）", () => {
  for (const position of [1, 2]) {
    const request = buildTurnRequest({
      targetType: "a2a",
      preset: "pack:analyst",
      prompt: "干活",
      trigger: "manual",
      origin: { fleet: { fleetId: "f", memberId: "m", depth: position } },
    });
    assert.equal(request.depth, position, "投递视角记的是这一跳的位置");
    assert.equal(
      outboundDelegationDepth(request.depth, { topLevel: 1 }),
      position + 1,
      `位置 ${position} 的回合往外发是 ${position + 1}，不是 ${position + 2}`,
    );
  }
  // A top-level task has no origin at all: its a2a call is hop 1, unchanged.
  const top = buildTurnRequest({ targetType: "a2a", preset: "pack:analyst", prompt: "干活", trigger: "manual" });
  assert.equal(top.depth, 1, "顶层 a2a 任务本身就是 hop 1");
  assert.equal(outboundDelegationDepth(undefined, { topLevel: 1 }), 1);
});

// ── the outbound side's CAPABILITY (kept from the pre-wiring file) ────────

test("the outbound client sends depth only for delegated traffic, and refuses at the cap", async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(init.headers);
    throw new Error("stop-after-headers");
  };
  try {
    await assert.rejects(() => runA2aTurn("http://agent.test/", "干活", { depth: 0, gatewayToken: "g", agentToken: "a" }));
    assert.equal(sent.at(-1)["X-Delegation-Depth"], undefined, "a human chat carries no depth header");

    await assert.rejects(() => runA2aTurn("http://agent.test/", "干活", { depth: 2, gatewayToken: "g", agentToken: "a" }));
    assert.equal(sent.at(-1)["X-Delegation-Depth"], "2");

    await assert.rejects(
      () => runA2aTurn("http://agent.test/", "干活", { depth: DELEGATION_DEPTH_BOUND, gatewayToken: "g", agentToken: "a" }),
      /depth bound/,
      "the client refuses to chain past the cap even if the caller asks",
    );
    assert.equal(sent.length, 2, "the over-bound call never left the process");
  } finally {
    globalThis.fetch = realFetch;
  }
});
