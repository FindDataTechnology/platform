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

  // officeparser handles XLSX and PPTX
  if (reader === "officeparser") {
    return new Promise((resolve, reject) => {
      officeparser.parseOffice(buffer, (text, err) => {
        if (err) {
          reject(new Error(`officeparser failed for ${type}: ${err}`));
        } else if (!text || !text.trim()) {
          reject(new Error(`officeparser produced empty text for ${type}`));
        } else {
          resolve(text.trim());
        }
      }, { preserveTempFiles: false });
    });
  }

  // LlamaIndex readers for DOCX, CSV, HTML, JSON
  const content = new Uint8Array(buffer);
  const docs = await reader.loadDataAsContent(content);
  const text = docs.map((d) => d.text || "").join("\n\n").trim();
  if (!text) throw new Error(`Reader produced empty text for ${type}`);
  return text;
}
