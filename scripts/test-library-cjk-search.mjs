// add-library-semantic-rung 1.x: 中文词法档必须真的排序。
//
// 背景（实测）：unicode61 把一段连续汉字当成单个 token，所以子串查询 MATCH 不到，
// 全部落进 LIKE 全表扫描——不排序、按插入顺序。契约（document-search-index 的
// 「ranked by full-text relevance」）要求排序，故这是实现违规。
//
// 断言：
//   1. 中文子串查询走 trigram 通路并给出排序（via === "trigram"）
//   2. 2 字查询不退化为空（trigram 只能处理 ≥3 字，路由必须回落到 unicode61/LIKE）
//   3. ASCII 查询行为与改造前一致（仍走 unicode61）
//   4. 删除文档时两个索引都不留残行
//   5. 未迁移的库（没有 v2 表）不会崩，只是回落

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-lib-search-"));
process.env.DB_PATH = path.join(dir, "library.sqlite");

const db = await import(path.join(ROOT, "db.js"));
const search = await import(path.join(ROOT, "documents-search.js"));
await db.initDb();

// 一份足够长的中文正文，让「框架对比」落在某个汉字段的中间（子串而非整 token）
const ZH = [
  "# 主流 AI Agent 框架对比",
  "",
  "本文比较若干主流智能体框架在编排、工具调用与可观测性上的差异，并给出选型建议。",
  "",
  "## 二、编排能力",
  "",
  "多智能体协同需要显式的状态机与可恢复的检查点，否则长任务一旦中断就很难续跑。",
].join("\n");

db.upsertDocument({
  id: "doc-zh",
  name: "框架报告.md",
  type: "md",
  status: "ready",
  added_at: new Date().toISOString(),
  source_text: ZH,
});
db.replaceDocumentChunks("doc-zh", "框架报告.md", search.chunkText(ZH));

// ── 1. 子串查询走 trigram 且有排序 ─────────────────────────────────────────
{
  const hits = search.searchLibrary("智能体框");
  assert.ok(hits.length > 0, "中文子串查询必须命中（trigram 通路）");
  assert.equal(hits[0].via, "trigram", `子串查询应走 trigram，实际 ${hits[0].via}`);
}

// ── 2. 2 字查询不得归零 ───────────────────────────────────────────────────
{
  const two = search.searchLibrary("框架");
  assert.ok(two.length > 0, "2 字查询不得因 trigram 只支持 ≥3 字而归零");
  assert.notEqual(two[0].via, "trigram", "2 字查询不应被路由到 trigram");
}

// ── 3. ASCII 行为不变 ─────────────────────────────────────────────────────
{
  db.upsertDocument({
    id: "doc-en", name: "notes.md", type: "md", status: "ready",
    added_at: new Date().toISOString(), source_text: "retrieval pipeline notes",
  });
  db.replaceDocumentChunks("doc-en", "notes.md", search.chunkText("retrieval pipeline notes"));
  const hits = search.searchLibrary("retrieval");
  assert.ok(hits.length > 0, "ASCII 查询必须仍然命中");
  assert.equal(hits[0].via, "fts", "ASCII 查询仍走 unicode61");
}

// ── 4. 删除不留残行（两个索引都清） ───────────────────────────────────────
{
  db.deleteDocument("doc-zh");
  assert.equal(db.searchDocumentChunks('"智能体"').length, 0, "v1 残留");
  assert.equal(db.searchDocumentChunksTrigram('"智能体框"').length, 0, "v2 残留");
  assert.equal(search.searchLibrary("智能体框").length, 0, "删除后不得再被检索到");
}

// ── 5. 无 v2 表时不崩，回落 v1 ────────────────────────────────────────────
{
  db.execRaw("DROP TABLE IF EXISTS document_chunks_v2");
  db.resetTrigramChunkIndexProbe();
  assert.equal(db.hasTrigramChunkIndex(), false, "探测应认为 v2 不存在");
  assert.equal(db.searchDocumentChunksTrigram('"x"'), null, "缺 v2 时应返回 null 而非 []");
  const hits = search.searchLibrary("retrieval");
  assert.ok(hits.length > 0, "缺 v2 时仍应能检索（回落 v1）");
  assert.equal(hits[0].via, "fts");
}

