// ── Functional-reference normalization for mirrored assistant text ──────────
//
// openspec: add-artifact-delivery (ADR-0009). At the mirror point the
// assistant's markdown may carry two kinds of broken *functional* references:
//
//   - `data:text/*` URI links — the model improvising a "download" by inlining
//     bytes. Browsers block top-level data: navigation, so the link is dead.
//     When the payload's bytes match a file under the session workspace, the
//     link is rewritten to that file's workspace-relative path (the platform
//     serves it); otherwise the link is reduced to its visible text.
//   - Absolute-path links that resolve under the session workspace — rewritten
//     to workspace-relative form so the clients' link resolver recognizes them.
//
// Narrative content is never altered: only markdown link targets in non-fenced
// segments are examined. Prose, inline code, and fenced code blocks (which may
// legitimately SHOW example markdown) pass through verbatim.
//
// Everything here is synchronous and bounded on purpose: recordMessage is a
// synchronous funnel (better-sqlite3) shared by web/WS, dsh events, cron and
// delegation. The workspace walk visits at most MAX_FILES entries, skips
// dependency/VCS directories, and reads a file only when its size already
// matches the payload's — typically zero or one read per data: link.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { maxFileBytes } from "./resources.js";

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_WALKED_FILES = 500;

// `[label](target)` — bare targets only (no spaces, no <…> form); a title
// suffix (`[l](t "title")`) is tolerated. Matches never cross a newline in the
// label, so a pasted fenced block inside prose cannot be half-matched.
const MD_LINK_RE = /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const FENCE_SPLIT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Parse a `data:<mediatype>[;base64],<payload>` URI into raw bytes, or null
// when it is not a text/* URI or does not decode.
function parseTextDataUri(uri) {
  const comma = uri.indexOf(",");
  if (comma === -1) return null;
  const meta = uri.slice(5, comma); // after "data:"
  const payload = uri.slice(comma + 1);
  const parts = meta.split(";");
  const mediatype = parts[0].toLowerCase();
  if (mediatype && !mediatype.startsWith("text/")) return null;
  const isBase64 = parts.slice(1).some((p) => p.trim().toLowerCase() === "base64");
  try {
    const buf = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
    // decodeURIComponent over base64 garbage succeeds with empty/short output;
    // a zero-byte payload is never a file match worth claiming.
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

// Bounded DFS over the workspace collecting relPath by (size, sha256), for one
// target size at a time. Any error means "cannot prove a match" — the caller
// leaves such links untouched rather than stripping them.
function buildIndexForSize(root, targetBytes) {
  const byHash = new Map();
  let walked = 0;
  const stack = [root];
  try {
    while (stack.length && walked < MAX_WALKED_FILES) {
      const dir = stack.pop();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (++walked >= MAX_WALKED_FILES) break;
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile() || st.size !== targetBytes || st.size > maxFileBytes()) continue;
        try {
          const hash = sha256Hex(readFileSync(full));
          if (!byHash.has(hash)) byHash.set(hash, path.relative(root, full).split(path.sep).join("/"));
        } catch {
          // unreadable file: not a candidate
        }
      }
    }
  } catch {
    return null;
  }
  return byHash;
}

function containedIn(root, resolved) {
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return false;
  try {
    // Symlink-escape guard, same discipline as the file-serving route.
    const realRoot = realpathSync(root);
    const realResolved = realpathSync(resolved);
    return realResolved === realRoot || realResolved.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

// Normalize one markdown link match. Returns the replacement string, or the
// original match when the target is not a functional reference we touch.
function replaceLink(match, label, target, root, sizeIndexCache) {
  if (target.startsWith("data:")) {
    const buf = parseTextDataUri(target);
    if (!buf) return match; // not a decodable text/* URI: leave as-is
    if (buf.length > maxFileBytes()) return label; // can never match: dead link, strip
    let index = sizeIndexCache.get(buf.length);
    if (index === undefined) {
      index = buildIndexForSize(root, buf.length);
      sizeIndexCache.set(buf.length, index);
    }
    if (index === null) return match; // walk failed: cannot prove no-match
    const rel = index.get(sha256Hex(buf));
    return rel ? `[${label}](${rel})` : label;
  }
  if (target.startsWith("/")) {
    const resolved = path.resolve(target);
    if (!containedIn(root, resolved) || !existsSync(resolved)) return match;
    const rel = path.relative(root, resolved).split(path.sep).join("/");
    return `[${label}](${rel})`;
  }
  return match;
}

// Rewrite functional references in `text` against `workspaceRoot`. Pure
// (no state survives the call), idempotent, and never throws: any internal
// failure returns the input unchanged — normalization must not be able to
// fail a message mirror.
export function normalizeFunctionalRefs(text, workspaceRoot) {
  if (typeof text !== "string" || !workspaceRoot || typeof workspaceRoot !== "string") return text;
  // Cheap prefilters: both rewrite forms are visible in the raw text.
  if (!text.includes("](data:") && !/\]\(\/[^)\s]*\)/.test(text)) return text;
  const sizeIndexCache = new Map();
  const segments = text.split(FENCE_SPLIT_RE);
  try {
    return segments
      .map((segment, i) => {
        // Odd indices are the fence captures from the split; skip them.
        if (i % 2 === 1) return segment;
        return segment.replace(MD_LINK_RE, (m, label, target) =>
          replaceLink(m, label, target, workspaceRoot, sizeIndexCache),
        );
      })
      .join("");
  } catch {
    return text;
  }
}
