// ── Document readers (local text extraction) ─────────────────────────────────
//
// Extracts plain text from uploaded file buffers for document types beyond
// PDF/Markdown/text/URL. Each type is parsed by the matching @llamaindex/readers
// reader (DocxReader, CSVReader, HTMLReader, JSONReader) or officeparser
// (XLSX, PPTX), which exposes loadDataAsContent(Uint8Array): Promise<Document[]>.
// The extracted text becomes the document's persisted source_text in the
// library store — pure local parsing, no LLM involvement.
//
// All readers work with no extra npm dependencies today: mammoth (docx),
// csv-parse (csv), @discoveryjs/json-ext (json), and htmlparser2 (html) are
// present transitively. JSONReader is constructed with a no-op logger so the
// underlying json-ext parser does not write progress lines to the server log.

import { DocxReader } from "@llamaindex/readers/docx";
import { CSVReader } from "@llamaindex/readers/csv";
import { HTMLReader } from "@llamaindex/readers/html";
import { JSONReader } from "@llamaindex/readers/json";
import officeparser from "officeparser";

// Silences @discoveryjs/json-ext's per-parse "Parsing JSON" progress logging.
const SILENT_LOGGER = {
  log() {},
  warn() {},
  error() {},
  info() {},
  debug() {},
};

// document type -> () => reader instance. Types not listed here (pdf/markdown/
// text/url) are handled directly by documents.js and never reach here.
function readerFor(type) {
  switch (type) {
    case "docx":
      return new DocxReader();
    case "xlsx":
      return "officeparser";
    case "pptx":
      return "officeparser";
    case "csv":
      return new CSVReader();
    case "html":
      return new HTMLReader();
    case "json":
      return new JSONReader({ logger: SILENT_LOGGER });
    default:
      return null;
  }
}

// Whether a document type is backed by a reader (used by documents.js to
// dispatch extraction).
export function hasReader(type) {
  return readerFor(type) !== null;
}

// Extract plain text from an in-memory buffer for a reader-backed document
// type. Returns the concatenated text of all extracted Documents. Throws on
// extraction failure; the caller (documents.js addDocument) turns that into an
// `error` row in isolation, so one bad file never affects another.
export async function extractText(type, buffer) {
  const reader = readerFor(type);
  if (!reader) throw new Error(`No reader for document type: ${type}`);
  if (!buffer) throw new Error(`Missing buffer for ${type} document`);

  // officeparser handles XLSX and PPTX.
  //
  // 两个必须一起改的点（2026-11-13 实测 officeparser@7.8.0）：
  //   1. 回调第一参**不是字符串**，是 ParsedOffice 对象，文本在 `.toText()` 上。
  //      按字符串 `.trim()` 会抛 `text.trim is not a function`。
  //   2. `parseOffice` 出错时**先**回调 `(undefined, err)`、**再**把同一个错误抛出去。
  //      旧写法不接它的返回值，那条 promise 没人处理 → unhandledRejection；
  //      Node 默认策略下这会**结束进程**，而表面症状只是"文档导入失败"。
  //      改成 await，错误就落到本函数的调用方手里。
  if (reader === "officeparser") {
    const result = await officeparser.parseOffice(buffer);
    // v7 是对象 + toText()；v6 直接给字符串。两种都认，升级依赖时不必再改这里。
    const text = typeof result?.toText === "function" ? result.toText() : result;
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) throw new Error(`officeparser produced empty text for ${type}`);
    return trimmed;
  }

  // LlamaIndex readers for DOCX, CSV, HTML, JSON
  const content = new Uint8Array(buffer);
  const docs = await reader.loadDataAsContent(content);
  const text = docs.map((d) => d.text || "").join("\n\n").trim();
  if (!text) throw new Error(`Reader produced empty text for ${type}`);
  return text;
}
