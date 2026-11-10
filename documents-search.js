// ── Library search infrastructure (chunker + FTS5 orchestration) ─────────────
//
// Shared by the ingest path (documents.js indexes chunks right after
// extraction), the boot-time backfill, and the library MCP server
// (server/library-mcp.js) — one module, one notion of search, no REST or WS
// coupling. Everything here is local and deterministic: no LLM, no embedding
// provider, nothing to configure.
//
// Retrieval contract: `searchLibrary` returns ranked chunk hits with a
// document name and a `loc` locator; `readDocumentPage` pages the full source
// text SQL-side. An agent (or any caller) finds passages, then reads around
// them.

import * as db from "./db.js";

// Chunk shaping: paragraphs packed toward ~1200 chars with a 150-char tail
// overlap. Paragraphs are the natural coherence unit; the overlap keeps a
// sentence split across a boundary findable from both sides.
const CHUNK_TARGET = 1200;
const CHUNK_OVERLAP = 150;

// Split source text into [{ text, loc }] where loc is a character offset into
// the original (JS string index — a locator hint for reads, not a byte count).
export function chunkText(text) {
  const src = String(text || "");
  const chunks = [];
  const paragraphs = src.split(/\n{2,}/);
  let buf = "";
  let start = 0;
  let cursor = 0; // absolute offset of the end of consumed input
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const sep = i < paragraphs.length - 1 ? "\n\n" : "";
    if (buf.length + para.length > CHUNK_TARGET && buf.trim()) {
      chunks.push({ text: buf.trim(), loc: start });
      const tail = buf.slice(-CHUNK_OVERLAP);
      start = cursor - tail.length;
      buf = tail;
    }
    buf += para + sep;
    cursor += para.length + sep.length;
  }
  if (buf.trim()) chunks.push({ text: buf.trim(), loc: start });
  return chunks;
}

// Index (or re-index) one document's chunks. Wholesale replace keeps repeated
// calls idempotent — same input, same end state.
export function indexDocumentChunks(docId, name, sourceText) {
  db.replaceDocumentChunks(docId, name, chunkText(sourceText));
}

// Boot-time backfill: every ready doc with source text but no chunks gets
// chunked. Per-doc isolation — one bad row never blocks the rest — and a
// second run is a no-op (the id list comes back empty).
//
// Then the same for the trigram index: a cell that migrated after its documents
// were ingested has v1 rows but no v2 rows. That pass rebuilds from the chunk
// rows (not from source text) so the boundaries stay identical.
export function backfillChunks() {
  let n = 0;
  for (const id of db.listDocIdsWithoutChunks()) {
    try {
      const doc = db.getDocument(id);
      if (doc?.source_text) {
        db.replaceDocumentChunks(id, doc.name, chunkText(doc.source_text));
        n++;
      }
    } catch (e) {
      console.error(`[documents-search] backfill failed for ${id}:`, e.message);
    }
  }
  if (n) console.log(`[documents-search] backfilled chunks for ${n} document(s)`);

  const m = backfillTrigramChunks();
  return n + m;
}

// Mirror v1 chunk rows into the trigram table for docs that lack them. Idempotent
// and per-doc isolated, same as the chunk backfill above.
export function backfillTrigramChunks() {
  if (!db.hasTrigramChunkIndex()) return 0;
  let m = 0;
  for (const id of db.listDocIdsMissingTrigramChunks()) {
    try {
      const rows = db.rebuildTrigramChunksFor(id);
      if (rows?.changes || rows) m += 1;
    } catch (e) {
      console.error(`[documents-search] trigram backfill failed for ${id}:`, e.message);
    }
  }
  if (m) {
    // Disk is the cost of this index, and cell nodes have run out before: state
    // the measured footprint rather than letting it grow invisibly.
    const fp = db.chunkIndexFootprint();
    if (fp) {
      const ratio = fp.unicode61_bytes
        ? (fp.trigram_bytes / fp.unicode61_bytes).toFixed(2)
        : "n/a";
      console.log(
        `[documents-search] trigram index rebuilt for ${m} document(s); ` +
          `unicode61=${Math.round(fp.unicode61_bytes / 1024)}KB ` +
          `trigram=${Math.round(fp.trigram_bytes / 1024)}KB (ratio ${ratio}x)`
      );
    }
  }
  return m;
}

// Build a safe FTS5 MATCH expression from a free-text query: each whitespace
// term becomes a quoted phrase, terms OR'd. Internal quotes are stripped (a
// lone quote would be a syntax error in the expression).
function matchExprFor(query) {
  const terms = String(query)
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter(Boolean)
    .map((t) => `"${t}"`);
  return terms.length ? terms.join(" OR ") : null;
}

