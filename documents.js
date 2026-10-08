// ── Document library module (local extraction + SQLite) ──────────────────────
//
// Ingests documents (PDF, Markdown, plain text, URL, office formats) by
// extracting text LOCALLY — no LLM calls, no indexing pipeline, no provider
// configuration. Extraction happens inside the add request: the response
// carries the terminal status (`ready` or `error`), so the UI can never
// observe a stuck "indexing" state. Document records and extracted source
// text persist to the SQLite project database (`db.js`); search infrastructure
// over the library lives in `documents-search.js` (FTS5 chunks) and the agent
// retrieves through the library MCP tools.
//
// Status transitions are broadcast over WebSocket via an injected `broadcast`
// callback as `documents_status` events (a consistency mechanism — with
// synchronous ingest the HTTP response already carries the terminal status).

import { randomUUID } from "node:crypto";
import * as db from "./db.js";
import * as readers from "./readers.js";
import * as search from "./documents-search.js";
import { fetchUrlAsText } from "./server/web-fetch.js";
import { PDFParse } from "pdf-parse";

// Supported file extensions -> document type. The single source of truth for
// what the upload route accepts; the client file-picker `accept` and drag/paste
// type inference mirror this. Unsupported extensions are rejected (HTTP 415)
// rather than silently classified as Markdown.
export const EXT_TYPE_MAP = {
  ".pdf": "pdf",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".text": "text",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
  ".csv": "csv",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
};
export const SUPPORTED_EXTS = Object.keys(EXT_TYPE_MAP);

// Map an uploaded filename to its document type, or null if unsupported.
export function typeForFilename(filename) {
  const dot = (filename || "").lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  return EXT_TYPE_MAP[ext] || null;
}

// URL fetch caps live in server/web-fetch.js (shared with the websearch MCP).

let broadcast = () => {}; // injected WS broadcast (no-op until initStore)

// ── Store init ────────────────────────────────────────────────────────────────

export async function initStore({ broadcast: broadcastFn }) {
  if (broadcastFn) broadcast = broadcastFn;

  // Reconcile rows left non-terminal by a previous process. Synchronous ingest
  // makes these rare (a crash mid-request); WITH source_text the extraction is
  // already the deliverable → ready; without it the ingest cannot resume.
  if (db.isDbReady()) {
    for (const d of db.listDocuments()) {
      if (d.status !== "queued" && d.status !== "indexing") continue;
      const full = db.getDocument(d.id);
      if (full?.source_text?.trim()) {
        db.updateDocumentStatus(d.id, "ready");
        emitStatus(d, "ready");
      } else {
        const msg = "Ingest interrupted by server restart; please re-add the document.";
        db.updateDocumentStatus(d.id, "error", msg);
        emitStatus(d, "error", msg);
      }
    }
    // Idempotent chunk backfill for pre-upgrade rows (local CPU, no LLM).
    search.backfillChunks();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

// Add a document: extract text locally, persist it, return the TERMINAL status.
// The row is inserted as `queued` first so a mid-extraction crash leaves
// something for startup reconciliation; callers only see `ready`/`error`.
// `payload` carries the ingestion input:
//   - pdf: { buffer }
//   - markdown/text: { content } or { buffer }
//   - url: { url }
//   - reader types (docx/csv/html/json/xlsx/pptx): { buffer }
export async function addDocument({ type, name, buffer, content, url }) {
  const id = randomUUID();
  const docName = name || defaultName(type, url, content);
  const now = new Date().toISOString();
  db.upsertDocument({ id, name: docName, type, status: "queued", added_at: now });
  try {
    const sourceText = await extractSourceText({ type, name: docName, buffer, content, url });
    if (!sourceText.trim()) throw new Error("Extraction produced empty text");
    db.setDocumentSource(id, sourceText);
    search.indexDocumentChunks(id, docName, sourceText);
    db.updateDocumentStatus(id, "ready");
    emitStatus({ id, name: docName }, "ready");
    return { id, name: docName, status: "ready" };
  } catch (err) {
    const msg = err.message || "Ingest failed";
    db.updateDocumentStatus(id, "error", msg);
    emitStatus({ id, name: docName }, "error", msg);
    console.error(`[documents] ingest failed for "${docName}":`, msg);
    return { id, name: docName, status: "error", error: msg };
  }
}

export function listDocuments() {
  return db.listDocuments(); // [{ id, name, type, status, addedAt, error }]
}

// Return the extracted source text for a document (for the "view content" UI).
export async function getDocumentContent(id) {
  const doc = db.getDocument(id);
  return doc?.source_text ?? null;
}

// Delete a document (record + source text + index rows, via ON DELETE CASCADE).
// Idempotent: a missing id succeeds.
export async function removeDocument(id) {
  db.deleteDocument(id);
  return true;
}

// ── Local extraction ─────────────────────────────────────────────────────────

// Extract plain text for any supported document type. Pure-local: file buffers
// are parsed in-process, URLs are fetched (SSRF-protected). Throws with a
// specific message on failure; addDocument turns that into an `error` row.
async function extractSourceText({ type, buffer, content, url }) {
  if (url || type === "url") {
    return fetchUrlAsText(url);
  }
  if (type === "markdown" || type === "text") {
    const text = content ?? (buffer ? buffer.toString("utf8") : "");
    if (!text.trim()) throw new Error(`Missing ${type} content`);
    return text;
  }
  if (type === "pdf") {
    if (!buffer) throw new Error("Missing PDF buffer");
    // pdf-parse v2: one parser instance per document; destroy releases the
    // worker it spins up, so the finally matters as much as the await.
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      const text = (result?.text || "").trim();
      if (!text) throw new Error("PDF extraction produced empty text (scanned/image PDF?)");
      return text;
    } finally {
      parser.destroy();
    }
  }
  if (readers.hasReader(type)) {
    // Reader-backed types extract from the buffer; a content-only payload means
    // a restart re-ingest of already-extracted text — pass it through.
    if (buffer) return readers.extractText(type, buffer);
    const text = content || "";
    if (!text.trim()) throw new Error(`Missing ${type} content`);
    return text;
  }
  throw new Error(`Unsupported document type: ${type}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultName(type, url, content) {
  if (type === "url" && url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
  if (type === "text") {
    const preview = (content || "").trim().slice(0, 40).replace(/\n/g, " ");
    return preview ? `Note: ${preview}` : `Note ${new Date().toISOString().slice(0, 16)}`;
  }
  return "Untitled";
}

function emitStatus(doc, status, error) {
  broadcast({
    type: "documents_status",
    id: doc.id,
    name: doc.name,
    status,
    error: error || undefined,
  });
}
