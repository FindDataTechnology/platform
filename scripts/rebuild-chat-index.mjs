#!/usr/bin/env node
// ── Rebuild the chat session index from dsh transcripts ──────────────────────
//
// The session index (`chat_sessions` / `chat_messages` in a cell's app.db) is a
// PROJECTION of the dsh runtime's per-session transcripts
// (`<cell>/dsh/sessions/<scope>/<sessionId>/session.jsonl.zstd`). When the index
// is lost or damaged, this tool rebuilds it from the transcripts — the store of
// record for conversation content (openspec: rebuild-chat-index, ADR-0021).
//
//   node scripts/rebuild-chat-index.mjs --cell-root /data/cells/<userId> \
//        [--legacy /path/to/pre-migration-app.db] [--apply] [--report out.json]
//
// Default is a DRY RUN: it parses, merges, and reports, and writes nothing.
// With --apply it backs up the existing index first, then upserts.
//
// Row semantics are the LIVE MIRROR's, not an approximation: they were verified
// byte-for-byte against a cell whose index still exists (14/14 sessions), and
// `scripts/test-rebuild-chat-index.mjs` pins them.
//
// Scope rules (design D2/D5):
//   - top-level sessions only (`delegationDepth` 0) — the live mirror never
//     indexes subagent sessions either;
//   - all three scope directories are read (`--app--`, `--data-workspace--`,
//     and the current per-cell workspace);
//   - a session present in both the transcripts and --legacy takes the MORE
//     COMPLETE side (row count), because the legacy database is a frozen
//     snapshot from the migration moment while a transcript keeps growing;
//   - legacy rows owned by another user are skipped, and legacy-only sessions
//     are imported as-is (including empty "New chat" rows, restoring the list
//     as it looked before the loss).

import { mkdir, readFile, readdir, copyFile, writeFile, rm as rmFile, mkdtemp } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import Database from "better-sqlite3";
import { normalizeFunctionalRefs } from "../artifact-normalize.js";
import { truncateTitle as truncateTitleShared } from "../lib/persistence.js";

const TITLE_MAX = 60;

// ── Transcript decoding ──────────────────────────────────────────────────────