// Non-ASCII detection for the routing gates below. \p{ASCII} avoids spelling
// control characters in the literal.
const hasNonAscii = (s) => /\P{ASCII}/u.test(s);

// Minimum query length the trigram index can serve: it indexes 3-character
// windows, so a 1-2 character CJK query matches NOTHING there. Those go to
// unicode61 (which matches whole tokens) and then to the LIKE escape hatch.
const TRIGRAM_MIN_CHARS = 3;

// Search the library.
//
// Routing, by measured capability rather than by preference:
//   * ASCII            -> unicode61 (v1). Unchanged behaviour.
//   * non-ASCII, >=3ch -> trigram (v2). unicode61 cannot MATCH a sub-phrase of a
//                         Han run; measured 25/25 such queries returned zero
//                         hits and fell into the unranked LIKE scan.
//   * non-ASCII, <3ch  -> unicode61 first (it can match a whole 2-char token),
//                         then LIKE. Never the trigram table: 0 hits guaranteed.
// `via` on each hit records which path produced it, so a degraded/unranked
// result is distinguishable from a ranked one.
export function searchLibrary(query, { collectionId = null, docId = null, limit = 10 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const filters = { collectionId, docId, limit };
  const shape = (rows, via) =>
    rows.map((r) => ({
      docId: r.doc_id, name: r.name, loc: r.loc, snippet: r.snippet, via,
    }));

  const expr = matchExprFor(q);
  const nonAscii = hasNonAscii(q);
  const useTrigram = nonAscii && [...q].length >= TRIGRAM_MIN_CHARS;

  if (expr && useTrigram) {
    const trigramHits = db.searchDocumentChunksTrigram(expr, filters);
    if (trigramHits && trigramHits.length) return shape(trigramHits, "trigram");
    // Trigram index absent, or genuinely nothing matched at trigram granularity:
    // fall through to the v1 path rather than returning a misleading empty set.
  }

  if (expr) {
    const hits = shape(db.searchDocumentChunks(expr, filters), "fts");
    if (hits.length || !nonAscii) return hits;
  }
  if (nonAscii) {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    // Unranked escape hatch: row order is chunk insertion order. Tagged so a
    // caller can tell it apart from a ranked result.
    return shape(db.likeDocumentChunks(like, filters), "like");
  }
  return [];
}

// Page through a document's full text. `cursor` is the next page's start
// (SQLite character position; pass the returned nextCursor verbatim).
// Returns { name, text, nextCursor, total } or { error } for the failure
// modes an agent can act on.
const READ_PAGE_CHARS = 8000;
export function readDocumentPage(docId, cursor = 0) {
  const start = Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0;
  const row = db.getDocumentPage(docId, start, READ_PAGE_CHARS);
  if (!row) return { error: `document ${docId} does not exist` };
  if (row.status !== "ready") return { error: `document "${row.name}" is not ready (status: ${row.status})` };
  const total = row.total ?? 0;
  const next = start + READ_PAGE_CHARS < total ? start + READ_PAGE_CHARS : null;
  return { name: row.name, text: row.text ?? "", nextCursor: next, total };
}

// ── Semantic rung (optional) ────────────────────────────────────────────────
//
// Contract: presence is opt-in, absence is not an error. `semanticHits` answers
// with an explicit `ok` flag so the caller can label the rung truthfully instead
// of guessing from an empty list. Fusion is RRF on ranks, because BM25 and
// cosine scores are not comparable and a weighted sum would need per-corpus
// tuning that drifts as the corpus changes.

import {
  readEmbedConfig, createEmbedder, decodeVector, encodeVector, cosine,
} from "./lib/embed-client.js";

const RRF_K = 60;

let _embedder = null;
let _embedderConfigKey = "";

function embedderFor(cfg) {
  const key = `${cfg.baseUrl}|${cfg.model}|${cfg.dimensions}`;
  if (!_embedder || _embedderConfigKey !== key) {
    _embedder = createEmbedder({ config: cfg });
    _embedderConfigKey = key;
  }
  return _embedder;
}

// Is the semantic rung switched on for this deployment? Configuration is the
// gate: no credentials, no rung. (Per-library opt-in is the product surface on
// top of this.)
export function semanticRungStatus(env = process.env) {
  const cfg = readEmbedConfig(env);
  const enabled = String(env.LIBRARY_SEMANTIC_RUNG || "").toLowerCase() === "on";
  return { enabled, configured: cfg.configured, model: cfg.model, dimensions: cfg.dimensions };
}

// Returns { ok, hits, reason, retryable }.
//   ok:false + reason "disabled"    -> rung off by configuration
//   ok:false + reason "unavailable" -> lane failed; the caller labels the downgrade
export async function semanticHits(query, { collectionId = null, docId = null, limit = 10 } = {},
  { embedder = null } = {}) {
  const status = semanticRungStatus();
  if (!status.enabled) return { ok: false, hits: [], reason: "disabled" };
  if (!status.configured) return { ok: false, hits: [], reason: "unavailable", retryable: false };
  // Per-library opt-in: the deployment lane being available is necessary but not
  // sufficient — nobody's documents are sent out until they said so.
  if (!db.getDeploymentConfig(SEMANTIC_OPT_IN_KEY)) return { ok: false, hits: [], reason: "disabled" };
  if (db.getDeploymentConfig(SEMANTIC_OPT_IN_KEY) !== "on") {
    return { ok: false, hits: [], reason: "disabled" };
  }

  const cfg = readEmbedConfig();
  const emb = embedder || embedderFor(cfg);
  let vector;
  try {
    const out = await emb.embedBatch([String(query || "")]);
    vector = Float32Array.from(out.vectors[0]);
  } catch (err) {
    return { ok: false, hits: [], reason: "unavailable", retryable: Boolean(err?.retryable) };
  }

  const rows = db.listChunkVectors({
    model: cfg.model, dim: cfg.dimensions, collectionId, docId,
  });
  const scored = [];
  for (const r of rows) {
    const v = decodeVector(r.vector);
    if (!v) continue;
    scored.push({ docId: r.doc_id, name: r.name, loc: r.loc, snippet: r.snippet, score: cosine(vector, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, Math.max(1, Math.min(20, limit))).map((h) => ({
    docId: h.docId, name: h.name, loc: h.loc, snippet: h.snippet, via: "vector",
  }));
  return { ok: true, hits, reason: "vector" };
}

// Reciprocal rank fusion. Same (docId, loc) from both paths accumulates, so a
// passage that is strong on both legs outranks one that is strong on only one.
export function fuseRrf(lexical, semantic, limit = 10) {
  const acc = new Map();
  const add = (rows, path) => {
    rows.forEach((r, i) => {
      const key = `${r.docId}::${r.loc}`;
      const cur = acc.get(key) || { ...r, via: r.via || path, score: 0, legs: new Set() };
      cur.score += 1 / (RRF_K + i + 1);
      cur.legs.add(path);
      if (!cur.snippet && r.snippet) cur.snippet = r.snippet;
      acc.set(key, cur);
    });
  };
  add(lexical, "lexical");
  add(semantic, "vector");
  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(20, limit)))
    .map((r) => ({
      docId: r.docId, name: r.name, loc: r.loc, snippet: r.snippet,
      // A hit found by both legs is a hybrid hit; otherwise name the leg that
      // actually produced it.
      via: r.legs.size > 1 ? "hybrid" : [...r.legs][0],
    }));
}

// ── Embedding pass (opt-in) ─────────────────────────────────────────────────
//
// There is deliberately NO job table. "A ready document whose chunks lack a
// vector under the current model/dim" IS the queue (db.listDocIdsMissingVectors):
// a failed document stays missing, so the next pass retries it, and there is no
// second source of truth to drift from the data. The only extra state is an
// in-memory cooldown so a permanently-bad document is not retried in a hot loop.

const _embedCooldown = new Map(); // docId -> epoch ms before which we skip
const EMBED_RETRY_COOLDOWN_MS = Number(process.env.LIBRARY_EMBED_RETRY_COOLDOWN_MS) || 10 * 60 * 1000;
const _embedStats = { attempted: 0, ok: 0, failed: 0, skipped: 0, lastError: null };

let _embedChain = Promise.resolve();

function inCooldown(docId, now = Date.now()) {
  const until = _embedCooldown.get(docId) || 0;
  return until > now;
}

// Embed one document's chunks. Resolves to { status, vectors?, error?, retryable? }
// and never throws — the caller is fire-and-forget.
export async function embedDocument(docId, { embedder = null } = {}) {
  const status = semanticRungStatus();
  if (!status.enabled || !status.configured) return { status: "disabled" };
  if (db.getDeploymentConfig(SEMANTIC_OPT_IN_KEY) !== "on") return { status: "disabled" };
  if (inCooldown(docId)) return { status: "cooldown" };

  const cfg = readEmbedConfig();
  const emb = embedder || embedderFor(cfg);
  const chunks = db.listDocumentChunks(docId);
  if (!chunks.length) return { status: "no_chunks" };

  const items = [];
  try {
    for (let i = 0; i < chunks.length; i += cfg.batchSize) {
      const batch = chunks.slice(i, i + cfg.batchSize);
      const out = await emb.embedBatch(batch.map((c) => c.text));
      batch.forEach((c, j) => {
        items.push({ loc: c.loc, vector: encodeVector(out.vectors[j]) });
      });
    }
  } catch (err) {
    const retryable = Boolean(err?.retryable);
    // Cooldown only for retryable failures: a permanent mismatch (bad input,
    // dimension drift) would be retried forever otherwise.
    if (retryable) _embedCooldown.set(docId, Date.now() + EMBED_RETRY_COOLDOWN_MS);
    _embedStats.failed++;
    _embedStats.lastError = { docId, message: err?.message || String(err), retryable };
    console.error(
      `[documents-search] embed failed for ${docId} (retryable=${retryable}):`,
      err?.message || err
    );
    return { status: "failed", error: err?.message || String(err), retryable };
  }

  db.upsertChunkVectors(docId, items, { model: cfg.model, dim: cfg.dimensions || null });
  bumpEmbedUsage(
    Math.ceil(chunks.length / Math.max(1, cfg.batchSize)),
    chunks.reduce((n, c) => n + c.text.length, 0),
  );
  _embedCooldown.delete(docId);
  _embedStats.ok++;
  return { status: "ok", vectors: items.length };
}

// Fire-and-forget, serialised: one embedding pass at a time keeps the lane's
// budget meaningful and stops a bulk upload from opening N concurrent batches.
export function scheduleEmbed(docId, { embedder = null } = {}) {
  const status = semanticRungStatus();
  if (!status.enabled || !status.configured) return Promise.resolve({ status: "disabled" });
  _embedStats.attempted++;
  _embedChain = _embedChain
    .then(() => embedDocument(docId, { embedder }))
    .catch((err) => {
      _embedStats.failed++;
      console.error(`[documents-search] embed pass crashed for ${docId}:`, err?.message || err);
      return { status: "failed", error: String(err?.message || err), retryable: true };
    });
  return _embedChain;
}

// Boot/backfill pass over documents missing vectors. Bounded per call so a large
// library cannot stall startup; the remainder is picked up on the next pass.
export async function backfillVectors({
  max = Number(process.env.LIBRARY_EMBED_BACKFILL_MAX) || 25, embedder = null,
} = {}) {
  const status = semanticRungStatus();
  if (!status.enabled || !status.configured) return { status: "disabled", done: 0, remaining: 0 };
  const cfg = readEmbedConfig();
  const missing = db.listDocIdsMissingVectors({ model: cfg.model, dim: cfg.dimensions });
  let done = 0;
  for (const id of missing.slice(0, max)) {
    const r = await scheduleEmbed(id, { embedder });
    if (r?.status === "ok") done++;
  }
  return { status: "ok", done, remaining: Math.max(0, missing.length - done) };
}

// ── Cost attribution + disk precheck ───────────────────────────────────────
//
// One cell == one deployment == one payer, so the counter lives in the cell's own
// deployment_config rather than a platform-side ledger. Default-off means the
// counter stays at zero, which is the whole point of an opt-in rung.
const EMBED_CALLS_KEY = "library.embed.calls";
const EMBED_CHARS_KEY = "library.embed.chars";

function bumpEmbedUsage(batches, chars) {
  const calls = Number(db.getDeploymentConfig(EMBED_CALLS_KEY) || 0) + batches;
  const total = Number(db.getDeploymentConfig(EMBED_CHARS_KEY) || 0) + chars;
  db.setDeploymentConfig(EMBED_CALLS_KEY, String(calls));
  db.setDeploymentConfig(EMBED_CHARS_KEY, String(total));
}

export function embedUsage() {
  return {
    calls: Number(db.getDeploymentConfig(EMBED_CALLS_KEY) || 0),
    chars: Number(db.getDeploymentConfig(EMBED_CHARS_KEY) || 0),
  };
}

// Vector bytes = chunks x dim x 4 (float32), the only新增 storage this rung adds.
// Refuse to enable when the estimate blows the configured ceiling: a cell that
// fills its node disk gets evicted, which is a much worse failure than an
// unavailable feature.
export function estimateVectorFootprint({ env = process.env } = {}) {
  const cfg = readEmbedConfig(env);
  const dim = cfg.dimensions || 0;
  const chunks = db.countTotalChunks ? db.countTotalChunks() : 0;
  const bytes = dim ? chunks * dim * 4 : 0;
  // `Number(x) || 512` would silently turn an explicit 0 into 512; a cap of 0 is
  // a legitimate "refuse everything" setting, so only an ABSENT value defaults.
  const rawCap = env.LIBRARY_VECTOR_DISK_CAP_MB;
  const capMb = rawCap === undefined || rawCap === "" ? 512 : Number(rawCap);
  return {
    chunks, dim, bytes,
    mb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
    capMb,
    ok: !dim ? false : bytes <= capMb * 1024 * 1024,
  };
}

// Reasons a search answered the way it did, for the tool's rung label.
export function embedStats() {
  const cfg = readEmbedConfig();
  return {
    ..._embedStats,
    stored: db.countChunkVectors({ model: cfg.model, dim: cfg.dimensions }),
    pending: db.listDocIdsMissingVectors({ model: cfg.model, dim: cfg.dimensions }).length,
  };
}

// ── Per-library semantic rung: opt-in + disclosure ledger ───────────────────
//
// The rung is off unless BOTH the deployment has a lane configured AND the
// library was explicitly switched on. Turning it on means the library's chunk
// text will leave the cell for the embedding lane, so the switch records who
// acknowledged that and when — "default off, explicit opt-in with disclosure"
// is a promise that needs an audit trail, not just a boolean.
//
// Stored in deployment_config (the existing per-cell key/value store): one
// library per cell, so a deployment-scoped key IS the library's setting.

const SEMANTIC_OPT_IN_KEY = "library.semanticRung";
const SEMANTIC_DISCLOSURE_KEY = "library.semanticRung.disclosure";

export const SEMANTIC_DISCLOSURE_TEXT =
  "开启后，本资料库的文档切块文本将被发送到部署配置的嵌入通道（外部服务）以生成检索向量。" +
  "文档原件与正文仍保存在本机；关闭后不再发送，但已生成的向量会保留以避免重复计费。";

// Full state for the settings surface, including WHY it cannot be enabled.
export function semanticOptInState(env = process.env) {
  const rung = semanticRungStatus(env);
  const enabled = db.getDeploymentConfig(SEMANTIC_OPT_IN_KEY) === "on";
  const disclosure = db.getDeploymentConfig(SEMANTIC_DISCLOSURE_KEY);
  return {
    enabled: enabled && rung.enabled && rung.configured,
    optedIn: enabled,
    laneConfigured: rung.configured,
    laneEnabled: rung.enabled,
    model: rung.model || null,
    dimensions: rung.dimensions || null,
    disclosure: SEMANTIC_DISCLOSURE_TEXT,
    acknowledgedAt: disclosure || null,
    // An unconfigured lane must be reported as unavailable, never as "off and
    // you can turn it on whenever".
    blockingReason: !rung.configured
      ? "嵌入通道未配置（LIBRARY_EMBED_BASE_URL / MODEL），无法开启"
      : !rung.enabled
        ? "部署未启用语义档（LIBRARY_SEMANTIC_RUNG=on）"
        : null,
  };
}

// Enablement requires an explicit acknowledgment of the disclosure. Passing a
// falsy ack is refused rather than silently ignored: consent that was not asked
// for is not consent.
export function setSemanticOptIn(on, { acknowledged = false } = {}) {
  const state = semanticOptInState();
  if (on) {
    if (!state.laneConfigured || !state.laneEnabled) {
      return { ok: false, reason: state.blockingReason || "嵌入通道不可用" };
    }
    if (!acknowledged) {
      return { ok: false, reason: "未确认出网披露", disclosure: SEMANTIC_DISCLOSURE_TEXT };
    }
    const fp = estimateVectorFootprint();
    if (!fp.ok) {
      return {
        ok: false,
        reason: `向量体积超上限：估算 ${fp.mb}MB > 上限 ${fp.capMb}MB（${fp.chunks} 块 × ${fp.dim} 维）`,
        footprint: fp,
      };
    }
    db.setDeploymentConfig(SEMANTIC_OPT_IN_KEY, "on");
    db.setDeploymentConfig(SEMANTIC_DISCLOSURE_KEY, new Date().toISOString());
    return { ok: true, state: semanticOptInState() };
  }
  db.setDeploymentConfig(SEMANTIC_OPT_IN_KEY, "off");
  return { ok: true, state: semanticOptInState() };
}

// Effective gate used by the search path: deployment lane + library opt-in.
export function semanticRungEffective(env = process.env) {
  const rung = semanticRungStatus(env);
  const optedIn = db.getDeploymentConfig(SEMANTIC_OPT_IN_KEY) === "on";
  return rung.enabled && rung.configured && optedIn;
}
