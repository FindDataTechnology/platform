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

// 迁移链的 head 由数组本身决定（2026-11-10）。测试曾把 head 写成字面量 115，
// 于是每加一条迁移就有六条断言假红——那是「测的是历史快照，不是当前契约」。
// 导出这个常量后，断言可以写「跑到 head」而不必跟着数字改。
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
    // Full-fidelity dsh notification log for the /trace viewer. The table moved
    // OUT of this database (openspec: bound-trace-storage): trace is
    // observational data and now lives in its own `trace.db`, so a session
    // index can never be inflated — or a rebuild entangled — by trace volume.
    // This migration is retained as a version marker only; databases created
    // before the move still carry the table, and `server/trace.js` moves its
    // rows into `trace.db` and drops it on first boot.
    statements: [],
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
  {
    version: 24,
    // pack-usage telemetry (add-pack-usage-telemetry, design D1): one row per
    // completed chat turn, for the marketplace's supply feedback (weekly-active
    // packs). pack_id is NULL for local personas / custom presets — those turns
    // aggregate into their own bucket, never inflating a pack. Kept in the main
    // app db (NOT trace.db): 180-day aggregate surface, not a 7-day debug tap.
    statements: [
      `CREATE TABLE IF NOT EXISTS pack_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        user_email TEXT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        pack_id TEXT,
        outcome TEXT NOT NULL,
        duration_ms INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pack_usage_ts ON pack_usage_events(ts)`,
    ],
  },
  {
    version: 25,
    // add-connector-account-picker D1/D6: one email may hold several connector
    // accounts. (email, slot) is the key — slot is the user-readable account
    // name (zero-paste names it after the connector identity; paste defaults
    // to 'default'). pat_id keeps the connector-side PAT id from the mint
    // response so disconnect/replace can best-effort revoke (D7); paste rows
    // have none. active marks the one account injected into profiles; exactly
    // one per email, maintained transactionally by the store. Old single rows
    // migrate to slot='default', active=1 so connected users don't drop.
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(user_connector_credentials)").all().map((c) => c.name)
      );
      if (cols.has("slot")) return; // already rebuilt
      db.exec(`CREATE TABLE user_connector_credentials_v25 (
        email TEXT NOT NULL,
        slot TEXT NOT NULL,
        token TEXT NOT NULL,
        pat_id TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (email, slot)
      )`);
      db.exec(`INSERT INTO user_connector_credentials_v25 (email, slot, token, pat_id, stale, active, updated_at)
        SELECT email, 'default', token, NULL, stale, 1, updated_at FROM user_connector_credentials`);
      db.exec(`DROP TABLE user_connector_credentials`);
      db.exec(`ALTER TABLE user_connector_credentials_v25 RENAME TO user_connector_credentials`);
    },
  },
  {
    version: 26,
    // add-session-to-preset: sample prompts captured from a session ride the
    // preset (≤3×200 chars, validated in routes/custom-presets.js) and flow
    // into the pack draft's serving card at publish. NULL = none authored;
    // JSON array like the sibling list columns.
    apply: (db) => {
      const cols = new Set(db.prepare("PRAGMA table_info(user_presets)").all().map((c) => c.name));
      if (cols.has("examples")) return;
      db.exec(`ALTER TABLE user_presets ADD COLUMN examples TEXT`);
    },
  },
  {
    // add-search-byok: the user's own search-provider key (SerpAPI), used by
    // the relay in preference to the shared pool. Same shape as the sibling
    // per-user credential tables (registry v15, connector v23) — a separate
    // table for the same reason: independent lifecycle, no shared migration.
    version: 27,
    statements: [
      `CREATE TABLE IF NOT EXISTS user_search_credentials (
        email TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 28,
    // facet-market-credentials (add-facet-market-credentials, design D1): the
    // market's app tokens live 12h, so what's stored is the DEVICE identity
    // (Ed25519 keypair + facet-side account), not a terminal token. token /
    // token_exp are the silent-relogin cache (challenge→sign→login); stale
    // means the binding was revoked (re-pair required). Referenced from
    // mcp.json's facet-market server row as `credentialRef: "facet-market"`.
    statements: [
      `CREATE TABLE IF NOT EXISTS user_facet_market_devices (
        email TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        facet_email TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        token TEXT,
        token_exp INTEGER,
        paired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 29,
    // paper-trading-credentials (add-paper-trading-credentials, design D7):
    // one pasted `fdt_` long-lived token per identity — the service has no
    // multi-account dimension, so a single slot (token IS the identity). No
    // expiry and no re-login: stale is the only invalid state, cleared by
    // re-pasting. Referenced from mcp.json's paper-trading server row as
    // `credentialRef: "paper-trading"`.
    statements: [
      `CREATE TABLE IF NOT EXISTS user_paper_trading_credentials (
        email TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 30,
    // add-external-skill-install (刀二, design D1): a stored skill becomes a
    // directory tree, not a lone SKILL.md.
    //   files       — JSON map {"scripts/x.py": "<text>"} of AUXILIARY files
    //                 only (the SKILL.md body stays in `content`). NULL = the
    //                 pre-existing single-file shape; behavior is byte-identical.
    //   frontmatter — the upstream frontmatter map (JSON) captured at install;
    //                 materialization re-emits it (name/description overridden
    //                 by the row) so dsh-consumed fields (whenToUse /
    //                 user-invocable / disable-model-invocation / metadata)
    //                 survive. NULL = regenerate the legacy name/description
    //                 header exactly as before.
    //   origin_meta — external provenance JSON {kind:"external", source, slug,
    //                 originUrl, upstreamName, upstreamVersion}. NULL = locally
    //                 authored or pack-owned.
    // All nullable and additive: existing rows migrate losslessly.
    statements: [
      `ALTER TABLE custom_skills ADD COLUMN files TEXT`,
      `ALTER TABLE custom_skills ADD COLUMN frontmatter TEXT`,
      `ALTER TABLE custom_skills ADD COLUMN origin_meta TEXT`,
    ],
  },
  {
    version: 31,
    // line-credentials (add-line-credential-refs, design D1): per-line creds —
    // wire-customer / lex hold short-lived Logto ID tokens (browser PKCE silent
    // mint; aud is each line's own Logto app — upstream verifies),
    // wanxing-caller holds a pasted long-lived sk- key. Referenced from
    // mcp.json rows as credentialRef: wire-customer | lex | wanxing-caller.
    statements: [
      `CREATE TABLE IF NOT EXISTS user_line_credentials (
        email TEXT NOT NULL,
        line TEXT NOT NULL,
        token TEXT NOT NULL,
        token_exp INTEGER,
        stale INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (email, line)
      )`,
    ],
  },
  {
    version: 32,
    // ciyuan-account-lane (design D4): one 词元 account binding per identity —
    // the key minted server-side through the user's 词元 login, plus display
    // metadata (never the password or the login token, which are discarded).
    statements: [
      `CREATE TABLE IF NOT EXISTS user_ciyuan_account (
        email TEXT NOT NULL PRIMARY KEY,
        token TEXT NOT NULL,
        key_id INTEGER,
        key_name TEXT,
        group_id INTEGER,
        ciyuan_email_masked TEXT,
        minted_at TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 33,
    // full-mode-tool-scope (design D4): a custom preset may narrow each of its
    // own MCP references to tool leaf names — JSON {server: [leaf...]}.
    // '{}' / NULL = no declaration (the preset inherits the full-mode derived
    // scope). Additive and nullable: existing rows migrate losslessly.
    statements: [`ALTER TABLE user_presets ADD COLUMN mcp_tools TEXT DEFAULT '{}'`],
  },
  {
    version: 34,
    // add-line-boards-and-action-gate: action proposals + audit log.
    //   action_proposals — pending/approved/rejected/expired actions;
    //     id (proposalId), line, action_id, args_digest (sha256), args_json (encrypted or plain for execution), risk, target,
    //     impact_text, proposer_session, proposer_email, approver_email,
    //     approved_at, expired_at, state ("pending"|"executed"|"rejected"|"expired"),
    //     result_summary, created_at, updated_at.
    //   action_audit — executed actions (append-only); same columns plus
    //     executor_info, duration_ms, error_text.
    // Both tables use WAL-friendly design; no FK cascades needed (session/user
    // rows are soft-deleted by design; we keep history even if session is gone).
    statements: [
      `CREATE TABLE IF NOT EXISTS action_proposals (
        proposal_id TEXT PRIMARY KEY,
        line TEXT NOT NULL,
        action_id TEXT NOT NULL,
        args_digest TEXT NOT NULL,
        args_json TEXT,
        risk TEXT NOT NULL,
        target TEXT NOT NULL,
        impact_text TEXT NOT NULL,
        proposer_session TEXT,
        proposer_email TEXT,
        approver_email TEXT,
        approved_at TEXT,
        expired_at TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        result_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_action_proposals_line ON action_proposals(line)`,
      `CREATE INDEX IF NOT EXISTS idx_action_proposals_state ON action_proposals(state)`,
      `CREATE INDEX IF NOT EXISTS idx_action_proposals_created ON action_proposals(created_at DESC)`,
      `CREATE TABLE IF NOT EXISTS action_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT REFERENCES action_proposals(proposal_id) ON DELETE SET NULL,
        line TEXT NOT NULL,
        action_id TEXT NOT NULL,
        args_digest TEXT NOT NULL,
        args_json TEXT,
        risk TEXT NOT NULL,
        target TEXT NOT NULL,
        impact_text TEXT NOT NULL,
        executor_info TEXT,
        duration_ms INTEGER,
        error_text TEXT,
        result_summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_action_audit_line ON action_audit(line)`,
      `CREATE INDEX IF NOT EXISTS idx_action_audit_created ON action_audit(created_at DESC)`,
    ],
  },
  {
    version: 35,
    // add-crm-desk-pack-embed (task 2.1): per-user Chatwoot BYOK credential —
    // the API token (tool face + action execution) plus optional login
    // email/password (embed server-side sign-in only). One row per user;
    // paste semantics (401 flips stale, re-paste to recover) like the
    // connector family. Plaintext at rest matches the line/registry
    // credential tables' existing posture (same threat domain, owner-keyed).
    statements: [
      `CREATE TABLE IF NOT EXISTS user_chatwoot_credentials (
        email TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        login_email TEXT,
        login_password TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    // version 100 on purpose: cell ledgers carry their own compacted history
    // (old cells sat at 60+), so a low number would collide with an
    // already-recorded entry and NEVER run on those cells. 100 is beyond any
    // ledger seen in the wild; versions need not be contiguous.
    version: 100,
    // add-crm-desk-pack-embed task 6.x (SSO): the Chatwoot user id behind the
    // stored API token — discovered lazily via /api/v1/profile and cached so
    // the platform-API SSO login endpoint can be addressed per user.
    //
    // Guarded, not a bare ALTER: a cell whose ledger already records v35 can
    // still be missing the table (compacted/legacy cell DB — cell
    // 2b043ce050ca134c is one: 42 tables at v37, no user_chatwoot_credentials).
    // A bare ALTER there throws `no such table`, runMigrations aborts, initDb
    // catches and disables the WHOLE database — every feature of that cell,
    // not just the Chatwoot one. Recreate the v35 shape, then add the column
    // only when it is absent; both steps are no-ops on a healthy database.
    apply: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS user_chatwoot_credentials (
        email TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        login_email TEXT,
        login_password TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`);
      const cols = new Set(
        db.prepare("PRAGMA table_info(user_chatwoot_credentials)").all().map((c) => c.name)
      );
      if (!cols.has("chatwoot_user_id")) {
        db.exec(`ALTER TABLE user_chatwoot_credentials ADD COLUMN chatwoot_user_id INTEGER`);
      }
    },
  },
  {
    // fix-gateway-bot-owner: the creator email on the bot row — the gateway's
    // webhook router prefers it over session-ownership inference (which is
    // arbitrary on cells with mixed sign-in history). Nullable: legacy rows
    // fall back to the inference path.
    version: 101,
    statements: [`ALTER TABLE bots ADD COLUMN owner_email TEXT`],
  },
  {
    // add-line-credential-renewal: the rotating refresh token for ID-token
    // lines (wire-customer/lex), minted together with the ID token via
    // offline_access and consumed server-side for unattended renewal. NULL =
    // no renewal capability (legacy rows, manual pastes); readable only
    // through the secret-bearing accessor — never the projection SELECT.
    version: 102,
    statements: [`ALTER TABLE user_line_credentials ADD COLUMN refresh_token TEXT`],
  },
  {
    // add-agent-config-dims: the two configuration dimensions beyond the model
    // (thinking depth, per-turn context budget), declarable per bot. Nullable
    // by design — unset = inherit the deployment default = byte-identical to
    // before; rollback needs no data migration.
    version: 103,
    statements: [
      `ALTER TABLE bots ADD COLUMN effort TEXT`,
      `ALTER TABLE bots ADD COLUMN context_budget INTEGER`,
    ],
  },
  {
    // add-zhiyu-im-bridge: optional room binding for a bot (`zhiRoomId`, null
    // = legacy per-chat agent session, byte-identical) plus the output bridge's
    // restart-safe last-sent cursor (`zhiBridgeCursor`, room message seq).
    version: 104,
    statements: [
      `ALTER TABLE bots ADD COLUMN zhi_room_id TEXT`,
      `ALTER TABLE bots ADD COLUMN zhi_bridge_cursor INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // add-unified-memory-and-outputs: resources carry a denormalized mirror of
    // the fd-memory reference page's tier/tags for fast list filtering. Truth
    // lives in fd-memory; these columns only ever move via the gesture write
    // face — never by direct client writes.
    version: 105,
    statements: [
      `ALTER TABLE resources ADD COLUMN tier TEXT NOT NULL DEFAULT 'draft'`,
      `ALTER TABLE resources ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE resources ADD COLUMN memory_ref_path TEXT`,
      `ALTER TABLE resources ADD COLUMN tags_origin TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE resources ADD COLUMN tier_origin TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    // add-local-fleet-control-plane: the local roster truth. One row per
    // deployed serving agent on THIS machine; the local feed
    // (server/local-agent-feed.js) synthesizes registry-shaped entries from
    // these rows × the installed pack manifest, so agent-runner needs no
    // code change — only a feed pointer. `agent_path` is the stable identity
    // across stop/start (stop removes the entry from the feed, keeps the row).
    version: 106,
    statements: [
      `CREATE TABLE IF NOT EXISTS local_fleet_deployments (
        agent_path TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_overrides TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (pack_id, agent_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_local_fleet_deployments_pack
        ON local_fleet_deployments(pack_id)`,
    ],
  },
  {
    // add-offline-pack-supply: an installed pack remembers where it came from
    // (market | bundle). Historical rows default to 'market' — the only source
    // that existed before bundles — so no backfill pass is needed and old
    // readers that ignore the column are unaffected.
    version: 107,
    statements: [
      `ALTER TABLE installed_packs ADD COLUMN source TEXT NOT NULL DEFAULT 'market'`,
    ],
  },
  {
    // add-skill-self-evolution: the candidate store (AI-proposed skills) and
    // the lineage column on custom_skills. Candidates live OUTSIDE
    // custom_skills on purpose (D1): the materializer mirrors custom_skills
    // verbatim, so a status column there would be one missed filter away from
    // a candidate going live. Promotion is a one-way write with audit.
    // lineage records "superseded by X per eval Y" on the OLD row (never
    // delete — 永不删页只 lineage).
    version: 109,
    statements: [
      `CREATE TABLE IF NOT EXISTS skill_candidates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        body TEXT NOT NULL,
        evidence TEXT NOT NULL,
        supersedes TEXT,
        status TEXT NOT NULL DEFAULT 'candidate',
        eval_report TEXT,
        proposed_by TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_skill_candidates_status ON skill_candidates(status)`,
      `ALTER TABLE custom_skills ADD COLUMN evolution_lineage TEXT`,
    ],
  },
  {
    // add-unified-fleet-console: a deployment row remembers WHO established it
    // — 'manual' (user action on this machine, wins over cloud desired state)
    // or 'cloud' (applied by the desired-state merge, keeps following the
    // cloud's desired set until a manual action adopts it). Historical rows
    // default to 'manual' — the only source that existed before the merge —
    // so no backfill pass is needed and old readers that ignore the column
    // are unaffected (same convention as installed_packs.source v107).
    version: 108,
    statements: [
      `ALTER TABLE local_fleet_deployments ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`,
    ],
  },
  {
    // add-web-project-container: Project as the web-side top-level container —
    // a persisted entity with identity (id + display name), NOT just a
    // directory. `projects` carries id/name/backing-path (unique)/owner and
    // timestamps. Sessions and document collections each gain a nullable
    // project_id (additive; every existing row keeps NULL → the read-time
    // 默认项目 fallback). Cron jobs get the same attribution but live in
    // task-engine's jobs.json (file store), NOT this SQLite DB — they carry
    // project_id as a record field there (handled with the cron lane, not a
    // migration). The backing path stays the engine-facing contract: the dsh
    // cwd and the set_workspace chain are untouched (design D1). The ALTERs
    // ride the `apply` hook with PRAGMA guards because a fresh DB created them
    // inside the CREATE TABLE (so an ALTER would throw "duplicate column")
    // while older DBs need the column added — same idempotency convention as
    // v6 chat_messages.blocks.
    version: 110,
    statements: [
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        backing_path TEXT NOT NULL,
        owner TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_backing_path ON projects(backing_path)`,
    ],
    apply: (db) => {
      const addCol = (table, col) => {
        // Table-existence guard (same discipline as v111's bots ALTER): a
        // legacy fixture DB claiming v1..12 physically carries only the tables
        // its fixture knows about — a missing table must be skipped, not kill
        // the whole migration chain (真机走查班 2026-10-31: role-gated fixture
        // has no `collections`, v110 aborted the chain → initDb degraded).
        const tables = new Set(
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
        );
        if (!tables.has(table)) return;
        const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
        if (!cols.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
      };
      addCol("chat_sessions", "project_id");
      addCol("collections", "project_id");
    },
  },
  {
    version: 111,
    // Bot identity and per-bot tool posture (harden-bot-reply-lane). Both live
    // on the bot ROW, not in the credentials JSON: credentials are the secret
    // face (maskBot publishes only their key names) and are REPLACED as a whole
    // object on rotation, so a persona parked there would be wiped by an
    // unrelated credential edit. `allow_tools` defaults to 0 = the spec's
    // no-tools posture; the deployment env is only a ceiling on top of it.
    // PRAGMA-guarded like every additive ALTER (a fresh DB never ran the ALTER
    // and a re-run must not throw "duplicate column").
    apply: (db) => {
      // Table-guarded like v110's addCol: an ADD COLUMN on an absent base table
      // must not take the whole database down (schema-migrations spec).
      if (!migrationTableExists(db, "bots")) {
        console.warn("[db] v111: skipped bots persona/allow_tools — table absent (legacy cell ledger)");
        return;
      }
      const cols = new Set(db.prepare("PRAGMA table_info(bots)").all().map((c) => c.name));
      if (!cols.has("persona")) db.exec("ALTER TABLE bots ADD COLUMN persona TEXT");
      if (!cols.has("allow_tools")) {
        db.exec("ALTER TABLE bots ADD COLUMN allow_tools INTEGER NOT NULL DEFAULT 0");
      }
    },
  },
  {
    // add-persona-self-evolution: the persona amendment candidate store (the
    // role-bucket twin of skill_candidates v109). Candidates live OUTSIDE
    // custom_presets and packs on purpose (D1): promotion is the only bridge,
    // and it SPLITS — presets materialize via the CRUD path, pack personas
    // fork into drafts (D3). current_persona snapshots the text the amendment
    // addresses (the eval arm + the lineage anchor); lineage records the
    // promotion outcome (previous persona / fork draft id) on the candidate.
    version: 112,
    statements: [
      `CREATE TABLE IF NOT EXISTS persona_candidates (
        id TEXT PRIMARY KEY,
        target_kind TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        agent_id TEXT,
        current_persona TEXT,
        amended_persona TEXT NOT NULL,
        evidence TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate',
        eval_report TEXT,
        proposed_by TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        lineage TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_persona_candidates_status ON persona_candidates(status)`,
      `CREATE INDEX IF NOT EXISTS idx_persona_candidates_target ON persona_candidates(target_kind, target_ref, agent_id)`,
    ],
  },
  {
    // add-agent-builder-workspace 8.1：候选→来源工作区文档回链。提案主要来自
    // cell 内 agent（MCP skill_propose/persona_propose），那边天然没有 studio
    // 文档上下文——列可空，只有 studio 发起的提案才带（诚实缺席=零芯片）。
    version: 113,
    statements: [
      `ALTER TABLE skill_candidates ADD COLUMN source_doc_id TEXT`,
      `ALTER TABLE persona_candidates ADD COLUMN source_doc_id TEXT`,
    ],
  },
  {
    // add-connector-bindings D3：凭据表分两类行 + 绑定台账。
    //
    //   kind='account'  connector 账号（v25 起的既有形状：一个身份 N 个账号，
    //                   其中一个是 active 的）。注入决策只看这一类。
    //   kind='binding'  按包绑定铸出的窄面令牌。slot 即 binding key，与账号名
    //                   同处一槽位，故主键必须带上 kind——否则用户的账号名与
    //                   包的绑定 key 同名时会互相覆盖。
    //
    // purpose 记该行的用途标签（内置自由探索 / pack:binding），source_account
    // 记该绑定令牌由哪个账号铸造，供失效时回溯来源（不自动改选）。
    //
    // 台账独立成表：凭据行是「密文 + 生命周期」，台账是「声明 + 解析结论」，
    // 读路径相反（凭据永不返回明文，台账要进 GET /api/connections 投影）。
    version: 114,
    apply: (db) => {
      const cols = new Set(
        db.prepare("PRAGMA table_info(user_connector_credentials)").all().map((c) => c.name)
      );
      if (!cols.has("kind")) {
        db.exec(`CREATE TABLE user_connector_credentials_v114 (
          email TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'account',
          slot TEXT NOT NULL,
          token TEXT NOT NULL,
          pat_id TEXT,
          purpose TEXT,
          source_account TEXT,
          stale INTEGER NOT NULL DEFAULT 0,
          active INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (email, kind, slot)
        )`);
        // Every pre-114 row is an account row; nothing is dropped or renamed.
        db.exec(`INSERT INTO user_connector_credentials_v114
            (email, kind, slot, token, pat_id, purpose, source_account, stale, active, updated_at)
          SELECT email, 'account', slot, token, pat_id, NULL, NULL, stale, active, updated_at
          FROM user_connector_credentials`);
        db.exec(`DROP TABLE user_connector_credentials`);
        db.exec(`ALTER TABLE user_connector_credentials_v114 RENAME TO user_connector_credentials`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS connector_binding_ledger (
        email TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_version TEXT,
        binding_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        operations TEXT NOT NULL,
        connection_id TEXT,
        status TEXT NOT NULL,
        optional INTEGER NOT NULL DEFAULT 0,
        granted_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (email, pack_id, binding_key)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_connector_binding_ledger_status
        ON connector_binding_ledger(email, status)`);
    },
  },
  {
    // add-connector-role-mapping D2: a role binding's provider is chosen by the
    // user, so the choice lives per identity — one row per (email, role),
    // shared by every pack that declares that role. `role` is added to the
    // ledger so a row can say "provider=wangdian (role=wms)" without rewriting
    // history: existing rows get NULL and mean "plain service-id binding".
    version: 115,
    apply: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS connector_role_mappings (
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (email, role)
      )`);
      const cols = new Set(
        db.prepare("PRAGMA table_info(connector_binding_ledger)").all().map((c) => c.name)
      );
      if (!cols.has("role")) {
        db.exec(`ALTER TABLE connector_binding_ledger ADD COLUMN role TEXT`);
      }
    },
  },
  {
    version: 116,
    // add-personal-mandate: the mandate columns on the execution ledger.
    // `action_audit` is the single source of truth for "what ran", so the
    // mandate reference rides here rather than in a second table (design D6).
    //   mandate_ref     — which policy+domain authorized it (nullable: most
    //                     actions are still proposed and approved by a human)
    //   mandate_domain  — the domain, for "show me this domain's actions"
    //   mandate_mode    — advise/draft/act-notify/act-silent at execution time
    //   disclose_level  — the strictest level the content touched (nullable)
    //   reversible_until— epoch ms; null means irreversible (never auto-run)
    //   content_digest  — sha256 of the outbound text; the text itself is NOT
    //                     stored (a second copy of what the agent said in your
    //                     name would be a new sensitive surface)
    //   revoked_at      — set when the owner撤回s inside the window
    // All additive and nullable: existing rows and readers are untouched.
    apply: (db) => {
      const cols = new Set(db.prepare("PRAGMA table_info(action_audit)").all().map((c) => c.name));
      const add = (name, type) => {
        if (!cols.has(name)) db.exec(`ALTER TABLE action_audit ADD COLUMN ${name} ${type}`);
      };
      add("mandate_ref", "TEXT");
      add("mandate_domain", "TEXT");
      add("mandate_mode", "TEXT");
      add("disclose_level", "TEXT");
      add("reversible_until", "INTEGER");
      add("content_digest", "TEXT");
      add("revoked_at", "TEXT");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_action_audit_domain ON action_audit(mandate_domain)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_action_audit_reversible ON action_audit(reversible_until)`);
    },
  },
  {
    version: 117,
    // add-principal-disclosure-gate: who a spoken message represented, and to
    // whom it was said. The rest of the accountability columns already exist on
    // this table (v116) — a second ledger would drift out of sync, and the whole
    // value of an audit trail is that it agrees with itself.
    //   principal — the identity the agent spoke for (owner / principal stamp)
    //   audience  — recipient identifier + channel
    // Both nullable: non-spoken actions have no audience, and old rows predate
    // the concept.
    apply: (db) => {
      const cols = new Set(db.prepare("PRAGMA table_info(action_audit)").all().map((c) => c.name));
      const add = (name, type) => {
        if (!cols.has(name)) db.exec(`ALTER TABLE action_audit ADD COLUMN ${name} ${type}`);
      };
      add("principal", "TEXT");
      add("audience", "TEXT");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_action_audit_audience ON action_audit(audience)`);
    },
  },
  {
    version: 118,
    // add-library-semantic-rung 1.2: a trigram full-text index beside the
    // unicode61 one.
    //
    // Why a second table instead of replacing the first: unicode61 treats a run
    // of Han characters as ONE token, so a query only matches when it equals a
    // whole token. Measured on a real 6-doc / 234-chunk Chinese library, 25 of
    // 25 sub-phrase queries returned zero FTS hits and fell into the unranked
    // LIKE scan. trigram indexes every 3-character window, so sub-phrases match
    // with real BM25 ranking.
    //
    // Why not replace outright: trigram needs at least 3 characters, so a
    // 2-character query ("框架", "茅台") matches NOTHING there while unicode61
    // matches its tokens. Keeping both means neither query length regresses.
    // The router (<3 chars -> unicode61, >=3 -> trigram) lives in
    // documents-search.js.
    //
    // Cost, measured on the same library: the trigram index is ~5.5x the
    // unicode61 index (~3x the source text). Cell nodes have run out of disk
    // before, so documents-search.js logs the measured ratio on rebuild.
    //
    // DDL only: rows are rebuilt from document_chunks by the boot backfill.
    apply: (db) => {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS document_chunks_v2 USING fts5(
        text,
        doc_id UNINDEXED,
        name UNINDEXED,
        loc UNINDEXED,
        tokenize='trigram'
      )`);
    },
  },
  {
    version: 119,
    // add-library-semantic-rung 2.1: the vector companion table for the optional
    // semantic rung.
    //
    // Why a companion table and not a column: document_chunks is an FTS5 virtual
    // table — it cannot carry a BLOB column, and virtual tables do not support
    // ALTER. So vectors live beside it.
    //
    // Why (doc_id, loc) is the key rather than the FTS rowid: the rowid is not
    // guaranteed stable across a rebuild, and v118 does rebuild the chunk tables.
    // loc is the character offset into the source text, so it points at the same
    // passage before and after a rebuild.
    //
    // model + dim are stored per row on purpose: the embedding lane contract
    // (ciyuan-embedding-lane) makes dimensions an explicit request parameter, so
    // a row produced under a different model/dimension is NOT comparable. Keeping
    // them lets the reader ignore mismatched rows instead of silently mixing.
    //
    // Empty by default and stays empty while the rung is off.
    apply: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS document_chunk_vectors (
        doc_id TEXT NOT NULL,
        loc INTEGER NOT NULL,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, loc)
      )`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_dcv_doc ON document_chunk_vectors(doc_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_dcv_model ON document_chunk_vectors(model, dim)`);
    },
  },
];

