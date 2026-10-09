// ── Project database (SQLite) ────────────────────────────────────────────────
//
// The single persistence layer for the project's important information: chat
// messages, document records & source text, the PageIndex document index, and
// single-user preferences. Opened with WAL + foreign keys; schema migrations
// are tracked in `schema_migrations` and applied transactionally.
//
// Graceful degradation: if the DB cannot be opened or migrated (missing dir,
// permissions, corrupt file), `dbReady` stays false, a warning is logged, and
// the server continues to start - chat runs in-memory without persistence and
// documents are disabled. This mirrors the project's optional-dependency pattern.
//
// `DB_PATH` overrides the default `data/app.db` location.

import Database from "better-sqlite3";
import { promises as fs } from "node:fs";
import path from "node:path";
import { storeDir } from "./paths.js";

const DEFAULT_DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(storeDir("data"), "app.db");
const INDEX_VERSION = 1; // PageIndex result format version (re-index from source_text if bumped)

let db = null;
let dbReady = false;

// ── Schema migrations ───────────────────────────────────────────────────────
//
// Each migration is a list of SQL statements applied in a single transaction.
// `schema_migrations` itself is bootstrapped by the runner (chicken-and-egg),
// so it does not appear as a numbered migration.

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New chat',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        path TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        seq INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_session
        ON chat_messages(session_id, seq)`,
      `CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        added_at TEXT NOT NULL,
        error TEXT,
        source_text TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS doc_index (
        doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
        index_data TEXT NOT NULL,
        index_version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS user_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS collection_documents (
        collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        PRIMARY KEY (collection_id, document_id)
      )`,
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS extension_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS custom_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        content TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 4,
    statements: [
      `ALTER TABLE extension_configs ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`,
    ],
  },
  {
    version: 5,
    // origin: who seeded the row ("bundled" = shipped in the installer via the
    //   bundle manifest / server startup, "startup" = mcp.json, "user" = API).
    // locked: bundled entries the packager forbids deleting/disabling/editing.
    // permissions: nullable JSON ({ allow?: string[], deny?: string[] }) — the
    //   packager-declared tool allow/deny lists (consumed by the follow-up
    //   extension-tool-permissions change; stored now so seeding can persist it).
    // PRAGMA-guarded so the migration stays idempotent on DBs that picked the
    // columns up out-of-band (e.g. dev experimentation).
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(extension_configs)").all().map((c) => c.name)
      );
      if (!cols.has("origin"))
        db.exec(`ALTER TABLE extension_configs ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`);
      if (!cols.has("locked"))
        db.exec(`ALTER TABLE extension_configs ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`);
      if (!cols.has("permissions"))
        db.exec(`ALTER TABLE extension_configs ADD COLUMN permissions TEXT`);
    },
  },
  {
    version: 6,
    // Transcript block structure (tool calls with results) as nullable JSON on
    // assistant messages, so a reloaded session rebuilds the evidence trail
    // instead of flattening it to prose. Rows written before this migration
    // have NULL blocks and fall back to the plain-content path.
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(chat_messages)").all().map((c) => c.name)
      );
      if (!cols.has("blocks")) db.exec(`ALTER TABLE chat_messages ADD COLUMN blocks TEXT`);
    },
  },
  {
    version: 7,
    // Full-fidelity dsh notification log for the /trace viewer. One row per
    // runtime notification, keyed by turn (the durable message id returned by
    // prompt()). Payload is raw JSON; per-type summaries are derived at read
    // time so new event types never need a migration.
    statements: [
      `CREATE TABLE IF NOT EXISTS trace_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        method TEXT NOT NULL,
        event_type TEXT,
        payload TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_trace_turn ON trace_events(turn_id)`,
      `CREATE INDEX IF NOT EXISTS idx_trace_ts ON trace_events(ts)`,
    ],
  },
  {
    version: 8,
    // Social chat-platform bots (WeCom / Feishu / Telegram / WeChat OA).
    // `secret` is the per-bot random path segment of the webhook URL (it
    // defeats bot-id guessing; the platform's own signature check is the real
    // verification). `credentials` is server-only JSON — never serialized to
    // the browser (the REST layer masks it).
    statements: [
      `CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        secret TEXT NOT NULL,
        credentials TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 9,
    // The dsh agent preset (agent mode) a session STARTED under, recorded at
    // session-row creation so a resumed session's header label resolves to the
    // composition it actually runs. Nullable: rows written before this
    // migration (and blank deployments) read as "the deployment default".
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(chat_sessions)").all().map((c) => c.name)
      );
      if (!cols.has("agent_preset"))
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN agent_preset TEXT`);
    },
  },
  {
    version: 10,
    // The runtime workspace a session ran in, recorded at session-row creation
    // so the sidebar can group sessions by workspace. Nullable: rows written
    // before this migration surface as the sidebar's "Ungrouped" group, and a
    // mid-session workspace switch never re-stamps the row.
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(chat_sessions)").all().map((c) => c.name)
      );
      if (!cols.has("workspace"))
        db.exec(`ALTER TABLE chat_sessions ADD COLUMN workspace TEXT`);
    },
  },
  {
    version: 11,
    // Library search index: chunked document text under FTS5 (bm25 ranking).
    // Written in the same logical step as source_text at ingest; rows are
    // replaced wholesale per document (delete + insert in one transaction).
    // A virtual table cannot carry FK cascades, so document deletion purges
    // chunks explicitly in deleteDocument(). Existing rows are backfilled at
    // startup by documents-search.js, not by this migration (keep DDL only).
    statements: [
      `CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks USING fts5(
        text,
        doc_id UNINDEXED,
        name UNINDEXED,
        loc UNINDEXED
      )`,
    ],
  },
  {
    version: 12,
    statements: [
      `CREATE TABLE IF NOT EXISTS user_model_bindings (
        email TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (email)
      )`,
      `CREATE TABLE IF NOT EXISTS user_mcp_bindings (
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (email, name)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_mcp_bindings_email
        ON user_mcp_bindings(email)`,
    ],
  },
  {
    // Role gating for market-installed MCP entries (add-role-gated-extensions):
    // null = ungated; a JSON array of group names required to keep the server
    // in the effective runtime profile. Stamped at install time only.
    version: 13,
    statements: [
      `ALTER TABLE extension_configs ADD COLUMN required_groups TEXT`,
    ],
  },
  {
    // Machine-caller relay (add-bot-relay-endpoint). `bot_chats` records which
    // chats have actually talked to each bot — the chat key is otherwise never
    // persisted (it is hashed one-way into the dsh session id), so this is the
    // only way a destination can be shown or bound. `bot_channels` binds a
    // stable name to exactly one (bot, chat_key), which is what a relay caller
    // addresses. `bot_relay_log` audits every relay attempt.
    //
    // No message text in any of the three: the log keeps the length only, and
    // the chat record keeps identity and timing only (design D4/D5).
    version: 14,
    statements: [
      `CREATE TABLE IF NOT EXISTS bot_chats (
        bot_id TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        sender_name TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, chat_key)
      )`,
      `CREATE TABLE IF NOT EXISTS bot_channels (
        name TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS bot_relay_log (
        ts TEXT NOT NULL,
        channel TEXT,
        bot_id TEXT,
        text_chars INTEGER,
        outcome TEXT NOT NULL,
        error TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_bot_relay_log_ts ON bot_relay_log(ts)`,
    ],
  },
  {
    // registry-sso-credentials: one market-proxy credential per user, minted
    // through the registry's silent SSO popup (or pasted by hand). Keyed by
    // identity email, never returned to the browser, and referenced from an
    // installed registry MCP server as `credentialRef: "registry"` — the
    // effective-profile writer resolves that ref to an Authorization header, so
    // the token itself never lands in extension_configs.
    version: 15,
    statements: [
      `CREATE TABLE IF NOT EXISTS user_registry_credentials (
        email TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        expires_at TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'sso',
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    // resource-library: artifacts produced in chat (openspec: add-resource-library).
    // Charts are captured automatically from assistant turns; files are saved
    // by explicit user action. `type` + `payload` is the extension seam for
    // future kinds — a new type adds rows, never a schema change.
    //
    // Provenance is a SOFT reference on purpose: session_id/message_id carry
    // no foreign key, so deleting a session leaves its resources intact, with
    // session_title (a snapshot taken at capture time) as the display fallback.
    //
    // content_hash is UNIQUE because a resource's identity IS its content:
    // regeneration re-emits identical chart specs, and this constraint (plus
    // the insert-or-return-existing helper) is what makes that idempotent.
    // file_path is relative to the resources root that /api/files serves
    // (`root=resources`); payload holds the normalized chart option JSON.
    version: 16,
    statements: [
      `CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        session_title TEXT,
        message_id INTEGER,
        payload TEXT,
        file_path TEXT,
        file_size INTEGER,
        file_mime TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT,
        seeded INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_hash ON resources(content_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type, created_at DESC)`,
    ],
  },
  {
    // Chart data binding: the binding rows + the resource-side references
    // (openspec: add-chart-data-binding). A binding is a data SOURCE, not a
    // property of one chart: identity is the content-derived lineage key, so
    // two charts over the same call share one row and one observation history.
    //
    // Additive on purpose — an older build ignores these columns entirely
    // (SELECTs name their columns, the new columns are nullable), which is the
    // rollback story: drop the routes, keep the tables, charts keep rendering
    // their static payload.
    //
    //   binding_refs       JSON [{seriesIndex, bindingId}] — one per rendered
    //                      series; a chart with no refs renders its own payload.
    //   binding_candidates JSON [{name, args, result}] — the same-turn MCP
    //                      calls that produced the chart, retained so the user
    //                      can confirm one later. Results are capped at capture
    //                      (200KB) because this column is per-chart, not global.
    version: 17,
    statements: [
      `CREATE TABLE IF NOT EXISTS chart_bindings (
        id TEXT PRIMARY KEY,
        lineage_key TEXT NOT NULL,
        server TEXT NOT NULL,
        tool TEXT NOT NULL,
        args TEXT NOT NULL,
        map TEXT NOT NULL,
        concept TEXT,
        frequency TEXT NOT NULL,
        unit TEXT,
        refresh_rule TEXT,
        origin TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        stale_reason TEXT,
        stale_since TEXT,
        last_ok_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        backoff_until TEXT,
        gate_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_chart_bindings_lineage ON chart_bindings(lineage_key)`,
      `ALTER TABLE resources ADD COLUMN binding_refs TEXT`,
      `ALTER TABLE resources ADD COLUMN binding_candidates TEXT`,
    ],
  },
  {
    // The bitemporal point store + the refresh log (openspec:
    // add-chart-data-binding). Two time axes: `period` is the valid time the
    // value is about, `observed_at` the record time we learned it.
    //
    //   chart_point_revisions — append-only truth. `kind` records what each
    //     observation WAS (appended/revised/resourced/unchanged) because the
    //     retention sweeper keeps changed rows forever and prunes unchanged
    //     ones to their first+latest observation; without the kind the
    //     distinction is unrecoverable.
    //   chart_series_points — the materialized latest view every render reads,
    //     written in the same transaction as the revision rows.
    //   chart_refreshes — what we DID (log, not data): one row per refresh
    //     attempt with per-classification counts, the gate fingerprint it
    //     skipped on, and the anomaly detail (both conflicting values).
    version: 18,
    statements: [
      `CREATE TABLE IF NOT EXISTS chart_point_revisions (
        binding_id TEXT NOT NULL,
        series TEXT NOT NULL,
        period TEXT NOT NULL,
        value REAL,
        source TEXT,
        kind TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (binding_id, series, period, observed_at)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chart_point_revisions_seen ON chart_point_revisions(observed_at)`,
      `CREATE TABLE IF NOT EXISTS chart_series_points (
        binding_id TEXT NOT NULL,
        series TEXT NOT NULL,
        period TEXT NOT NULL,
        value REAL,
        source TEXT,
        first_seen_at TEXT NOT NULL,
        revision_count INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (binding_id, series, period)
      )`,
      `CREATE TABLE IF NOT EXISTS chart_refreshes (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        trigger TEXT NOT NULL,
        outcome TEXT NOT NULL,
        added INTEGER NOT NULL DEFAULT 0,
        revised INTEGER NOT NULL DEFAULT 0,
        resourced INTEGER NOT NULL DEFAULT 0,
        unchanged INTEGER NOT NULL DEFAULT 0,
        missing INTEGER NOT NULL DEFAULT 0,
        anomalies INTEGER NOT NULL DEFAULT 0,
        anomalies_detail TEXT,
        gate TEXT,
        error TEXT,
        duration_ms INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chart_refreshes_binding ON chart_refreshes(binding_id, fetched_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_chart_refreshes_fetched ON chart_refreshes(fetched_at)`,
    ],
  },
  {
    version: 19,
    statements: [
      // Deployment-wide key/value config (branding now, future knobs without
      // migrations). Same shape as user_preferences, resolved stored→env at read.
      `CREATE TABLE IF NOT EXISTS deployment_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 20,
    // Pack marketplace (add-pack-marketplace). All additive: pack ownership of
    // custom skills (nullable — user-created and pre-migration rows have none),
    // creator drafts, and the cell's installed-pack state (the operational
    // truth for what a subscription materialized here, including the version
    // snapshot that uninstall and upgrade diff against).
    statements: [
      `ALTER TABLE custom_skills ADD COLUMN origin_pack_id TEXT`,
      `ALTER TABLE custom_skills ADD COLUMN origin_pack_version INTEGER`,
      `CREATE TABLE IF NOT EXISTS pack_drafts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        entries TEXT NOT NULL DEFAULT '{}',
        published_pack_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS installed_packs (
        pack_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        manifest TEXT NOT NULL,
        report TEXT NOT NULL DEFAULT '[]',
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 21,
    // Custom presets (add-custom-presets, design D1): the cell's user-composed
    // persona presets. One row per preset — indexed rows (not a preferences
    // blob) because the catalog source and the management page list them; the
    // installed_packs table is the working precedent. ids are server-assigned
    // under the reserved `user.` prefix; the row IS the owner (no ownership
    // bookkeeping columns).
    statements: [
      `CREATE TABLE IF NOT EXISTS user_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        persona TEXT NOT NULL,
        skills TEXT NOT NULL DEFAULT '[]',
        mcp_servers TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        icon TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 22,
    // Session ownership (add-session-ownership): the email of the authenticated
    // user whose connection submitted the session's first user message. Nullable
    // by design — auth-off deployments never stamp (single-user semantics), and
    // pre-existing rows are backfilled only when SESSION_LEGACY_OWNER names the
    // account that owns them (unset ⇒ rows stay NULL, which under auth-on means
    // admin-only visibility). The backfill itself is an idempotent boot step,
    // not just this migration — see backfillSessionOwners.
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(chat_sessions)").all().map((c) => c.name)
      );
      if (!cols.has("owner")) db.exec(`ALTER TABLE chat_sessions ADD COLUMN owner TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner ON chat_sessions(owner)`);
    },
  },
  {
    version: 23,
    // connector-credentials (add-connector-credentials, design D2): the 萬星
    // connector's per-user PAT (oct_…, no expiry — revocation is user-driven).
    // Same shape as user_registry_credentials but a separate table: the two
    // credentials have independent lifecycles (connecting one side must never
    // disturb the other), and merging them would force a data migration for
    // zero behavioral gain. Referenced from mcp.json's connector server row as
    // `credentialRef: "connector"` — the token never lands in any server config.
    statements: [
      `CREATE TABLE IF NOT EXISTS user_connector_credentials (
        email TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
];

function nowIso() {
  return new Date().toISOString();
}

function bootstrapMigrationsTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
}

function appliedVersions() {
  return new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version)
  );
}

function runMigrations() {
  bootstrapMigrationsTable();
  const applied = appliedVersions();
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const apply = db.transaction(() => {
      for (const stmt of m.statements ?? []) db.exec(stmt);
      if (m.apply) m.apply(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(m.version, nowIso());
    });
    apply();
    console.log(`[db] applied migration v${m.version}`);
  }
}

function latestVersion() {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
  return row?.v ?? 0;
}

// ── Init / degradation ───────────────────────────────────────────────────────

export async function initDb() {
  const dbPath = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : DEFAULT_DB_PATH;
  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations();
    dbReady = true;
    // Legacy-owner assignment (add-session-ownership): idempotent, runs on
    // every boot so setting SESSION_LEGACY_OWNER later still claims the
    // ownerless remainder on the next restart.
    const legacyOwner = String(process.env.SESSION_LEGACY_OWNER || "").trim();
    if (legacyOwner) {
      const claimed = backfillSessionOwners(legacyOwner);
      if (claimed) console.log(`[db] assigned ${claimed} ownerless session(s) to the legacy owner`);
    }
    console.log(`[db] opened ${dbPath} (schema v${latestVersion()})`);
  } catch (err) {
    dbReady = false;
    db = null;
    console.warn(`[db] disabled: could not open/migrate ${dbPath}: ${err.message}`);
  }
}

export function isDbReady() {
  return dbReady;
}

// Raw handle for feature modules that own their own tables/queries (trace).
// Null when the DB failed to open — callers guard with isDbReady().
export function getDb() {
  return db;
}

export function getIndexVersion() {
  return INDEX_VERSION;
}

// Prepared-statement registry: better-sqlite3 statements are reusable and
// compiled per prepare() — caching them turns every helper call (hot path:
// two per chat message) from a compile+run into a run only. Cache lives for
// the process lifetime; db.js opens exactly once (initDb) and a failed open
// nulls dbReady before any helper runs.
const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

// ── Chat sessions & messages ─────────────────────────────────────────────────

export function upsertSession(id, title, createdAt, updatedAt, path = null, agentPreset = null, workspace = null) {
  if (!dbReady) return;
  stmt(
    `INSERT INTO chat_sessions (id, title, created_at, updated_at, path, agent_preset, workspace)
     VALUES (@id, @title, @created_at, @updated_at, @path, @agent_preset, @workspace)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       updated_at = excluded.updated_at,
       path = COALESCE(excluded.path, chat_sessions.path),
       agent_preset = COALESCE(chat_sessions.agent_preset, excluded.agent_preset),
       workspace = COALESCE(chat_sessions.workspace, excluded.workspace)`
  ).run({ id, title: title || "New chat", created_at: createdAt, updated_at: updatedAt, path, agent_preset: agentPreset, workspace });
}

export function setSessionPath(id, path) {
  if (!dbReady) return;
  stmt("UPDATE chat_sessions SET path = ? WHERE id = ?").run(path, id);
}

// Stamp the owning user on first mirror (add-session-ownership). Write-once:
// only a NULL owner is fillable, so cron/bot turns continuing another user's
// session can never re-stamp it. Returns true when the row was stamped.
export function stampSessionOwner(id, owner) {
  if (!dbReady || !id || !owner) return false;
  const result = stmt(
    "UPDATE chat_sessions SET owner = ? WHERE id = ? AND owner IS NULL"
  ).run(owner, id);
  return result.changes > 0;
}

// Assign every still-ownerless row to the deploy-designated legacy owner
// (add-session-ownership). Idempotent, and deliberately a boot STEP rather
// than only a migration: a versioned migration runs exactly once, but the
// operator story is "set SESSION_LEGACY_OWNER (now or later) and restart" —
// this is what makes the later half true. Auth-off deployments leave the env
// unset and never call it with a value.
export function backfillSessionOwners(owner) {
  if (!dbReady || !owner) return 0;
  return stmt("UPDATE chat_sessions SET owner = ? WHERE owner IS NULL").run(owner).changes;
}

export function touchSession(id, updatedAt) {
  if (!dbReady) return;
  stmt("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(updatedAt, id);
}

// Set a session's title and bump updated_at. Returns true if the row was
// updated, false if no such session or the DB is unavailable.
export function setTitle(id, title, updatedAt) {
  if (!dbReady || !id) return false;
  const result = db
    .prepare("UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?")
    .run(title || "New chat", updatedAt, id);
  return result.changes > 0;
}

// Append a message with the next per-session seq. Returns { seq, id } — the
// per-session sequence and the row id (the resource library keeps the row id
// as a soft message reference) — or null when the DB is unavailable.
export function appendMessage(sessionId, role, content, createdAt, blocksJson) {
  if (!dbReady) return null;
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM chat_messages WHERE session_id = ?")
    .get(sessionId);
  const seq = (row?.max_seq ?? 0) + 1;
  const info = stmt(
    `INSERT INTO chat_messages (session_id, role, content, seq, created_at, blocks)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sessionId, role, content, seq, createdAt, blocksJson ?? null);
  return { seq, id: Number(info.lastInsertRowid) };
}

// List session rows, most-recently-updated first. Scope (add-session-ownership):
//   undefined          — no scoping (auth-off: the deployment is one user)
//   { owner: email }   — only that user's rows (NULL-owner rows excluded:
//                        under auth-on they are admin-visible only)
//   { includeAll: true } — every row (admin group / ops console)
export function listChatSessions(scope) {
  if (!dbReady) return [];
  const base = `SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt, s.path, s.agent_preset AS agentPreset, s.workspace, s.owner,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS messageCount
       FROM chat_sessions s`;
  if (scope?.owner && !scope.includeAll) {
    return db.prepare(`${base} WHERE s.owner = ? ORDER BY s.updated_at DESC`).all(scope.owner);
  }
  return db.prepare(`${base} ORDER BY s.updated_at DESC`).all();
}

export function getSessionPath(id) {
  if (!dbReady) return null;
  return stmt("SELECT path FROM chat_sessions WHERE id = ?").get(id)?.path ?? null;
}

export function sessionExists(id) {
  if (!dbReady) return false;
  return !!stmt("SELECT 1 FROM chat_sessions WHERE id = ?").get(id);
}

// Delete a session row (cascades to chat_messages via FK). Returns true if a row
// was removed, false if no such session or the DB is unavailable.
export function deleteSession(id) {
  if (!dbReady || !id) return false;
  const result = stmt("DELETE FROM chat_sessions WHERE id = ?").run(id);
  return result.changes > 0;
}

export function getSessionMeta(id) {
  if (!dbReady) return null;
  return db
    .prepare(
      "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, path, agent_preset AS agentPreset, workspace, owner FROM chat_sessions WHERE id = ?"
    )
    .get(id);
}

export function getChatMessages(sessionId) {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT role, content, blocks FROM chat_messages WHERE session_id = ? ORDER BY seq ASC"
    )
    .all(sessionId)
    .map((row) => ({
      role: row.role,
      content: row.content,
      // Block structure (nullable JSON; absent on pre-migration rows).
      ...(row.blocks ? { blocks: JSON.parse(row.blocks) } : {}),
    }));
}

export function countChatSessions() {
  if (!dbReady) return 0;
  return stmt("SELECT COUNT(*) AS n FROM chat_sessions").get()?.n ?? 0;
}

// ── Documents ────────────────────────────────────────────────────────────────

export function upsertDocument(doc) {
  // doc: { id, name, type, status, added_at, error?, source_text? }
  if (!dbReady) return;
  stmt(
    `INSERT INTO documents (id, name, type, status, added_at, error, source_text)
     VALUES (@id, @name, @type, @status, @added_at, @error, @source_text)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       type = excluded.type,
       status = excluded.status,
       error = excluded.error,
       source_text = COALESCE(excluded.source_text, documents.source_text)`
  ).run({
    id: doc.id,
    name: doc.name,
    type: doc.type,
    status: doc.status,
    added_at: doc.added_at,
    error: doc.error ?? null,
    source_text: doc.source_text ?? null,
  });
}

export function updateDocumentStatus(id, status, error = null) {
  if (!dbReady) return;
  stmt("UPDATE documents SET status = ?, error = ? WHERE id = ?").run(
    status,
    error,
    id
  );
}

export function setDocumentSource(id, sourceText) {
  if (!dbReady) return;
  stmt("UPDATE documents SET source_text = ? WHERE id = ?").run(sourceText, id);
}

export function listDocuments() {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT id, name, type, status, added_at AS addedAt, error FROM documents"
    )
    .all();
}

export function getDocument(id) {
  if (!dbReady) return null;
  return stmt("SELECT * FROM documents WHERE id = ?").get(id);
}

// Prefix-only fetch for @doc: prompt expansion: the caller slices to a fixed
// character budget anyway, so selecting substr(source_text, 1, n) at the SQL
// layer avoids dragging a potentially multi-megabyte column into memory (and
// blocking the event loop) for every attachment reference.
export function getDocumentPrefix(id, chars) {
  if (!dbReady) return null;
  return stmt("SELECT substr(source_text, 1, ?) AS source_text FROM documents WHERE id = ?")
    .get(chars, id)?.source_text ?? null;
}

export function documentExists(id) {
  if (!dbReady) return false;
  return !!stmt("SELECT 1 FROM documents WHERE id = ?").get(id);
}

export function deleteDocument(id) {
  if (!dbReady) return;
  // FTS chunks carry no FK cascade (virtual table) — purge explicitly, then
  // the row delete cascades doc_index + collection memberships.
  deleteDocumentChunks(id);
  stmt("DELETE FROM documents WHERE id = ?").run(id);
}

// Light select for retrieval: queryCollection only reads id/name (the tree
// text comes from getDocIndex). Loading every ready document's source_text
// here dragged megabytes through memory per query for nothing.
export function listReadyDocuments() {
  if (!dbReady) return [];
  return stmt("SELECT id, name, type FROM documents WHERE status = 'ready'").all();
}

export function countDocuments() {
  if (!dbReady) return 0;
  return stmt("SELECT COUNT(*) AS n FROM documents").get()?.n ?? 0;
}

// Light card for chat-side @doc: expansion: metadata plus a bounded summary
// prefix — never loads the full source_text column (which can be megabytes).
export function getDocumentCard(id) {
  if (!dbReady) return null;
  return (
    db
      .prepare(
        `SELECT id, name, type, status, substr(source_text, 1, 220) AS summary
         FROM documents WHERE id = ?`
      )
      .get(id) || null
  );
}

// ── Library search chunks (FTS5) ─────────────────────────────────────────────

// Replace a document's chunks wholesale: delete + insert in one transaction,
// so a reader never sees a half-written chunk set. `name` is denormalized onto
// each row so search results carry the document name without a join.
export function replaceDocumentChunks(docId, name, chunks) {
  if (!dbReady) return;
  const run = db.transaction(() => {
    db.prepare("DELETE FROM document_chunks WHERE doc_id = ?").run(docId);
    const ins = db.prepare(
      "INSERT INTO document_chunks (text, doc_id, name, loc) VALUES (?, ?, ?, ?)"
    );
    for (const c of chunks) ins.run(c.text, docId, name, c.loc);
  });
  run();
}

export function deleteDocumentChunks(docId) {
  if (!dbReady) return;
  stmt("DELETE FROM document_chunks WHERE doc_id = ?").run(docId);
}

export function hasDocumentChunks(docId) {
  if (!dbReady) return false;
  return !!stmt("SELECT 1 FROM document_chunks WHERE doc_id = ? LIMIT 1").get(docId);
}

// Ids of ready docs that have source text but no chunks yet — the backfill
// source. Ids only: the backfill loads each doc separately so no read cursor
// is open while it writes (better-sqlite3 iterators hold the connection busy).
export function listDocIdsWithoutChunks() {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT id FROM documents
       WHERE status = 'ready' AND source_text IS NOT NULL AND source_text != ''
         AND NOT EXISTS (SELECT 1 FROM document_chunks WHERE doc_id = documents.id)`
    )
    .all()
    .map((r) => r.id);
}

// FTS5-ranked chunk search, scoped to ready documents. `matchExpr` is a
// pre-built MATCH expression (caller quotes terms). Filters: a collection id
// (membership subselect) and/or a document id. Emits loc for follow-up reads.
export function searchDocumentChunks(matchExpr, { collectionId, docId, limit = 10 } = {}) {
  if (!dbReady) return [];
  const conds = [];
  const params = [matchExpr];
  if (collectionId) {
    conds.push(
      "c.doc_id IN (SELECT document_id FROM collection_documents WHERE collection_id = ?)"
    );
    params.push(collectionId);
  }
  if (docId) {
    conds.push("c.doc_id = ?");
    params.push(docId);
  }
  params.push(Math.max(1, Math.min(20, limit)));
  const extra = conds.length ? ` AND ${conds.join(" AND ")}` : "";
  // Unaliased FTS references: this SQLite build resolves auxiliary functions
  // (snippet/bm25) and the MATCH qualifier by table NAME only, not by alias.
  return db
    .prepare(
      `SELECT document_chunks.doc_id, document_chunks.name, document_chunks.loc,
              snippet(document_chunks, 0, '«', '»', '…', 16) AS snippet,
              bm25(document_chunks) AS rank
       FROM document_chunks JOIN documents d ON d.id = document_chunks.doc_id
       WHERE document_chunks MATCH ? AND d.status = 'ready'${extra}
       ORDER BY rank
       LIMIT ?`
    )
    .all(...params);
}

// LIKE-based fallback scan over chunks, for scripts (CJK etc.) the unicode61
// tokenizer cannot MATCH. Unranked — row order is chunk insertion order.
export function likeDocumentChunks(likeExpr, { collectionId, docId, limit = 10 } = {}) {
  if (!dbReady) return [];
  const conds = ["c.text LIKE ? ESCAPE '\\'", "d.status = 'ready'"];
  const params = [likeExpr];
  if (collectionId) {
    conds.push(
      "c.doc_id IN (SELECT document_id FROM collection_documents WHERE collection_id = ?)"
    );
    params.push(collectionId);
  }
  if (docId) {
    conds.push("c.doc_id = ?");
    params.push(docId);
  }
  params.push(Math.max(1, Math.min(20, limit)));
  return db
    .prepare(
      `SELECT c.doc_id, c.name, c.loc, substr(c.text, 1, 200) AS snippet
       FROM document_chunks c JOIN documents d ON d.id = c.doc_id
       WHERE ${conds.join(" AND ")}
       LIMIT ?`
    )
    .all(...params);
}

// One page of a document's source text, sliced SQL-side so a page read never
// loads the full column. Offsets are SQLite character positions (1-based
// substr); the total lets callers size follow-up pages.
export function getDocumentPage(id, offset, len) {
  if (!dbReady) return null;
  return (
    db
      .prepare(
        `SELECT name, status, length(source_text) AS total,
                substr(source_text, ?, ?) AS text
         FROM documents WHERE id = ?`
      )
      .get(offset + 1, len, id) || null
  );
}

// ── Document index (PageIndex tree, JSON) ────────────────────────────────────

export function setDocIndex(docId, indexData) {
  if (!dbReady) return;
  stmt(
    `INSERT INTO doc_index (doc_id, index_data, index_version, updated_at)
     VALUES (@doc_id, @index_data, @index_version, @updated_at)
     ON CONFLICT(doc_id) DO UPDATE SET
       index_data = excluded.index_data,
       index_version = excluded.index_version,
       updated_at = excluded.updated_at`
  ).run({
    doc_id: docId,
    index_data: JSON.stringify(indexData),
    index_version: INDEX_VERSION,
    updated_at: nowIso(),
  });
}

export function getDocIndex(docId) {
  if (!dbReady) return null;
  const row = stmt("SELECT index_data, index_version FROM doc_index WHERE doc_id = ?").get(docId);
  if (!row) return null;
  try {
    // index_data is the JSON-serialized PageIndexResult ({ docName, structure }).
    // Spread it so callers get .structure (the TreeNode[]) directly.
    const parsed = JSON.parse(row.index_data);
    return { ...parsed, indexVersion: row.index_version };
  } catch {
    return null;
  }
}

// ── Collections ───────────────────────────────────────────────────────────────
//
// Named groups of documents. `collection_documents` is the join table; both
// foreign keys ON DELETE CASCADE, so deleting a document removes its memberships
// and deleting a collection removes its memberships (but never the documents).

export function createCollection({ id, name, description, created_at }) {
  if (!dbReady) return;
  stmt(
    `INSERT INTO collections (id, name, description, created_at)
     VALUES (@id, @name, @description, @created_at)`
  ).run({ id, name, description, created_at });
}

export function getCollection(id) {
  if (!dbReady) return null;
  return (
    db
      .prepare(
        `SELECT c.id, c.name, c.description, c.created_at AS createdAt,
                (SELECT COUNT(*) FROM collection_documents cd WHERE cd.collection_id = c.id) AS documentCount
         FROM collections c WHERE c.id = ?`
      )
      .get(id) || null
  );
}

export function listCollections() {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT c.id, c.name, c.description, c.created_at AS createdAt,
              (SELECT COUNT(*) FROM collection_documents cd WHERE cd.collection_id = c.id) AS documentCount
       FROM collections c ORDER BY c.created_at DESC`
    )
    .all();
}

export function renameCollection(id, { name, description }) {
  if (!dbReady) return;
  stmt(
    `UPDATE collections SET name = @name, description = @description WHERE id = @id`
  ).run({ id, name, description });
}

export function deleteCollection(id) {
  if (!dbReady) return;
  // ON DELETE CASCADE removes the membership rows.
  stmt("DELETE FROM collections WHERE id = ?").run(id);
}

// Idempotent: adding an existing membership is a no-op (INSERT OR IGNORE).
export function addDocumentToCollection(collectionId, documentId) {
  if (!dbReady) return;
  stmt(
    `INSERT OR IGNORE INTO collection_documents (collection_id, document_id, added_at)
     VALUES (?, ?, ?)`
  ).run(collectionId, documentId, nowIso());
}

// Idempotent: removing a non-member is a no-op.
export function removeDocumentFromCollection(collectionId, documentId) {
  if (!dbReady) return;
  stmt(
    "DELETE FROM collection_documents WHERE collection_id = ? AND document_id = ?"
  ).run(collectionId, documentId);
}

export function listCollectionDocuments(collectionId) {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT d.id, d.name, d.type, d.status, d.added_at AS addedAt,
              cd.added_at AS addedToCollectionAt
       FROM collection_documents cd
       JOIN documents d ON d.id = cd.document_id
       WHERE cd.collection_id = ?
       ORDER BY cd.added_at ASC`
    )
    .all(collectionId);
}

// Ready member documents of a collection with source_text, for scoped retrieval.
export function listReadyDocumentsInCollection(collectionId) {
  if (!dbReady) return [];
  return stmt(
    `SELECT d.id, d.name, d.type
     FROM collection_documents cd
     JOIN documents d ON d.id = cd.document_id
     WHERE cd.collection_id = ? AND d.status = 'ready'`
  ).all(collectionId);
}

// ── User preferences (single-user, key/value) ────────────────────────────────

export function setPreference(key, value) {
  if (!dbReady) return;
  stmt(
    `INSERT INTO user_preferences (key, value, updated_at)
     VALUES (@key, @value, @updated_at)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run({ key, value: String(value), updated_at: nowIso() });
}

export function getPreference(key) {
  if (!dbReady) return null;
  return stmt("SELECT value FROM user_preferences WHERE key = ?").get(key)?.value ?? null;
}

export function getAllPreferences() {
  if (!dbReady) return {};
  const rows = stmt("SELECT key, value FROM user_preferences").all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ── Focus overlay preferences (add-focus-overlay, design D1) ─────────────────
// A focused role's subscriber adjustments are ONE preference key per preset —
// `focus.overlay.<presetId>` — holding a preference diff (add/remove name
// lists per dimension), never a materialized set. Every composition point
// re-reads the diff and recomposes over the derivation, so nothing can drift;
// an all-empty diff deletes the key, and a corrupt row reads as absent
// (inert, self-healing — no error state to repair).

const OVERLAY_DIMENSIONS = ["addMcp", "removeMcp", "addSkills", "removeSkills"];

export function focusOverlayKey(presetId) {
  return `focus.overlay.${presetId}`;
}

// Read the stored diff (null when absent, empty, or corrupt). Dimension order
// is normalized so callers and tests can compare shapes structurally.
export function getFocusOverlay(presetId) {
  if (!dbReady || !presetId) return null;
  const raw = getPreference(focusOverlayKey(presetId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const out = {};
    for (const dim of OVERLAY_DIMENSIONS) {
      if (!Array.isArray(parsed[dim])) return null;
      out[dim] = parsed[dim].filter((n) => typeof n === "string" && n);
    }
    // An all-empty stored diff is equivalent to no overlay at all.
    return OVERLAY_DIMENSIONS.every((d) => out[d].length === 0) ? null : out;
  } catch {
    return null;
  }
}

// Validate + normalize a client-submitted diff. Dedupes while preserving
// order, and rejects a name present in both add and remove for the same
// dimension (the client resolves the ambiguity, not the composer). Returns
// { ok: true, overlay } or { ok: false, error } naming the offending field.
export function parseFocusOverlay(input) {
  if (input === null || input === undefined) {
    return { ok: true, overlay: Object.fromEntries(OVERLAY_DIMENSIONS.map((d) => [d, []])) };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "overlay must be an object with addMcp/removeMcp/addSkills/removeSkills arrays" };
  }
  const out = {};
  for (const dim of OVERLAY_DIMENSIONS) {
    const list = input[dim] ?? [];
    if (!Array.isArray(list)) {
      return { ok: false, error: `overlay.${dim} must be an array of strings` };
    }
    for (const n of list) {
      if (typeof n !== "string" || !n.trim()) {
        return { ok: false, error: `overlay.${dim} must contain non-empty strings` };
      }
    }
    out[dim] = [...new Set(list.map((n) => n.trim()))];
  }
  for (const [add, remove, dim] of [
    ["addMcp", "removeMcp", "mcpServers"],
    ["addSkills", "removeSkills", "skills"],
  ]) {
    const clash = out[add].find((n) => out[remove].includes(n));
    if (clash) {
      return { ok: false, error: `"${clash}" appears in both add and remove of overlay ${dim}; resolve the conflict before applying` };
    }
  }
  return { ok: true, overlay: out };
}

// Store a normalized diff; an all-empty diff deletes the key (no ceremony row).
// Dedupes defensively so the stored shape is canonical whatever wrote it.
export function setFocusOverlay(presetId, overlay) {
  if (!dbReady || !presetId) return;
  const key = focusOverlayKey(presetId);
  const norm = Object.fromEntries(
    OVERLAY_DIMENSIONS.map((d) => [d, [...new Set(overlay?.[d] ?? [])]]),
  );
  const isEmpty = OVERLAY_DIMENSIONS.every((d) => norm[d].length === 0);
  if (isEmpty) {
    stmt("DELETE FROM user_preferences WHERE key = ?").run(key);
    return;
  }
  setPreference(key, JSON.stringify(norm));
}

// ── Deployment config (deployment-wide, key/value; branding etc.) ────────────

export function setDeploymentConfig(key, value) {
  if (!dbReady) return;
  stmt(
    `INSERT INTO deployment_config (key, value, updated_at)
     VALUES (@key, @value, @updatedAt)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run({ key, value: String(value), updatedAt: nowIso() });
}

export function clearDeploymentConfig(key) {
  if (!dbReady) return;
  stmt("DELETE FROM deployment_config WHERE key = ?").run(key);
}

export function getDeploymentConfig(key) {
  if (!dbReady) return null;
  return stmt("SELECT value FROM deployment_config WHERE key = ?").get(key)?.value ?? null;
}

export function normalizeIdentityEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

export function getUserModelBinding(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  // Aliased to the {id, provider} shape the runtime uses for a model everywhere
  // else (ctx.defaultModel, ctx.dshModels), so callers compare like with like.
  const row = stmt("SELECT model_id AS id, provider_id AS provider, updated_at AS updatedAt FROM user_model_bindings WHERE email = ?").get(key);
  return row || null;
}

export function setUserModelBinding(email, providerId, modelId) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key || !providerId || !modelId) return null;
  stmt(
    `INSERT INTO user_model_bindings (email, provider_id, model_id, updated_at)
     VALUES (@email, @providerId, @modelId, @updatedAt)
     ON CONFLICT(email) DO UPDATE SET
       provider_id = excluded.provider_id,
       model_id = excluded.model_id,
       updated_at = excluded.updated_at`
  ).run({ email: key, providerId, modelId, updatedAt: nowIso() });
  return getUserModelBinding(key);
}

export function clearUserModelBinding(email) {
  if (!dbReady) return false;
  return stmt("DELETE FROM user_model_bindings WHERE email = ?").run(normalizeIdentityEmail(email)).changes > 0;
}

export function getUserMcpBindings(email) {
  if (!dbReady) return {};
  const key = normalizeIdentityEmail(email);
  if (!key) return {};
  return Object.fromEntries(
    stmt("SELECT name, enabled FROM user_mcp_bindings WHERE email = ?")
      .all(key)
      .map((row) => [row.name, !!row.enabled])
  );
}

export function setUserMcpBinding(email, name, enabled) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key || !name || typeof enabled !== "boolean") return null;
  stmt(
    `INSERT INTO user_mcp_bindings (email, name, enabled, updated_at)
     VALUES (@email, @name, @enabled, @updatedAt)
     ON CONFLICT(email, name) DO UPDATE SET
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`
  ).run({ email: key, name, enabled: enabled ? 1 : 0, updatedAt: nowIso() });
  return { name, enabled };
}

