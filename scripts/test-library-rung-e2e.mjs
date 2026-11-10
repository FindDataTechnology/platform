// add-library-semantic-rung 5.2：端到端三态。
//
// 一段可重放的脚本，按真实顺序走三遍：
//   ① 关闭态：中文检索有排序、且零嵌入调用
//   ② 开启态：语义档参与，命中同义表述（字面不同但语义相近）
//   ③ 断通道：降级为词法，档位与成因如实标注
//
// 嵌入通道用确定性的假实现（同义向量由文本哈希决定），这样「语义命中」是可验证的，
// 而不是碰运气。这是替身，不是真实模型：它证明的是接线与降级，不是模型质量。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-lib-e2e-"));
process.env.DB_PATH = path.join(dir, "library.sqlite");
const DIM = 8;

const db = await import(path.join(ROOT, "db.js"));
const search = await import(path.join(ROOT, "documents-search.js"));
await db.initDb();

// 语义相近的两句共用同一个向量：一句是被检索的正文，另一句是用户的问法。
const SAME_MEANING = ["营收增长", "收入增速"];
const vectorFor = (text) => {
  const bucket = SAME_MEANING.some((k) => text.includes(k)) ? 1 : 2;
  return Array.from({ length: DIM }, (_, j) => (j === 0 && bucket === 1 ? 1 : j === 1 && bucket === 2 ? 1 : 0));
};
const fakeEmbedder = {
  embedBatch: async (texts) => ({ model: "fake", dim: DIM, vectors: texts.map(vectorFor) }),
};

const DOCS = [
  ["doc-a", "公司年报摘要.md", "本年度公司营业收入同比增长百分之十二，主要来自华东区域。\n\n成本端保持稳定，毛利率小幅提升。"],
  ["doc-b", "行业观察.md", "行业整体景气度回升，龙头企业份额继续集中。"],
];
for (const [id, name, text] of DOCS) {
  db.upsertDocument({ id, name, type: "md", status: "ready", added_at: new Date().toISOString(), source_text: text });
  db.replaceDocumentChunks(id, name, search.chunkText(text));
}

const report = {};

// ① 关闭态
{
  const hits = search.searchLibrary("营业收入同比");
  assert.ok(hits.length > 0, "关闭态中文检索仍须命中");
  report.off = { hits: hits.length, via: [...new Set(hits.map((h) => h.via))], embedCalls: search.embedUsage().calls };
  assert.ok(["trigram", "fts"].includes(hits[0].via), `关闭态应为词法通路，实际 ${hits[0].via}`);
  assert.equal(report.off.embedCalls, 0, "关闭态不得产生任何嵌入调用");
}

// ② 开启态
process.env.LIBRARY_SEMANTIC_RUNG = "on";
process.env.LIBRARY_EMBED_BASE_URL = "https://lane.example/v1";
process.env.LIBRARY_EMBED_MODEL = "fake";
process.env.LIBRARY_EMBED_DIMENSIONS = String(DIM);
{
  const enabled = search.setSemanticOptIn(true, { acknowledged: true });
  assert.equal(enabled.ok, true, `开启应成功：${JSON.stringify(enabled)}`);
  for (const id of ["doc-a", "doc-b"]) {
    const r = await search.embedDocument(id, { embedder: fakeEmbedder });
    assert.equal(r.status, "ok", `${id} 嵌入应成功`);
  }

  // 用户问法和正文用词不同（"收入增速" vs "营业收入同比"）：词法可能命中"收入"，
  // 但语义通路应当把 doc-a 抬到第一。
  const sem = await search.semanticHits("收入增速", {}, { embedder: fakeEmbedder });
  assert.equal(sem.ok, true, "开启后语义档应可用");
  assert.equal(sem.hits[0].docId, "doc-a", "语义通路应把同义表述的文档排第一");

  const lexical = search.searchLibrary("收入增速");
  const fused = search.fuseRrf(lexical, sem.hits, 5);
  assert.equal(fused[0].docId, "doc-a");
  report.on = {
    lexical: lexical.length, semantic: sem.hits.length, fusedTop: fused[0].docId,
    usage: search.embedUsage(),
  };
  assert.ok(report.on.usage.calls > 0, "开启后应有嵌入记账");
}

// ③ 断通道
{
  const down = { embedBatch: async () => { const e = new Error("timeout"); e.retryable = true; throw e; } };
  const sem = await search.semanticHits("收入增速", {}, { embedder: down });
  assert.equal(sem.ok, false);
  assert.equal(sem.reason, "unavailable");
  assert.equal(sem.retryable, true);
  const lexical = search.searchLibrary("收入增速");
  // 降级不是故障：词法结果照常返回，档位标注为 keyword
  assert.ok(Array.isArray(lexical), "通道断开时检索不得报错");
  report.down = { reason: sem.reason, retryable: sem.retryable, lexical: lexical.length };
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("ok - library rung e2e");
console.log(JSON.stringify(report, null, 2));