function nowIso() {
  return new Date().toISOString();
}

export { nowIso };

// 迁移链 head（最后一条迁移的版本号）。测试断言「跑到 head」时用它，
// 不要写字面量——新增迁移不该让一批断言假红。
export const SCHEMA_HEAD = MIGRATIONS[MIGRATIONS.length - 1].version;

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
      for (const stmt of m.statements ?? []) execMigrationStatement(stmt, m.version);
      if (m.apply) m.apply(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"
      ).run(m.version, nowIso());
    });
    apply();
    console.log(`[db] applied migration v${m.version}`);
  }
}

// ── ADD COLUMN is made idempotent, deliberately ─────────────────────────────
//
// schema-migrations spec (harden-legacy-cell-migrations): "任一迁移抛出未预期错误时，
// 失败 SHALL 局限于该迁移，不得让整个数据库进入停用状态". The v100 fix repairs the
// one table that was actually missing; this makes the whole class impossible.
//
// SQLite has no `ADD COLUMN IF NOT EXISTS`, and a cell ledger is not a faithful
// record of DDL: legacy/compacted cell DBs record a version whose CREATE never
// ran. An unguarded ADD COLUMN then throws `no such table`; each migration is one
// transaction, so the throw aborts the run and initDb disables the ENTIRE
// database — a cell loses sessions, packs, ledger and credentials because one
// unrelated table is missing (2026-11-08: cell 2b043ce050ca134c).
//
// Only this one statement shape is tolerated: skip when the base table is absent
// or the column is already there, and say which. Every other statement runs
// verbatim — this is NOT an "ignore migration errors" switch and never swallows
// a failure that could mean data loss.
const ADD_COLUMN_RE = /^\s*ALTER\s+TABLE\s+"?([A-Za-z_][\w]*)"?\s+ADD\s+COLUMN\s+"?([A-Za-z_][\w]*)"?/i;