export function deleteUserMcpBinding(email, name) {
  if (!dbReady) return false;
  return stmt("DELETE FROM user_mcp_bindings WHERE email = ? AND name = ?")
    .run(normalizeIdentityEmail(email), name).changes > 0;
}

// ── Registry credentials (market proxy token, one row per user) ──────────────
//
// The raw token is returned by getRegistryCredential for the overlay writer
// only. Route handlers must go through registry-credentials.js, whose status
// projection is token-free by construction.

export function getRegistryCredential(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  const row = stmt(
    "SELECT token, expires_at AS expiresAt, stale, source, updated_at AS updatedAt FROM user_registry_credentials WHERE email = ?"
  ).get(key);
  return row ? { ...row, stale: !!row.stale } : null;
}

export function setRegistryCredential({ email, token, expiresAt = null, source = "sso" }) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key || !token) return null;
  // A fresh token clears the stale flag: the user just proved the credential
  // works (or replaced it), so the next overlay write may use it again.
  stmt(
    `INSERT INTO user_registry_credentials (email, token, expires_at, stale, source, updated_at)
     VALUES (@email, @token, @expiresAt, 0, @source, @updatedAt)
     ON CONFLICT(email) DO UPDATE SET
       token = excluded.token,
       expires_at = excluded.expires_at,
       stale = 0,
       source = excluded.source,
       updated_at = excluded.updated_at`
  ).run({ email: key, token, expiresAt, source, updatedAt: nowIso() });
  return getRegistryCredential(key);
}

