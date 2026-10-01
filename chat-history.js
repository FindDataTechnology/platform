// ── Chat history module (mirrored to SQLite) ─────────────────────────────────
//
// The dsh runtime persists chat sessions by id; SQLite is the store of record
// for the session list and read-only view APIs. This module MIRRORS each user
// prompt and assistant response into the project SQLite database as the turn
// progresses. List/view read from SQLite; the live agent is held by server.js.
//
// The `sm` (session manager) shim is set by server.js once the agent is created
// and exposes the minimum shape this module needs (getSessionId /
// getSessionFile / buildSessionContext) so the sidebar can flag the current
// session. Under dsh it is a thin shim around the dsh session id.
//
// Exposes:
//   - recordMessage(sessionId, role, content): mirror a turn into SQLite.
//   - listSessions(): SQLite sessions, merged with the in-memory current session.
//   - getSession(id): read a session's messages (SQLite, or live for current).
//   - currentSessionId(), getSessionPath(), messagesForClient(), etc.
//
// Switching/creating sessions mutates the live agent and is performed in
// server.js, which owns the agent session; this module owns read/convert/mirror
// operations.

import { promises as fs } from "node:fs";
import * as db from "./db.js";
import * as resources from "./resources.js";
import { storeDir } from "./paths.js";
import { truncateTitle as truncateTitleShared } from "./lib/persistence.js";

const TITLE_MAX = 60;

let SESSIONS_DIR = storeDir("sessions-store");
// The live agent's SessionManager (set by server.js once the agent is created).
let sm = null;
// The dsh bridge (set by server.js once the bridge is up). Optional — when
// absent, deleteSession skips the dsh-side cleanup (still removes the SQLite
// row and any on-disk JSONL).
let dshBridge = null;
// The selected dsh agent preset, read at session-row creation so the row
// records the mode the session starts under (best-effort: absent source or
// empty value leaves the row blank = deployment default). Set by server.js.
let presetSource = null;
// The runtime workspace, read at session-row creation so the row records the
// workspace the session starts in (best-effort: absent source leaves the row
// blank = the sidebar's Ungrouped group). Set by server.js. Read once — a
// mid-session workspace switch never re-groups a session.
let workspaceSource = null;

export async function initChatHistory() {
  SESSIONS_DIR = storeDir("sessions-store", process.env.SESSIONS_STORE_DIR);
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

export function setSessionManager(sessionManager) {
  sm = sessionManager;
}

export function setDshBridge(bridge) {
  dshBridge = bridge;
}

export function setPresetSource(source) {
  presetSource = typeof source === "function" ? source : null;
}

export function setWorkspaceSource(source) {
  workspaceSource = typeof source === "function" ? source : null;
}

export function getSessionsDir() {
  return SESSIONS_DIR;
}

// ── Message conversion ───────────────────────────────────────────────────────

// Extract a plain-text transcript from an SDK AgentMessage's content (which may be
// a string or an array of TextContent / ThinkingContent / ToolCall / ImageContent
// blocks). Thinking and tool-call blocks are omitted from the displayed transcript;
// the live agent still receives the full structured messages for context continuity.
export function extractMessageText(msg) {
  const c = msg?.content;
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (b == null) return "";
        if (typeof b === "string") return b;
        if (b.type === "text") return b.text || "";
        return ""; // skip thinking / toolCall / image
      })
      .join("\n")
      .trim();
  }
  return "";
}

// Convert SDK AgentMessage[] to the {role, content} form the UI renders. Only user
// and assistant text turns are included in the displayed transcript.
export function messagesForClient(agentMessages) {
  if (!Array.isArray(agentMessages)) return [];
  return agentMessages
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: extractMessageText(m) }));
}

const truncateTitle = (s) => truncateTitleShared(s, TITLE_MAX);

function titleFromFirstUser(messages) {
  const first = messages.find((m) => m?.role === "user");
  return truncateTitle(extractMessageText(first)) || "New chat";
}

// ── Mirroring ────────────────────────────────────────────────────────────────