// A session log is a sequence of concatenated zstd frames; zstdDecompressSync
// decodes only the first one, so split on the frame magic (same discipline as
// scripts/inspect-live-session.mjs). A partially-written trailing frame is
// skipped rather than failing the whole session.
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decodeTranscript(buf) {
  const starts = [];
  let at = buf.indexOf(ZSTD_MAGIC);
  while (at !== -1) {
    starts.push(at);
    at = buf.indexOf(ZSTD_MAGIC, at + 4);
  }
  let text = "";
  for (let i = 0; i < starts.length; i++) {
    const slice = buf.subarray(starts[i], i + 1 < starts.length ? starts[i + 1] : buf.length);
    try {
      text += zstdDecompressSync(slice).toString("utf8");
    } catch {
      /* a frame still being written — keep the frames that decode */
    }
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function textOf(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && typeof b === "object" && b.type === "text")
    .map((b) => b.text || "")
    .join("");
}

// ── The mirror semantics ─────────────────────────────────────────────────────

// Pure: transcript events in, mirror rows out. Mirrors server/dsh-events.js +
// server/agent-session.js as they write the live index:
//   - a user row per genuine user event (source.kind === "user"), whether it
//     arrives as an `agent/inbox/spliced` insertion or a consumed
//     `user/message`; deduplicated by event id (the same message appears as
//     both), so a prompt is never stored twice;
//   - an assistant row per `assistant/message` that carries text or that turn's
//     accumulated tool blocks;
//   - blocks synthesized from the turn's `tool/call`s, with `result`/`state`
//     filled from the matching `tool/result` (`arguments` is a JSON string on
//     the wire and an object in the store; `isError` maps to done/error).
export function transcriptToRows(events, { workspaceRoot = null } = {}) {
  const rows = [];
  const seenUserIds = new Set();
  let turnTools = [];

  const pushUser = (id, blocks) => {
    if (id && seenUserIds.has(id)) return;
    if (id) seenUserIds.add(id);
    rows.push({ role: "user", content: textOf(blocks), blocks: null, time: null });
  };

  for (const e of events) {
    const type = e?.type;
    const d = e?.data ?? {};
    if (!d || typeof d !== "object") continue;
    if (type === "turn/start") {
      turnTools = [];
    } else if (type === "tool/call") {
      let args = d.arguments;
      try {
        args = JSON.parse(args);
      } catch {
        /* keep the raw string, exactly as the live mirror does */
      }
      turnTools.push({ kind: "tool", id: d.callId, name: d.name, args });
    } else if (type === "tool/result") {
      const callId = d?.message?.source?.callId ?? d?.message?.content?.[0]?.toolCallId;
      const resultBlocks = d?.message?.content?.[0]?.content;
      const resultText = textOf(resultBlocks) || null;
      const isError = Boolean(d?.error) || Boolean(d?.message?.content?.[0]?.isError);
      for (const b of turnTools) {
        if (b.id === callId) {
          b.result = resultText;
          b.state = isError ? "error" : "done";
        }
      }
    } else if (type === "agent/inbox/spliced") {
      for (const ins of d.inserted || []) {
        if (ins && typeof ins === "object" && ins.source?.kind === "user") {
          pushUser(ins.id, ins.content);
        }
      }
    } else if (type === "user/message") {
      if (d.source?.kind === "user") pushUser(d.id, d.content);
    } else if (type === "assistant/message") {
      const blocks = d?.message?.content;
      const text = textOf(blocks);
      const persistBlocks = [...turnTools, ...(text ? [{ kind: "text", text }] : [])];
      if (text || turnTools.length) {
        rows.push({ role: "assistant", content: text, blocks: persistBlocks.length ? persistBlocks : null, time: e.time ?? null });
      }
    }
  }

  // Functional-reference normalization, as the live mirror applies before
  // persisting (ADR-0009). A failure here must never fail the rebuild — the
  // helper is itself total, and this guard keeps that contract visible.
  if (workspaceRoot) {
    for (const r of rows) {
      if (r.role === "assistant" && r.content) {
        try {
          r.content = normalizeFunctionalRefs(r.content, workspaceRoot);
        } catch {
          /* keep the un-normalized text rather than lose the message */
        }
      }
    }
  }
  return rows;
}

// Session metadata comes from the transcript header and the first user message,
// matching the live mirror's creation facts (title / preset / workspace) and
// its timestamps.
export function sessionMetaFrom(events, rows) {
  const header = events.find((e) => e?.type === "session") ?? {};
  const times = events.map((e) => e?.time).filter((t) => typeof t === "number");
  const firstUser = rows.find((r) => r.role === "user" && r.content.trim());
  return {
    id: header.id ?? null,
    delegationDepth: header.delegationDepth ?? 0,
    agentPreset: header.agentPreset ?? null,
    workspace: header.cwd ?? null,
    title: firstUser ? truncateTitleShared(firstUser.content, TITLE_MAX) || "New chat" : "New chat",
    createdAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    updatedAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

// ── Cell / transcript discovery ──────────────────────────────────────────────

async function readTranscriptSessions(cellRoot, report) {
  const sessionsRoot = path.join(cellRoot, "dsh", "sessions");
  const out = new Map(); // sessionId -> { meta, rows, scope }
  let scopes = [];
  try {
    scopes = (await readdir(sessionsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    report.errors.push(`no transcript root at ${sessionsRoot}`);
    return out;
  }
  for (const scope of scopes) {
    const scopeDir = path.join(sessionsRoot, scope);
    let dirs = [];
    try {
      dirs = (await readdir(scopeDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const sid of dirs) {
      const file = path.join(scopeDir, sid, "session.jsonl.zstd");
      if (!existsSync(file)) continue;
      let events;
      try {
        events = decodeTranscript(await readFile(file));
      } catch (err) {
        report.errors.push(`${scope}/${sid}: ${err.message}`);
        continue;
      }
      const rows = transcriptToRows(events, { workspaceRoot: null });
      const meta = sessionMetaFrom(events, rows);
      // Subagent sessions are never indexed (the live mirror skips them too).
      if (meta.delegationDepth !== 0) continue;
      // Normalization needs the workspace root, which the header supplies.
      if (meta.workspace) {
        for (const r of rows) {
          if (r.role === "assistant" && r.content) {
            try {
              r.content = normalizeFunctionalRefs(r.content, meta.workspace);
            } catch {
              /* keep un-normalized */
            }
          }
        }
      }
      const id = meta.id || sid;
      out.set(id, { meta: { ...meta, id }, rows, scope });
    }
  }
  return out;
}

async function readLegacySessions(legacyPath, owner, report) {
  const out = new Map();
  if (!legacyPath) return out;
  if (!existsSync(legacyPath)) {
    report.errors.push(`legacy database not found: ${legacyPath}`);
    return out;
  }
  // Copy before opening: the legacy file may sit on a read-only path (a mounted
  // configmap, a root-owned directory), and a WAL replay must never touch the
  // original. The copy goes to a temp directory, not beside the source.
  const tmpDir = await mkdtemp(path.join(tmpdir(), "rebuild-legacy-"));
  const tmp = path.join(tmpDir, "legacy.db");
  try {
    await copyFile(legacyPath, tmp);
  } catch (err) {
    report.errors.push(`legacy read failed: ${err.message}`);
    await rmFile(tmpDir, { recursive: true, force: true });
    return out;
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${legacyPath}${suffix}`)) await copyFile(`${legacyPath}${suffix}`, `${tmp}${suffix}`);
  }
  let db;
  try {
    db = new Database(tmp);
    const hasSessions = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_sessions'`)
      .get();
    if (!hasSessions) {
      report.errors.push(`legacy database has no chat_sessions table: ${legacyPath}`);
      return out;
    }
    const sessions = db.prepare(`SELECT * FROM chat_sessions`).all();
    for (const s of sessions) {
      if (owner && s.owner && s.owner !== owner) {
        report.skippedForeignOwner.push({ id: s.id, owner: s.owner });
        continue;
      }
      const msgs = db
        .prepare(`SELECT role, content, blocks, created_at FROM chat_messages WHERE session_id = ? ORDER BY seq`)
        .all(s.id);
      out.set(s.id, {
        meta: {
          id: s.id,
          title: s.title || "New chat",
          agentPreset: s.agent_preset ?? null,
          workspace: s.workspace ?? null,
          createdAt: s.created_at ?? null,
          updatedAt: s.updated_at ?? null,
          owner: s.owner ?? null,
        },
        rows: msgs.map((m) => ({
          role: m.role,
          content: m.content ?? "",
          blocks: m.blocks ? JSON.parse(m.blocks) : null,
          time: null,
        })),
      });
    }
  } catch (err) {
    report.errors.push(`legacy read failed: ${err.message}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
    await rmFile(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  return out;
}

// ── Merge ────────────────────────────────────────────────────────────────────

export function mergeSessions(transcripts, legacy, report) {
  const merged = new Map();
  for (const [id, t] of transcripts) {
    const l = legacy.get(id);
    if (!l) {
      report.plan.push({ id, source: "transcript", rows: t.rows.length, title: t.meta.title });
      merged.set(id, { ...t, source: "transcript" });
      continue;
    }
    // The more complete side wins, per session: the legacy database is a
    // snapshot frozen at the migration moment, so a session that kept going
    // has more in its transcript, while a pre-migration session can have more
    // in the legacy copy.
    const useTranscript = t.rows.length >= l.rows.length;
    const winner = useTranscript ? t : l;
    report.plan.push({
      id,
      source: useTranscript ? "transcript" : "legacy",
      rows: winner.rows.length,
      otherRows: useTranscript ? l.rows.length : t.rows.length,
      title: winner.meta.title,
    });
    merged.set(id, {
      meta: { ...winner.meta, owner: winner.meta.owner ?? l.meta.owner ?? t.meta.owner ?? null },
      rows: winner.rows,
      source: useTranscript ? "transcript" : "legacy",
    });
  }
  for (const [id, l] of legacy) {
    if (merged.has(id)) continue;
    report.plan.push({ id, source: "legacy-only", rows: l.rows.length, title: l.meta.title });
    merged.set(id, { ...l, source: "legacy-only" });
  }
  return merged;
}

// ── Index write ──────────────────────────────────────────────────────────────

function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    path TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, seq)`);
  const cols = new Set(db.prepare(`PRAGMA table_info(chat_sessions)`).all().map((c) => c.name));
  for (const [col, type] of [
    ["agent_preset", "TEXT"],
    ["workspace", "TEXT"],
    ["owner", "TEXT"],
  ]) {
    if (!cols.has(col)) db.exec(`ALTER TABLE chat_sessions ADD COLUMN ${col} ${type}`);
  }
  const msgCols = new Set(db.prepare(`PRAGMA table_info(chat_messages)`).all().map((c) => c.name));
  if (!msgCols.has("blocks")) db.exec(`ALTER TABLE chat_messages ADD COLUMN blocks TEXT`);
}

function writeIndex(db, merged, owner, now) {
  const upsertSession = db.prepare(
    `INSERT INTO chat_sessions (id, title, created_at, updated_at, path, agent_preset, workspace, owner)
     VALUES (@id, @title, @created_at, @updated_at, NULL, @agent_preset, @workspace, @owner)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       updated_at = excluded.updated_at,
       agent_preset = COALESCE(chat_sessions.agent_preset, excluded.agent_preset),
       workspace = COALESCE(chat_sessions.workspace, excluded.workspace),
       owner = COALESCE(chat_sessions.owner, excluded.owner)`
  );
  const deleteMsgs = db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`);
  const insertMsg = db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, seq, created_at, blocks)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  let sessions = 0;
  let messages = 0;
  const run = db.transaction(() => {
    for (const [id, s] of merged) {
      const created = s.meta.createdAt || now;
      const updated = s.meta.updatedAt || created;
      upsertSession.run({
        id,
        title: s.meta.title || "New chat",
        created_at: created,
        updated_at: updated,
        agent_preset: s.meta.agentPreset ?? null,
        workspace: s.meta.workspace ?? null,
        owner: s.meta.owner ?? owner ?? null,
      });
      // Idempotent: replace this session's messages wholesale so a re-run (or a
      // partial earlier run) converges on the same rows instead of appending.
      deleteMsgs.run(id);
      let seq = 0;
      for (const r of s.rows) {
        seq += 1;
        const ts = r.time ? new Date(r.time).toISOString() : created;
        insertMsg.run(id, r.role, r.content ?? "", seq, ts, r.blocks ? JSON.stringify(r.blocks) : null);
        messages += 1;
      }
      sessions += 1;
    }
  });
  run();
  return { sessions, messages };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--cell-root") args.cellRoot = argv[++i];
    else if (a === "--legacy") args.legacy = argv[++i];
    else if (a === "--report") args.report = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
  }
  return args;
}

const HELP = `Rebuild a cell's chat session index from its dsh transcripts.

Usage:
  node scripts/rebuild-chat-index.mjs --cell-root <dir> [--legacy <app.db>] [--apply] [--report <file>]

  --cell-root <dir>  the cell root (contains data/, dsh/, workspace/)
  --legacy <path>    pre-migration single-process app.db to merge (optional)
  --apply            write the index (default: dry run, nothing is written)
  --report <file>    also write the JSON report to this path
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!args.cellRoot) {
    process.stderr.write("--cell-root is required\n\n" + HELP);
    return 2;
  }
  const cellRoot = path.resolve(args.cellRoot);
  if (!existsSync(cellRoot)) {
    process.stderr.write(`cell root does not exist: ${cellRoot}\n`);
    return 2;
  }

  const report = {
    cellRoot,
    mode: args.apply ? "apply" : "dry-run",
    owner: null,
    plan: [],
    skippedForeignOwner: [],
    errors: [],
    totals: null,
    bytes: null,
  };

  // Owner: the cell's own identity file (absent in some fixtures — then rows
  // keep whatever owner the legacy side carried).
  let owner = null;
  const ownerFile = path.join(cellRoot, "data", "owner-groups.json");
  if (existsSync(ownerFile)) {
    try {
      owner = JSON.parse(await readFile(ownerFile, "utf8")).email ?? null;
    } catch {
      report.errors.push(`unreadable owner-groups.json: ${ownerFile}`);
    }
  }
  report.owner = owner;

  const transcripts = await readTranscriptSessions(cellRoot, report);
  const legacy = await readLegacySessions(args.legacy, owner, report);
  const merged = mergeSessions(transcripts, legacy, report);

  const rows = [...merged.values()].reduce((n, s) => n + s.rows.length, 0);
  const bytes = [...merged.values()].reduce(
    (n, s) => n + s.rows.reduce((m, r) => m + (r.content?.length ?? 0) + (r.blocks ? JSON.stringify(r.blocks).length : 0), 0),
    0
  );
  report.totals = {
    sessions: merged.size,
    messages: rows,
    fromTranscript: report.plan.filter((p) => p.source === "transcript").length,
    fromLegacy: report.plan.filter((p) => p.source === "legacy").length,
    legacyOnly: report.plan.filter((p) => p.source === "legacy-only").length,
    skippedForeignOwner: report.skippedForeignOwner.length,
  };
  report.bytes = bytes;

  const dbPath = path.join(cellRoot, "data", "data", "app.db");

  if (!args.apply) {
    // Dry run: report only. Still check the index for the live-writer warning.
    const suspicious = ["-wal", "-shm"].filter((s) => existsSync(`${dbPath}${s}`) && statSyncSize(`${dbPath}${s}`) > 0);
    if (suspicious.length) {
      report.warnings = [
        `index sidecar files present (${suspicious.join(", ")}) — a live cell may hold this database; stop the cell before --apply`,
      ];
    }
    printReport(report);
    if (args.report) await writeFile(args.report, JSON.stringify(report, null, 2));
    return report.errors.length ? 1 : 0;
  }

  // Apply: back up first, then write.
  await mkdir(path.dirname(dbPath), { recursive: true });
  if (existsSync(dbPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = `${dbPath}${suffix}`;
      if (existsSync(src)) await copyFile(src, `${dbPath}.bak-${stamp}${suffix}`);
    }
    report.backup = `${dbPath}.bak-${stamp}`;
  }
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    ensureSchema(db);
    report.written = writeIndex(db, merged, owner, new Date().toISOString());
  } finally {
    db.close();
  }
  printReport(report);
  if (args.report) await writeFile(args.report, JSON.stringify(report, null, 2));
  return report.errors.length ? 1 : 0;
}

function statSyncSize(p) {
  try {
    return readFileSync(p).length;
  } catch {
    return 0;
  }
}

function printReport(report) {
  const t = report.totals;
  console.log(`[rebuild] cell: ${report.cellRoot}`);
  console.log(`[rebuild] mode: ${report.mode}${report.backup ? ` (backup: ${report.backup})` : ""}`);
  console.log(`[rebuild] owner: ${report.owner ?? "(unknown)"}`);
  console.log(
    `[rebuild] sessions: ${t.sessions} (transcript ${t.fromTranscript}, legacy ${t.fromLegacy}, legacy-only ${t.legacyOnly})`
  );
  console.log(`[rebuild] messages: ${t.messages}`);
  console.log(`[rebuild] content bytes: ${t.messages ? (report.bytes / 1024).toFixed(1) : 0} KiB`);
  if (t.skippedForeignOwner) console.log(`[rebuild] skipped foreign-owner sessions: ${t.skippedForeignOwner}`);
  if (report.written) console.log(`[rebuild] wrote ${report.written.sessions} sessions / ${report.written.messages} messages`);
  for (const w of report.warnings ?? []) console.warn(`[rebuild] warning: ${w}`);
  for (const e of report.errors) console.error(`[rebuild] error: ${e}`);
}

// Run as a CLI only when this exact file is the entry point. A suffix check is
// not enough: `test-rebuild-chat-index.mjs` also ends with this file's name, and
// importing the module from the test suite would then run the CLI.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const code = await main();
  process.exit(code);
}