export function deleteRegistryCredential(email) {
  if (!dbReady) return false;
  return stmt("DELETE FROM user_registry_credentials WHERE email = ?")
    .run(normalizeIdentityEmail(email)).changes > 0;
}

// 401 from a registry-origin MCP server: keep the row (so the UI can tell
// "expired" apart from "never connected") but stop injecting it until the user
// reconnects. `AND stale = 0` makes the return value "the state actually
// changed", which is what the caller uses to re-apply the profile exactly once
// per expiry instead of on every failing call.
export function markRegistryCredentialStale(email) {
  if (!dbReady) return false;
  return stmt("UPDATE user_registry_credentials SET stale = 1, updated_at = ? WHERE email = ? AND stale = 0")
    .run(nowIso(), normalizeIdentityEmail(email)).changes > 0;
}

// ── Connector credentials (萬星 connector PAT, one row per user) ─────────────
//
// Same contract as the registry accessors above; the PAT is opaque (no expiry
// column) and 401-driven staleness is the only "not live" state besides absence.

export function getConnectorCredential(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  const row = stmt(
    "SELECT token, stale, updated_at AS updatedAt FROM user_connector_credentials WHERE email = ?"
  ).get(key);
  return row ? { ...row, stale: !!row.stale } : null;
}

export function setConnectorCredential({ email, token }) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key || !token) return null;
  // A fresh paste clears the stale flag, exactly like the registry row: the
  // user just replaced the credential, so the next profile write may use it.
  stmt(
    `INSERT INTO user_connector_credentials (email, token, stale, updated_at)
     VALUES (@email, @token, 0, @updatedAt)
     ON CONFLICT(email) DO UPDATE SET
       token = excluded.token,
       stale = 0,
       updated_at = excluded.updated_at`
  ).run({ email: key, token, updatedAt: nowIso() });
  return getConnectorCredential(key);
}