function migrationTableExists(handle, table) {
  return (
    handle.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).c === 1
  );
}

function migrationColumns(handle, table) {
  return new Set(handle.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function execMigrationStatement(sql, version) {
  const match = ADD_COLUMN_RE.exec(sql);
  if (!match) return db.exec(sql);
  const [, table, column] = match;
  if (!migrationTableExists(db, table)) {
    console.warn(`[db] v${version}: skipped ADD COLUMN ${table}.${column} — table absent (legacy cell ledger)`);
    return undefined;
  }
  if (migrationColumns(db, table).has(column)) {
    console.warn(`[db] v${version}: skipped ADD COLUMN ${table}.${column} — column already present`);
    return undefined;
  }
  return db.exec(sql);
}

function latestVersion() {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
  return row?.v ?? 0;
}

// ── Init / degradation ───────────────────────────────────────────────────────

// The path the open handle points at. Needed to tell "re-init the same
// database" (reuse the handle, re-run migrations) from "switch databases"
// (close, then open the other file).
let openedDbPath = null;

export async function initDb() {
  const dbPath = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : DEFAULT_DB_PATH;
  try {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    // Re-open policy, and why it is not "just open another handle":
    //   same path — REUSE the handle and re-run migrations. This is the
    //     migration-test path (drop a table, roll the version back, init again)
    //     and it must keep the caller's getDb() handle usable. Opening a
    //     second connection to the same file while the first is live is what
    //     produced `disk I/O error` here (two WAL connections, one of them
    //     holding a stale -shm mapping).
    //   different path — CLOSE the old handle first. Statements and callers
    //     aimed at the previous database must fail loudly rather than quietly
    //     write into whichever file the handle still had open.
    if (db && openedDbPath !== dbPath) {
      try {
        db.close();
      } catch { /* already closed */ }
      db = null;
    }
    // Statements prepared against a pre-migration shape must not survive a
    // re-init even on the same handle.
    stmtCache.clear();
    if (!db) {
      db = new Database(dbPath);
      openedDbPath = dbPath;
    }
    db.pragma("journal_mode = WAL");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations();
    dbReady = true;
    // add-connector-bindings: pre-change accounts become the built-in
    // free-exploration binding. Idempotent, runs on every boot so an account
    // connected before this release still gains its binding on upgrade.
    backfillConnectorExploreBinding();
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
  // Project attribution (add-web-project-container, design D2): the session's
  // workspace path is backtraced to a project row at the SAME single stamping
  // point as the workspace column itself — no separate enqueue-side writer.
  // A path with no project (desktop origin, legacy rows) stays NULL and renders
  // under the read-time 默认项目 fallback. Write-once like workspace: a later
  // turn whose workspace changed must not re-stamp creation facts.
  const projectId = workspace ? (getProjectByPath(workspace)?.id ?? null) : null;
  stmt(
    `INSERT INTO chat_sessions (id, title, created_at, updated_at, path, agent_preset, workspace, project_id)
     VALUES (@id, @title, @created_at, @updated_at, @path, @agent_preset, @workspace, @project_id)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       updated_at = excluded.updated_at,
       path = COALESCE(excluded.path, chat_sessions.path),
       agent_preset = COALESCE(chat_sessions.agent_preset, excluded.agent_preset),
       workspace = COALESCE(chat_sessions.workspace, excluded.workspace),
       project_id = COALESCE(chat_sessions.project_id, excluded.project_id)`
  ).run({ id, title: title || "New chat", created_at: createdAt, updated_at: updatedAt, path, agent_preset: agentPreset, workspace, project_id: projectId });
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

// ── Projects (add-web-project-container) ────────────────────────────────────
// Project = the web-side top-level container with identity (id + display
// name). `backing_path` is the engine-facing directory the set_workspace switch
// already produces; the unique index makes path→id backtrace a single lookup
// (design D2). Rows are additive: a directory created before this table existed
// attaches by path on the next create attempt, never a duplicate.

export function listProjects() {
  if (!dbReady) return [];
  return stmt(
    "SELECT id, name, backing_path AS backingPath, owner, created_at AS createdAt, updated_at AS updatedAt FROM projects ORDER BY name"
  ).all();
}

export function getProjectByPath(backingPath) {
  if (!dbReady || !backingPath) return null;
  const row = stmt(
    "SELECT id, name, backing_path AS backingPath, owner, created_at AS createdAt FROM projects WHERE backing_path = ?"
  ).get(backingPath);
  return row ?? null;
}

export function getProjectById(id) {
  if (!dbReady || !id) return null;
  const row = stmt(
    "SELECT id, name, backing_path AS backingPath, owner, created_at AS createdAt FROM projects WHERE id = ?"
  ).get(id);
  return row ?? null;
}

// Insert-or-attach by backing path. A directory that already backs a project
// returns the existing row (attaching, design D5 / spec: attach on reuse); a
// fresh one mints a new id and returns it. Returns { id, name, path, attached }.
export function upsertProjectByName(name, backingPath, owner = null) {
  if (!dbReady || !name || !backingPath) return null;
  const existing = getProjectByPath(backingPath);
  if (existing) return { id: existing.id, name: existing.name, path: backingPath, attached: true };
  const id = crypto.randomUUID();
  stmt(
    "INSERT INTO projects (id, name, backing_path, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, name, backingPath, owner, nowIso(), nowIso());
  return { id, name, path: backingPath, attached: false };
}

// Rename display name only; backing path and identity never move (design D5).
// Returns true when a row changed.
export function renameProject(id, name) {
  if (!dbReady || !id || !name) return false;
  return stmt("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(name, nowIso(), id).changes > 0;
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
  const base = `SELECT s.id, s.title, s.created_at AS createdAt, s.updated_at AS updatedAt, s.path, s.agent_preset AS agentPreset, s.workspace, s.project_id AS projectId, s.owner,
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

// ── Windowed transcript reads (openspec: polish-web-surfaces) ────────────────
// The WS `session_loaded` payload carries only a tail window; these are the
// bounded reads behind it and the paging that walks backwards. `seq` rides
// along so the client always has a cursor for "load earlier".

function mapChatMessageRow(row) {
  return {
    role: row.role,
    content: row.content,
    ...(row.blocks ? { blocks: JSON.parse(row.blocks) } : {}),
    seq: row.seq,
  };
}

export function countChatMessages(sessionId) {
  if (!dbReady) return 0;
  return db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?").get(sessionId)?.n ?? 0;
}

export function countChatMessagesBefore(sessionId, beforeSeq) {
  if (!dbReady) return 0;
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND seq < ?")
      .get(sessionId, beforeSeq)?.n ?? 0
  );
}

// The most recent `limit` messages, ascending (the transcript tail).
export function getChatMessagesTail(sessionId, limit) {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT role, content, blocks, seq FROM chat_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?"
    )
    .all(sessionId, limit)
    .reverse()
    .map(mapChatMessageRow);
}

// Up to `limit` messages immediately older than `beforeSeq`, ascending.
export function getChatMessagesBefore(sessionId, beforeSeq, limit) {
  if (!dbReady) return [];
  return db
    .prepare(
      "SELECT role, content, blocks, seq FROM chat_messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?"
    )
    .all(sessionId, beforeSeq, limit)
    .reverse()
    .map(mapChatMessageRow);
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
// ── Library chunk index: unicode61 (v1) + trigram (v2) ──────────────────────
//
// Two full-text tables over the same chunk rows. unicode61 is the original and
// still answers exact-token queries (including 1-2 character CJK terms); the
// trigram table answers sub-phrase queries that unicode61 cannot MATCH at all.
// Both are written in the same transaction so they cannot drift.

let _chunkV2Present = null;

// The trigram table only exists after migration v118. A cell database that has
// not migrated yet must keep working — callers check this before touching v2.
export function hasTrigramChunkIndex() {
  if (!dbReady) return false;
  if (_chunkV2Present === null) {
    _chunkV2Present = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_chunks_v2'")
      .get();
  }
  return _chunkV2Present;
}

// Test/rebuild hook: forget the cached presence probe (a migration run after
// module load flips it).
export function resetTrigramChunkIndexProbe() {
  _chunkV2Present = null;
}

// Escape hatch for tests that need to prove the un-migrated path still works
// (drop v2, then assert search falls back instead of crashing).
export function execRaw(sql) {
  if (!dbReady) return;
  db.exec(sql);
}

export function replaceDocumentChunks(docId, name, chunks) {
  if (!dbReady) return;
  const v2 = hasTrigramChunkIndex();
  const run = db.transaction(() => {
    db.prepare("DELETE FROM document_chunks WHERE doc_id = ?").run(docId);
    const ins = db.prepare(
      "INSERT INTO document_chunks (text, doc_id, name, loc) VALUES (?, ?, ?, ?)"
    );
    let ins2 = null;
    if (v2) {
      db.prepare("DELETE FROM document_chunks_v2 WHERE doc_id = ?").run(docId);
      ins2 = db.prepare(
        "INSERT INTO document_chunks_v2 (text, doc_id, name, loc) VALUES (?, ?, ?, ?)"
      );
    }
    for (const c of chunks) {
      ins.run(c.text, docId, name, c.loc);
      if (ins2) ins2.run(c.text, docId, name, c.loc);
    }
  });
  run();
}

export function deleteDocumentChunks(docId) {
  if (!dbReady) return;
  stmt("DELETE FROM document_chunks WHERE doc_id = ?").run(docId);
  if (hasTrigramChunkIndex()) {
    db.prepare("DELETE FROM document_chunks_v2 WHERE doc_id = ?").run(docId);
  }
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

// Ready docs whose chunks never made it into the trigram table (e.g. the cell
// migrated after the document was ingested). Empty when v2 is absent, so the
// backfill stays a no-op on un-migrated databases.
export function listDocIdsMissingTrigramChunks() {
  if (!dbReady || !hasTrigramChunkIndex()) return [];
  return db
    .prepare(
      `SELECT id FROM documents
       WHERE status = 'ready' AND source_text IS NOT NULL AND source_text != ''
         AND EXISTS (SELECT 1 FROM document_chunks WHERE doc_id = documents.id)
         AND NOT EXISTS (SELECT 1 FROM document_chunks_v2 WHERE doc_id = documents.id)`
    )
    .all()
    .map((r) => r.id);
}

// Rebuild one document's trigram rows from its already-chunked v1 rows. Used by
// the backfill; cheaper and safer than re-chunking source text (the chunk rows
// are the authority on where the boundaries landed).
export function rebuildTrigramChunksFor(docId) {
  if (!dbReady || !hasTrigramChunkIndex()) return 0;
  const run = db.transaction(() => {
    db.prepare("DELETE FROM document_chunks_v2 WHERE doc_id = ?").run(docId);
    return db
      .prepare(
        `INSERT INTO document_chunks_v2 (text, doc_id, name, loc)
         SELECT text, doc_id, name, loc FROM document_chunks WHERE doc_id = ?`
      )
      .run(docId).changes;
  });
  return run();
}

// Measured index footprint, for the honest-accounting log on rebuild.
export function chunkIndexFootprint() {
  if (!dbReady) return null;
  const sizeOf = (name) => {
    let total = 0;
    for (const suffix of ["_data", "_idx", "_content", "_docsize"]) {
      try {
        const row = db.prepare(`SELECT sum(length(block)) AS b FROM ${name}${suffix}`).get();
        total += row?.b || 0;
      } catch {
        /* shadow table shape varies by options; skip what is absent */
      }
    }
    return total;
  };
  const v1 = sizeOf("document_chunks");
  const v2 = hasTrigramChunkIndex() ? sizeOf("document_chunks_v2") : 0;
  return { unicode61_bytes: v1, trigram_bytes: v2 };
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

// Like searchDocumentChunks but over the trigram index (v2). Returns null when
// the trigram table is absent so callers can fall back deliberately instead of
// silently getting an empty list.
export function searchDocumentChunksTrigram(matchExpr, { collectionId, docId, limit = 10 } = {}) {
  if (!dbReady || !hasTrigramChunkIndex()) return null;
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
  return db
    .prepare(
      `SELECT document_chunks_v2.doc_id, document_chunks_v2.name, document_chunks_v2.loc,
              snippet(document_chunks_v2, 0, '«', '»', '…', 16) AS snippet,
              bm25(document_chunks_v2) AS rank
       FROM document_chunks_v2 JOIN documents d ON d.id = document_chunks_v2.doc_id
       WHERE document_chunks_v2 MATCH ? AND d.status = 'ready'${extra}
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

export function createCollection({ id, name, description, created_at, project_id = null }) {
  if (!dbReady) return;
  stmt(
    `INSERT INTO collections (id, name, description, created_at, project_id)
     VALUES (@id, @name, @description, @created_at, @project_id)`
  ).run({ id, name, description, created_at, project_id });
}

export function getCollection(id) {
  if (!dbReady) return null;
  return (
    db
      .prepare(
        `SELECT c.id, c.name, c.description, c.created_at AS createdAt, c.project_id AS projectId,
                (SELECT COUNT(*) FROM collection_documents cd WHERE cd.collection_id = c.id) AS documentCount
         FROM collections c WHERE c.id = ?`
      )
      .get(id) || null
  );
}

// projectId: undefined = every collection (default view, unchanged behavior);
// null = only unattributed (默认项目); a string = that project's collections.
export function listCollections({ projectId } = {}) {
  if (!dbReady) return [];
  const base = `SELECT c.id, c.name, c.description, c.created_at AS createdAt, c.project_id AS projectId,
              (SELECT COUNT(*) FROM collection_documents cd WHERE cd.collection_id = c.id) AS documentCount
       FROM collections c`;
  if (projectId === undefined) {
    return db.prepare(`${base} ORDER BY c.created_at DESC`).all();
  }
  if (projectId === null) {
    return db.prepare(`${base} WHERE c.project_id IS NULL ORDER BY c.created_at DESC`).all();
  }
  return db.prepare(`${base} WHERE c.project_id = ? ORDER BY c.created_at DESC`).all(projectId);
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

// ── Full-surface overrides (full-mode-tool-scope D3) ─────────────────────────
// One GLOBAL preference: the server names the user marked "show the complete
// tool surface", effective in every mode. JSON array; an empty result deletes
// the key so "never set" and "cleared" are the same state. A corrupt value
// reads as none — inert, like the other preference readers.
export function getFullSurfaceServers() {
  if (!dbReady) return [];
  try {
    const parsed = JSON.parse(getPreference("toolScope.fullSurface") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string" && s) : [];
  } catch {
    return [];
  }
}

export function setFullSurfaceServers(servers) {
  if (!dbReady) return [];
  const clean = [...new Set((Array.isArray(servers) ? servers : []).filter((s) => typeof s === "string" && s))];
  if (clean.length === 0) stmt("DELETE FROM user_preferences WHERE key = ?").run("toolScope.fullSurface");
  else setPreference("toolScope.fullSurface", JSON.stringify(clean));
  return clean;
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

// ── Connector credentials (萬星 connector PAT, rows per (email, slot)) ───────
//
// add-connector-account-picker: one email may hold several connector accounts.
// slot is the user-readable account name (zero-paste names it after the
// connector identity; paste defaults to 'default'). pat_id carries the
// connector-side PAT id for best-effort revocation on disconnect/replace.
// Exactly one row per email has active=1 — maintained transactionally here.
// Legacy single-row accessors keep working by targeting the 'default' slot.

function normalizeSlot(slot) {
  const name = String(slot ?? "").trim();
  if (!name || name.length > 64) return null;
  // eslint-disable-next-line no-control-regex
  if (new RegExp("[\\u0000-\\u001f\\u007f]").test(name)) return null;
  return name;
}

export function getConnectorCredential(email, slot = "default") {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  const name = normalizeSlot(slot);
  if (!key || !name) return null;
  const row = stmt(
    "SELECT slot, token, pat_id AS patId, stale, active, updated_at AS updatedAt FROM user_connector_credentials WHERE email = ? AND kind = 'account' AND slot = ?"
  ).get(key, name);
  return row ? { ...row, stale: !!row.stale, active: !!row.active } : null;
}

export function listConnectorCredentials(email) {
  if (!dbReady) return [];
  const key = normalizeIdentityEmail(email);
  if (!key) return [];
  return stmt(
    "SELECT slot, pat_id AS patId, stale, active, updated_at AS updatedAt FROM user_connector_credentials WHERE email = ? AND kind = 'account' ORDER BY slot"
  )
    .all(key)
    .map((row) => ({ ...row, stale: !!row.stale, active: !!row.active }));
}

export function getActiveConnectorCredential(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  const row = stmt(
    "SELECT slot, token, pat_id AS patId, stale, active, updated_at AS updatedAt FROM user_connector_credentials WHERE email = ? AND kind = 'account' AND active = 1"
  ).get(key);
  return row ? { ...row, stale: !!row.stale, active: !!row.active } : null;
}

export function setConnectorCredential({ email, slot = "default", token, patId = null }) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  // An empty/whitespace slot means "the default account" (paste path), not an
  // invalid name — normalize before the null check.
  const name = slot != null && String(slot).trim() === "" ? "default" : normalizeSlot(slot);
  if (!key || !name || !token) return null;
  const wasActive = !!stmt(
    "SELECT 1 FROM user_connector_credentials WHERE email = ? AND kind = 'account' AND slot = ? AND active = 1"
  ).get(key, name);
  const hasAnyActive = !!stmt("SELECT 1 FROM user_connector_credentials WHERE email = ? AND kind = 'account' AND active = 1").get(key);
  // A fresh store clears the stale flag: the user just replaced the credential,
  // so the next profile write may use it. A brand-new account becomes active
  // when the user has no active account yet (first connect); an existing
  // account keeps its previous active flag so connecting a second account
  // never silently flips injection.
  const active = wasActive || !hasAnyActive ? 1 : 0;
  stmt(
    `INSERT INTO user_connector_credentials (email, kind, slot, token, pat_id, stale, active, updated_at)
     VALUES (@email, 'account', @slot, @token, @patId, 0, @active, @updatedAt)
     ON CONFLICT(email, kind, slot) DO UPDATE SET
       token = excluded.token,
       pat_id = excluded.pat_id,
       stale = 0,
       active = excluded.active,
       updated_at = excluded.updated_at`
  ).run({ email: key, slot: name, token, patId, active, updatedAt: nowIso() });
  return getConnectorCredential(key, name);
}

export function setConnectorCredentialActive(email, slot) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  const name = normalizeSlot(slot);
  if (!key || !name) return false;
  const target = stmt(
    "SELECT stale FROM user_connector_credentials WHERE email = ? AND kind = 'account' AND slot = ?"
  ).get(key, name);
  if (!target || target.stale) return false;
  db.transaction(() => {
    stmt("UPDATE user_connector_credentials SET active = 0 WHERE email = ? AND kind = 'account' AND active = 1").run(key);
    stmt("UPDATE user_connector_credentials SET active = 1 WHERE email = ? AND kind = 'account' AND slot = ?").run(key, name);
  })();
  return true;
}

export function deleteConnectorCredential(email, slot = "default") {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  const name = normalizeSlot(slot);
  if (!key || !name) return false;
  const wasActive = !!stmt(
    "SELECT 1 FROM user_connector_credentials WHERE email = ? AND kind = 'account' AND slot = ? AND active = 1"
  ).get(key, name);
  const changes = stmt("DELETE FROM user_connector_credentials WHERE email = ? AND kind = 'account' AND slot = ?")
    .run(key, name).changes;
  // No auto-reselect (design D2): deleting the active account intentionally
  // leaves the user with no active account; they pick the next one explicitly.
  return changes > 0 && wasActive ? true : changes > 0;
}

export function markConnectorCredentialStale(email, slot) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  if (slot === undefined) {
    // Legacy single-row call sites (agent-session 401 handler): flip whichever
    // row is active.
    return stmt("UPDATE user_connector_credentials SET stale = 1, updated_at = ? WHERE email = ? AND kind = 'account' AND stale = 0 AND active = 1")
      .run(nowIso(), key).changes > 0;
  }
  const name = normalizeSlot(slot);
  if (!name) return false;
  return stmt("UPDATE user_connector_credentials SET stale = 1, updated_at = ? WHERE email = ? AND kind = 'account' AND slot = ? AND stale = 0")
    .run(nowIso(), key, name).changes > 0;
}

// ── Connector binding rows + ledger (add-connector-bindings D3) ──────────────
//
// Binding rows live in the same table as accounts (kind='binding'), so their
// tokens share one lifecycle (stale flag, revocation, encryption-at-rest) with
// the account they came from. slot is the binding key here — `chat:explore` for
// the built-in free-exploration binding, `<packId>:<bindingKey>` for pack ones.

export const CONNECTOR_EXPLORE_BINDING = "chat:explore";

export function getConnectorBinding(email, slot) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  const name = normalizeSlot(slot);
  if (!key || !name) return null;
  const row = stmt(
    "SELECT slot, token, pat_id AS patId, purpose, source_account AS sourceAccount, stale, updated_at AS updatedAt FROM user_connector_credentials WHERE email = ? AND kind = 'binding' AND slot = ?"
  ).get(key, name);
  return row ? { ...row, stale: !!row.stale } : null;
}

export function listConnectorBindings(email) {
  if (!dbReady) return [];
  const key = normalizeIdentityEmail(email);
  if (!key) return [];
  return stmt(
    "SELECT slot, pat_id AS patId, purpose, source_account AS sourceAccount, stale, updated_at AS updatedAt FROM user_connector_credentials WHERE email = ? AND kind = 'binding' ORDER BY slot"
  )
    .all(key)
    .map((row) => ({ ...row, stale: !!row.stale }));
}

export function setConnectorBinding({ email, slot, token, patId = null, purpose = null, sourceAccount = null }) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  const name = normalizeSlot(slot);
  if (!key || !name || !token) return null;
  stmt(
    `INSERT INTO user_connector_credentials (email, kind, slot, token, pat_id, purpose, source_account, stale, active, updated_at)
     VALUES (@email, 'binding', @slot, @token, @patId, @purpose, @sourceAccount, 0, 0, @updatedAt)
     ON CONFLICT(email, kind, slot) DO UPDATE SET
       token = excluded.token,
       pat_id = excluded.pat_id,
       purpose = excluded.purpose,
       source_account = excluded.source_account,
       stale = 0,
       updated_at = excluded.updated_at`
  ).run({ email: key, slot: name, token, patId, purpose, sourceAccount, updatedAt: nowIso() });
  return getConnectorBinding(key, name);
}

export function deleteConnectorBinding(email, slot) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  const name = normalizeSlot(slot);
  if (!key || !name) return false;
  return stmt("DELETE FROM user_connector_credentials WHERE email = ? AND kind = 'binding' AND slot = ?")
    .run(key, name).changes > 0;
}

export function markConnectorBindingStale(email, slot) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  const name = normalizeSlot(slot);
  if (!key || !name) return false;
  return stmt(
    "UPDATE user_connector_credentials SET stale = 1, updated_at = ? WHERE email = ? AND kind = 'binding' AND slot = ? AND stale = 0"
  ).run(nowIso(), key, name).changes > 0;
}

// One ledger row per (identity, pack, binding key). status is the resolved
// state (satisfied / missing / stale / unwired / undetermined); operations is a
// JSON array of operation classes so the status face can say *what* is
// missing without re-reading the pack.
export function upsertConnectorBindingLedgerRow({
  email,
  packId,
  packVersion = null,
  bindingKey,
  provider,
  operations = [],
  connectionId = null,
  status,
  optional = false,
  grantedAt = null,
  role = null,
}) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key || !packId || !bindingKey || !provider || !status) return null;
  stmt(
    `INSERT INTO connector_binding_ledger
       (email, pack_id, pack_version, binding_key, provider, operations, connection_id, status, optional, granted_at, role, updated_at)
     VALUES (@email, @packId, @packVersion, @bindingKey, @provider, @operations, @connectionId, @status, @optional, @grantedAt, @role, @updatedAt)
     ON CONFLICT(email, pack_id, binding_key) DO UPDATE SET
       pack_version = excluded.pack_version,
       provider = excluded.provider,
       operations = excluded.operations,
       connection_id = excluded.connection_id,
       status = excluded.status,
       optional = excluded.optional,
       granted_at = COALESCE(excluded.granted_at, connector_binding_ledger.granted_at),
       role = excluded.role,
       updated_at = excluded.updated_at`
  ).run({
    email: key,
    packId,
    packVersion,
    bindingKey,
    provider,
    operations: JSON.stringify(operations),
    connectionId,
    status,
    optional: optional ? 1 : 0,
    grantedAt,
    role,
    updatedAt: nowIso(),
  });
  return getConnectorBindingLedgerRow(key, packId, bindingKey);
}

function decodeLedgerRow(row) {
  if (!row) return null;
  return {
    ...row,
    operations: safeJsonArray(row.operations),
    optional: !!row.optional,
  };
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getConnectorBindingLedgerRow(email, packId, bindingKey) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  const row = stmt(
    `SELECT pack_id AS packId, pack_version AS packVersion, binding_key AS bindingKey, provider,
            operations, connection_id AS connectionId, status, optional, role,
            granted_at AS grantedAt, updated_at AS updatedAt
     FROM connector_binding_ledger WHERE email = ? AND pack_id = ? AND binding_key = ?`
  ).get(key, packId, bindingKey);
  return decodeLedgerRow(row);
}

export function listConnectorBindingLedger(email, packId) {
  if (!dbReady) return [];
  const key = normalizeIdentityEmail(email);
  if (!key) return [];
  const rows = packId
    ? stmt(
        `SELECT pack_id AS packId, pack_version AS packVersion, binding_key AS bindingKey, provider,
                operations, connection_id AS connectionId, status, optional, role,
                granted_at AS grantedAt, updated_at AS updatedAt
         FROM connector_binding_ledger WHERE email = ? AND pack_id = ? ORDER BY binding_key`
      ).all(key, packId)
    : stmt(
        `SELECT pack_id AS packId, pack_version AS packVersion, binding_key AS bindingKey, provider,
                operations, connection_id AS connectionId, status, optional, role,
                granted_at AS grantedAt, updated_at AS updatedAt
         FROM connector_binding_ledger WHERE email = ? ORDER BY pack_id, binding_key`
      ).all(key);
  return rows.map(decodeLedgerRow);
}

/**
 * Role → provider mappings (add-connector-role-mapping D2).
 *
 * A role binding declares `provider: "wms"` with `providerRole: true`: the pack
 * says what it needs, the identity says which system it actually runs. The
 * mapping is keyed on (email, role) rather than on the binding because the fact
 * ("my WMS is wangdian") is a property of the customer, not of one pack — two
 * packs needing `wms` must not get two answers.
 */
export function getConnectorRoleMapping(email, role) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  const name = typeof role === "string" ? role.trim() : "";
  if (!key || !name) return null;
  return stmt(
    "SELECT role, provider, updated_at AS updatedAt FROM connector_role_mappings WHERE email = ? AND role = ?"
  ).get(key, name) ?? null;
}

