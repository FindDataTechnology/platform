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

// ── document-management：摄取不得等待嵌入（关键性质此前无断言）───────────
// 现在代码里是 `void scheduleEmbed(id)`。若有人把 void 换成 await，所有既有
// 测试仍会全绿——只有线上摄取会随嵌入通道变慢。这条断言就是防这个。
{
  let resolveEmbed = null;
  const hanging = {
    embedBatch: () => new Promise((resolve) => { resolveEmbed = resolve; }),
  };
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fd-nonblock-"));
  db.upsertDocument({ id: "nb-1", name: "nb.md", type: "md", status: "ready",
    added_at: new Date().toISOString(), source_text: "不阻塞用例" });
  db.replaceDocumentChunks("nb-1", "nb.md", search.chunkText("不阻塞用例"));

  const t0 = Date.now();
  const pending = search.scheduleEmbed("nb-1", { embedder: hanging });
  // 调度立即返回（不等嵌入完成）
  assert.ok(Date.now() - t0 < 200, "scheduleEmbed 必须立即返回，不得等待通道");

  // 通道还挂着的时候，文档照常可被词法检索命中
  const hits = search.searchLibrary("不阻塞用例");
  assert.ok(hits.some((h) => h.docId === "nb-1"), "嵌入未完成不得影响词法可用性");

  // 链是异步推进的：等 embedBatch 真的被调用（resolveEmbed 被赋值）再放行，
  // 否则直接调用会撞上「赋值还没发生」的竞态，pending 永远不 settle。
  for (let i = 0; i < 40 && !resolveEmbed; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(resolveEmbed, "embedBatch 应已被调用");
  resolveEmbed({ vectors: Array.from({ length: 8 }, () => new Array(8).fill(0)), model: "test-model", dim: 8 });
  await pending;

  // 单次抛错不得 poison 整条链：下一次调度仍要能跑
  const exploding = { embedBatch: async () => { throw new Error("boom"); } };
  await search.scheduleEmbed("nb-1", { embedder: exploding }).catch(() => {});
  const after = await search.scheduleEmbed("nb-1", { embedder: fakeEmbedder() });
  assert.equal(after.status, "ok", "前一次崩溃后链必须仍可用（不得 poison）");
  fs.rmSync(dir2, { recursive: true, force: true });
}

// ── 回填必须按批限速，不是一次性打满 ───────────────────────────────────────
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "fd-gap-"));
  for (let i = 0; i < 3; i++) {
    const id = `gap-${i}`;
    db.upsertDocument({ id, name: `${id}.md`, type: "md", status: "ready",
      added_at: new Date().toISOString(), source_text: `限速用例 ${i}` });
    db.replaceDocumentChunks(id, `${id}.md`, search.chunkText(`限速用例 ${i}`));
  }
  const t0 = Date.now();
  const out = await search.backfillVectors({ max: 3, gapMs: 200, embedder: fakeEmbedder() });
  const elapsed = Date.now() - t0;
  assert.ok(out.done >= 2, "应回填多篇");
  // 3 篇之间至少两次 200ms 间隔
  assert.ok(elapsed >= 350, `回填必须批间限速，实测仅 ${elapsed}ms`);

  // gapMs=0 时不应人为拖延（证明延迟来自限速而不是别处）
  const t1 = Date.now();
  await search.backfillVectors({ max: 1, gapMs: 0, embedder: fakeEmbedder() });
  assert.ok(Date.now() - t1 < 300, "单篇不应被限速拖慢");
  fs.rmSync(dir2, { recursive: true, force: true });
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