export function deleteConnectorCredential(email) {
  if (!dbReady) return false;
  return stmt("DELETE FROM user_connector_credentials WHERE email = ?")
    .run(normalizeIdentityEmail(email)).changes > 0;
}

export function markConnectorCredentialStale(email) {
  if (!dbReady) return false;
  return stmt("UPDATE user_connector_credentials SET stale = 1, updated_at = ? WHERE email = ? AND stale = 0")
    .run(nowIso(), normalizeIdentityEmail(email)).changes > 0;
}

// ── Extension configs (MCP servers) ──────────────────────────────────────────

function parsePermissions(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function serializeExtensionConfig(row) {
  if (!row) return null;
  return {
    ...row,
    config: JSON.parse(row.configJson),
    enabled: !!row.enabled,
    locked: !!row.locked,
    permissions: parsePermissions(row.permissions),
    requiredGroups: parsePermissions(row.requiredGroups),
  };
}

export function listExtensionConfigs() {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT id, name, type, config_json AS configJson, enabled, source, origin, locked, permissions, required_groups AS requiredGroups, created_at AS createdAt, updated_at AS updatedAt FROM extension_configs ORDER BY name"
    )
    .all()
    .map(serializeExtensionConfig);
}

export function getExtensionConfig(name) {
  if (!dbReady) return null;
  const row = db
    .prepare(
      "SELECT id, name, type, config_json AS configJson, enabled, source, origin, locked, permissions, required_groups AS requiredGroups, created_at AS createdAt, updated_at AS updatedAt FROM extension_configs WHERE name = ?"
    )
    .get(name);
  return serializeExtensionConfig(row);
}

