#!/usr/bin/env node
// ── Broadcast acceptance, in-cluster (add-broadcast-and-notification-inbox §6) ─
//
// Runs INSIDE the platform pod (it needs the gateway's ledger, the cell roots
// and the deployment's Logto M2M credentials). Two modes:
//
//   node scripts/accept-broadcast.mjs check
//       Read-only. Exercises the real audience resolver against live Logto
//       (tasks 6.1's "hit count matches the org's member count") and reports
//       the ledger's state. Safe to run any time.
//
//   node scripts/accept-broadcast.mjs send --org <name> [--title T] [--body B]
//       Issues ONE real broadcast through the same center the route uses, then
//       prints the id/seq so the pull + wake state can be watched.
//
// Deliverability of the mail itself is proven separately (P4 was verified with a
// real send); this script proves the PLATFORM half — identity expansion, ledger,
// cursor, and the inbox row on the owning cell.

import path from "node:path";
import Database from "better-sqlite3";
import { openBroadcastCenter } from "../gateway/broadcast-center.js";
import { createRoleStore } from "../gateway/roles.js";
import { smtpConfigFromEnv } from "../lib/mailer.js";

const DATA_ROOT = path.resolve(process.env.CELL_DATA_ROOT || "/data/cells");
const env = process.env;

function roleStore() {
  return createRoleStore({ file: path.join(DATA_ROOT, "roles.json"), env });
}

function center() {
  const c = openBroadcastCenter({ dataRoot: DATA_ROOT, roleStore: roleStore(), env });
  if (!c) throw new Error(`broadcast ledger unavailable under ${DATA_ROOT}`);
  return c;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function check() {
  const out = { ledger: null, logto: null, smtp: null, roles: null, cursors: [] };
  const c = center();
  out.logto = { configured: c.logto.configured() };
  out.smtp = { configured: smtpConfigFromEnv(env).configured };

  if (c.logto.configured()) {
    try {
      const all = await c.logto.allUserEmails();
      out.logto.users = all.length;
      const orgs = await c.logto.resolveOrgId("lex-customers").then(
        (id) => ({ "lex-customers": id }),
        (e) => ({ error: e.message }),
      );
      out.logto.orgResolve = orgs;
      if (orgs["lex-customers"]) {
        out.logto.lexMembers = (await c.logto.usersInOrg("lex-customers")).length;
        out.logto.wireMembers = (await c.logto.usersInOrg("wire-customers")).length;
      }
    } catch (err) {
      out.logto.error = err.message;
    }
  }

  const store = roleStore();
  out.roles = store.list().length;

  out.ledger = {
    broadcasts: c.db.prepare("SELECT count(*) AS c FROM broadcasts").get().c,
    receipts: c.db.prepare("SELECT count(*) AS c FROM broadcast_receipts").get().c,
    recent: c.ledger.pendingSince(0, 5),
  };

  // Per-cell cursor + inbox depth. The cursor lives in each cell's own db.
  try {
    for (const row of c.db.prepare("SELECT 1").all()) void row; // keep the handle warm
    const fs = await import("node:fs");
    for (const entry of fs.readdirSync(DATA_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dbPath = path.join(DATA_ROOT, entry.name, "data", "data", "app.db");
      if (!fs.existsSync(dbPath)) continue;
      try {
        const db = new Database(dbPath, { readonly: true });
        const cursor = db.prepare("SELECT value FROM deployment_config WHERE key = 'broadcast.cursor'").get()?.value ?? "0";
        const notifs = db.prepare("SELECT count(*) AS c FROM notifications").get().c;
        const unread = db.prepare("SELECT count(*) AS c FROM notifications WHERE state='unread'").get().c;
        db.close();
        if (Number(cursor) > 0 || notifs > 0) out.cursors.push({ cell: entry.name, cursor: Number(cursor), notifications: notifs, unread });
      } catch (err) {
        out.cursors.push({ cell: entry.name, error: err.message });
      }
    }
  } catch (err) {
    out.cursors.push({ error: err.message });
  }

  console.log(JSON.stringify(out, null, 2));
}

async function send() {
  const c = center();
  const org = arg("org");
  const audience = org ? { kind: "org", id: org } : null;
  if (!audience) throw new Error("--org <name> is required (this script never defaults to `all`)");
  const title = arg("title", "广播通道验收");
  const body = arg("body", "这条广播用于验证受众展开、账本、游标与收件箱投递。可以忽略。");
  const wake = arg("wake", "none");

  const resolved = await c.resolveAudience(audience);
  const record = c.ledger.recordBroadcast({
    actor: arg("actor", "acceptance@script"),
    audience,
    title,
    body,
    hitCount: resolved.recipients.length,
    recipients: resolved.recipients,
    wake,
  });
  console.log(
    JSON.stringify(
      {
        id: record.id,
        seq: record.seq,
        hitCount: resolved.recipients.length,
        recipients: resolved.recipients,
        wake,
        next: "wait one pull interval (BROADCAST_PULL_MS, default 60s), then run `check` and look at cursors[]",
      },
      null,
      2,
    ),
  );
}

const mode = process.argv[2];
try {
  if (mode === "check") await check();
  else if (mode === "send") await send();
  else {
    console.error("usage: accept-broadcast.mjs check | send --org <name> [--title T] [--body B] [--wake none|batch|immediate]");
    process.exit(2);
  }
} catch (err) {
  console.error("FAILED:", err?.message || err);
  process.exit(1);
}
