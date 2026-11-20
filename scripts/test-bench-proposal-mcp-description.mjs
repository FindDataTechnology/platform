// ── bench_proposal_submit 的工具描述必须按模式说话 ───────────────────────────
//
// change `bind-bench-proposal-identity-to-credential` 的 task 3.3。
//
// 为什么这条要单独钉：岗位唯一会读的那段文字就是工具描述。在役舰队的 persona 是
// 建队时浇铸的、改不到，所以「你的 fleet_id 是 BENCH_FLEET_REF」这句话只能长在
// **工具描述**里——它随镜像出片就到达所有挂这个面的岗位，不依赖任何舰队重建。
//
// 三个方向都会错，所以三条都钉：
//   · session 档被机器面的字样污染 ⇒ 会话面的岗位会去找一个它没有的环境变量；
//   · machine 档报不出真 ref ⇒ 岗位还是得猜（正是 3.3 要修的那件事）；
//   · machine 档没配 ref 却报出一个前缀 ⇒ 比不报更坏，岗位会照抄一个错的身份。
//
// 描述在模块加载时由环境算出，所以每条用例都要拿一个**新的模块实例**
// （ESM 按 URL 缓存——加 `?case=` 破缓存，别指望 delete require.cache）。

import { test } from "node:test";
import assert from "node:assert/strict";

const REF = "fleet_0000000000000_aaaaaa";

async function describeSource(env) {
  const saved = {};
  for (const k of ["BENCH_PROPOSAL_MODE", "BENCH_FLEET_REF"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  try {
    const mod = await import(`../server/bench-proposal-mcp.js?case=${Math.random()}`);
    const entry = [...mod.server._requestHandlers.entries()].find(([k]) =>
      String(k.method ?? k).includes("tools/list"),
    );
    const res = await entry[1]({ method: "tools/list" }, {});
    const tool = res.tools[0];
    return { source: tool.inputSchema.properties.source.description, description: tool.description };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("session 档：说身份行，不提机器面的环境变量", async () => {
  const { source, description } = await describeSource({});
  assert.match(source, /fleet:<fleet_id>\/<post_id>/);
  assert.doesNotMatch(source, /BENCH_FLEET_REF/);
  assert.doesNotMatch(description, /BENCH_FLEET_REF/);
  assert.match(description, /403 means the credential is not an expert of this domain/);
});

test("machine 档 + 有 ref：把真前缀原样报出来（岗位不必再猜自己是谁）", async () => {
  const { source, description } = await describeSource({
    BENCH_PROPOSAL_MODE: "machine",
    BENCH_FLEET_REF: REF,
  });
  assert.match(source, new RegExp(`fleet:${REF}/`));
  assert.match(source, /BENCH_FLEET_REF/);
  // 「本地拒绝、请求不发出」是机器面与 session 最要紧的差别，必须写在岗位读得到处
  assert.match(source, /refused locally/);
  assert.match(description, new RegExp(`fleet:${REF}/`));
  assert.doesNotMatch(description, /not an expert of this domain/);
});

test("machine 档 + 没 ref：退成占位前缀，不许编一个 ref", async () => {
  const { source } = await describeSource({ BENCH_PROPOSAL_MODE: "machine" });
  assert.match(source, /fleet:<your fleet_ref>\//);
  assert.match(source, /not set here/);
  assert.doesNotMatch(source, /fleet:fleet_/);
});