// INSERT OR IGNORE so startup seeding doesn't overwrite user edits.
// Returns the existing row if it was already present, or the newly inserted row.
export function seedExtensionConfig({ name, type, config, enabled = true, source = "startup", origin = "user", locked = false, permissions = null, requiredGroups = null }) {
  if (!dbReady) return null;
  const existing = getExtensionConfig(name);
  if (existing) return existing;
  return addExtensionConfig({ name, type, config, enabled, source, origin, locked, permissions, requiredGroups });
}

export function addExtensionConfig({ name, type, config, enabled = true, source = "user", origin = "user", locked = false, permissions = null, requiredGroups = null }) {
  if (!dbReady) return null;
  const id = crypto.randomUUID();
  const now = nowIso();
  stmt(
    `INSERT INTO extension_configs (id, name, type, config_json, enabled, source, origin, locked, permissions, required_groups, created_at, updated_at)
     VALUES (@id, @name, @type, @config_json, @enabled, @source, @origin, @locked, @permissions, @required_groups, @created_at, @updated_at)`
  ).run({
    id,
    name,
    type,
    config_json: JSON.stringify(config),
    enabled: enabled ? 1 : 0,
    source,
    origin,
    locked: locked ? 1 : 0,
    permissions: permissions ? JSON.stringify(permissions) : null,
    required_groups: requiredGroups ? JSON.stringify(requiredGroups) : null,
    created_at: now,
    updated_at: now,
  });
  return getExtensionConfig(name);
}

export function updateExtensionConfig(name, { type, config, enabled }) {
  if (!dbReady) return null;
  const updates = [];
  const params = { name, updated_at: nowIso() };
  if (type !== undefined) {
    updates.push("type = @type");
    params.type = type;
  }
  if (config !== undefined) {
    updates.push("config_json = @config_json");
    params.config_json = JSON.stringify(config);
  }
  if (enabled !== undefined) {
    updates.push("enabled = @enabled");
    params.enabled = enabled ? 1 : 0;
  }
  if (updates.length === 0) return getExtensionConfig(name);
  updates.push("updated_at = @updated_at");
  stmt(`UPDATE extension_configs SET ${updates.join(", ")} WHERE name = @name`).run(params);
  return getExtensionConfig(name);
}

export function deleteExtensionConfig(name) {
  if (!dbReady) return false;
  const result = stmt("DELETE FROM extension_configs WHERE name = ?").run(name);
  return result.changes > 0;
}

export function setExtensionEnabled(name, enabled) {
  if (!dbReady) return null;
  stmt("UPDATE extension_configs SET enabled = ?, updated_at = ? WHERE name = ?").run(
    enabled ? 1 : 0,
    nowIso(),
    name
  );
  return getExtensionConfig(name);
}

// ── Custom skills ────────────────────────────────────────────────────────────

const CUSTOM_SKILL_COLS =
  "id, name, description, content, enabled, origin_pack_id AS originPackId, origin_pack_version AS originPackVersion, created_at AS createdAt, updated_at AS updatedAt";

export function listCustomSkills() {
  if (!dbReady) return [];
  return db
    .prepare(`SELECT ${CUSTOM_SKILL_COLS} FROM custom_skills ORDER BY name`)
    .all()
    .map((r) => ({ ...r, enabled: !!r.enabled }));
}

export function getCustomSkill(name) {
  if (!dbReady) return null;
  const row = db
    .prepare(`SELECT ${CUSTOM_SKILL_COLS} FROM custom_skills WHERE name = ?`)
    .get(name);
  if (!row) return null;
  return { ...row, enabled: !!row.enabled };
}

export function addCustomSkill({ name, description, content, enabled = true, originPackId = null, originPackVersion = null }) {
  if (!dbReady) return null;
  const id = crypto.randomUUID();
  const now = nowIso();
  stmt(
    `INSERT INTO custom_skills (id, name, description, content, enabled, origin_pack_id, origin_pack_version, created_at, updated_at)
     VALUES (@id, @name, @description, @content, @enabled, @originPackId, @originPackVersion, @created_at, @updated_at)`
  ).run({
    id,
    name,
    description: description || null,
    content,
    enabled: enabled ? 1 : 0,
    originPackId,
    originPackVersion,
    created_at: now,
    updated_at: now,
  });
  return getCustomSkill(name);
}

export function updateCustomSkill(name, { description, content, enabled }) {
  if (!dbReady) return null;
  const updates = [];
  const params = { name, updated_at: nowIso() };
  if (description !== undefined) {
    updates.push("description = @description");
    params.description = description;
  }
  if (content !== undefined) {
    updates.push("content = @content");
    params.content = content;
  }
  if (enabled !== undefined) {
    updates.push("enabled = @enabled");
    params.enabled = enabled ? 1 : 0;
  }
  if (updates.length === 0) return getCustomSkill(name);
  updates.push("updated_at = @updated_at");
  stmt(`UPDATE custom_skills SET ${updates.join(", ")} WHERE name = @name`).run(params);
  return getCustomSkill(name);
}

// Pack-internal: stamp the installed version onto rows a pack owns. Never
// exposed through the user-edit path — updateCustomSkill deliberately cannot
// touch ownership columns.
export function stampSkillPackVersion(name, originPackVersion) {
  if (!dbReady) return null;
  stmt("UPDATE custom_skills SET origin_pack_version = ?, updated_at = ? WHERE name = ?").run(
    originPackVersion,
    nowIso(),
    name,
  );
  return getCustomSkill(name);
}

export function deleteCustomSkill(name) {
  if (!dbReady) return false;
  const result = stmt("DELETE FROM custom_skills WHERE name = ?").run(name);
  return result.changes > 0;
}

export function setCustomSkillEnabled(name, enabled) {
  if (!dbReady) return null;
  stmt("UPDATE custom_skills SET enabled = ?, updated_at = ? WHERE name = ?").run(
    enabled ? 1 : 0,
    nowIso(),
    name
  );
  return getCustomSkill(name);
}

// ── Pack drafts (add-pack-marketplace) ───────────────────────────────────────
//
// Creator-side authoring state: a draft carries the pack's display fields plus
// its entries (skills bodies, MCP references, agent personas) as JSON, and —
// after a first publish — the pack id it published to, so later publishes of
// the same draft append versions to that pack. Private to the author's cell.

const DRAFT_COLS =
  "id, name, description, tags, entries, published_pack_id AS publishedPackId, created_at AS createdAt, updated_at AS updatedAt";

function hydrateDraft(row) {
  if (!row) return null;
  return {
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    entries: JSON.parse(row.entries || "{}"),
  };
}

export function listPackDrafts() {
  if (!dbReady) return [];
  return db.prepare(`SELECT ${DRAFT_COLS} FROM pack_drafts ORDER BY updated_at DESC`).all().map(hydrateDraft);
}

export function getPackDraft(id) {
  if (!dbReady) return null;
  return hydrateDraft(db.prepare(`SELECT ${DRAFT_COLS} FROM pack_drafts WHERE id = ?`).get(id));
}

