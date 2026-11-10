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

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const POSITIVE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 10_000;
// Cell roots are the 16-hex userId dir names the spawner mints (userIdFor).
const CELL_DIR = /^[0-9a-f]{16}$/;

export function createBotWebhookRouter({ dataRoot, openDb }) {
  const cache = new Map(); // botId → { email, userId, at } (email null = miss)

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

  function resolve(botId) {
    const now = Date.now();
    const hit = cache.get(botId);
    if (hit && now - hit.at < (hit.email ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)) return hit;
    let entry = { email: null, userId: null, at: now };
    let dirs;
    try {
      dirs = readdirSync(dataRoot);
    } catch {
      cache.set(botId, entry);
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
        const bot = db.prepare("SELECT id, owner_email FROM bots WHERE id = ?").get(botId);
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
    cache.set(botId, entry);
    return entry;
  }

  return { resolve };
}
