// Bot webhook routing for the multi-tenant gateway (add-user-questions, fd-prod
// cells topology). Chat-platform servers (WeChat OA / WeCom / Feishu / Telegram)
// call /api/bots/webhook/<botId>/<secret> with NO platform identity — the
// gateway's authenticated catch-all would 401 them before any cell is reached.
// The webhook's own auth domain is the per-bot path secret plus each adapter's
// signature verification (the cell route is identity-exempt by design; see
// server/auth.js AUTH_EXEMPT_PREFIXES), so the gateway's only job is ROUTING:
// botId → owning cell.
//
// Resolution reads the cells' own DBs from the shared data root — it works for
// STOPPED cells too (the bot row is on disk), and the owner email for the spawn
// comes from the cell's session-ownership column (fallback: an email-shaped
// binding key). Results are cached — positive for minutes, negative for
// seconds — so conversational webhook rates never rescan, and a bot created a
// moment ago is found on the next retry.
//
// A second address rides the same scan: fd-bot's subscriber envelope carries a
// `bindingId` (not our bot id), so `/api/bots/events` resolves by
// `bots.fd_bot_binding_id` instead — see resolveByBinding.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 10_000;
// Cell roots are the 16-hex userId dir names the spawner mints (userIdFor).
const CELL_DIR = /^[0-9a-f]{16}$/;