export function listConnectorRoleMappings(email) {
  if (!dbReady) return [];
  const key = normalizeIdentityEmail(email);
  if (!key) return [];
  return stmt(
    "SELECT role, provider, updated_at AS updatedAt FROM connector_role_mappings WHERE email = ? ORDER BY role"
  ).all(key);
}

/** Idempotent: re-selecting the same provider leaves the row untouched. */
export function setConnectorRoleMapping(email, role, provider) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  const name = typeof role === "string" ? role.trim() : "";
  const target = typeof provider === "string" ? provider.trim() : "";
  if (!key || !name || !target) return null;
  stmt(
    `INSERT INTO connector_role_mappings (email, role, provider, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(email, role) DO UPDATE SET
       provider = excluded.provider,
       updated_at = excluded.updated_at
     WHERE connector_role_mappings.provider IS NOT excluded.provider`
  ).run(key, name, target, nowIso());
  return getConnectorRoleMapping(key, name);
}

/** Returns true when a row was removed (the role was mapped). */
export function deleteConnectorRoleMapping(email, role) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  const name = typeof role === "string" ? role.trim() : "";
  if (!key || !name) return false;
  return stmt("DELETE FROM connector_role_mappings WHERE email = ? AND role = ?").run(key, name).changes > 0;
}