// Mirror a single turn (user prompt or assistant response) for the current
// session into SQLite. Creates the session row on first message (title derived
// from the first user message; path from the SDK session file), then appends the
// message. `blocks` (optional, assistant turns) persists the block structure —
// tool calls with results — so a reloaded session rebuilds the evidence trail.
// No-op when the DB is unavailable (chat stays in-memory).
export function createSession(sessionId, owner = null) {
  if (!sessionId || deletingSessions.has(sessionId) || !db.isDbReady()) return;
  const now = new Date().toISOString();
  if (!db.sessionExists(sessionId)) {
    db.upsertSession(
      sessionId,
      "New chat",
      now,
      now,
      sm?.getSessionFile?.() ?? null,
      presetSource?.() || null,
      workspaceSource?.() || null,
    );
    // A session minted on a known requester's behalf (REST create) is that
    // user's from the first row — write-once, same as the first-message stamp.
    if (owner) db.stampSessionOwner(sessionId, owner);
  }
}

export function recordMessage(sessionId, role, content, blocks, ownerUser = null) {
  if (!sessionId || deletingSessions.has(sessionId) || !db.isDbReady()) return;
  const now = new Date().toISOString();
  const path = sm?.getSessionFile?.() ?? null;

  if (!db.sessionExists(sessionId)) {
    const title = role === "user" ? truncateTitle(content) || "New chat" : "New chat";
    // Creation facts: the preset + workspace selected at the moment the
    // session's first message lands. dsh locks a session to the composition
    // it started with, and the sidebar groups by the workspace it started
    // in — both are stamped once and never updated.
    const agentPreset = presetSource?.() || null;
    const workspace = workspaceSource?.() || null;
    db.upsertSession(sessionId, title, now, now, path, agentPreset, workspace);
    // Ownership is a creation fact too (add-session-ownership): the
    // authenticated user of the connection that submitted this session's
    // first mirrored message. Write-once at the store layer, so later turns
    // from cron/bot/other connections cannot re-stamp it.
    if (ownerUser) db.stampSessionOwner(sessionId, ownerUser);
  } else {
    if (ownerUser) db.stampSessionOwner(sessionId, ownerUser);
    if (role === "user" && content?.trim()) {
      const meta = db.getSessionMeta(sessionId);
      if (meta?.title === "New chat" && db.getChatMessages(sessionId).length === 0) {
        db.setTitle(sessionId, truncateTitle(content), now);
      }
    }
    db.touchSession(sessionId, now);
    if (path) db.setSessionPath(sessionId, path);
  }
  const inserted = db.appendMessage(sessionId, role, content || "", now, blocks?.length ? JSON.stringify(blocks) : undefined);
  // Charts ride the mirror funnel (openspec: add-resource-library): every
  // assistant turn that reaches SQLite — web, mini program, scheduled task — is
  // examined once, here. A parse failure is a skipped chart, never a failed
  // message record.
  if (role === "assistant" && inserted) {
    try {
      resources.captureFromMessage({
        sessionId,
        messageId: inserted.id,
        sessionTitle: db.getSessionMeta(sessionId)?.title || null,
        text: content || "",
        // The turn's own evidence trail: which MCP calls ran and what they
        // returned. A chart captured here can be witnessed against it, and the
        // calls are retained so the user can confirm one as its data source.
        blocks,
        createdAt: now,
      });
    } catch (err) {
      console.warn(`[resources] capture failed for session ${sessionId}: ${err.message}`);
    }
  }
}

// ── Listing ──────────────────────────────────────────────────────────────────

// Return session metadata (no message bodies), most-recently-updated first, with
// the current session flagged. Sourced from SQLite, merged with the in-memory
// current session so a brand-new (not-yet-mirrored) chat still appears.
//
// Scope (add-session-ownership): undefined = unscoped (auth-off — the
// deployment is one user); { owner } = that user's rows only; { includeAll }
// = everything (admin). The in-memory current-session merge respects the
// scope: a shared runtime's current session belongs to whoever prompted last,
// and must not leak into another user's list.
export async function listSessions(scope) {
  const currentId = sm?.getSessionId?.() ?? null;

  let sessions = [];
  if (db.isDbReady()) {
    sessions = db.listChatSessions(scope).map((s) => ({
      id: s.id,
      title: s.title || "Untitled",
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount ?? 0,
      path: s.path || null,
      agentPreset: s.agentPreset || null,
      workspace: s.workspace || null,
    }));
  }

  // Merge the current in-memory session if it isn't in SQLite yet (brand-new
  // chat before its first mirrored message) — but only when the scope is
  // entitled to it. An unscoped list (auth-off) sees everything; an owner
  // scope sees it when the row carries that owner, or when there is no row at
  // all: the un-rowed live session is the deployment's blank canvas — it owns
  // no content to leak, and accessSession admits every entitled connection
  // (the first mirrored message stamps its owner).
  // Truthiness, not === null: better-sqlite3's .get() returns UNDEFINED for a
  // missing row, and a strict === null check silently skipped the blank-canvas
  // merge (observed live: auth-on fresh boot pushed an empty list).
  const currentMeta = currentId && db.isDbReady() ? db.getSessionMeta(currentId) : null;
  const currentVisible =
    currentId &&
    (!scope?.owner ||
      scope.includeAll ||
      !currentMeta ||
      currentMeta?.owner === scope.owner);
  if (currentId && currentVisible && !sessions.some((s) => s.id === currentId)) {
    const ctx = sm?.buildSessionContext?.() ?? { messages: [] };
    sessions.push({
      id: currentId,
      title: titleFromFirstUser(ctx.messages),
      createdAt: null,
      updatedAt: null,
      messageCount: ctx.messages.length,
      path: sm?.getSessionFile?.() ?? null,
      agentPreset: presetSource?.() || null,
      workspace: workspaceSource?.() || null,
    });
  }

  for (const s of sessions) s.current = s.id === currentId;
  sessions.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return sessions;
}

