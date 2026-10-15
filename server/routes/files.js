// Read-only file serving for the preview drawer (openspec: file-preview-drawer).
//
// This is the first route that hands arbitrary file bytes to the browser, so
// the safety properties ARE the feature: read-only, an allowlist of roots
// (workspace, uploads, and the resource library's stored copies), and a
// realpath + prefix check that rejects traversal, absolute paths and
// symlinks that escape their root. Content the browser could execute in this
// origin is never served inline — anything off the safe-type allowlist forces a
// download disposition with an opaque type.

import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as resources from "../../resources.js";
import { storeDir } from "../../paths.js";

// Uploaded files get their own root, apart from the agent workspace: the agent
// can write the workspace, and a user's upload must not live somewhere the
// agent can overwrite or delete.
export const UPLOADS_DIR = storeDir("uploads");

// Types safe to serve inline. SVG is on the list but pinned down by the CSP
// header below — as an image subresource it is already inert, and the header
// makes it inert for the direct-navigation case too (stored XSS otherwise).
const INLINE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
]);

// A document id is a UUID; anything else in a key position is refused rather
// than resolved. DELETE /api/documents/:id takes its id from the URL, so a
// crafted id must never be able to name a directory outside the uploads root.
function safeKey(key) {
  const k = String(key ?? "");
  return /^[A-Za-z0-9_-]{1,64}$/.test(k) ? k : null;
}

// Write a buffer under a per-document directory and return the { root, rel }
// reference the serving route resolves. Keying by document id makes the stored
// original a pure function of that id: nothing has to be persisted to find it
// again, and removing the document removes the directory (removeUploadDir).
// This is the write path for composer attachments.
export async function saveUploadFile(buffer, filename, key) {
  const id = safeKey(key);
  if (!id) throw new Error("saveUploadFile requires a safe key");
  const dir = path.join(UPLOADS_DIR, id);
  await mkdir(dir, { recursive: true });
  // A leading dot would make the stored name a dotfile, which the serving route
  // refuses (dotfiles: "deny") — the reference would 403 forever. Strip leading
  // dots, and never let the name collapse to "." or "..": path.join would
  // resolve that back onto the uploads root and the write would fail EISDIR.
  const safe =
    path.basename(String(filename || "upload"))
      .replace(/[^\w.-]+/g, "_")
      .replace(/^\.+/, "") || "upload";
  const rel = `${id}/${safe}`;
  await writeFile(path.join(UPLOADS_DIR, rel), buffer);
  return { root: "uploads", rel };
}

// Remove a document's stored original. Idempotent: a missing directory is a
// success, so deleting a document twice does not error.
export async function removeUploadDir(key) {
  const id = safeKey(key);
  if (!id) return;
  await rm(path.join(UPLOADS_DIR, id), { recursive: true, force: true });
}

function rootsFor(ctx) {
  return {
    workspace: ctx.dshBridge?.getCwd?.() || process.cwd(),
    uploads: UPLOADS_DIR,
    // Stored resource bytes (openspec: add-resource-library). Server-written
    // only — resources.saveFile is the sole writer; this route stays read-only.
    resources: resources.filesRoot(),
  };
}

export function registerFileRoutes(ctx) {
  const { app } = ctx;

  app.get("/api/files", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const rootName = typeof req.query.root === "string" ? req.query.root : "workspace";
    const root = rootsFor(ctx)[rootName];
    // An unknown root, an empty path, a NUL, or an absolute path is a malformed
    // request, not a file — refuse before touching the filesystem.
    if (!root || !rel || rel.includes("\0") || path.isAbsolute(rel)) {
      return res.status(403).end();
    }

    // Lexical containment first, so a `..` attempt is a 403 even when the
    // escaped path does not exist (realpath of a missing file throws ENOENT,
    // which would otherwise be indistinguishable from an honest 404).
    const lexicalRoot = path.resolve(root);
    const lexical = path.resolve(lexicalRoot, rel);
    if (lexical !== lexicalRoot && !lexical.startsWith(lexicalRoot + path.sep)) {
      return res.status(403).end();
    }

    let realRoot;
    let real;
    try {
      realRoot = await realpath(lexicalRoot);
      real = await realpath(lexical);
    } catch {
      return res.status(404).end();
    }
    // Second check, on the resolved path: catches an in-root symlink whose
    // target lies outside the root.
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      return res.status(403).end();
    }

    const info = await stat(real).catch(() => null);
    if (!info?.isFile()) return res.status(404).end();

    const ext = path.extname(real).toLowerCase();
    const inlineType = INLINE_TYPES.get(ext);
    const filename = encodeURIComponent(path.basename(real));
    res.setHeader(
      "Content-Disposition",
      `${inlineType ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
    );
    if (inlineType) {
      res.type(inlineType);
      if (ext === ".svg") res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    } else {
      res.type("application/octet-stream");
    }
    // Send the path RELATIVE to the served root: `send` applies its dotfile
    // policy to the path it is handed, so an absolute path makes a dot in the
    // root's own prefix (a home dir like /Users/john.doe, or the e2e temp root)
    // look like a forbidden dotfile and 403s every file. Relative keeps the
    // guard where it belongs — a `.env` inside the root is still denied.
    // sendFile also adds Range/ETag/HEAD and keeps the Content-Type already set.
    res.sendFile(path.relative(realRoot, real), { root: realRoot, dotfiles: "deny" });
  });
}