/**
 * Every ledger row of one pack, across all identities (harden: uninstall).
 *
 * The ledger is keyed by (email, pack_id, binding_key) and grants are per
 * identity, while an installed pack is per deployment — so "this pack is gone"
 * has to reach rows the uninstaller does not know the owners of. Returns the
 * distinct emails that still hold rows for the pack.
 */
export function listConnectorBindingLedgerEmails(packId) {
  if (!dbReady || !packId) return [];
  return stmt("SELECT DISTINCT email FROM connector_binding_ledger WHERE pack_id = ? ORDER BY email")
    .all(packId)
    .map((row) => row.email);
}

export function deleteConnectorBindingLedgerRow(email, packId, bindingKey) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("DELETE FROM connector_binding_ledger WHERE email = ? AND pack_id = ? AND binding_key = ?")
    .run(key, packId, bindingKey).changes > 0;
}

/**
 * Built-in free-exploration binding (add-connector-bindings, 存量迁移).
 *
 * Pre-change connector credentials were a single full-authority PAT injected as
 * one global `connector` row. The binding-only injection model needs that
 * capability to *be* a binding, so every identity that already has an active
 * account gets one: slot `chat:explore`, the account's token (unchanged scope =
 * unchanged behavior), purpose `内置自由探索`.
 *
 * Idempotent by construction — the existence check and the insert run in one
 * transaction, and an existing row is never overwritten (a user may have
 * re-granted it narrower on purpose).
 */
export function backfillConnectorExploreBinding() {
  if (!dbReady) return 0;
  const accounts = stmt(
    "SELECT email, slot, token FROM user_connector_credentials WHERE kind = 'account' AND active = 1"
  ).all();
  let inserted = 0;
  for (const account of accounts) {
    const exists = stmt(
      "SELECT 1 FROM user_connector_credentials WHERE email = ? AND kind = 'binding' AND slot = ?"
    ).get(account.email, CONNECTOR_EXPLORE_BINDING);
    if (exists) continue;
    stmt(
      `INSERT INTO user_connector_credentials (email, kind, slot, token, pat_id, purpose, source_account, stale, active, updated_at)
       VALUES (?, 'binding', ?, ?, NULL, ?, ?, 0, 0, ?)`
    ).run(account.email, CONNECTOR_EXPLORE_BINDING, account.token, "内置自由探索", account.slot, nowIso());
    inserted += 1;
  }
  if (inserted) console.log(`[db] backfilled ${inserted} built-in connector binding row(s)`);
  return inserted;
}

// ── User search credentials (add-search-byok) ────────────────────────────────
// The user's own search-provider key, mirroring the registry/connector
// accessor shapes: normalized email is the key, token never leaves the
// server except through the injection path.

export function getSearchCredential(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  const row = stmt("SELECT token, updated_at AS updatedAt FROM user_search_credentials WHERE email = ?").get(key);
  return row ?? null;
}

export function setSearchCredential(email, token) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key || typeof token !== "string" || !token) return null;
  stmt(
    `INSERT INTO user_search_credentials (email, token, updated_at)
     VALUES (@email, @token, @updatedAt)
     ON CONFLICT(email) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at`
  ).run({ email: key, token, updatedAt: nowIso() });
  return { email: key, updatedAt: nowIso() };
}

export function deleteSearchCredential(email) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("DELETE FROM user_search_credentials WHERE email = ?").run(key).changes > 0;
}