// Ownership access check (add-session-ownership) shared by the WS handlers and
// the REST routes. `user` is the request's identity ({ email, groups } or
// null). Returns { ok, meta, reason } where reason is "not_found" |
// "forbidden". With auth off there is exactly one user (the machine owner):
// everything is accessible, preserving the dev/desktop/e2e single-user
// contract. With auth on: owner-or-admin, and NULL-owner rows (legacy,
// un-stamped) are admin-only — never a guess.
export function accessSession(user, id, { authEnabled, isAdmin }) {
  const meta = db.isDbReady() && id ? db.getSessionMeta(id) : null;
  // The live session can predate its first mirror (a brand-new chat has no
  // row until its first message lands): it is the deployment's own current
  // state and carries no foreign content, so viewing/prompting into it is
  // allowed — the first mirrored message stamps the owner.
  if (!meta) {
    if (id && id === currentSessionId()) return { ok: true, meta: null };
    return { ok: false, reason: "not_found", meta: null };
  }
  if (!authEnabled) return { ok: true, meta };
  if (isAdmin) return { ok: true, meta };
  if (meta.owner && user?.email && meta.owner === user.email) return { ok: true, meta };
  return { ok: false, reason: "forbidden", meta };
}

export function currentSessionId() {
  return sm?.getSessionId?.() ?? null;
}

// ── Title rename ─────────────────────────────────────────────────────────────
//
// Title validation is shared with the PATCH /api/chat-history/sessions/:id REST
// route in server.js; both call sanitizeTitle() so the WS path and the REST
// path have identical acceptance behavior. NOTE: distinct from the local
// `TITLE_MAX` (60) used for truncating message-derived chat titles above.
const RENAME_TITLE_MIN = 1;
const RENAME_TITLE_MAX = 200;

export class TitleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "empty" | "too_long" | "control_chars" | "not_found"
  }
}

export function sanitizeTitle(raw) {
  if (raw == null) {
    return { error: new TitleError("empty", "Title must not be empty") };
  }
  const t = String(raw).trim();
  if (t.length < RENAME_TITLE_MIN) {
    return { error: new TitleError("empty", "Title must not be empty") };
  }
  if (t.length > RENAME_TITLE_MAX) {
    return { error: new TitleError("too_long", `Title must be ≤ ${RENAME_TITLE_MAX} characters`) };
  }
  // Reject control characters (newlines, tabs, NULs). These are not user-visible
  // in any chat UI and would break the sidebar layout.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional - this regex exists to reject control characters in titles
  if (/[\x00-\x1f\x7f]/.test(t)) {
    return { error: new TitleError("control_chars", "Title must not contain control characters") };
  }
  return { value: t };
}

// Set a session's title by id. Returns the trimmed title on success; throws
// TitleError for validation failures or "not_found" when the id is unknown.
export function setTitle(id, rawTitle) {
  if (!id) throw new TitleError("not_found", "missing id");
  const r = sanitizeTitle(rawTitle);
  if (r.error) throw r.error;
  if (!db.isDbReady() || !db.sessionExists(id)) {
    throw new TitleError("not_found", `session ${id} not found`);
  }
  const now = new Date().toISOString();
  db.setTitle(id, r.value, now);
  return r.value;
}

// ── Delete ───────────────────────────────────────────────────────────────────
//
// Per-session mutex: keyed by sessionId so deletes against the SAME id serialize,
// but deletes against different ids run in parallel. The mutex covers both the
// in-flight check and the on-disk + DB cleanup so a concurrent `recordMessage`
// for the same id can never interleave with its own delete. The DB DELETE is
// atomic (single statement, FK CASCADE handles chat_messages); the on-disk
// unlink is atomic per file.
const deleteLocks = new Map();
const deletingSessions = new Set();