export function createPackDraft({ name, description = "", tags = [], entries = {} }) {
  if (!dbReady) return null;
  const id = crypto.randomUUID();
  const now = nowIso();
  stmt(
    `INSERT INTO pack_drafts (id, name, description, tags, entries, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, name, description || "", JSON.stringify(tags ?? []), JSON.stringify(entries ?? {}), now, now);
  return getPackDraft(id);
}

export function updatePackDraft(id, { name, description, tags, entries }) {
  if (!dbReady) return null;
  const updates = [];
  const params = { id, updated_at: nowIso() };
  if (name !== undefined) {
    updates.push("name = @name");
    params.name = name;
  }
  if (description !== undefined) {
    updates.push("description = @description");
    params.description = description;
  }
  if (tags !== undefined) {
    updates.push("tags = @tags");
    params.tags = JSON.stringify(tags ?? []);
  }
  if (entries !== undefined) {
    updates.push("entries = @entries");
    params.entries = JSON.stringify(entries ?? {});
  }
  if (updates.length === 0) return getPackDraft(id);
  updates.push("updated_at = @updated_at");
  stmt(`UPDATE pack_drafts SET ${updates.join(", ")} WHERE id = @id`).run(params);
  return getPackDraft(id);
}

export function setDraftPublishedPack(id, packId) {
  if (!dbReady) return null;
  stmt("UPDATE pack_drafts SET published_pack_id = ?, updated_at = ? WHERE id = ?").run(packId, nowIso(), id);
  return getPackDraft(id);
}

export function deletePackDraft(id) {
  if (!dbReady) return false;
  return stmt("DELETE FROM pack_drafts WHERE id = ?").run(id).changes > 0;
}

// ── Installed packs (add-pack-marketplace) ───────────────────────────────────
//
// The cell's operational truth for subscriptions: which packs are installed,
// at which version, with the manifest snapshot that uninstall diffs against
// and the last per-part report. Gateway subscription records are advisory —
// this table is what materialization, updates, and uninstall act on.

function hydrateInstalled(row) {
  if (!row) return null;
  return {
    ...row,
    manifest: JSON.parse(row.manifest || "{}"),
    report: JSON.parse(row.report || "{}"),
  };
}

export function listInstalledPacks() {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT pack_id AS packId, name, version, manifest, report, installed_at AS installedAt, updated_at FROM installed_packs ORDER BY installed_at DESC"
    )
    .all()
    .map(hydrateInstalled);
}

export function getInstalledPack(packId) {
  if (!dbReady) return null;
  return hydrateInstalled(
    db
      .prepare(
        "SELECT pack_id AS packId, name, version, manifest, report, installed_at AS installedAt, updated_at FROM installed_packs WHERE pack_id = ?"
      )
      .get(packId),
  );
}

export function upsertInstalledPack({ packId, name, version, manifest, report }) {
  if (!dbReady) return null;
  const existing = getInstalledPack(packId);
  const now = nowIso();
  stmt(
    `INSERT INTO installed_packs (pack_id, name, version, manifest, report, installed_at, updated_at)
     VALUES (@packId, @name, @version, @manifest, @report, @now, @now)
     ON CONFLICT (pack_id) DO UPDATE SET
       name = @name, version = @version, manifest = @manifest, report = @report, updated_at = @now`
  ).run({
    packId,
    name,
    version,
    manifest: JSON.stringify(manifest ?? {}),
    report: JSON.stringify(report ?? {}),
    now,
  });
  return { ...existing, packId, name, version, manifest, report, updatedAt: now };
}

export function deleteInstalledPack(packId) {
  if (!dbReady) return false;
  return stmt("DELETE FROM installed_packs WHERE pack_id = ?").run(packId).changes > 0;
}

// Skills owned by a pack (pack install/uninstall bookkeeping).
export function listCustomSkillsByPack(packId) {
  if (!dbReady) return [];
  return db
    .prepare(`SELECT ${CUSTOM_SKILL_COLS} FROM custom_skills WHERE origin_pack_id = ? ORDER BY name`)
    .all(packId)
    .map((r) => ({ ...r, enabled: !!r.enabled }));
}

export function deleteCustomSkillsByPack(packId) {
  if (!dbReady) return 0;
  return stmt("DELETE FROM custom_skills WHERE origin_pack_id = ?").run(packId).changes;
}

// ── Custom presets (add-custom-presets, design D1) ───────────────────────────
//
// The cell's user-composed persona presets: display name, persona text, and
// resource REFERENCES (skill names + MCP server names) resolved against the
// locally-available universe at composition time. Deployment-global roster
// state — every client sees the same rows. Ids are SERVER-ASSIGNED under the
// reserved `user.` prefix (authors choose names, never ids); a slug collision
// appends a numeric suffix. The catalog's user source and the pack backstop
// read these rows; nothing else keys off them.

const USER_PRESET_COLS =
  "id, name, persona, skills, mcp_servers AS mcpServers, tags, icon, created_at AS createdAt, updated_at AS updatedAt";

function hydrateUserPreset(row) {
  if (!row) return null;
  const parseNames = (raw) => {
    try {
      const parsed = JSON.parse(raw || "[]");
      return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "string") : [];
    } catch {
      return []; // corrupt row reads as no references — inert, like overlays
    }
  };
  return {
    ...row,
    skills: parseNames(row.skills),
    mcpServers: parseNames(row.mcpServers),
    tags: parseNames(row.tags),
  };
}

export function listUserPresets() {
  if (!dbReady) return [];
  return db
    .prepare(`SELECT ${USER_PRESET_COLS} FROM user_presets ORDER BY created_at, id`)
    .all()
    .map(hydrateUserPreset);
}

export function getUserPreset(id) {
  if (!dbReady || !id) return null;
  return hydrateUserPreset(db.prepare(`SELECT ${USER_PRESET_COLS} FROM user_presets WHERE id = ?`).get(id));
}

// Slug from a display name: fold non-alphanumerics to dashes (CJK names fold
// to nothing — the fallback slug keeps the id well-formed), capped so the
// `user.` prefix + a collision suffix stays inside the 64-char preset-id bound
// dsh-profile's isSafePresetId enforces.
function userPresetSlug(name) {
  const slug = String(name)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 48);
  return slug || "preset";
}

function assignUserPresetId(name) {
  const base = `user.${userPresetSlug(name)}`;
  let id = base;
  for (let n = 2; getUserPreset(id); n++) id = `${base}-${n}`;
  return id;
}

export function createUserPreset({ name, persona, skills = [], mcpServers = [], tags = [], icon = null }) {
  if (!dbReady) return null;
  const id = assignUserPresetId(name);
  const now = nowIso();
  stmt(
    `INSERT INTO user_presets (id, name, persona, skills, mcp_servers, tags, icon, created_at, updated_at)
     VALUES (@id, @name, @persona, @skills, @mcpServers, @tags, @icon, @now, @now)`
  ).run({
    id,
    name,
    persona,
    skills: JSON.stringify(skills ?? []),
    mcpServers: JSON.stringify(mcpServers ?? []),
    tags: JSON.stringify(tags ?? []),
    icon,
    now,
  });
  return getUserPreset(id);
}

export function updateUserPreset(id, { name, persona, skills, mcpServers, tags, icon }) {
  if (!dbReady) return null;
  const updates = [];
  const params = { id, updated_at: nowIso() };
  if (name !== undefined) { updates.push("name = @name"); params.name = name; }
  if (persona !== undefined) { updates.push("persona = @persona"); params.persona = persona; }
  if (skills !== undefined) { updates.push("skills = @skills"); params.skills = JSON.stringify(skills ?? []); }
  if (mcpServers !== undefined) { updates.push("mcp_servers = @mcpServers"); params.mcpServers = JSON.stringify(mcpServers ?? []); }
  if (tags !== undefined) { updates.push("tags = @tags"); params.tags = JSON.stringify(tags ?? []); }
  if (icon !== undefined) { updates.push("icon = @icon"); params.icon = icon; }
  if (updates.length === 0) return getUserPreset(id);
  updates.push("updated_at = @updated_at");
  stmt(`UPDATE user_presets SET ${updates.join(", ")} WHERE id = @id`).run(params);
  return getUserPreset(id);
}

export function deleteUserPreset(id) {
  if (!dbReady || !id) return false;
  return stmt("DELETE FROM user_presets WHERE id = ?").run(id).changes > 0;
}

// ── Bots (social chat channels) ──────────────────────────────────────────────
//
// Rows carry the raw `credentials` JSON and the webhook `secret`; both are
// server-only. Callers that serve the browser MUST go through the masking in
// server/bots.js — never hand a row straight to res.json().

const BOT_COLS =
  "id, type, name, enabled, secret, credentials, created_at AS createdAt";

function hydrateBot(row) {
  if (!row) return null;
  let credentials = {};
  try { credentials = JSON.parse(row.credentials); } catch { /* corrupt row → no creds */ }
  return { ...row, enabled: !!row.enabled, credentials };
}

export function listBots() {
  if (!dbReady) return [];
  return db.prepare(`SELECT ${BOT_COLS} FROM bots ORDER BY created_at`).all().map(hydrateBot);
}

export function getBot(id) {
  if (!dbReady) return null;
  return hydrateBot(stmt(`SELECT ${BOT_COLS} FROM bots WHERE id = ?`).get(id));
}

export function addBot({ id, type, name, credentials, secret, enabled = true }) {
  if (!dbReady) return null;
  stmt(
    `INSERT INTO bots (id, type, name, enabled, secret, credentials, created_at)
     VALUES (@id, @type, @name, @enabled, @secret, @credentials, @created_at)`
  ).run({
    id,
    type,
    name,
    enabled: enabled ? 1 : 0,
    secret,
    credentials: JSON.stringify(credentials ?? {}),
    created_at: nowIso(),
  });
  return getBot(id);
}

export function updateBot(id, { name, credentials, enabled }) {
  if (!dbReady) return null;
  const updates = [];
  const params = { id };
  if (name !== undefined) { updates.push("name = @name"); params.name = name; }
  if (credentials !== undefined) {
    updates.push("credentials = @credentials");
    params.credentials = JSON.stringify(credentials);
  }
  if (enabled !== undefined) { updates.push("enabled = @enabled"); params.enabled = enabled ? 1 : 0; }
  if (updates.length) stmt(`UPDATE bots SET ${updates.join(", ")} WHERE id = @id`).run(params);
  return getBot(id);
}

export function deleteBot(id) {
  if (!dbReady) return false;
  return stmt("DELETE FROM bots WHERE id = ?").run(id).changes > 0;
}

// ── Bot chats, relay channels, relay audit (add-bot-relay-endpoint) ───────────
//
// The relay's destination list. A channel binding is only creatable from a row
// `upsertBotChat` wrote, so a caller holding the relay token cannot reach a
// chat this deployment has never seen. None of these rows carries message text.

const BOT_CHAT_COLS =
  "bot_id AS botId, chat_key AS chatKey, sender_name AS senderName, " +
  "first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt";

// Record a verified inbound message's chat. `first_seen_at` is written once;
// later messages only advance `last_seen_at`, and a later message without a
// display name keeps the name already known.
export function upsertBotChat(botId, chatKey, senderName) {
  if (!dbReady) return false;
  const now = nowIso();
  stmt(
    `INSERT INTO bot_chats (bot_id, chat_key, sender_name, first_seen_at, last_seen_at)
     VALUES (@bot_id, @chat_key, @sender_name, @now, @now)
     ON CONFLICT(bot_id, chat_key) DO UPDATE SET
       last_seen_at = @now,
       sender_name = COALESCE(excluded.sender_name, bot_chats.sender_name)`
  ).run({
    bot_id: String(botId),
    chat_key: String(chatKey),
    sender_name: String(senderName ?? "").trim() || null,
    now,
  });
  return true;
}

export function listBotChats() {
  if (!dbReady) return [];
  return db.prepare(`SELECT ${BOT_CHAT_COLS} FROM bot_chats ORDER BY last_seen_at DESC`).all();
}

export function getBotChat(botId, chatKey) {
  if (!dbReady) return null;
  return (
    stmt(`SELECT ${BOT_CHAT_COLS} FROM bot_chats WHERE bot_id = ? AND chat_key = ?`).get(
      String(botId),
      String(chatKey),
    ) ?? null
  );
}

const CHANNEL_COLS = "name, bot_id AS botId, chat_key AS chatKey, created_at AS createdAt";

export function listChannels() {
  if (!dbReady) return [];
  return db.prepare(`SELECT ${CHANNEL_COLS} FROM bot_channels ORDER BY name`).all();
}

export function getChannel(name) {
  if (!dbReady) return null;
  return stmt(`SELECT ${CHANNEL_COLS} FROM bot_channels WHERE name = ?`).get(String(name)) ?? null;
}

// Throws on a duplicate name (the primary key is the authority — a check-then-
// insert in the route would race the constraint anyway).
export function createChannel({ name, botId, chatKey }) {
  if (!dbReady) return null;
  stmt(
    `INSERT INTO bot_channels (name, bot_id, chat_key, created_at)
     VALUES (@name, @botId, @chatKey, @createdAt)`
  ).run({ name, botId, chatKey: String(chatKey), createdAt: nowIso() });
  return getChannel(name);
}

export function deleteChannel(name) {
  if (!dbReady) return false;
  return stmt("DELETE FROM bot_channels WHERE name = ?").run(String(name)).changes > 0;
}

// One row per relay attempt that got past authentication. `text_chars` is the
// length, never the text — the log answers "to which channel, and did it land"
// for incident review without becoming a copy of the traffic.
export function insertRelayLog({ channel, botId, textChars, outcome, error }) {
  if (!dbReady) return false;
  stmt(
    `INSERT INTO bot_relay_log (ts, channel, bot_id, text_chars, outcome, error)
     VALUES (@ts, @channel, @bot_id, @text_chars, @outcome, @error)`
  ).run({
    ts: nowIso(),
    channel: channel == null ? null : String(channel),
    bot_id: botId == null ? null : String(botId),
    text_chars: Number.isInteger(textChars) ? textChars : null,
    outcome: String(outcome),
    error: error == null ? null : String(error),
  });
  return true;
}

export function listRelayLog(limit = 50) {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT ts, channel, bot_id AS botId, text_chars AS textChars, outcome, error
       FROM bot_relay_log ORDER BY ts DESC, rowid DESC LIMIT ?`
    )
    .all(Math.max(1, Number(limit) || 50));
}

// ── Resource library ────────────────────────────────────────────────────────
//
// Rows for chat-produced artifacts (openspec: add-resource-library). The
// service module (resources.js) owns capture, byte copying and the store dir;
// these helpers are the storage contract only. `insertResource` folds dedupe
// into the write itself: the UNIQUE content_hash means an identical spec or
// file returns the EXISTING row rather than racing a check-then-insert.

const RESOURCE_COLS = `id, type, title, source, session_id AS sessionId,
  session_title AS sessionTitle, message_id AS messageId, payload,
  file_path AS filePath, file_size AS fileSize, file_mime AS fileMime,
  content_hash AS contentHash, created_at AS createdAt,
  updated_at AS updatedAt, last_seen_at AS lastSeenAt, seeded,
  binding_refs AS bindingRefs`;

