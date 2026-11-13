// add-library-semantic-rung 2.2-2.4: 嵌入客户端与预算纪律。
//
// 全部用假的 transport，不触碰任何真实端点——替身必须如实反映已装源码的契约
// （请求体里必须带 dimensions；响应维度不符必须拒绝，而不是先存下来再说）。

import assert from "node:assert/strict";
import {
  cosine, createEmbedder, createLatencyBudget, decodeVector, encodeVector,
  EmbedError, isRetryableFailure, readEmbedConfig,
} from "../lib/embed-client.js";

const CONFIG = {
  baseUrl: "https://lane.example/v1",
  apiKey: "sk-test",
  model: "Qwen/Qwen3-Embedding-8B",
  dimensions: 1024,
  budgetFloorMs: 800,
  budgetCeilingMs: 8000,
  batchSize: 16,
  configured: true,
};

function okResponse(texts, dim = 1024) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: texts.map((_, i) => ({ embedding: Array.from({ length: dim }, (_, j) => (i + 1) * 0.001 + j * 1e-6) })),
    }),
    text: async () => "",
  };
}

// ── 请求契约 ────────────────────────────────────────────────────────────────
{
  let seen = null;
  const embedder = createEmbedder({
    config: CONFIG,
    fetchImpl: async (url, init) => {
      seen = { url, body: JSON.parse(init.body), headers: init.headers };
      return okResponse(JSON.parse(init.body).input);
    },
  });
  const out = await embedder.embedBatch(["a", "b"]);
  assert.equal(seen.url, "https://lane.example/v1/embeddings");
  assert.equal(seen.body.dimensions, 1024, "dimensions 必须显式下发，不能依赖服务端默认");
  assert.equal(seen.body.model, CONFIG.model);
  assert.equal(seen.headers.authorization, "Bearer sk-test");
  assert.equal(out.dim, 1024);
  assert.equal(out.vectors.length, 2);
}

// ── 维度漂移必须拒绝 ───────────────────────────────────────────────────────
{
  const embedder = createEmbedder({
    config: CONFIG,
    fetchImpl: async (_url, init) => okResponse(JSON.parse(init.body).input, 4096),
  });
  await assert.rejects(
    () => embedder.embedBatch(["a"]),
    (err) => err instanceof EmbedError && /维度漂移/.test(err.message) && err.retryable === false,
    "请求 1024 却返回 4096 必须报错且不可重试",
  );
}

// ── 未配置时不发请求 ───────────────────────────────────────────────────────
{
  let called = false;
  const embedder = createEmbedder({
    config: { ...CONFIG, configured: false, baseUrl: "" },
    fetchImpl: async () => { called = true; return okResponse(["a"]); },
  });
  await assert.rejects(() => embedder.embedBatch(["a"]), /未配置/);
  assert.equal(called, false, "未配置时不得发出任何请求");
}

// ── 分类：可重试 vs 不可重试 ───────────────────────────────────────────────
{
  const e429 = createEmbedder({
    config: CONFIG,
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => "slow down" }),
  });
  await assert.rejects(() => e429.embedBatch(["a"]), (e) => e.retryable === true);

  const e400 = createEmbedder({
    config: CONFIG,
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => "bad input" }),
  });
  await assert.rejects(() => e400.embedBatch(["a"]), (e) => e.retryable === false);

  const eShape = createEmbedder({
    config: CONFIG,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [1, 2] }] }) }),
  });
  await assert.rejects(() => eShape.embedBatch(["a", "b"]), (e) => e.retryable === false);

  assert.equal(isRetryableFailure(new Error("socket hang up")), true);
  assert.equal(isRetryableFailure(new Error("invalid api key")), false);
}

// ── 预算：由近期真实延迟推导，且不塌缩 ─────────────────────────────────────
{
  const quick = createLatencyBudget({ window: 10, margin: 1.5, floorMs: 800, ceilingMs: 8000 });
  assert.equal(quick.next(), 8000, "无样本时取上限");
  for (let i = 0; i < 10; i++) quick.record(900);
  assert.ok(quick.next() <= 1400, `快样本应收紧预算，实际 ${quick.next()}`);

  const bimodal = createLatencyBudget({ window: 10, margin: 1.5, floorMs: 800, ceilingMs: 8000 });
  // 九成快、一成极慢：p90 必须被慢样本抬起来，不能塌到下限
  for (let i = 0; i < 9; i++) bimodal.record(50);
  bimodal.record(9000);
  assert.ok(bimodal.next() >= 800, "双峰时预算不得塌到 0");

  const clamped = createLatencyBudget({ window: 5, margin: 3, floorMs: 800, ceilingMs: 2000 });
  clamped.record(5000);
  assert.equal(clamped.next(), 2000, "必须被上限 clamp");
}

// ── 超时样本必须也进预算（否则永远学不到「慢」） ─────────────────────────
{
  const budget = createLatencyBudget({ window: 5, margin: 1.5, floorMs: 50, ceilingMs: 100 });
  for (let i = 0; i < 4; i++) budget.record(60);
  const tight = budget.next();
  budget.record(100); // 超时样本（取的是当时的等待预算上限）
  assert.ok(budget.samples().includes(100), "超时样本必须落库");
  assert.ok(budget.next() >= tight, "加入慢样本后预算不得收紧");

  // 端到端：真发一次超时请求，事后样本数要增加
  const embedder = createEmbedder({
    config: { ...CONFIG, budgetFloorMs: 40, budgetCeilingMs: 40 },
    fetchImpl: async (_url, init) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 120);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const e = new Error("aborted"); e.name = "AbortError"; reject(e);
        });
      });
      return okResponse(["a"]);
    },
  });
  await assert.rejects(() => embedder.embedBatch(["a"]));
  assert.ok(embedder.budget.samples().length > 0, "一次超时之后预算必须至少有一个样本");
}

// ── 超预算算降级（可重试），不是崩溃 ───────────────────────────────────────
{
  const embedder = createEmbedder({
    config: { ...CONFIG, budgetCeilingMs: 30, budgetFloorMs: 30 },
    // The fake must honour `signal` exactly as real fetch does — a fake that
    // ignores it would make the budget look enforced when it is not.
    fetchImpl: async (_url, init) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 80);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      return okResponse(["a"]);
    },
  });
  await assert.rejects(
    () => embedder.embedBatch(["a"]),
    (e) => e instanceof EmbedError && /超预算/.test(e.message) && e.retryable === true,
  );
}

// ── 向量编解码与余弦 ───────────────────────────────────────────────────────
{
  const v = [1, 0, 0];
  const round = Array.from(decodeVector(encodeVector(v)));
  assert.deepEqual(round, [1, 0, 0]);
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))) < 1e-6);
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([0, 1, 2])), 0, "长度不符返回 0");
}

// ── 配置读取：默认关闭 ─────────────────────────────────────────────────────
{
  assert.equal(readEmbedConfig({}).configured, false, "无配置时默认关闭");
  assert.equal(readEmbedConfig({ LIBRARY_EMBED_BASE_URL: "x" }).configured, false, "缺 model 也算未配置");
  assert.equal(
    readEmbedConfig({ LIBRARY_EMBED_BASE_URL: "x", LIBRARY_EMBED_MODEL: "m" }).configured,
    true,
  );
}

console.log("ok - library embed client");
