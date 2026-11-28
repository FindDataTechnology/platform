// ── fetch_document_file implementation core ──────────────────────────────────
//
// The logic behind the library MCP server's fourth tool (add-doc-studio):
// locate a document's retained original under the uploads root and copy it
// into the agent workspace, so the agent can run office tooling (docx/xlsx/
// pptx) on files the user actually uploaded rather than on extracted text.
//
// Kept separate from library-mcp.js because that file is a stdio executable
// (importing it opens the database and connects a transport); this module is
// pure enough to unit-test directly. The workspace resolution here mirrors
// server/agent-session.js resolveBootWorkspace (AGENT_WORKSPACE pin >
// workspace.current preference > cwd) but cannot import that module — its
// import chain drags the whole server surface into the stdio child.

import path from "node:path";
import fs, { constants as fsConstants } from "node:fs/promises";

// Same key agent-session.js persists under; reading it (never writing) keeps
// this child in sync with the platform's workspace switch without a wire.
export const WORKSPACE_CURRENT_KEY = "workspace.current";

// Mirror of agent-session validateWorkspace: realpath FIRST (validate the
// target, not the link), then a writability probe — produced files must be
// writable here or every downstream consumer (preview, resource save) breaks.
async function writableRealDir(candidate) {
  try {
    const resolved = await fs.realpath(candidate);
    await fs.access(resolved, fsConstants.W_OK);
    return resolved;
  } catch {
    return null;
  }
}

// Same precedence as resolveBootWorkspace, same tier names for the reply so
// the agent (and logs) can see which tier produced the target directory.
export async function resolveWorkspaceDir({ env = process.env, getPreference = null } = {}) {
  const pin = String(env.AGENT_WORKSPACE || "").trim();
  if (pin) {
    const p = await writableRealDir(pin);
    if (p) return { path: p, source: "env" };
  }
  const saved = getPreference ? String(getPreference(WORKSPACE_CURRENT_KEY) || "").trim() : "";
  if (saved) {
    const p = await writableRealDir(saved);
    if (p) return { path: p, source: "preference" };
  }
  return { path: process.cwd(), source: "cwd" };
}

// Same sanitization as files.js saveUploadFile — a stored name and the name we
// write into the workspace must obey one rule, or serving/dotfile guarantees
// drift between the two copies.
export function safeFilename(name) {
  return (
    path
      .basename(String(name || "upload"))
      .replace(/[^\w.-]+/g, "_")
      .replace(/^\.+/, "") || "upload"
  );
}

// Error class so the stdio wrapper can distinguish "user-actionable original
// unavailable" from unexpected failures — both end up as tool errors, but the
// message wording is a contract (spec: explicit error, never a text fallback).
export class OriginalNotRetainedError extends Error {}

// Locate the original bytes for a document and copy them into workspaceDir.
// Returns the workspace-relative path. The stored original lives at
// uploads/<docId>/<name> (files.js saveUploadFile layout); the reference
// itself is not in the database, so presence IS a directory listing.
export async function storeOriginalInWorkspace({ doc, uploadsRoot, workspaceDir }) {
  if (!doc) throw new OriginalNotRetainedError("document does not exist");
  const dir = path.join(uploadsRoot, doc.id);
  let stored;
  try {
    stored = (await fs.readdir(dir)).filter((f) => !f.startsWith("."))[0] || null;
  } catch {
    stored = null;
  }
  if (!stored) {
    throw new OriginalNotRetainedError(
      `original file for ${doc.id} (${JSON.stringify(doc.name)}) was not retained — ` +
        `use read_document for the extracted text`,
    );
  }
  const filename = safeFilename(doc.name);
  const bytes = await fs.readFile(path.join(dir, stored));
  const target = path.join(workspaceDir, filename);
  // Overwrite is intentional: the bytes are canonical for the doc id, so a
  // re-fetch is idempotent rather than a duplicate.
  await fs.writeFile(target, bytes);
  return path.relative(workspaceDir, target);
}
