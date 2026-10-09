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
  return n;
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

// Non-ASCII detection for the LIKE-fallback gate (unicode61 cannot MATCH CJK
// runs; ASCII queries gain nothing from the scan). \p{ASCII} avoids spelling
// control characters in the literal.
const hasNonAscii = (s) => /\P{ASCII}/u.test(s);

// Search the library. Ranked FTS5 hits; falls back to a LIKE scan only when
// the query contains non-ASCII — the scan is the documented escape hatch for
// scripts the tokenizer cannot segment. Empty/no-match returns [] — never an
// error, never null.
export function searchLibrary(query, { collectionId = null, docId = null, limit = 10 } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  const filters = { collectionId, docId, limit };
  const shape = (rows) =>
    rows.map((r) => ({ docId: r.doc_id, name: r.name, loc: r.loc, snippet: r.snippet }));

  const expr = matchExprFor(q);
  if (expr) {
    const hits = shape(db.searchDocumentChunks(expr, filters));
    if (hits.length || !hasNonAscii(q)) return hits;
  }
  if (hasNonAscii(q)) {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    return shape(db.likeDocumentChunks(like, filters));
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
