// ── Legacy data migration importer ───────────────────────────────────────────
//
// One-time import of the project's legacy file-based stores into the SQLite
// project database, run at startup when the DB is fresh (empty). Each import is
// idempotent (skipped if the DB already has data / ids) and never deletes the
// legacy stores - they remain on disk as a backup / migration source.
//
//   - documents-store/manifest.json + per-doc source.txt  ->  documents
//       Docs with imported source_text land `ready` directly — under local
//       extraction the text IS the deliverable (no re-index queue anymore).
//       A legacy `ready` doc without source.txt lands `queued` so startup
//       reconciliation flags it for re-adding. Other statuses are preserved.
//   - sessions-store/*.jsonl (pi SessionManager line-delimited JSON) +
//     chat-history-store/*.json (oldest {id,title,messages[]} format)
//       ->  chat_sessions + chat_messages, mirroring user/assistant turns.
//
// Reads both legacy chat formats directly with stdlib fs (no SDK dependency);
// the dsh runtime persists sessions by id and SQLite is the store of record, so
// the old SDK-JSONL intermediate is gone and both formats flow straight in.
//
// Per-item failures are logged and skipped; they never block startup.

import { promises as fs } from "node:fs";
import path from "node:path";
import * as db from "./db.js";
import { extractMessageText } from "./chat-history.js";
import { truncateTitle as truncateTitleShared } from "./lib/persistence.js";

const TITLE_MAX = 60;

// migrate's variant falls back to "New chat" on empty (legacy rows without
// any title content) — the shared helper returns "" there.
const truncateTitle = (s) => truncateTitleShared(s, TITLE_MAX) || "New chat";

function toIso(d) {
  if (!d) return new Date().toISOString();
  if (typeof d === "string") return d;
  if (d instanceof Date || typeof d.toISOString === "function") return d.toISOString();
  return String(d);
}

// ── Documents ────────────────────────────────────────────────────────────────

export async function importLegacyDocuments() {
  if (!db.isDbReady()) return 0;
  if (db.countDocuments() > 0) return 0; // not fresh

  const storeDir = process.env.DOCUMENTS_STORE_DIR
    ? path.resolve(process.env.DOCUMENTS_STORE_DIR)
    : path.resolve("documents-store");
  const manifestPath = path.join(storeDir, "manifest.json");

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    return 0; // no legacy document store
  }

  const docs = Array.isArray(manifest.documents) ? manifest.documents : [];
  let imported = 0;
  for (const d of docs) {
    try {
      let sourceText = null;
      try {
        sourceText = await fs.readFile(path.join(storeDir, d.id, "source.txt"), "utf8");
      } catch {
        /* source may be missing for non-ready docs */
      }
      // Imported source text means extraction already happened → ready. A
      // legacy `ready` doc WITHOUT source text cannot resume → `queued`, which
      // startup reconciliation turns into an error row with re-add guidance.
      const status = sourceText ? "ready" : d.status === "ready" ? "queued" : d.status || "queued";
      db.upsertDocument({
        id: d.id,
        name: d.name,
        type: d.type,
        status,
        added_at: d.addedAt || toIso(),
        error: d.error ?? null,
        source_text: sourceText,
      });
      imported++;
    } catch (err) {
      console.warn(`[migrate] skipped document ${d.id}: ${err.message}`);
    }
  }
  if (imported) {
    console.log(`[migrate] imported ${imported} document(s) from ${storeDir}`);
  }
  return imported;
}

// ── Chat sessions ────────────────────────────────────────────────────────────
//
// One-time import of the project's two legacy chat stores into SQLite, run when
// the DB is fresh (empty). Reads both formats directly with stdlib fs:
//   - sessions-store/*.jsonl  : pi SessionManager JSONL (line-delimited entries)
//   - chat-history-store/*.json: oldest {id,title,createdAt,messages[]} format
//
// Idempotent (skipped if the DB already has sessions); never deletes the legacy
// stores. Per-session failures are logged and skipped.
//
// ponytail: flattens user/assistant message entries in file order — does not
// follow the SDK's branch tree or apply compaction summaries. Branched sessions
// may interleave, but legacy chats are rarely branched and this is a one-time
// best-effort read-only import.

// Parse a pi SessionManager JSONL file into {id,name,created,messages} where
// messages is the flat user/assistant text list in file order. Returns null if
// the file has no valid session header.
async function readJsonlSession(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let header = null;
  let name = null;
  const messages = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!header) {
      if (entry.type === "session" && typeof entry.id === "string") header = entry;
      continue;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") {
      name = entry.name.trim() || null;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const m = entry.message;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = extractMessageText(m);
    if (text) messages.push({ role: m.role, content: text, ts: entry.timestamp });
  }
  if (!header) return null;
  return { id: header.id, name, created: header.timestamp, messages };
}

// Read a chat-history-store/*.json file (oldest format).
async function readJsonSession(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let s;
  try {
    s = JSON.parse(raw);
  } catch {
    return null;
  }
  const msgs = Array.isArray(s.messages) ? s.messages : [];
  const messages = msgs
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: String(m.content || ""), ts: m.ts }));
  if (!messages.length) return null;
  return { id: s.id, name: s.title, created: s.createdAt, messages };
}

function writeSessionToDb(session) {
  const title = truncateTitle(session.name || session.messages[0]?.content);
  db.upsertSession(session.id, title, toIso(session.created), toIso(session.created), null);
  for (const m of session.messages) {
    db.appendMessage(session.id, m.role, m.content, toIso(m.ts));
  }
}

export async function importLegacySessions() {
  if (!db.isDbReady()) return 0;
  if (db.countChatSessions() > 0) return 0; // not fresh

  let imported = 0;

  // sessions-store/*.jsonl (pi SessionManager format)
  const sessionsDir = process.env.SESSIONS_STORE_DIR
    ? path.resolve(process.env.SESSIONS_STORE_DIR)
    : path.resolve("sessions-store");
  try {
    const files = (await fs.readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl"));
    for (const f of files) {
      const session = await readJsonlSession(path.join(sessionsDir, f));
      if (!session || !session.messages.length) continue;
      try {
        writeSessionToDb(session);
        imported++;
      } catch (err) {
        console.warn(`[migrate] skipped session ${session.id}: ${err.message}`);
      }
    }
  } catch {
    // no legacy sessions-store
  }

  // chat-history-store/*.json (oldest format)
  const legacyDir = process.env.CHAT_HISTORY_STORE_DIR
    ? path.resolve(process.env.CHAT_HISTORY_STORE_DIR)
    : path.resolve("chat-history-store");
  try {
    const files = (await fs.readdir(legacyDir)).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const session = await readJsonSession(path.join(legacyDir, f));
      if (!session || !session.messages.length) continue;
      try {
        writeSessionToDb(session);
        imported++;
      } catch (err) {
        console.warn(`[migrate] skipped session ${session.id}: ${err.message}`);
      }
    }
  } catch {
    // no legacy chat-history-store
  }

  if (imported) {
    console.log(`[migrate] imported ${imported} legacy session(s)`);
  }
  return imported;
}

export async function runLegacyMigrations() {
  if (!db.isDbReady()) return;
  await importLegacyDocuments();
  await importLegacySessions();
}
