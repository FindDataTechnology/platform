// add-library-semantic-rung 2.6 / 4.3：摄取后异步嵌入与回填。
//
// 关键不变量：
//   * 语义档关闭时，摄取照旧 ready，且不产生任何嵌入调用
//   * 开启后，文档仍是 ready 之后才嵌入（不阻塞摄取）
//   * 失败不会让文档离开队列——它仍是「缺向量」，下轮自动重试
//   * 永久性失败有冷却，不做热循环

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-lib-embed-"));
process.env.DB_PATH = path.join(dir, "library.sqlite");

const db = await import(path.join(ROOT, "db.js"));
const search = await import(path.join(ROOT, "documents-search.js"));
await db.initDb();

function seed(id, text) {
  db.upsertDocument({
    id, name: `${id}.md`, type: "md", status: "ready",
    added_at: new Date().toISOString(), source_text: text,
  });
  db.replaceDocumentChunks(id, `${id}.md`, search.chunkText(text));
}

const fakeEmbedder = (dim = 8) => ({
  embedBatch: async (texts) => ({
    model: "test-model",
    dim,
    vectors: texts.map((_, i) => Array.from({ length: dim }, (_, j) => (i === 0 && j === 0 ? 1 : 0))),
  }),
});

// ── 关闭态：零嵌入调用 ─────────────────────────────────────────────────────
{
  seed("doc-off", "关闭态文档，内容若干。");
  const before = db.countChunkVectors({ model: "test-model", dim: 8 });
  const r = await search.embedDocument("doc-off", { embedder: fakeEmbedder() });
  assert.equal(r.status, "disabled");
  assert.equal(db.countChunkVectors({ model: "test-model", dim: 8 }), before, "关闭时不得写入任何向量");
}

// ── 开启态：嵌入成功，向量落库 ─────────────────────────────────────────────
process.env.LIBRARY_SEMANTIC_RUNG = "on";
process.env.LIBRARY_EMBED_BASE_URL = "https://lane.example/v1";
process.env.LIBRARY_EMBED_MODEL = "test-model";
process.env.LIBRARY_EMBED_DIMENSIONS = "8";
process.env.LIBRARY_EMBED_BATCH = "4";
// 每库开关：没有它，即使部署配好通道也不会发任何请求
assert.equal(search.semanticOptInState().optedIn, false);
assert.equal(search.setSemanticOptIn(true, { acknowledged: false }).ok, false, "未确认披露不得开启");
assert.equal(search.setSemanticOptIn(true, { acknowledged: true }).ok, true);
{
  seed("doc-on", "开启态文档，第一段。\n\n第二段，稍长一些用来验证切块。");
  const r = await search.embedDocument("doc-on", { embedder: fakeEmbedder() });
  assert.equal(r.status, "ok");
  assert.ok(r.vectors >= 1, "应至少写入一条向量");
  assert.equal(db.countChunkVectors({ model: "test-model", dim: 8 }), r.vectors);
  assert.ok(
    !db.listDocIdsMissingVectors({ model: "test-model", dim: 8 }).includes("doc-on"),
    "成功嵌入后不得再出现在缺向量名单",
  );
}

// ── 可重试失败：留在队列，且进冷却 ─────────────────────────────────────────
{
  seed("doc-flaky", "会失败一次的文档。");
  const failing = { embedBatch: async () => { const e = new Error("timeout"); e.retryable = true; throw e; } };
  const r = await search.embedDocument("doc-flaky", { embedder: failing });
  assert.equal(r.status, "failed");
  assert.equal(r.retryable, true);
  assert.ok(
    db.listDocIdsMissingVectors({ model: "test-model", dim: 8 }).includes("doc-flaky"),
    "可重试失败后文档必须仍在队列里（否则永远不会被重试）",
  );
  assert.ok(
    db.listDocIdsMissingVectors({ model: "test-model", dim: 8 }).includes("doc-flaky"),
    "冷却期内仍应视为待办，而不是已完成",
  );
  const again = await search.embedDocument("doc-flaky", { embedder: fakeEmbedder() });
  assert.equal(again.status, "cooldown", "冷却期内不应重复调用通道");
  assert.ok(search.embedStats().lastError?.retryable === true, "失败分类应可观测");
}

// ── 回填：只处理缺向量的文档，且有上限 ─────────────────────────────────────
{
  for (let i = 0; i < 3; i++) seed(`bf-${i}`, `回填文档 ${i}，内容。`);
  const before = db.listDocIdsMissingVectors({ model: "test-model", dim: 8 }).length;
  assert.ok(before >= 3);
  const out = await search.backfillVectors({ max: 2, embedder: fakeEmbedder() });
  assert.equal(out.done, 2, "回填应遵守 max 上限");
  assert.ok(out.remaining >= 1, "回填应报出剩余量，便于下一轮");
  assert.ok(db.listDocIdsMissingVectors({ model: "test-model", dim: 8 }).length < before);
}

// ── 关闭后不再回填，但已有向量保留 ─────────────────────────────────────────
{
  const kept = db.countChunkVectors({ model: "test-model", dim: 8 });
  process.env.LIBRARY_SEMANTIC_RUNG = "off";
  const out = await search.backfillVectors({ max: 10 });
  assert.equal(out.status, "disabled");
  assert.equal(db.countChunkVectors({ model: "test-model", dim: 8 }), kept, "关闭不得删向量（再开无需全量重算）");
}

// ── 成本归集：只统计真实发出的批次 ─────────────────────────────────────────
{
  const usage = search.embedUsage();
  assert.ok(usage.calls > 0, "嵌入成功后应记下批次数");
  assert.ok(usage.chars > 0, "嵌入成功后应记下字符数");
}

// ── 磁盘预检：超上限必须拒绝开启，并给出实测数字 ───────────────────────────
{
  // 先关掉，再把上限压到 0 以便必超（上一段把 rung 关过，这里复位）
  process.env.LIBRARY_SEMANTIC_RUNG = "on";
  search.setSemanticOptIn(false);
  const prev = process.env.LIBRARY_VECTOR_DISK_CAP_MB;
  process.env.LIBRARY_VECTOR_DISK_CAP_MB = "0";
  const fp = search.estimateVectorFootprint();
  assert.equal(fp.dim, 8);
  assert.ok(fp.chunks > 0);
  assert.equal(fp.ok, false, "上限为 0 时必然超");

  const refused = search.setSemanticOptIn(true, { acknowledged: true });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /向量体积超上限/);
  assert.ok(refused.footprint && refused.footprint.chunks > 0, "拒绝时必须给出实测数字");

  if (prev === undefined) delete process.env.LIBRARY_VECTOR_DISK_CAP_MB;
  else process.env.LIBRARY_VECTOR_DISK_CAP_MB = prev;
}

// ── 通道不可配时，开关必须报不可用而不是「关着可开」 ───────────────────────
{
  const saved = process.env.LIBRARY_EMBED_BASE_URL;
  delete process.env.LIBRARY_EMBED_BASE_URL;
  const state = search.semanticOptInState();
  assert.equal(state.laneConfigured, false);
  assert.match(state.blockingReason, /嵌入通道未配置/);
  assert.equal(search.setSemanticOptIn(true, { acknowledged: true }).ok, false);
  process.env.LIBRARY_EMBED_BASE_URL = saved;
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("ok - library embed pass");