// ── User facet-market devices (add-facet-market-credentials) ────────────────
// One device identity per user (Ed25519 keypair). token/token_exp are the
// silent-relogin cache; the row (and the private key) never leaves the
// server except through the injection path.

const FACET_MARKET_COLS = `device_id AS deviceId, public_key AS publicKey, private_key AS privateKey,
  facet_email AS facetEmail, stale, token, token_exp AS tokenExp, paired_at AS pairedAt`;

export function getFacetMarketDevice(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  return stmt(`SELECT ${FACET_MARKET_COLS} FROM user_facet_market_devices WHERE email = ?`).get(key) ?? null;
}

export function setFacetMarketDevice({ email, deviceId, publicKey, privateKey, facetEmail, token, tokenExp, stale = 0 }) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  const now = nowIso();
  stmt(
    `INSERT INTO user_facet_market_devices
       (email, device_id, public_key, private_key, facet_email, stale, token, token_exp, paired_at, updated_at)
     VALUES (@email, @deviceId, @publicKey, @privateKey, @facetEmail, @stale, @token, @tokenExp, @now, @now)
     ON CONFLICT(email) DO UPDATE SET
       device_id = excluded.device_id, public_key = excluded.public_key,
       private_key = excluded.private_key, facet_email = excluded.facet_email,
       stale = excluded.stale, token = excluded.token, token_exp = excluded.token_exp,
       updated_at = excluded.updated_at`
  ).run({ email: key, deviceId, publicKey, privateKey, facetEmail: facetEmail ?? null, stale: stale ? 1 : 0, token, tokenExp: tokenExp ?? null, now });
  return getFacetMarketDevice(key);
}

export function setFacetMarketDeviceToken(email, token, tokenExp, facetEmail, stale = false) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  stmt(
    `UPDATE user_facet_market_devices
     SET token = ?, token_exp = ?, facet_email = COALESCE(?, facet_email), stale = ?, updated_at = ?
     WHERE email = ?`
  ).run(token, tokenExp ?? null, facetEmail ?? null, stale ? 1 : 0, nowIso(), key);
  return getFacetMarketDevice(key);
}

export function clearFacetMarketDeviceToken(email) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("UPDATE user_facet_market_devices SET token = NULL, token_exp = NULL, updated_at = ? WHERE email = ?")
    .run(nowIso(), key).changes > 0;
}

export function markFacetMarketDeviceStale(email) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("UPDATE user_facet_market_devices SET stale = 1, token = NULL, token_exp = NULL, updated_at = ? WHERE email = ?")
    .run(nowIso(), key).changes > 0;
}

export function deleteFacetMarketDevice(email) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("DELETE FROM user_facet_market_devices WHERE email = ?").run(key).changes > 0;
}

// ── User line credentials (add-line-credential-refs) ────────────────────────
// Per-line creds: wire-customer / lex = short-lived Logto ID tokens (browser
// silent mint), wanxing-caller = pasted long-lived sk- key. Token never leaves
// the server except through the injection path.

export function getLineCredential(email, line) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  return stmt(
    "SELECT token, token_exp AS tokenExp, stale, updated_at AS updatedAt FROM user_line_credentials WHERE email = ? AND line = ?"
  ).get(key, line) ?? null;
}

// Secret-bearing read for the renewal path only (add-line-credential-renewal):
// carries the refresh token, which must never ride the projection SELECT above.
// updatedAt rides along as the rotation-age anchor for the fixed-cadence
// renewal policy (the rotator TTL is tenant-configured and opaque — observed
// ~31-33min on this deployment — so cadence keys off last rotation, not the
// ID token's exp).
export function getLineCredentialWithRefresh(email, line) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  return stmt(
    "SELECT token, token_exp AS tokenExp, stale, refresh_token AS refreshToken, updated_at AS updatedAt FROM user_line_credentials WHERE email = ? AND line = ?"
  ).get(key, line) ?? null;
}

// Renewal sweep candidates (add-line-credential-renewal trigger ②): mint lines
// with a stored refresh token, not stale, whose LAST ROTATION is older than
// maxAgeMs — the fixed cadence that keeps every rotator's life well inside the
// tenant's (short, opaque) refresh TTL. Stale rows wait for a human reconnect.
export function listRenewableLineCredentials(nowMs, maxAgeMs) {
  if (!dbReady) return [];
  return stmt(
    `SELECT email, line FROM user_line_credentials
     WHERE line IN ('wire-customer','lex') AND stale = 0 AND refresh_token IS NOT NULL
       AND updated_at < ?`
  ).all(new Date(nowMs - maxAgeMs).toISOString());
}

// refreshToken semantics: undefined = keep the stored value (a manual ID-token
// paste never breaks a live refresh chain), string/null = set it (the mint
// stores the freshly issued token; null = honestly no renewal capability).
// updatedAt: optional ISO override — the renewal cadence keys off this column,
// and tests need to place rows in the past.
export function setLineCredential({ email, line, token, tokenExp, stale = 0, refreshToken, updatedAt }) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  stmt(
    `INSERT INTO user_line_credentials (email, line, token, token_exp, stale, refresh_token, updated_at)
     VALUES (@email, @line, @token, @tokenExp, @stale, @refreshToken, @now)
     ON CONFLICT(email, line) DO UPDATE SET
       token = excluded.token, token_exp = excluded.token_exp,
       stale = excluded.stale, updated_at = excluded.updated_at,
       refresh_token = CASE WHEN @setRefresh THEN excluded.refresh_token ELSE user_line_credentials.refresh_token END`
  ).run({
    email: key, line, token, tokenExp: tokenExp ?? null, stale: stale ? 1 : 0,
    refreshToken: refreshToken ?? null, setRefresh: refreshToken !== undefined ? 1 : 0,
    now: updatedAt ?? nowIso(),
  });
  return getLineCredential(key, line);
}

export function markLineCredentialStale(email, line) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("UPDATE user_line_credentials SET stale = 1, updated_at = ? WHERE email = ? AND line = ?")
    .run(nowIso(), key, line).changes > 0;
}

export function clearLineCredential(email, line) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("DELETE FROM user_line_credentials WHERE email = ? AND line = ?").run(key, line).changes > 0;
}

// ── User Chatwoot credential (add-crm-desk-pack-embed task 2.1) ─────────────
// Per-user BYOK: API token (tool face + gated send) + optional login
// email/password (embed server-side sign-in). Paste semantics like the
// connector family: 401 flips stale, re-save recovers.

export function getChatwootCredential(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  return stmt(
    "SELECT token, login_email AS loginEmail, login_password AS loginPassword, chatwoot_user_id AS chatwootUserId, stale, updated_at AS updatedAt FROM user_chatwoot_credentials WHERE email = ?"
  ).get(key) ?? null;
}

export function setChatwootCredential({ email, token, loginEmail = null, loginPassword = null }) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  stmt(
    `INSERT INTO user_chatwoot_credentials (email, token, login_email, login_password, stale, updated_at)
     VALUES (@email, @token, @loginEmail, @loginPassword, 0, @now)
     ON CONFLICT(email) DO UPDATE SET
       token = excluded.token, login_email = excluded.login_email,
       login_password = excluded.login_password, stale = 0, updated_at = excluded.updated_at`
  ).run({ email: key, token, loginEmail: loginEmail ?? null, loginPassword: loginPassword ?? null, now: nowIso() });
  return getChatwootCredential(key);
}

export function markChatwootCredentialStale(email) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("UPDATE user_chatwoot_credentials SET stale = 1, updated_at = ? WHERE email = ?")
    .run(nowIso(), key).changes > 0;
}

export function setChatwootUserId(email, chatwootUserId) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key || !Number.isInteger(chatwootUserId)) return false;
  return stmt("UPDATE user_chatwoot_credentials SET chatwoot_user_id = ?, updated_at = ? WHERE email = ?")
    .run(chatwootUserId, nowIso(), key).changes > 0;
}

export function clearChatwootCredential(email) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("DELETE FROM user_chatwoot_credentials WHERE email = ?").run(key).changes > 0;
}

// ── User 词元 account binding (ciyuan-account-lane) ──────────────────────────
// One server-minted sk- key per identity plus display metadata. The 词元
// password and login token are never stored anywhere — only the minted key.

export function getCiyuanAccount(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  return stmt(
    `SELECT token, key_id AS keyId, key_name AS keyName, group_id AS groupId,
            ciyuan_email_masked AS ciyuanEmailMasked, minted_at AS mintedAt, stale, updated_at AS updatedAt
     FROM user_ciyuan_account WHERE email = ?`
  ).get(key) ?? null;
}

export function setCiyuanAccount({ email, token, keyId = null, keyName = null, groupId = null, ciyuanEmailMasked = null, mintedAt = null }) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  const now = nowIso();
  stmt(
    `INSERT INTO user_ciyuan_account (email, token, key_id, key_name, group_id, ciyuan_email_masked, minted_at, stale, updated_at)
     VALUES (@email, @token, @keyId, @keyName, @groupId, @masked, @mintedAt, 0, @now)
     ON CONFLICT(email) DO UPDATE SET
       token = excluded.token, key_id = excluded.key_id, key_name = excluded.key_name,
       group_id = excluded.group_id, ciyuan_email_masked = excluded.ciyuan_email_masked,
       minted_at = excluded.minted_at, stale = 0, updated_at = excluded.updated_at`
  ).run({ email: key, token, keyId, keyName, groupId, masked: ciyuanEmailMasked, mintedAt: mintedAt ?? now, now });
  return getCiyuanAccount(key);
}

export function markCiyuanAccountStale(email, stale = true) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("UPDATE user_ciyuan_account SET stale = ?, updated_at = ? WHERE email = ?")
    .run(stale ? 1 : 0, nowIso(), key).changes > 0;
}

export function clearCiyuanAccount(email) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("DELETE FROM user_ciyuan_account WHERE email = ?").run(key).changes > 0;
}

// ── User paper-trading credentials (add-paper-trading-credentials) ──────────
// One pasted `fdt_` token per identity (single slot — token IS the identity).
// Mirrors the search-credential accessor shapes: normalized email is the key,
// token never leaves the server except through the injection path. No expiry:
// stale is the only invalid state.

export function getPaperTradingCredential(email) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key) return null;
  const row = stmt(
    "SELECT token, stale, updated_at AS updatedAt FROM user_paper_trading_credentials WHERE email = ?"
  ).get(key);
  return row ? { ...row, stale: !!row.stale } : null;
}

export function setPaperTradingCredential(email, token) {
  if (!dbReady) return null;
  const key = normalizeIdentityEmail(email);
  if (!key || typeof token !== "string" || !token) return null;
  // A fresh paste replaces the row wholesale and clears stale — re-pasting is
  // the one recovery path after a 401 flip (design D2).
  stmt(
    `INSERT INTO user_paper_trading_credentials (email, token, stale, updated_at)
     VALUES (@email, @token, 0, @updatedAt)
     ON CONFLICT(email) DO UPDATE SET token = excluded.token, stale = 0, updated_at = excluded.updated_at`
  ).run({ email: key, token, updatedAt: nowIso() });
  return getPaperTradingCredential(key);
}

export function markPaperTradingCredentialStale(email) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("UPDATE user_paper_trading_credentials SET stale = 1, updated_at = ? WHERE email = ? AND stale = 0")
    .run(nowIso(), key).changes > 0;
}