export function createBotWebhookRouter({ dataRoot, openDb, registryDb = null }) {
  // The registry knows which USER owns which cell — exact, and independent of
  // whatever sign-in history a cell's session rows happen to carry. It is the
  // authority the registry exists for; the session inference below is only a
  // fallback for cells that predate the registry.
  const registryOwners = new Map(); // cellId → owner_email
  let registryRead = false;
  function ownerFromRegistry(cellId) {
    if (!registryRead) {
      registryRead = true;
      try {
        const db = openDb(path.join(dataRoot, "cells-registry.db"));
        try {
          for (const row of db.prepare("SELECT cell_id, owner_email FROM cell_registry WHERE owner_email IS NOT NULL").all()) {
            registryOwners.set(row.cell_id, row.owner_email);
          }
        } finally {
          try {
            db.close();
          } catch {
            /* already closed */
          }
        }
      } catch {
        /* no registry on this deployment: fall through to inference */
      }
    }
    return registryOwners.get(cellId) ?? null;
  }

  function ownerEmailOf(db) {
    const session = db
      .prepare("SELECT owner FROM chat_sessions WHERE owner IS NOT NULL LIMIT 1")
      .get();
    if (session?.owner) return session.owner;
    // A cell whose sessions are all pre-ownership rows: the reserved binding
    // keys under user.<email>.* still name the owner.
    const binding = db
      .prepare("SELECT key FROM user_preferences WHERE key LIKE 'user.%' LIMIT 1")
      .get();
    const email = /^user\.([^@]+@[^@]+)\./.exec(binding?.key ?? "")?.[1];
    return email ?? null;
  }

  // One scan, two addresses. `id` is the legacy webhook's path segment;
  // `fd_bot_binding_id` is what fd-bot's envelope carries (adopt-fd-bot-transport
  // 6.1) — the row stores it when the binding is created, so it is a lookup, not
  // a derivation (two bots may share a platform).
  function scan(cache, key, sql) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < (hit.email ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) return hit;
    let entry = { email: null, userId: null, at: now };
    let dirs;
    try {
      dirs = readdirSync(dataRoot);
    } catch {
      cache.set(key, entry);
      return entry;
    }
    for (const dir of dirs) {
      if (!CELL_DIR.test(dir)) continue;
      const dbPath = path.join(dataRoot, dir, "data", "data", "app.db");
      if (!existsSync(dbPath)) continue;
      let db;
      try {
        db = openDb(dbPath);
      } catch {
        continue; // locked or foreign file: not ours to read
      }
      try {
        const bot = db.prepare(sql).get(key);
        if (!bot) continue;
        // Creator identity first (fix-gateway-bot-owner): the row records who
        // created the bot, which is exact even on cells with mixed sign-in
        // history. Next the registry's owner of THIS cell. Session inference is
        // the legacy-row fallback — it picks the first session owner, which on
        // a mixed cell is a DIFFERENT person (fd-prod: a legacy bot's webhook
        // was routed to another user's cell and refused as "unknown").
        const email = bot.owner_email || ownerFromRegistry(dir) || ownerEmailOf(db);
        if (!email) continue; // a bot without a resolvable owner is unrouteable
        entry = { email, userId: dir, at: now };
        break;
      } catch {
        // Schema drift on ONE cell must not break routing for the rest.
      } finally {
        try {
          db.close();
        } catch {
          /* already closed */
        }
      }
    }
    cache.set(key, entry);
    return entry;
  }

  // Separate caches: a bot id and a binding id are different key spaces (and an
  // id can only ever collide by accident), so a hit in one must never answer
  // for the other.
  const byBotId = new Map(); // botId → { email, userId, at } (email null = miss)
  const byBinding = new Map(); // fd_bot_binding_id → same shape
  const byWebsite = new Map(); // website token → same shape

  // One scan at a time (harden-cell-isolation 2.1): the fallback still exists
  // for deployments with no registry/index, but concurrent anonymous requests
  // must not queue N full scans on the single event loop.
  let scanChain = Promise.resolve();
  function serializedScan(cache, key, sql) {
    const run = scanChain.then(() => scan(cache, key, sql));
    scanChain = run.catch(() => {});
    return run;
  }

  // One-time population for rows that predate the index. After it, EVERY
  // resolution is a single query — an unknown id is refused before any cell
  // database is opened (the anonymous-DoS fix). The sentinel makes "populated"
  // distinguishable from "no bots exist yet" so an empty deployment scans once,
  // not on every miss.
  const INDEX_READY_KEY = "__index_ready__";
  let indexPopulate = null;
  function ensureIndexed() {
    if (!registryDb || typeof registryDb.botIndexCount !== "function") return null;
    if (registryDb.botIndexCount() > 0) return null;
    indexPopulate ??= (async () => {
      let dirs = [];
      try {
        dirs = readdirSync(dataRoot);
      } catch {
        return;
      }
      for (const dir of dirs) {
        if (!CELL_DIR.test(dir)) continue;
        const dbPath = path.join(dataRoot, dir, "data", "data", "app.db");
        if (!existsSync(dbPath)) continue;
        let db;
        try {
          db = openDb(dbPath);
        } catch {
          continue;
        }
        try {
          // `*`: an older cell may lack fd_bot_binding_id/credentials columns;
          // missing fields are simply absent from the row, not a scan failure.
          const rows = db.prepare("SELECT * FROM bots").all();
          for (const row of rows) {
            const email = row.owner_email || ownerFromRegistry(dir) || ownerEmailOf(db);
            if (row.id) registryDb.botIndexPut({ key: row.id, kind: "bot", cellId: dir, ownerEmail: email });
            if (row.fd_bot_binding_id) registryDb.botIndexPut({ key: row.fd_bot_binding_id, kind: "binding", cellId: dir, ownerEmail: email });
            if (row.type === "chatwoot") {
              try {
                const token = JSON.parse(row.credentials || "{}")?.websiteToken;
                if (token) registryDb.botIndexPut({ key: token, kind: "website", cellId: dir, ownerEmail: email });
              } catch { /* unreadable credentials: that key just stays unindexed */ }
            }
          }
        } catch {
          // Schema drift on ONE cell must not stop the index for the rest.
        } finally {
          try {
            db.close();
          } catch {
            /* already closed */
          }
        }
      }
      registryDb.botIndexPut({ key: INDEX_READY_KEY, kind: "meta", cellId: "", ownerEmail: null });
    })().catch((e) => console.warn(`[gateway] bot index populate failed: ${e?.message || e}`));
    return indexPopulate;
  }

  async function lookup(cache, key, kind, sql) {
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < (hit.email ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) return hit;
    if (registryDb && typeof registryDb.botIndexGet === "function") {
      try {
        const pending = ensureIndexed();
        if (pending) await pending;
        const row = key === INDEX_READY_KEY ? null : registryDb.botIndexGet(key);
        const entry = row
          ? { email: row.ownerEmail || ownerFromRegistry(row.cellId), userId: row.cellId, at: now }
          : { email: null, userId: null, at: now };
        cache.set(key, entry);
        return entry;
      } catch {
        /* index unusable: fall through to the scan */
      }
    }
    const entry = await serializedScan(cache, key, sql);
    // Backfill: a registry without an index table still learns one hit at a time.
    if (registryDb && entry.userId && typeof registryDb.botIndexPut === "function") {
      try {
        registryDb.botIndexPut({ key, kind, cellId: entry.userId, ownerEmail: entry.email });
      } catch {
        /* best-effort backfill */
      }
    }
    return entry;
  }

  return {
    resolve: (botId) =>
      lookup(byBotId, botId, "bot", "SELECT id, owner_email FROM bots WHERE id = ?"),
    // fd-bot's envelope names the binding, never our bot id (the binding is
    // created on fd-bot's side; we store what it returns on the row).
    resolveByBinding: (bindingId) =>
      lookup(byBinding, bindingId, "binding", "SELECT id, owner_email FROM bots WHERE fd_bot_binding_id = ?"),
    // The visitor-identity door (chatwoot-ai-handoff 5.x) is addressed by the
    // widget's website token, because that is the only id the anonymous
    // browser knows. It is stored in the bot's credentials JSON, so the SQL
    // matches on that column rather than a dedicated one.
    resolveByWebsiteToken: (websiteToken) =>
      lookup(byWebsite, websiteToken, "website",
        "SELECT id, owner_email FROM bots WHERE type = 'chatwoot' AND json_extract(credentials, '$.websiteToken') = ?"),
  };
}