// ── 6. 语义档：关闭时零行为变化，失败时降级不报错，可用时与词法 RRF 融合 ──
{
  const { fuseRrf, semanticHits, semanticRungStatus } = search;

  // 关闭（默认）：不发请求、返回 disabled
  assert.equal(semanticRungStatus({}).enabled, false, "语义档默认关闭");
  const off = await semanticHits("检索", {});
  assert.equal(off.ok, false);
  assert.equal(off.reason, "disabled");

  const lex = [
    { docId: "d1", loc: 0, name: "a", snippet: "x", via: "fts" },
    { docId: "d2", loc: 0, name: "b", snippet: "y", via: "fts" },
  ];
  const sem = [
    { docId: "d2", loc: 0, name: "b", snippet: "y", via: "vector" },
    { docId: "d3", loc: 0, name: "c", snippet: "z", via: "vector" },
  ];
  const fused = fuseRrf(lex, sem, 10);
  assert.equal(fused[0].docId, "d2", "两路都命中的应排第一");
  assert.equal(fused[0].via, "hybrid", "两路命中标 hybrid");
  assert.deepEqual(fused.map((h) => h.docId).sort(), ["d1", "d2", "d3"], "融合不得丢任何一路的候选");
}

// 通道故障：降级原因可判别，且不抛
{
  process.env.LIBRARY_SEMANTIC_RUNG = "on";
  process.env.LIBRARY_EMBED_BASE_URL = "https://lane.example/v1";
  process.env.LIBRARY_EMBED_MODEL = "m";
  process.env.LIBRARY_EMBED_DIMENSIONS = "8";
  // 每库开关是第二道门：部署有通道还不够，必须显式开启并确认披露
  const pre = await search.semanticHits("检索", {});
  assert.equal(pre.reason, "disabled", "未 opt-in 时不得取向量");
  const optIn = search.setSemanticOptIn(true, { acknowledged: true });
  assert.equal(optIn.ok, true, `opt-in 应成功：${JSON.stringify(optIn)}`);
  const failing = { embedBatch: async () => { const e = new Error("timeout"); e.retryable = true; throw e; } };
  const res = await search.semanticHits("检索", {}, { embedder: failing });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "unavailable");
  assert.equal(res.retryable, true, "可重试性必须透出，供调用方决定");

  // 可用：自建一对文档（前面的用例已删过 doc-zh），按余弦排序
  for (const id of ["doc-s1", "doc-s2"]) {
    db.upsertDocument({
      id, name: `${id}.md`, type: "md", status: "ready",
      added_at: new Date().toISOString(), source_text: `语义测试 ${id}`,
    });
    db.replaceDocumentChunks(id, `${id}.md`, search.chunkText(`语义测试 ${id}`));
  }
  const vecs = {
    "doc-s1": [1, 0, 0, 0, 0, 0, 0, 0],
    "doc-s2": [0, 1, 0, 0, 0, 0, 0, 0],
  };
  for (const [id, v] of Object.entries(vecs)) {
    db.upsertChunkVectors(id, [{ loc: 0, vector: Buffer.from(Float32Array.from(v).buffer) }], { model: "m", dim: 8 });
  }
  const okEmbedder = { embedBatch: async () => ({ vectors: [[1, 0, 0, 0, 0, 0, 0, 0]], model: "m", dim: 8 }) };
  const hit = await search.semanticHits("检索", {}, { embedder: okEmbedder });
  assert.equal(hit.ok, true);
  assert.equal(hit.hits[0].docId, "doc-s1", "与查询向量最相似的应排第一");

  // 换模型是覆盖而不是并存：主键是 (doc_id, loc)，同一段文本只留一份向量。
  // 后果必须如实——当前模型下该文档查不到，它需要重嵌，而不是被旧模型的行蒙混过去。
  db.upsertChunkVectors("doc-s2", [{ loc: 0, vector: Buffer.from(Float32Array.from(vecs["doc-s2"]).buffer) }], { model: "other", dim: 8 });
  const miss = await search.semanticHits("检索", { docId: "doc-s2" }, { embedder: okEmbedder });
  assert.equal(miss.hits.length, 0, "另一模型的向量不得被当作当前模型的结果返回");
  assert.ok(
    db.listDocIdsMissingVectors({ model: "m", dim: 8 }).includes("doc-s2"),
    "换模型后的文档必须出现在「缺向量」名单里（需要重嵌）",
  );

  for (const k of ["LIBRARY_SEMANTIC_RUNG", "LIBRARY_EMBED_BASE_URL", "LIBRARY_EMBED_MODEL", "LIBRARY_EMBED_DIMENSIONS"]) delete process.env[k];
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("ok - library CJK lexical rung + semantic rung");