export function deletePaperTradingCredential(email) {
  if (!dbReady) return false;
  const key = normalizeIdentityEmail(email);
  if (!key) return false;
  return stmt("DELETE FROM user_paper_trading_credentials WHERE email = ?").run(key).changes > 0;
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

// files/frontmatter/origin_meta are TEXT-JSON columns (v30, 刀二). They are
// decoded here so every reader gets objects, not raw JSON strings; NULL stays
// null (the pre-existing single-file / locally-authored shape).
const CUSTOM_SKILL_COLS =
  "id, name, description, content, enabled, origin_pack_id AS originPackId, origin_pack_version AS originPackVersion, files, frontmatter, origin_meta AS originMeta, created_at AS createdAt, updated_at AS updatedAt";

function decodeSkillRow(row) {
  if (!row) return row;
  return {
    ...row,
    enabled: !!row.enabled,
    files: row.files ? JSON.parse(row.files) : null,
    frontmatter: row.frontmatter ? JSON.parse(row.frontmatter) : null,
    originMeta: row.originMeta ? JSON.parse(row.originMeta) : null,
  };
}

export function listCustomSkills() {
  if (!dbReady) return [];
  return db
    .prepare(`SELECT ${CUSTOM_SKILL_COLS} FROM custom_skills ORDER BY name`)
    .all()
    .map(decodeSkillRow);
}

export function getCustomSkill(name) {
  if (!dbReady) return null;
  const row = db
    .prepare(`SELECT ${CUSTOM_SKILL_COLS} FROM custom_skills WHERE name = ?`)
    .get(name);
  if (!row) return null;
  return decodeSkillRow(row);
}

export function addCustomSkill({ name, description, content, enabled = true, originPackId = null, originPackVersion = null, files = null, frontmatter = null, originMeta = null }) {
  if (!dbReady) return null;
  const id = crypto.randomUUID();
  const now = nowIso();
  stmt(
    `INSERT INTO custom_skills (id, name, description, content, enabled, origin_pack_id, origin_pack_version, files, frontmatter, origin_meta, created_at, updated_at)
     VALUES (@id, @name, @description, @content, @enabled, @originPackId, @originPackVersion, @files, @frontmatter, @originMeta, @created_at, @updated_at)`
  ).run({
    id,
    name,
    description: description || null,
    content,
    enabled: enabled ? 1 : 0,
    originPackId,
    originPackVersion,
    files: files ? JSON.stringify(files) : null,
    frontmatter: frontmatter ? JSON.stringify(frontmatter) : null,
    originMeta: originMeta ? JSON.stringify(originMeta) : null,
    created_at: now,
    updated_at: now,
  });
  return getCustomSkill(name);
}

// files/frontmatter/originMeta use the "undefined = untouched, null = clear"
// convention (matching description/content above), so any caller that does not
// know about the v30 columns keeps its exact old behavior.
export function updateCustomSkill(name, { description, content, enabled, files, frontmatter, originMeta }) {
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
  if (files !== undefined) {
    updates.push("files = @files");
    params.files = files ? JSON.stringify(files) : null;
  }
  if (frontmatter !== undefined) {
    updates.push("frontmatter = @frontmatter");
    params.frontmatter = frontmatter ? JSON.stringify(frontmatter) : null;
  }
  if (originMeta !== undefined) {
    updates.push("origin_meta = @originMeta");
    params.originMeta = originMeta ? JSON.stringify(originMeta) : null;
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
      "SELECT pack_id AS packId, name, version, manifest, report, source, installed_at AS installedAt, updated_at FROM installed_packs ORDER BY installed_at DESC"
    )
    .all()
    .map(hydrateInstalled);
}

export function getInstalledPack(packId) {
  if (!dbReady) return null;
  return hydrateInstalled(
    db
      .prepare(
        "SELECT pack_id AS packId, name, version, manifest, report, source, installed_at AS installedAt, updated_at FROM installed_packs WHERE pack_id = ?"
      )
      .get(packId),
  );
}

export function upsertInstalledPack({ packId, name, version, manifest, report, source = "market" }) {
  if (!dbReady) return null;
  const existing = getInstalledPack(packId);
  const now = nowIso();
  stmt(
    `INSERT INTO installed_packs (pack_id, name, version, manifest, report, source, installed_at, updated_at)
     VALUES (@packId, @name, @version, @manifest, @report, @source, @now, @now)
     ON CONFLICT (pack_id) DO UPDATE SET
       name = @name, version = @version, manifest = @manifest, report = @report,
       source = @source, updated_at = @now`
  ).run({
    packId,
    name,
    version,
    manifest: JSON.stringify(manifest ?? {}),
    report: JSON.stringify(report ?? {}),
    source: source === "bundle" ? "bundle" : "market",
    now,
  });
  return { ...existing, packId, name, version, manifest, report, source, updatedAt: now };
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
  "id, name, persona, skills, mcp_servers AS mcpServers, mcp_tools AS mcpTools, tags, icon, examples, created_at AS createdAt, updated_at AS updatedAt";

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
  // Per-server tool narrowing (full-mode-tool-scope D4): a tolerant reader —
  // a corrupt or legacy row reads as no declaration, never as an empty face.
  const parseToolMap = (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [server, names] of Object.entries(parsed)) {
      if (!Array.isArray(names)) continue;
      const clean = [...new Set(names.filter((n) => typeof n === "string" && n))];
      if (clean.length > 0) out[server] = clean;
    }
    return out;
  };
  return {
    ...row,
    skills: parseNames(row.skills),
    mcpServers: parseNames(row.mcpServers),
    mcpTools: parseToolMap(row.mcpTools),
    tags: parseNames(row.tags),
    // NULL (pre-v26 rows / none authored) reads as an absent field, not [] —
    // the API contract keeps examples optional end to end.
    examples: row.examples == null ? undefined : parseNames(row.examples),
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

export function createUserPreset({ name, persona, skills = [], mcpServers = [], mcpTools = {}, tags = [], icon = null, examples = null }) {
  if (!dbReady) return null;
  const id = assignUserPresetId(name);
  const now = nowIso();
  stmt(
    `INSERT INTO user_presets (id, name, persona, skills, mcp_servers, mcp_tools, tags, icon, examples, created_at, updated_at)
     VALUES (@id, @name, @persona, @skills, @mcpServers, @mcpTools, @tags, @icon, @examples, @now, @now)`
  ).run({
    id,
    name,
    persona,
    skills: JSON.stringify(skills ?? []),
    mcpServers: JSON.stringify(mcpServers ?? []),
    mcpTools: JSON.stringify(mcpTools ?? {}),
    tags: JSON.stringify(tags ?? []),
    icon,
    examples: examples ? JSON.stringify(examples) : null,
    now,
  });
  return getUserPreset(id);
}

export function updateUserPreset(id, { name, persona, skills, mcpServers, mcpTools, tags, icon, examples }) {
  if (!dbReady) return null;
  const updates = [];
  const params = { id, updated_at: nowIso() };
  if (name !== undefined) { updates.push("name = @name"); params.name = name; }
  if (persona !== undefined) { updates.push("persona = @persona"); params.persona = persona; }
  if (skills !== undefined) { updates.push("skills = @skills"); params.skills = JSON.stringify(skills ?? []); }
  if (mcpServers !== undefined) { updates.push("mcp_servers = @mcpServers"); params.mcpServers = JSON.stringify(mcpServers ?? []); }
  if (mcpTools !== undefined) { updates.push("mcp_tools = @mcpTools"); params.mcpTools = JSON.stringify(mcpTools ?? {}); }
  if (tags !== undefined) { updates.push("tags = @tags"); params.tags = JSON.stringify(tags ?? []); }
  if (icon !== undefined) { updates.push("icon = @icon"); params.icon = icon; }
  if (examples !== undefined) { updates.push("examples = @examples"); params.examples = examples ? JSON.stringify(examples) : null; }
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
  "id, type, name, enabled, secret, credentials, effort, context_budget AS contextBudget, zhi_room_id AS zhiRoomId, zhi_bridge_cursor AS zhiBridgeCursor, owner_email AS ownerEmail, persona, allow_tools AS allowTools, created_at AS createdAt";

function hydrateBot(row) {
  if (!row) return null;
  let credentials = {};
  try { credentials = JSON.parse(row.credentials); } catch { /* corrupt row → no creds */ }
  return { ...row, enabled: !!row.enabled, allowTools: !!row.allowTools, credentials };
}

export function listBots() {
  if (!dbReady) return [];
  return db.prepare(`SELECT ${BOT_COLS} FROM bots ORDER BY created_at`).all().map(hydrateBot);
}

export function getBot(id) {
  if (!dbReady) return null;
  return hydrateBot(stmt(`SELECT ${BOT_COLS} FROM bots WHERE id = ?`).get(id));
}

export function addBot({ id, type, name, credentials, secret, enabled = true, ownerEmail = null, effort = null, contextBudget = null, persona = null, allowTools = false }) {
  if (!dbReady) return null;
  stmt(
    `INSERT INTO bots (id, type, name, enabled, secret, credentials, effort, context_budget, created_at, owner_email, persona, allow_tools)
     VALUES (@id, @type, @name, @enabled, @secret, @credentials, @effort, @context_budget, @created_at, @owner_email, @persona, @allow_tools)`
  ).run({
    id,
    type,
    name,
    enabled: enabled ? 1 : 0,
    secret,
    credentials: JSON.stringify(credentials ?? {}),
    effort: effort ?? null,
    context_budget: Number.isFinite(contextBudget) ? contextBudget : null,
    created_at: nowIso(),
    owner_email: ownerEmail ?? null,
    persona: String(persona ?? "").trim() || null,
    allow_tools: allowTools ? 1 : 0,
  });
  return getBot(id);
}

export function updateBot(id, { name, credentials, enabled, effort, contextBudget, zhiRoomId, persona, allowTools }) {
  if (!dbReady) return null;
  const updates = [];
  const params = { id };
  if (name !== undefined) { updates.push("name = @name"); params.name = name; }
  if (credentials !== undefined) {
    updates.push("credentials = @credentials");
    params.credentials = JSON.stringify(credentials);
  }
  if (enabled !== undefined) { updates.push("enabled = @enabled"); params.enabled = enabled ? 1 : 0; }
  if (effort !== undefined) { updates.push("effort = @effort"); params.effort = effort || null; }
  if (persona !== undefined) {
    // Blank clears the persona: the turn then falls back to the neutral default
    // identity block instead of inheriting the cell's preset voice.
    updates.push("persona = @persona");
    params.persona = String(persona ?? "").trim() || null;
  }
  if (allowTools !== undefined) { updates.push("allow_tools = @allow_tools"); params.allow_tools = allowTools ? 1 : 0; }
  if (contextBudget !== undefined) {
    updates.push("context_budget = @context_budget");
    params.context_budget = Number.isFinite(contextBudget) ? contextBudget : null;
  }
  if (zhiRoomId !== undefined) { updates.push("zhi_room_id = @zhiRoomId"); params.zhiRoomId = zhiRoomId || null; }
  if (updates.length) stmt(`UPDATE bots SET ${updates.join(", ")} WHERE id = @id`).run(params);
  return getBot(id);
}

// add-zhiyu-im-bridge: the output bridge's restart-safe cursor (room message
// seq of the last row successfully delivered to IM).
export function setBotBridgeCursor(botId, seq) {
  if (!dbReady) return false;
  return stmt("UPDATE bots SET zhi_bridge_cursor = ? WHERE id = ?").run(Number(seq) || 0, botId).changes > 0;
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

// Bot activity sidecar for the fleet cockpit (fleet-ops-canvas): the newest
// inbound sighting across the bot's chats plus the relay log's newest row.
// Honest absence — a bot that never saw a message or never relayed returns
// nulls, never a fabricated "quiet" timestamp.
export function botActivitySummary(botId) {
  if (!dbReady) return null;
  const id = String(botId);
  const inbound = stmt("SELECT MAX(last_seen_at) AS lastAt FROM bot_chats WHERE bot_id = ?").get(id);
  const relayOk = stmt("SELECT ts FROM bot_relay_log WHERE bot_id = ? AND outcome = 'ok' ORDER BY ts DESC LIMIT 1").get(id);
  const relayErr = stmt("SELECT error, outcome FROM bot_relay_log WHERE bot_id = ? AND outcome != 'ok' ORDER BY ts DESC LIMIT 1").get(id);
  return {
    lastInboundAt: inbound?.lastAt ?? null,
    lastOutboundAt: relayOk?.ts ?? null,
    lastError: relayErr ? (relayErr.error ?? relayErr.outcome) : null,
  };
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
  binding_refs AS bindingRefs, tier, tags, memory_ref_path AS memoryRefPath,
  tags_origin AS tagsOrigin, tier_origin AS tierOrigin`;

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

// ── Type groups (openspec: add-resource-filters) ─────────────────────────────
//
// A file's kind for filtering purposes, derived from its file name extension.
// This map is the single home of that derivation — the list filter, the facet
// counts and (through the route) every client have to agree on what "document"
// means. `file_mime` is deliberately NOT the key: it is itself derived from an
// extension map that does not cover every extension below, so tsv/log/gz/yaml
// would all pile up as octet-stream. `chart` is a row type, not an extension,
// and is handled in the SQL expression.
//
// An extension matching no group — including a row with no file at all — is
// `other`, never dropped: every row always belongs to exactly one group.

export const RESOURCE_GROUPS = [
  "chart",
  "document",
  "spreadsheet",
  "image",
  "slideshow",
  "archive",
  "web",
  "data",
  "other",
];

const EXTENSION_GROUPS = {
  document: ["pdf", "doc", "docx", "md", "txt", "log"],
  spreadsheet: ["csv", "tsv", "xls", "xlsx"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"],
  slideshow: ["ppt", "pptx"],
  archive: ["zip", "tar", "gz", "tgz", "7z", "rar", "bz2", "xz"],
  web: ["html", "htm"],
  data: ["json", "yaml", "yml", "xml"],
};

// Built from the constant above, so the SQL can never drift from the map.
// LIKE is anchored at the end, so `%.xls` does not swallow `report.xlsx`.
const GROUP_EXPR = `CASE
      WHEN type = 'chart' THEN 'chart'
      ${Object.entries(EXTENSION_GROUPS)
        .map(
          ([group, exts]) =>
            `WHEN ${exts.map((e) => `lower(file_path) LIKE '%.${e}'`).join(" OR ")} THEN '${group}'`
        )
        .join("\n      ")}
      ELSE 'other' END`;

// `groups` is a caller-supplied selection and lands in SQL as bound parameters,
// never as interpolated text. An unrecognized name is dropped rather than
// fatal: a stale client sending an old group must narrow less, not error.
function groupPredicate(groups) {
  const wanted = (Array.isArray(groups) ? groups : []).filter((g) => RESOURCE_GROUPS.includes(g));
  if (!wanted.length) return { clause: "", params: {} };
  const params = {};
  const placeholders = wanted.map((g, i) => {
    params[`grp${i}`] = g;
    return `@grp${i}`;
  });
  return { clause: `AND (${GROUP_EXPR} IN (${placeholders.join(", ")}))`, params };
}

// List with the page's filters. `type`, `q`, `groups`, `since` and `until` are
// all optional and combine as AND. `created_at` is stored as an ISO 8601
// string, so lexicographic comparison is chronological comparison and the
// window needs no conversion. The count query mirrors every filter predicate
// so pagination metadata always agrees.
export function listResources({
  type = null,
  q = null,
  groups = null,
  since = null,
  until = null,
  tier = null,
  tags = null,
  limit = 50,
  offset = 0,
} = {}) {
  if (!dbReady) return { items: [], total: 0, limit, offset, facets: emptyFacets() };
  const group = groupPredicate(groups);
  // tier filter (single) + tags（多选以 LIKE 在 JSON 数组里匹）；未识别值收窄为无筛选而不是报错，
  // 与 groupPredicate 的语义保持一致。
  const tierValid = tier && ["draft", "stable", "canonical"].includes(tier) ? tier : null;
  const wantedTags = (Array.isArray(tags) ? tags : []).map(String).filter(Boolean);
  const tagClause = wantedTags.length
    ? "AND (" + wantedTags.map((_, i) => `tags LIKE @tag${i}`).join(" OR ") + ")"
    : "";
  const tagParams = Object.fromEntries(wantedTags.map((t, i) => [`tag${i}`, `%"${t}"%`]));
  const params = {
    type: type || null,
    q: q ? `%${escapeLike(q)}%` : null,
    since: since || null,
    until: until || null,
    tier: tierValid,
    limit: Math.max(1, Number(limit) || 50),
    offset: Math.max(0, Number(offset) || 0),
    ...group.params,
    ...tagParams,
  };
  const where = `WHERE (@type IS NULL OR type = @type)
      AND (@q IS NULL OR title LIKE @q ESCAPE '\\')
      AND (@since IS NULL OR created_at >= @since)
      AND (@until IS NULL OR created_at <= @until)
      AND (@tier IS NULL OR ${tierValid ? "tier = @tier" : "1=1"})
      ${tagClause}
      ${group.clause}`;
  const items = db
    .prepare(
      `SELECT ${RESOURCE_COLS} FROM resources ${where} ORDER BY created_at DESC, rowid DESC LIMIT @limit OFFSET @offset`
    )
    .all(params);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM resources ${where}`).get(params).n;
  return {
    items,
    total,
    limit: params.limit,
    offset: params.offset,
    facets: countGroups({ q: params.q, since: params.since, until: params.until }),
  };
}

function emptyFacets() {
  return Object.fromEntries(RESOURCE_GROUPS.map((g) => [g, 0]));
}

// Per-group counts for the filter chips (openspec: add-resource-filters). The
// window is the active time window plus the title search, deliberately WITHOUT
// the group selection: a chip you unchecked still tells you what is behind it,
// which is the whole point of showing counts at all. Zero-filled, so a client
// can render every chip in a stable order without testing for presence.
function countGroups({ q = null, since = null, until = null } = {}) {
  if (!dbReady) return emptyFacets();
  const params = { q, since, until };
  const where = `WHERE (@q IS NULL OR title LIKE @q ESCAPE '\\')
      AND (@since IS NULL OR created_at >= @since)
      AND (@until IS NULL OR created_at <= @until)`;
  const facets = emptyFacets();
  for (const row of db
    .prepare(`SELECT ${GROUP_EXPR} AS g, COUNT(*) AS n FROM resources ${where} GROUP BY g`)
    .all(params)) {
    facets[row.g] = row.n;
  }
  return facets;
}

// add-unified-memory-and-outputs: memory mirror is fd-memory-write主-under;
// these setters are ONLY for the gesture write face syncing the local mirror —
// never bypass to let the index drift from the reference page.
export function setResourceTier(id, tier, updatedAt, origin = "human") {
  if (!dbReady) return false;
  const t = ["draft", "stable", "canonical"].includes(tier) ? tier : "draft";
  return stmt("UPDATE resources SET tier=?, tier_origin=?, updated_at=? WHERE id=?").run(t, origin, updatedAt, String(id)).changes > 0;
}

export function setResourceTags(id, tags, updatedAt, origin = "human") {
  if (!dbReady) return false;
  const arr = Array.isArray(tags) ? tags.map(String).slice(0, 5) : [];
  return stmt("UPDATE resources SET tags=?, tags_origin=?, updated_at=? WHERE id=?").run(JSON.stringify(arr), origin, updatedAt, String(id)).changes > 0;
}

export function setResourceMemoryRef(id, memoryRefPath, updatedAt) {
  if (!dbReady) return false;
  return stmt("UPDATE resources SET memory_ref_path=?, updated_at=? WHERE id=?").run(memoryRefPath ? String(memoryRefPath) : null, updatedAt, String(id)).changes > 0;
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

// ── Chunk vectors (optional semantic rung) ───────────────────────────────────

export function upsertChunkVectors(docId, items, { model, dim } = {}) {
  if (!dbReady) return 0;
  if (!model || !dim) throw new Error("upsertChunkVectors requires model and dim");
  const now = nowIso();
  const run = db.transaction(() => {
    const stmtIns = db.prepare(
      `INSERT INTO document_chunk_vectors (doc_id, loc, model, dim, vector, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id, loc) DO UPDATE SET
         model = excluded.model, dim = excluded.dim,
         vector = excluded.vector, updated_at = excluded.updated_at`
    );
    let n = 0;
    for (const it of items) {
      stmtIns.run(docId, it.loc, model, dim, it.vector, now);
      n++;
    }
    return n;
  });
  return run();
}

export function deleteChunkVectors(docId) {
  if (!dbReady) return;
  stmt("DELETE FROM document_chunk_vectors WHERE doc_id = ?").run(docId);
}

export function hasChunkVectors(docId, { model, dim } = {}) {
  if (!dbReady) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM document_chunk_vectors
       WHERE doc_id = ? AND model = ? AND dim = ? LIMIT 1`
    )
    .get(docId, model, dim);
  return !!row;
}

// Candidate vectors for a search, scoped like the lexical side. Only rows from
// the CURRENT model/dimension are returned: a vector produced under another
// model is not comparable, and mixing them would silently degrade ranking.
export function listChunkVectors({ model, dim, collectionId = null, docId = null, limit = 2000 } = {}) {
  if (!dbReady || !model || !dim) return [];
  const conds = ["v.model = ?", "v.dim = ?", "d.status = 'ready'"];
  const params = [model, dim];
  if (collectionId) {
    conds.push("v.doc_id IN (SELECT document_id FROM collection_documents WHERE collection_id = ?)");
    params.push(collectionId);
  }
  if (docId) {
    conds.push("v.doc_id = ?");
    params.push(docId);
  }
  params.push(Math.max(1, Math.min(5000, limit)));
  return db
    .prepare(
      `SELECT v.doc_id, v.loc, v.vector, d.name,
              substr(c.text, 1, 200) AS snippet
       FROM document_chunk_vectors v
       JOIN documents d ON d.id = v.doc_id
       LEFT JOIN document_chunks c ON c.doc_id = v.doc_id AND c.loc = v.loc
       WHERE ${conds.join(" AND ")}
       LIMIT ?`
    )
    .all(...params);
}

// Ready docs whose chunks have no vector under the current model/dim — the
// backfill input. Ids only, same reason as listDocIdsWithoutChunks.
export function listDocIdsMissingVectors({ model, dim } = {}) {
  if (!dbReady || !model || !dim) return [];
  return db
    .prepare(
      `SELECT DISTINCT d.id FROM documents d
       WHERE d.status = 'ready' AND d.source_text IS NOT NULL AND d.source_text != ''
         AND EXISTS (SELECT 1 FROM document_chunks c WHERE c.doc_id = d.id)
         AND NOT EXISTS (
           SELECT 1 FROM document_chunk_vectors v
           WHERE v.doc_id = d.id AND v.model = ? AND v.dim = ?)`
    )
    .all(model, dim)
    .map((r) => r.id);
}

export function countChunkVectors({ model, dim } = {}) {
  if (!dbReady) return 0;
  if (!model || !dim) return db.prepare("SELECT count(*) AS c FROM document_chunk_vectors").get().c;
  return db
    .prepare("SELECT count(*) AS c FROM document_chunk_vectors WHERE model = ? AND dim = ?")
    .get(model, dim).c;
}

// Chunk rows of one document, for the embed pass (text + loc, in order).
export function listDocumentChunks(docId) {
  if (!dbReady) return [];
  return db
    .prepare("SELECT text, loc FROM document_chunks WHERE doc_id = ? ORDER BY loc")
    .all(docId);
}

// Total chunk rows (all ready documents) — the input to the vector footprint
// estimate. Counted, not summed by length: bytes of text are irrelevant to the
// vector size.
export function countTotalChunks() {
  if (!dbReady) return 0;
  return db
    .prepare(
      `SELECT count(*) AS c FROM document_chunks c
       JOIN documents d ON d.id = c.doc_id WHERE d.status = 'ready'`
    )
    .get().c;
}
// Personal-data export reader (privacy). Table names come from the caller's
// own allowlist, but validation lives HERE too: a query layer that interpolates
// a table name is the wrong place to trust the caller. Only tables whose rows
// are keyed by `email` qualify; deployment-global tables (user_preferences,
// user_presets, chart_bindings) are deliberately absent — they are not an
// individual's data.
const PERSONAL_TABLE_ALLOW = new Set([
  "user_model_bindings",
  "user_mcp_bindings",
  "user_registry_credentials",
  "user_connector_credentials",
  "user_search_credentials",
  "user_facet_market_devices",
  "user_paper_trading_credentials",
  "user_line_credentials",
  "user_ciyuan_account",
]);

// Erase the personal rows an export would have listed — and nothing else.
//
// Scope is deliberately the SAME allowlist as the export (one definition, so a
// future column can never be exported but forgotten on erase), plus DETACHING
// session ownership rather than deleting sessions: the conversation belongs to
// the transcript archive, and a user asking for their personal data to go does
// not ask for a teammate's shared history to vanish. Returns per-table counts so
// the caller can report exactly what went.
export function erasePersonalRows(email) {
  if (!dbReady || !email) return null;
  const deleted = {};
  for (const table of PERSONAL_TABLE_ALLOW) {
    try {
      deleted[table] = stmt(`DELETE FROM ${table} WHERE email = ?`).run(email).changes;
    } catch {
      deleted[table] = 0; // table absent in this deployment
    }
  }
  // Ownership is a personal fact (it says "this identity ran these turns"), so
  // it goes too — but the session row and its messages stay.
  const detached = stmt("UPDATE chat_sessions SET owner = NULL WHERE owner = ?").run(email).changes;
  return { deleted, detachedSessions: detached };
}

export function listPersonalRows(table, email) {
  if (!dbReady || !email) return [];
  if (!PERSONAL_TABLE_ALLOW.has(table)) throw new Error(`not a personal table: ${table}`);
  try {
    return db.prepare(`SELECT * FROM ${table} WHERE email = ?`).all(email);
  } catch {
    // Table absent in this deployment (lane never used, or older schema):
    // an export answers with what exists rather than failing wholesale.
    return [];
  }
}