// LIKE needs the query's own wildcards neutralized: a search for "50%" must
// not turn into "match everything".
function escapeLike(q) {
  return String(q).replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function getResource(id) {
  if (!dbReady) return null;
  return stmt(`SELECT ${RESOURCE_COLS} FROM resources WHERE id = ?`).get(String(id)) ?? null;
}

export function findResourceByHash(contentHash) {
  if (!dbReady) return null;
  return (
    stmt(`SELECT ${RESOURCE_COLS} FROM resources WHERE content_hash = ?`).get(String(contentHash)) ?? null
  );
}

// Insert, or return the existing row for the same content hash. `inserted`
// distinguishes the two for the caller's message ("saved" vs "already in the
// library") and for the seeding pass's counts.
export function insertResource(fields) {
  if (!dbReady) return { inserted: false, resource: null };
  const info = stmt(
    `INSERT INTO resources (id, type, title, source, session_id, session_title, message_id,
       payload, file_path, file_size, file_mime, content_hash, created_at, updated_at, last_seen_at, seeded)
     VALUES (@id, @type, @title, @source, @session_id, @session_title, @message_id,
       @payload, @file_path, @file_size, @file_mime, @content_hash, @created_at, @updated_at, @last_seen_at, @seeded)
     ON CONFLICT(content_hash) DO NOTHING`
  ).run({
    id: fields.id,
    type: fields.type,
    title: fields.title,
    source: fields.source,
    session_id: fields.sessionId ?? null,
    session_title: fields.sessionTitle ?? null,
    message_id: fields.messageId ?? null,
    payload: fields.payload ?? null,
    file_path: fields.filePath ?? null,
    file_size: fields.fileSize ?? null,
    file_mime: fields.fileMime ?? null,
    content_hash: fields.contentHash,
    created_at: fields.createdAt,
    updated_at: fields.updatedAt,
    last_seen_at: fields.lastSeenAt ?? null,
    seeded: fields.seeded ? 1 : 0,
  });
  if (info.changes > 0) return { inserted: true, resource: getResource(fields.id) };
  return { inserted: false, resource: findResourceByHash(fields.contentHash) };
}

export function touchResourceSeen(id, iso) {
  if (!dbReady) return false;
  return stmt("UPDATE resources SET last_seen_at = ? WHERE id = ?").run(iso, String(id)).changes > 0;
}

// List with the page's filters. `type` and `q` are optional; the count query
// mirrors the filter predicates so pagination metadata always agrees.
export function listResources({ type = null, q = null, limit = 50, offset = 0 } = {}) {
  if (!dbReady) return { items: [], total: 0 };
  const params = {
    type: type || null,
    q: q ? `%${escapeLike(q)}%` : null,
    limit: Math.max(1, Number(limit) || 50),
    offset: Math.max(0, Number(offset) || 0),
  };
  const where = `WHERE (@type IS NULL OR type = @type)
      AND (@q IS NULL OR title LIKE @q ESCAPE '\\')`;
  const items = db
    .prepare(
      `SELECT ${RESOURCE_COLS} FROM resources ${where} ORDER BY created_at DESC, rowid DESC LIMIT @limit OFFSET @offset`
    )
    .all(params);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM resources ${where}`).get(params).n;
  return { items, total, limit: params.limit, offset: params.offset };
}

export function renameResource(id, title, updatedAt) {
  if (!dbReady) return null;
  const ok =
    stmt("UPDATE resources SET title = ?, updated_at = ? WHERE id = ?").run(
      String(title),
      updatedAt,
      String(id)
    ).changes > 0;
  return ok ? getResource(id) : null;
}

// Delete and return the removed row — the caller needs file_path to drop the
// stored bytes. Null when the row did not exist.
export function deleteResource(id) {
  if (!dbReady) return null;
  const row = getResource(id);
  if (!row) return null;
  stmt("DELETE FROM resources WHERE id = ?").run(String(id));
  return row;
}

export function countResources() {
  if (!dbReady) return 0;
  return db.prepare("SELECT COUNT(*) AS n FROM resources").get().n;
}

// Assistant messages that could contain chart fences, with the session title
// for the provenance snapshot — the seeding pass's input. The LIKE prefilter
// keeps a large history from being JSON-scanned message by message.
export function listMessagesWithChartFences() {
  if (!dbReady) return [];
  return db
    .prepare(
      `SELECT m.id AS messageId, m.session_id AS sessionId, m.content AS content, m.created_at AS createdAt, s.title AS sessionTitle
       FROM chat_messages m
       LEFT JOIN chat_sessions s ON s.id = m.session_id
       WHERE m.role = 'assistant' AND m.content LIKE '%\`\`\`echarts%'
       ORDER BY m.id`
    )
    .all();
}

// Wrap a multi-insert pass (the seeding run) in one transaction. better-sqlite3
// transactions nest via savepoints, so calling this from inside another
// transaction is safe.
export function runInTransaction(fn) {
  if (!dbReady) return null;
  return db.transaction(fn)();
}

// ── Chart data bindings (openspec: add-chart-data-binding) ───────────────────
//
// Storage contract only; chart-bindings.js owns identity/priority, chart-
// refresh.js owns the diff and calls `applyChartRefresh` for the write half.
// `binding_candidates` is deliberately NOT part of RESOURCE_COLS: it holds
// capped tool results (up to 200KB each), and list responses must not carry it.

const BINDING_COLS = `id, lineage_key AS lineageKey, server, tool, args, map,
  concept, frequency, unit, refresh_rule AS refreshRule, origin,
  stale, stale_reason AS staleReason, stale_since AS staleSince,
  last_ok_at AS lastOkAt, consecutive_failures AS consecutiveFailures,
  backoff_until AS backoffUntil, gate_fingerprint AS gateFingerprint,
  created_at AS createdAt, updated_at AS updatedAt`;

function serializeBinding(row) {
  if (!row) return null;
  return {
    ...row,
    stale: !!row.stale,
    refreshRule: row.refreshRule ? JSON.parse(row.refreshRule) : null,
    args: safeJson(row.args) ?? row.args,
    map: safeJson(row.map) ?? row.map,
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function getChartBinding(id) {
  if (!dbReady) return null;
  return serializeBinding(stmt(`SELECT ${BINDING_COLS} FROM chart_bindings WHERE id = ?`).get(String(id)));
}

export function getChartBindingByLineage(lineageKey) {
  if (!dbReady) return null;
  return serializeBinding(
    stmt(`SELECT ${BINDING_COLS} FROM chart_bindings WHERE lineage_key = ?`).get(String(lineageKey))
  );
}

// Batch read for list responses: one query for the whole page's bindings.
export function getChartBindings(ids = []) {
  if (!dbReady || !ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(`SELECT ${BINDING_COLS} FROM chart_bindings WHERE id IN (${placeholders})`)
    .all(...ids.map(String))
    .map(serializeBinding);
}

// Per-binding counts for the source line ("截至 X", the period count the
// data-period filter slices). One aggregate for a whole page.
export function seriesPointStats(bindingIds = []) {
  if (!dbReady || !bindingIds.length) return new Map();
  const placeholders = bindingIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT binding_id AS bindingId, COUNT(*) AS periods, MAX(updated_at) AS lastObservedAt
       FROM chart_series_points WHERE binding_id IN (${placeholders}) GROUP BY binding_id`
    )
    .all(...bindingIds.map(String));
  return new Map(rows.map((r) => [r.bindingId, r]));
}

export function insertChartBinding(fields) {
  if (!dbReady) return null;
  stmt(
    `INSERT INTO chart_bindings (id, lineage_key, server, tool, args, map, concept, frequency,
       unit, refresh_rule, origin, stale, stale_reason, stale_since, last_ok_at,
       consecutive_failures, backoff_until, gate_fingerprint, created_at, updated_at)
     VALUES (@id, @lineage_key, @server, @tool, @args, @map, @concept, @frequency,
       @unit, @refresh_rule, @origin, 0, NULL, NULL, @last_ok_at,
       0, NULL, NULL, @created_at, @updated_at)`
  ).run({
    id: fields.id,
    lineage_key: fields.lineageKey,
    server: fields.server,
    tool: fields.tool,
    // Callers pass structures; the row stores canonical text. Accepting a
    // string too keeps the helper usable from a migration/backfill context.
    args: typeof fields.args === "string" ? fields.args : JSON.stringify(fields.args ?? {}),
    map: typeof fields.map === "string" ? fields.map : JSON.stringify(fields.map ?? {}),
    concept: fields.concept ?? null,
    frequency: fields.frequency,
    unit: fields.unit ?? null,
    refresh_rule: fields.refreshRule ? JSON.stringify(fields.refreshRule) : null,
    origin: fields.origin,
    last_ok_at: fields.lastOkAt ?? null,
    created_at: fields.createdAt,
    updated_at: fields.updatedAt,
  });
  return getChartBinding(fields.id);
}

// Field-wise update. Undefined keys are left alone (an explicit null clears) —
// the refresh path patches stale/backoff/gate incrementally and must not
// resurrect fields it did not touch.
const BINDING_PATCH_COLS = {
  origin: "origin",
  unit: "unit",
  concept: "concept",
  lastOkAt: "last_ok_at",
  stale: "stale",
  staleReason: "stale_reason",
  staleSince: "stale_since",
  consecutiveFailures: "consecutive_failures",
  backoffUntil: "backoff_until",
  gateFingerprint: "gate_fingerprint",
  refreshRule: "refresh_rule",
};

export function updateChartBinding(id, patch = {}, updatedAt) {
  if (!dbReady) return null;
  const sets = [];
  const params = { id: String(id), updated_at: updatedAt };
  for (const [key, col] of Object.entries(BINDING_PATCH_COLS)) {
    if (!(key in patch)) continue;
    sets.push(`${col} = @${key}`);
    let value = patch[key];
    if (key === "stale") value = value ? 1 : 0;
    if (key === "refreshRule") value = value ? JSON.stringify(value) : null;
    params[key] = value ?? null;
  }
  if (!sets.length) return getChartBinding(id);
  sets.push("updated_at = @updated_at");
  stmt(`UPDATE chart_bindings SET ${sets.join(", ")} WHERE id = @id`).run(params);
  return getChartBinding(id);
}

export function deleteChartBinding(id) {
  if (!dbReady) return false;
  return stmt("DELETE FROM chart_bindings WHERE id = ?").run(String(id)).changes > 0;
}

// Every binding, with the resource-reference count — the sweeper's input (a
// binding nobody references is removed with its history) and the scheduler's
// (only referenced bindings get timers). `binding_refs` is a JSON array
// inside a JSON column, so the count is a scan, not a JOIN: bindings number in
// the tens, and a JSON1 dependency for this would be worse than the scan.
export function listChartBindingsWithRefs() {
  if (!dbReady) return [];
  const bindings = stmt(`SELECT ${BINDING_COLS} FROM chart_bindings`).all().map(serializeBinding);
  const refs = new Map();
  for (const row of db
    .prepare("SELECT binding_refs AS refs FROM resources WHERE binding_refs IS NOT NULL")
    .all()) {
    for (const ref of safeJson(row.refs) ?? []) {
      if (ref?.bindingId) refs.set(ref.bindingId, (refs.get(ref.bindingId) ?? 0) + 1);
    }
  }
  return bindings.map((b) => ({ ...b, refCount: refs.get(b.id) ?? 0 }));
}

export function setResourceBindingRefs(id, refs, updatedAt) {
  if (!dbReady) return null;
  const json = Array.isArray(refs) && refs.length ? JSON.stringify(refs) : null;
  const ok =
    stmt("UPDATE resources SET binding_refs = ?, updated_at = ? WHERE id = ?").run(
      json,
      updatedAt,
      String(id)
    ).changes > 0;
  return ok ? getResource(id) : null;
}