export class DeleteSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "active" | "not_found"
  }
}

// Delete a session by id. Throws DeleteSessionError when the id matches the
// currently-active session ("active", 409) or when the session does not exist
// ("not_found", 404). On success: removes the SQLite row, unlinks the on-disk
// sessions-store/<id>.jsonl file (if any), and asks dsh to forget its own
// persisted state (best-effort — dsh has no stock session/delete RPC, so a
// method-not-found warning is logged and ignored).
export async function deleteSession(id) {
  if (!id) throw new DeleteSessionError("not_found", "missing id");

  // Serialize concurrent deletes against the SAME id. Tail-call the prior
  // promise so the second caller waits for the first to finish, then re-checks
  // existence (the row may have been deleted by the prior call already).
  const prior = deleteLocks.get(id) || Promise.resolve();
  const next = prior.then(() => undefined).catch(() => undefined);
  deleteLocks.set(id, next);
  deletingSessions.add(id);
  try {
    await next;
    if (id === currentSessionId()) {
      throw new DeleteSessionError("active", "cannot delete the active session");
    }
    if (!db.isDbReady() || !db.sessionExists(id)) {
      throw new DeleteSessionError("not_found", `session ${id} not found`);
    }
    // dsh-side delete first: a failure is logged & swallowed, so the host-side
    // SQLite/file cleanup is always the winning delete. The dsh entry is just
    // an orphaned persistence-layer row that no host code path will ever look
    // up again (listSessions, getSession all hit the SQLite mirror).
    try {
      await dshBridge.deleteSession?.(id);
    } catch (err) {
      console.warn(`[chat-history] dsh deleteSession for ${id} failed (ignored): ${err.message}`);
    }
    // Host-side on-disk JSONL (if the legacy importer left one behind — under
    // dsh the live session file is null and there is nothing to unlink).
    const path = await getSessionPath(id);
    if (path) {
      try {
        await fs.unlink(path);
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.warn(`[chat-history] unlink ${path} failed: ${err.message}`);
        }
      }
    }
    // A different client can switch into this session while dsh cleanup runs.
    // Recheck immediately before the host-side delete so it remains protected.
    if (id === currentSessionId()) {
      throw new DeleteSessionError("active", "cannot delete the active session");
    }
    db.deleteSession(id);
  } finally {
    deletingSessions.delete(id);
    if (deleteLocks.get(id) === next) deleteLocks.delete(id);
  }
}

// ── Read-only session access ─────────────────────────────────────────────────

// Return a single session's messages by id (read-only; does not touch the live
// agent). Reads from SQLite; falls back to the in-memory current session if the
// id is the current unflushed session.
export async function getSession(id) {
  if (!id) return null;
  // Under dsh the session shim's buildSessionContext() is a no-op (returns no
  // messages), so the live branch would hand back an empty transcript for the
  // current session even though recordMessage has mirrored the turns into
  // SQLite. Fall through to SQLite when the live context is empty. (Under the
  // old pi runtime buildSessionContext returned the freshest in-memory state,
  // which is why the live branch existed.)
  if (id === currentSessionId()) {
    const ctx = sm?.buildSessionContext?.() ?? { messages: [] };
    const live = messagesForClient(ctx.messages);
    if (live.length) return { id, title: titleFromFirstUser(ctx.messages), messages: live };
  }
  if (!db.isDbReady()) return null;
  const meta = db.getSessionMeta(id);
  if (!meta) return null;
  const messages = db.getChatMessages(id);
  return { id, title: meta.title || "Untitled", messages };
}

// Resolve a session's on-disk JSONL file path by id (used when switching the
// live agent via the SDK). Sourced from SQLite.
export async function getSessionPath(id) {
  if (!id) return null;
  if (id === currentSessionId()) return sm?.getSessionFile?.() ?? null;
  return db.getSessionPath(id);
}

// ── One-time legacy import ────────────────────────────────────────────────────
//
// Legacy chat-history-store/*.json sessions are imported straight into SQLite by
// migrate.js's importLegacySessions (it reads both sessions-store/*.jsonl and
// chat-history-store/*.json directly with stdlib fs). This module no longer
// round-trips them through an intermediate SDK-JSONL store, so it has no legacy
// import of its own — see migrate.js.