// Captured candidates are written once per capture (insert or refresh), so the
// caller replaces the whole array — merging is chart-bindings' job.
export function setResourceCandidates(id, candidates) {
  if (!dbReady) return false;
  const json = Array.isArray(candidates) && candidates.length ? JSON.stringify(candidates) : null;
  return (
    stmt("UPDATE resources SET binding_candidates = ? WHERE id = ?").run(json, String(id)).changes > 0
  );
}

export function getResourceCandidates(id) {
  if (!dbReady) return [];
  const row = stmt("SELECT binding_candidates AS c FROM resources WHERE id = ?").get(String(id));
  const parsed = safeJson(row?.c);
  return Array.isArray(parsed) ? parsed : [];
}

// The chart captured in the current turn — the declared channel's target. The
// session is the runtime's own, the timestamp is the turn's start, so a
// declaration can only ever reach a chart this turn produced.
export function latestChartForSession(sessionId, sinceIso = null) {
  if (!dbReady) return null;
  return (
    stmt(
      `SELECT ${RESOURCE_COLS} FROM resources
       WHERE type = 'chart' AND session_id = @session_id
         AND (@since IS NULL OR created_at >= @since)
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    ).get({ session_id: String(sessionId), since: sinceIso ?? null }) ?? null
  );
}

// ── Point store ─────────────────────────────────────────────────────────────

export function listSeriesPoints(bindingId) {
  if (!dbReady) return [];
  return stmt(
    `SELECT binding_id AS bindingId, series, period, value, source,
       first_seen_at AS firstSeenAt, revision_count AS revisionCount, updated_at AS updatedAt
     FROM chart_series_points WHERE binding_id = ? ORDER BY series, period`
  ).all(String(bindingId));
}

export function countSeriesPoints(bindingId) {
  if (!dbReady) return 0;
  return stmt("SELECT COUNT(*) AS n FROM chart_series_points WHERE binding_id = ?").get(String(bindingId)).n;
}

// As-of reconstruction: for every (series, period) the latest revision at or
// before `at`. MAX(observed_at) per group, then the row carrying it — one pass
// with a correlated lookup keeps it a single statement (the log is indexed by
// (binding_id, series, period, observed_at), which is exactly this shape).
export function asOfPoints(bindingId, atIso) {
  if (!dbReady) return [];
  return stmt(
    `SELECT r.series, r.period, r.value, r.source, r.observed_at AS observedAt
     FROM chart_point_revisions r
     JOIN (
       SELECT series, period, MAX(observed_at) AS observedAt
       FROM chart_point_revisions
       WHERE binding_id = ? AND observed_at <= ?
       GROUP BY series, period
     ) latest
       ON latest.series = r.series AND latest.period = r.period AND latest.observedAt = r.observed_at
     WHERE r.binding_id = ?
     ORDER BY r.series, r.period`
  ).all(String(bindingId), String(atIso), String(bindingId));
}

export function listPointRevisions(bindingId, { limit = 200 } = {}) {
  if (!dbReady) return [];
  return stmt(
    `SELECT series, period, value, source, kind, observed_at AS observedAt
     FROM chart_point_revisions WHERE binding_id = ?
     ORDER BY observed_at DESC, rowid DESC LIMIT ?`
  ).all(String(bindingId), Math.max(1, Number(limit) || 200));
}

// ── Refresh log ─────────────────────────────────────────────────────────────

export function insertChartRefresh(row) {
  if (!dbReady) return null;
  stmt(
    `INSERT INTO chart_refreshes (id, binding_id, fetched_at, trigger, outcome, added, revised,
       resourced, unchanged, missing, anomalies, anomalies_detail, gate, error, duration_ms)
     VALUES (@id, @binding_id, @fetched_at, @trigger, @outcome, @added, @revised,
       @resourced, @unchanged, @missing, @anomalies, @anomalies_detail, @gate, @error, @duration_ms)`
  ).run({
    id: row.id,
    binding_id: row.bindingId,
    fetched_at: row.fetchedAt,
    trigger: row.trigger,
    outcome: row.outcome,
    added: row.added ?? 0,
    revised: row.revised ?? 0,
    resourced: row.resourced ?? 0,
    unchanged: row.unchanged ?? 0,
    missing: row.missing ?? 0,
    anomalies: row.anomalies ?? 0,
    anomalies_detail: row.anomaliesDetail ? JSON.stringify(row.anomaliesDetail) : null,
    gate: row.gate ?? null,
    error: row.error ?? null,
    duration_ms: row.durationMs ?? null,
  });
  return row.id;
}

export function listChartRefreshes(bindingId, { since = null, until = null, limit = 100, offset = 0 } = {}) {
  if (!dbReady) return { items: [], total: 0 };
  const params = {
    bindingId: String(bindingId),
    since,
    until,
    limit: Math.max(1, Number(limit) || 100),
    offset: Math.max(0, Number(offset) || 0),
  };
  const where = `WHERE binding_id = @bindingId
    AND (@since IS NULL OR fetched_at >= @since)
    AND (@until IS NULL OR fetched_at <= @until)`;
  const items = db
    .prepare(
      `SELECT id, binding_id AS bindingId, fetched_at AS fetchedAt, trigger, outcome,
         added, revised, resourced, unchanged, missing, anomalies,
         anomalies_detail AS anomaliesDetail, gate, error, duration_ms AS durationMs
       FROM chart_refreshes ${where} ORDER BY fetched_at DESC, rowid DESC LIMIT @limit OFFSET @offset`
    )
    .all(params)
    .map((r) => ({ ...r, anomaliesDetail: safeJson(r.anomaliesDetail) }));
  const total = db.prepare(`SELECT COUNT(*) AS n FROM chart_refreshes ${where}`).get(params).n;
  return { items, total, limit: params.limit, offset: params.offset };
}

export function lastChartRefresh(bindingId) {
  if (!dbReady) return null;
  const row = stmt(
    `SELECT fetched_at AS fetchedAt, trigger, outcome, gate
     FROM chart_refreshes WHERE binding_id = ? ORDER BY fetched_at DESC, rowid DESC LIMIT 1`
  ).get(String(bindingId));
  return row ?? null;
}

// ── The refresh write, one transaction ──────────────────────────────────────
//
// Points and the refresh row land together or not at all: a crash between the
// two would otherwise leave the log disagreeing with the data it describes.
// `points` are the classifier's decisions — each carries its `kind` and a
// `bump` flag (the value in force changed) so the latest view's revision_count
// stays a property of the write, not a second query.
export function applyChartRefresh({
  points = [],
  bindingId,
  refresh = null,
  bindingPatch = null,
  payloadUpdates = [],
  updatedAt,
}) {
  if (!dbReady) return false;
  const insertRevision = stmt(
    `INSERT INTO chart_point_revisions (binding_id, series, period, value, source, kind, observed_at)
     VALUES (@binding_id, @series, @period, @value, @source, @kind, @observed_at)
     ON CONFLICT(binding_id, series, period, observed_at) DO NOTHING`
  );
  const upsertPoint = stmt(
    `INSERT INTO chart_series_points (binding_id, series, period, value, source, first_seen_at, revision_count, updated_at)
     VALUES (@binding_id, @series, @period, @value, @source, @observed_at, 1, @observed_at)
     ON CONFLICT(binding_id, series, period) DO UPDATE SET
       value = excluded.value,
       source = excluded.source,
       revision_count = chart_series_points.revision_count + @bump,
       updated_at = excluded.updated_at`
  );
  const updatePayload = stmt(
    "UPDATE resources SET payload = @payload, updated_at = @updated_at WHERE id = @id"
  );
  return db.transaction(() => {
    for (const p of points) {
      const row = {
        binding_id: String(bindingId),
        series: p.series ?? "",
        period: String(p.period),
        value: typeof p.value === "number" && Number.isFinite(p.value) ? p.value : null,
        source: p.source ?? null,
        kind: p.kind ?? "unchanged",
        observed_at: p.observedAt,
        bump: p.bump ? 1 : 0,
      };
      insertRevision.run(row);
      // `missing` is a log-only classification: the stored value is retained,
      // so nothing is written to the latest view for it.
      if (p.kind !== "missing") upsertPoint.run(row);
    }
    // The payload write rides the same transaction as the points it renders: a
    // chart must never display a value the store does not have (or vice versa).
    for (const update of payloadUpdates) {
      updatePayload.run({ id: String(update.resourceId), payload: update.payload, updated_at: updatedAt });
    }
    if (refresh) insertChartRefresh(refresh);
    if (bindingPatch) updateChartBinding(bindingId, bindingPatch, updatedAt);
    return true;
  })();
}

// Drop the OLDEST periods from the materialized latest view (the point log is
// untouched — as-of keeps working). Applied after a refresh that pushed the
// view past the cap.
export function trimSeriesPointsToCap(bindingId, cap) {
  if (!dbReady) return 0;
  const max = Math.max(1, Number(cap) || 0);
  return stmt(
    `DELETE FROM chart_series_points WHERE binding_id = @id AND period NOT IN (
       SELECT period FROM chart_series_points WHERE binding_id = @id
       ORDER BY period DESC LIMIT @max
     )`
  ).run({ id: String(bindingId), max }).changes;
}

// ── Retention ───────────────────────────────────────────────────────────────

export function pruneRefreshLog(cutoffIso) {
  if (!dbReady) return 0;
  return stmt("DELETE FROM chart_refreshes WHERE fetched_at < ?").run(String(cutoffIso)).changes;
}

// Superseded unchanged observations age out; the first and latest observation
// of every point survive, and any row that changed the value in force is kept
// forever. An `unchanged` row is superseded when a later row for the same
// (binding, series, period) exists.
export function pruneUnchangedRevisions(cutoffIso) {
  if (!dbReady) return 0;
  return stmt(
    `DELETE FROM chart_point_revisions
     WHERE kind = 'unchanged' AND observed_at < @cutoff
       AND EXISTS (
         SELECT 1 FROM chart_point_revisions later
         WHERE later.binding_id = chart_point_revisions.binding_id
           AND later.series = chart_point_revisions.series
           AND later.period = chart_point_revisions.period
           AND (later.observed_at > chart_point_revisions.observed_at
                OR (later.observed_at = chart_point_revisions.observed_at
                    AND later.rowid > chart_point_revisions.rowid))
       )
       AND EXISTS (
         SELECT 1 FROM chart_point_revisions earlier
         WHERE earlier.binding_id = chart_point_revisions.binding_id
           AND earlier.series = chart_point_revisions.series
           AND earlier.period = chart_point_revisions.period
           AND (earlier.observed_at < chart_point_revisions.observed_at
                OR (earlier.observed_at = chart_point_revisions.observed_at
                    AND earlier.rowid < chart_point_revisions.rowid))
       )`
  ).run({ cutoff: String(cutoffIso) }).changes;
}

export function deleteBindingHistory(bindingId) {
  if (!dbReady) return false;
  db.transaction(() => {
    stmt("DELETE FROM chart_point_revisions WHERE binding_id = ?").run(String(bindingId));
    stmt("DELETE FROM chart_series_points WHERE binding_id = ?").run(String(bindingId));
    stmt("DELETE FROM chart_refreshes WHERE binding_id = ?").run(String(bindingId));
    stmt("DELETE FROM chart_bindings WHERE id = ?").run(String(bindingId));
  })();
  return true;
}
