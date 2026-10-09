// ── Pack registry (openspec: add-pack-marketplace) ───────────────────────────
//
// The gateway's persistence + validation layer for the pack marketplace:
// identity-gated creators publish versioned, immutable capability packs
// (inline skill bodies + registry-name MCP references + persona-only agent
// entries), and every authenticated user can browse them and subscribe.
// Rows live in a dedicated SQLite file at the gateway data root — the same
// isolation rule as the share registry, for the same reason: a pack must
// outlive and cross cells, so it cannot live inside any one of them.
//
// Version immutability is structural: publishing appends a (pack_id, version)
// row and nothing ever updates one; "unpublish" only sets an unlisted flag.
// Pack ids are gateway-minted random (128 bits) — they carry no author or
// name structure, and display names are not unique, so there is no global
// namespace to contend for.
//
// Publishing is the only mutation gated beyond identity: the route layer
// checks the creator group, this module's validateManifest() enforces the v1
// content boundary (MCP entries are registry-name references only — no
// endpoints; agent entries are persona-only — no baseUrl/model/credentials),
// and createPublishRateLimiter() caps the publish rate per author.

import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import express from "express";
import { PACK_LIMITS, validatePackManifest as validateManifest, validateRhythm, budgetMinutesError, modelIdError } from "../lib/pack-manifest.js";
import { deployToRegistry, setAgentPaused, modelChoiceError, resolveServiceConfig, NOTIFY_CHANNEL_RE, SECRET_NAME_RE, SECRET_LIMITS, maskSecretRef } from "../lib/agent-serving.js";
import { createSub2apiClient } from "../lib/sub2api-admin.js";

// Re-exported for the gateway's own consumers (tests import from here).
export { PACK_LIMITS, validateManifest };

export function createPackRegistry({ file }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS packs (
    id TEXT PRIMARY KEY,
    author_email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    unlisted INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'public'
  )`);
  // add-agent-platform-ops: visibility on pre-existing databases.
  try {
    db.exec(`ALTER TABLE packs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
  } catch { /* column already present */ }
  db.exec(`CREATE TABLE IF NOT EXISTS pack_versions (
    pack_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    manifest TEXT NOT NULL,
    author_email TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, version)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
    pack_id TEXT NOT NULL,
    email TEXT NOT NULL,
    version INTEGER NOT NULL,
    subscribed_at INTEGER NOT NULL,
    unsubscribed_at INTEGER,
    PRIMARY KEY (pack_id, email)
  )`);
  // Agent-service deployments (add-a2a-agent-serving 3.3): bookkeeping only —
  // the runner pulls the bundle from the registry; this table answers "which
  // of this pack's roles are deployed" for the unpublish warning and the
  // deploy button's status. One row per (pack, agent); upgrades upsert.
  db.exec(`CREATE TABLE IF NOT EXISTS pack_deployments (
    pack_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    agent_path TEXT NOT NULL,
    skill_paths TEXT NOT NULL DEFAULT '[]',
    deployed_by TEXT NOT NULL,
    deployed_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, agent_id)
  )`);

  // Platform billing (add-agent-platform-ops D1/D2; revised by
  // revise-billing-key-acquisition): the deployer→sub2api account mapping is
  // identity + account id only — the legacy password column is kept for
  // schema compatibility but never written or read. Per-agent metered keys
  // store the value ONCE (sub2api keeps only a hash); the runner fetches
  // values by reference.
  db.exec(`CREATE TABLE IF NOT EXISTS sub2api_accounts (
    email TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    password TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS deployment_keys (
    pack_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    key_ref TEXT NOT NULL,
    key_value TEXT NOT NULL,
    deployer TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, agent_id)
  )`);
  // Deployment secrets (add-deployment-secrets D2): the deployment_keys trust
  // model generalized to arbitrary named values — the value is stored once,
  // the descriptor carries only the opaque ws_ reference, and the runner
  // fetches values over the authenticated internal route. One row per
  // (pack, agent, name); a re-paste replaces the row under a fresh reference.
  db.exec(`CREATE TABLE IF NOT EXISTS deployment_secrets (
    pack_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    secret_ref TEXT NOT NULL,
    secret_value TEXT NOT NULL,
    deployer TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, agent_id, name)
  )`);
  // Host-allowance settlements (wanxing add-agent-chat-lane D5): one row per
  // settled chat usage id — the packs-side idempotency record so a replayed
  // host-settle call never deducts twice. The deduction itself is also
  // idempotency-keyed upstream (sub2api); this row is the local fast-path
  // check and the audit of what was charged for whom.
  db.exec(`CREATE TABLE IF NOT EXISTS pack_host_settlements (
    usage_id TEXT PRIMARY KEY,
    agent_path TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    amount_usd REAL NOT NULL,
    deployer TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  const now = () => Date.now();
  const mintId = () => randomBytes(16).toString("base64url");

  const versionRow = (packId, version) =>
    db.prepare(`SELECT * FROM pack_versions WHERE pack_id = ? AND version = ?`).get(packId, version) ?? null;

  const latestVersionRow = (packId) =>
    db.prepare(`SELECT * FROM pack_versions WHERE pack_id = ? ORDER BY version DESC LIMIT 1`).get(packId) ?? null;

  const packRow = (packId) => db.prepare(`SELECT * FROM packs WHERE id = ?`).get(packId) ?? null;

  function summaryOf(pack, version) {
    return {
      id: pack.id,
      authorEmail: pack.author_email,
      createdAt: pack.created_at,
      version: version.version,
      name: version.name,
      description: version.description,
      tags: JSON.parse(version.tags || "[]"),
      publishedAt: version.published_at,
      unlisted: Boolean(pack.unlisted),
      visibility: pack.visibility === "private" ? "private" : "public",
    };
  }

  // Private packs are owner-scoped (openspec: pack-visibility): invisible to
  // everyone but the author and admins, with the same not-found answer a
  // nonexistent pack gives — probing teaches nothing. Closure-level so the
  // composite read below uses the same definition as everything else.
  function visibleTo(pack, user, { admin = false } = {}) {
    if (!pack) return false;
    if (pack.visibility !== "private") return true;
    return !!user && (pack.author_email === user.email || admin === true);
  }

  // Stored versions are always retrievable — "immutable" includes the unlisted
  // state (spec: every stored version SHALL remain retrievable). Only the
  // listing and latest-version detail hide unlisted packs.
  function getVersion(id, version) {
    const pack = packRow(id);
    if (!pack) return null;
    const row = versionRow(id, Number(version));
    if (!row) return null;
    return { id, version: row.version, manifest: JSON.parse(row.manifest) };
  }

  return {
    packRowPublic: packRow,

    visibleTo,

    // First publish: mint an id and store version 1.
    publish({ email, manifest }) {
      const id = mintId();
      const visibility = manifest.visibility === "private" ? "private" : "public";
      db.prepare(`INSERT INTO packs (id, author_email, created_at, visibility) VALUES (?, ?, ?, ?)`).run(id, email, now(), visibility);
      db.prepare(
        `INSERT INTO pack_versions (pack_id, version, name, description, tags, manifest, author_email, published_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      ).run(id, manifest.name, manifest.description || "", JSON.stringify(manifest.tags ?? []), JSON.stringify(manifest), email, now());
      return { id, version: 1 };
    },

    // Subsequent publish: author-checked append of the next version. Stored
    // versions are immutable — this is the only write path that touches one.
    publishVersion({ email, id, manifest }) {
      const pack = packRow(id);
      if (!pack) return { error: "not_found" };
      if (pack.author_email !== email) return { error: "forbidden" };
      // Visibility is a PACK-level attribute (owner-scoped everywhere); a
      // version cannot flip it — publish a new pack to change exposure.
      const latest = latestVersionRow(id);
      const version = (latest?.version ?? 0) + 1;
      db.prepare(
        `INSERT INTO pack_versions (pack_id, version, name, description, tags, manifest, author_email, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, version, manifest.name, manifest.description || "", JSON.stringify(manifest.tags ?? []), JSON.stringify(manifest), email, now());
      return { id, version };
    },

    // Latest-version detail. `includeUnlisted` is the route's call: an
    // unlisted pack stays visible to its author and active subscribers.
    get(id, { includeUnlisted = false } = {}) {
      const pack = packRow(id);
      if (!pack) return null;
      if (pack.unlisted && !includeUnlisted) return null;
      const version = latestVersionRow(id);
      if (!version) return null;
      return { ...summaryOf(pack, version), manifest: JSON.parse(version.manifest) };
    },

    // Stored versions are always retrievable — "immutable" includes the
    // unlisted state (spec: every stored version SHALL remain retrievable).
    // Only the listing and latest-version detail hide unlisted packs.
    getVersion,

    // Visibility-filtered stored-version read: the facet/HTTP route below and
    // the cell-side install fetch (pack-install-server-side-manifest, single-
    // process deployments) both resolve through this — one definition, so the
    // server-side install answers exactly like the market surface (private
    // packs are not-found to everyone but the author and admins).
    getVersionVisible(id, version, user, { admin = false } = {}) {
      const row = getVersion(id, version);
      if (!row) return null;
      if (!visibleTo(packRow(id), user, { admin })) return null;
      return row;
    },

    // Paginated listing of live (not unlisted) packs, newest publish first.
    // `search` matches name/description substrings; `tag` matches a tag
    // exactly (stored as a JSON array, matched textually for v1 volumes).
    list({ search = "", tag = "", page = 1, pageSize = 50, viewer = null } = {}) {
      const size = Math.min(Math.max(1, Number(pageSize) || 50), 100);
      const pageNum = Math.max(1, Number(page) || 1);
      const where = ["p.unlisted = 0"];
      const params = [];
      // Private packs: owner sees their own; nobody else's (admin listing goes
      // through the same clause — pass viewer with admin flag from the route).
      if (viewer?.admin) {
        where.push("1 = 1");
      } else {
        where.push("(p.visibility IS NULL OR p.visibility != 'private' OR p.author_email = ?)");
        params.push(String(viewer?.email ?? ""));
      }
      if (search) {
        where.push(`(v.name LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\')`);
        const pat = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        params.push(pat, pat);
      }
      if (tag) {
        where.push(`v.tags LIKE ? ESCAPE '\\'`);
        params.push(`%"${tag.replace(/[\\%_"]/g, (c) => `\\${c}`)}"%`);
      }
      const whereSql = where.join(" AND ");
      const total = db.prepare(
        `SELECT COUNT(*) AS n FROM packs p JOIN pack_versions v
           ON v.pack_id = p.id AND v.version = (SELECT MAX(version) FROM pack_versions WHERE pack_id = p.id)
         WHERE ${whereSql}`,
      ).get(...params).n;
      const rows = db.prepare(
        `SELECT p.*, v.version, v.name, v.description, v.tags, v.published_at FROM packs p JOIN pack_versions v
           ON v.pack_id = p.id AND v.version = (SELECT MAX(version) FROM pack_versions WHERE pack_id = p.id)
         WHERE ${whereSql}
         ORDER BY v.published_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, size, (pageNum - 1) * size);
      return {
        total,
        page: pageNum,
        pageSize: size,
        packs: rows.map((r) => summaryOf(r, r)),
      };
    },

    // Author-checked unlist. Versions and subscriptions are untouched.
    setUnlisted({ email, id }) {
      const pack = packRow(id);
      if (!pack) return false;
      if (pack.author_email !== email) return false;
      db.prepare(`UPDATE packs SET unlisted = 1 WHERE id = ?`).run(id);
      return true;
    },

    // Subscribe records the latest version at subscribe time. Resubscribing
    // (re)records it — the cell's own installed-pack state remains the
    // operational truth for what is materialized there.
    subscribe({ email, id }) {
      const pack = packRow(id);
      if (!pack || pack.unlisted) return null;
      const version = latestVersionRow(id);
      if (!version) return null;
      db.prepare(
        `INSERT INTO subscriptions (pack_id, email, version, subscribed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (pack_id, email) DO UPDATE SET version = excluded.version, subscribed_at = excluded.subscribed_at, unsubscribed_at = NULL`,
      ).run(id, email, version.version, now());
      return { version: version.version, manifest: JSON.parse(version.manifest) };
    },

    unsubscribe({ email, id }) {
      const r = db.prepare(
        `UPDATE subscriptions SET unsubscribed_at = ? WHERE pack_id = ? AND email = ? AND unsubscribed_at IS NULL`,
      ).run(now(), id, email);
      return r.changes > 0;
    },

    subscription(email, id) {
      return db.prepare(
        `SELECT * FROM subscriptions WHERE pack_id = ? AND email = ? AND unsubscribed_at IS NULL`,
      ).get(id, email) ?? null;
    },

    subscriberCount(id) {
      return db.prepare(
        `SELECT COUNT(*) AS n FROM subscriptions WHERE pack_id = ? AND unsubscribed_at IS NULL`,
      ).get(id).n;
    },

    authorEmail(id) {
      return packRow(id)?.author_email ?? null;
    },

    // ── Agent-service deployments (add-a2a-agent-serving 3.3) ────────────────
    // Bookkeeping only: the registry holds the deployed truth (agent entries);
    // these rows answer "which roles of this pack are deployed" for the
    // unpublish warning and the deploy button's status. Upsert keeps one row
    // per (pack, agent) across in-place upgrades.
    recordDeployment({ packId, agentId, version, agentPath, skillPaths, email }) {
      db.prepare(
        `INSERT INTO pack_deployments (pack_id, agent_id, version, agent_path, skill_paths, deployed_by, deployed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pack_id, agent_id) DO UPDATE SET
           version = excluded.version, agent_path = excluded.agent_path,
           skill_paths = excluded.skill_paths, deployed_by = excluded.deployed_by,
           deployed_at = excluded.deployed_at`,
      ).run(packId, agentId, Number(version), agentPath, JSON.stringify(skillPaths ?? []), email, now());
    },

    deployments(id) {
      return db.prepare(`SELECT * FROM pack_deployments WHERE pack_id = ? ORDER BY agent_id`).all(id)
        .map((r) => ({
          agentId: r.agent_id,
          version: r.version,
          agentPath: r.agent_path,
          skills: JSON.parse(r.skill_paths || "[]"),
          deployedBy: r.deployed_by,
          deployedAt: r.deployed_at,
        }));
    },
    // Every deployment across packs (add-wanxing-serving-api): the facade's
    // agent-slug lookup scans the full set — slug resolution is global, not
    // per-pack.
    allDeployments() {
      return db.prepare(`SELECT * FROM pack_deployments ORDER BY pack_id, agent_id`).all()
        .map((r) => ({
          packId: r.pack_id,
          agentId: r.agent_id,
          version: r.version,
          agentPath: r.agent_path,
          skills: JSON.parse(r.skill_paths || "[]"),
          deployedBy: r.deployed_by,
          deployedAt: r.deployed_at,
        }));
    },
    // ── Platform billing bookkeeping (add-agent-platform-ops) ─────────────
    billingAccount(email) {
      return db.prepare(`SELECT * FROM sub2api_accounts WHERE email = ?`).get(email) ?? null;
    },
    saveBillingAccount({ email, userId }) {
      db.prepare(
        `INSERT INTO sub2api_accounts (email, user_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id`,
      ).run(email, userId, Date.now());
    },
    recordDeploymentKey({ packId, agentId, keyRef, keyValue, deployer }) {
      // keyRef normalizes to string: sub2api ids arrive as numbers, route
      // params as strings — one canonical form or lookups miss.
      db.prepare(
        `INSERT INTO deployment_keys (pack_id, agent_id, key_ref, key_value, deployer, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pack_id, agent_id) DO UPDATE SET key_ref = excluded.key_ref,
           key_value = excluded.key_value, deployer = excluded.deployer`,
      ).run(packId, agentId, String(keyRef), keyValue, deployer, Date.now());
    },
    deploymentKeyByRef(keyRef) {
      const r = db.prepare(`SELECT * FROM deployment_keys WHERE key_ref = ?`).get(String(keyRef));
      return r ? { agentId: r.agent_id, packId: r.pack_id, keyValue: r.key_value, deployer: r.deployer } : null;
    },
    // The pack's full binding set (paste-flow lifecycle bookkeeping): the
    // deploy route keeps, replaces, and drops entries against this snapshot.
    deploymentKeysForPack(packId) {
      return db.prepare(`SELECT pack_id, agent_id, key_ref, key_value, deployer FROM deployment_keys WHERE pack_id = ?`).all(packId)
        .map((r) => ({ packId: r.pack_id, agentId: r.agent_id, keyRef: r.key_ref, keyValue: r.key_value, deployer: r.deployer }));
    },
    deleteDeploymentKey(packId, agentId) {
      db.prepare(`DELETE FROM deployment_keys WHERE pack_id = ? AND agent_id = ?`).run(packId, agentId);
    },
    listDeploymentKeys() {
      return db.prepare(`SELECT pack_id, agent_id, key_ref, deployer, created_at FROM deployment_keys`).all()
        .map((r) => ({ packId: r.pack_id, agentId: r.agent_id, keyRef: r.key_ref, deployer: r.deployer, createdAt: r.created_at }));
    },
    deploymentKeyForAgent(packId, agentId) {
      const r = db.prepare(`SELECT * FROM deployment_keys WHERE pack_id = ? AND agent_id = ?`).get(packId, agentId);
      return r ? { keyRef: r.key_ref, keyValue: r.key_value, deployer: r.deployer } : null;
    },
    hostSettlement(usageId) {
      return db.prepare(`SELECT * FROM pack_host_settlements WHERE usage_id = ?`).get(String(usageId)) ?? null;
    },
    recordHostSettlement({ usageId, agentPath, minutes, amountUsd, deployer }) {
      db.prepare(
        `INSERT INTO pack_host_settlements (usage_id, agent_path, minutes, amount_usd, deployer, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(String(usageId), agentPath, minutes, amountUsd, deployer, Date.now());
    },

    // ── Deployment secrets (add-deployment-secrets D2/D5) ────────────────────
    // Same discipline as deployment_keys: the value is written once, the
    // descriptor carries only the reference, the runner fetches the value
    // over the authenticated internal route. Re-pasting a name mints a fresh
    // reference (rotating the old one out of the descriptor on redeploy).
    recordDeploymentSecret({ packId, agentId, name, secretRef, secretValue, deployer }) {
      db.prepare(
        `INSERT INTO deployment_secrets (pack_id, agent_id, name, secret_ref, secret_value, deployer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pack_id, agent_id, name) DO UPDATE SET secret_ref = excluded.secret_ref,
           secret_value = excluded.secret_value, deployer = excluded.deployer`,
      ).run(packId, agentId, name, secretRef, secretValue, deployer, Date.now());
    },
    deleteDeploymentSecret(packId, agentId, name) {
      db.prepare(`DELETE FROM deployment_secrets WHERE pack_id = ? AND agent_id = ? AND name = ?`).run(packId, agentId, name);
    },
    // The pack's full binding set (lifecycle bookkeeping): the deploy route
    // keeps, replaces, and drops entries against this snapshot. Values stay
    // on this side — callers only ever surface names (or design-D6 masks).
    deploymentSecretsForPack(packId) {
      return db.prepare(`SELECT pack_id, agent_id, name, secret_ref, secret_value, deployer FROM deployment_secrets WHERE pack_id = ?`).all(packId)
        .map((r) => ({ packId: r.pack_id, agentId: r.agent_id, name: r.name, secretRef: r.secret_ref, secretValue: r.secret_value, deployer: r.deployer }));
    },
    deploymentSecretByRef(secretRef) {
      const r = db.prepare(`SELECT * FROM deployment_secrets WHERE secret_ref = ?`).get(String(secretRef));
      return r ? { packId: r.pack_id, agentId: r.agent_id, name: r.name, secretRef: r.secret_ref, secretValue: r.secret_value } : null;
    },

    close() {
      db.close();
    },
  };
}

// Per-author fixed-window publish limiter (share.js createRateLimiter
// pattern, keyed by author email instead of remote address).
export function createPublishRateLimiter({ windowMs = 60 * 60_000, max = 10 } = {}) {
  const buckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, b] of buckets) if (b.resetAt <= cutoff) buckets.delete(key);
  }, windowMs).unref();

  return function allow(email) {
    const t = Date.now();
    let b = buckets.get(email);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(email, b);
    }
    b.count += 1;
    return b.count <= max;
  };
}

// ── HTTP surface ─────────────────────────────────────────────────────────────
//
// Every route requires a verified identity (the gateway's resolveUser /
// rejectUnauthenticated — same as the share routes); only publishing adds the
// creator-group gate on top. Registered before the cell-proxy catch-all.

export function registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups,
  adminGroups = [],
  rateMax = 10,
  rateWindowMs = 60 * 60_000,
  jsonLimit = "1mb",
  deployConfig: deployConfigOpt = null,
  // Facet-open read face (add-facet-platform): when true, the three read
  // routes (browse / detail / stored version) answer anonymous callers with
  // a null-identity viewer — public live packs only; private and unlisted
  // stay invisible (visibleTo/get already enforce exactly that). Write
  // routes (publish/subscribe/deploy/unpublish) keep the hard auth gate.
  // The 壹座-embedded mount leaves this off: behind the Logto session the
  // wall costs nothing and the pre-facet spec posture holds there.
  anonymousRead = false,
}) {
  // Agent-serving wiring (3.2): injected config wins (tests), env falls back
  // to the dedicated AGENT_SERVING_* names, then the market-bridge vars —
  // on single-process deployments the registry is the same host either way.
  const deployConfig = () => {
    if (typeof deployConfigOpt === "function") return deployConfigOpt();
    if (deployConfigOpt && typeof deployConfigOpt === "object") return deployConfigOpt;
    return {
      registryUrl: process.env.AGENT_SERVING_REGISTRY_URL || process.env.REGISTRY_URL || "",
      token: process.env.AGENT_SERVING_REGISTRY_TOKEN || process.env.MARKET_REGISTRY_TOKEN || "",
      runnerBaseUrl: process.env.AGENT_SERVING_RUNNER_URL || "",
      packsPublicBase: process.env.AGENT_SERVING_PACKS_URL || process.env.PAAS_BASE_URL || "",
      // Platform billing (add-agent-platform-ops D1): the admin key rides the
      // platform secret; absent ⇒ the linkage degrades (no gate, no keys).
      ...(process.env.SUB2API_ADMIN_KEY
        ? { sub2api: { baseUrl: process.env.SUB2API_BASE_URL || "http://127.0.0.1:32080", adminKey: process.env.SUB2API_ADMIN_KEY } }
        : { sub2api: null }),
    };
  };
  const publishAllowed = createPublishRateLimiter({ windowMs: rateWindowMs, max: rateMax });
  const isCreator = (user) => creatorGroups.some((g) => (user.groups || []).includes(g));
  // The platform emergency stop's gate (add-agent-residency D5): admin groups
  // only — the deployer-facing pause/resume ride the author-or-creator gate.
  const isAdmin = (user) => adminGroups.some((g) => (user.groups || []).includes(g));
  const auth = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    return user;
  };

  // Read-face auth: identity when present, else the anonymous viewer when
  // the facet-open mount allows it. The viewer shape mirrors what the
  // visibility filters expect from a signed-out browser: no email, no
  // groups — visibleTo() shows such a caller public packs only, and the
  // unlisted guard in get() stays shut (includeUnlisted requires author or
  // subscriber, neither of which an empty email can match).
  const authRead = (req) => {
    const user = resolveUser(req);
    if (user) return user;
    return anonymousRead ? { email: "", groups: [] } : null;
  };

  // Publish (first version or next). Body: { packId?, manifest } — packId
  // targets an existing pack (author-checked); omitting it mints a new one.
  app.post("/api/packs", express.json({ limit: jsonLimit }), (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!isCreator(user)) return res.status(403).json({ error: "Creator group required" });
    const manifest = req.body?.manifest;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : null;
    if (!manifest) return res.status(400).json({ error: "manifest required" });
    const errors = validateManifest(manifest);
    if (errors.length > 0) return res.status(400).json({ error: "Invalid manifest", errors });
    // Only publishes that pass validation count against the author's budget —
    // iterating on a manifest must not exhaust it. Invalid attempts store
    // nothing and cost only a pure-function validation.
    if (!publishAllowed(user.email)) return res.status(429).json({ error: "Too many publishes, try again later" });
    const result = packId
      ? registry.publishVersion({ email: user.email, id: packId, manifest })
      : registry.publish({ email: user.email, manifest });
    if (result?.error === "not_found") return res.status(404).json({ error: "Pack not found" });
    if (result?.error === "forbidden") return res.status(403).json({ error: "Only the pack author may publish new versions" });
    res.json(result);
  });

  // Browse: paginated, searchable listing of live packs.
  app.get("/api/packs", (req, res) => {
    const user = authRead(req);
    if (!user) return rejectUnauthenticated(req, res);
    const { search = "", tag = "", page, pageSize } = req.query;
    res.json(registry.list({ search: String(search), tag: String(tag), page, pageSize, viewer: { email: user.email, admin: isAdmin(user) } }));
  });

  // Latest-version detail. An unlisted pack stays visible to its author and
  // active subscribers; the author additionally sees the subscriber count.
  app.get("/api/packs/:id", (req, res) => {
    const user = authRead(req);
    if (!user) return rejectUnauthenticated(req, res);
    const id = req.params.id;
    const isAuthor = registry.authorEmail(id) === user.email;
    const isSubscriber = Boolean(registry.subscription(user.email, id));
    const pack = registry.get(id, { includeUnlisted: isAuthor || isSubscriber });
    // Private packs answer not-found to everyone but the owner and admins —
    // indistinguishable from a nonexistent pack (openspec: pack-visibility).
    if (!pack || !registry.visibleTo({ visibility: pack.visibility, author_email: pack.authorEmail }, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    if (isAuthor) pack.subscriberCount = registry.subscriberCount(id);
    res.json(pack);
  });

  // A stored version is always retrievable, listed or not — but only under
  // the same visibility the listing applies (private ⇒ author/admin only,
  // otherwise not-found).
  app.get("/api/packs/:id/versions/:version", (req, res) => {
    const user = authRead(req);
    if (!user) return rejectUnauthenticated(req, res);
    const v = registry.getVersionVisible(req.params.id, req.params.version, user, { admin: isAdmin(user) });
    if (!v) return res.status(404).json({ error: "Pack version not found" });
    res.json(v);
  });

  // PUBLIC raw SKILL.md per pack skill (add-a2a-agent-serving D3): the
  // registry's skill registration fetches skill_md_url ANONYMOUSLY to
  // validate, so this route serves the body with synthesized frontmatter
  // (name/description from the manifest — pack skills are body-only) to any
  // caller. Pack skill bodies are already shown in full to every market
  // user; anonymous raw-md exposure is the same content, machine-shaped.
  // Registered before the authenticated routes; no auth check by design.
  app.get("/api/packs/:id/versions/:version/skills/:skill", (req, res) => {
    const version = registry.getVersion(req.params.id, req.params.version);
    // The URL always carries .md; normalize so the lookup never sees it (the
    // auth exemption matches on the .md suffix, path-to-regexp keeps it in
    // the param on some versions).
    const wanted = String(req.params.skill).replace(/\.md$/, "");
    const skill = version?.manifest?.skills?.find((s) => s.name === wanted);
    if (!skill) return res.status(404).type("text/plain").send("skill not found");
    const fm = [`---`, `name: ${JSON.stringify(skill.name)}`, `description: ${JSON.stringify(skill.description)}`, `---`, ""].join("\n");
    res.type("text/markdown").send(`${fm}${skill.content}`);
  });

  // Deploy a stored version's serving-contract roles as Agent Services
  // (add-a2a-agent-serving 3.2). Idempotent per (pack, agent): the registry
  // entry is upserted in place and the bookkeeping row follows. Gate: the
  // pack's author or a creator-group member (the same population that may
  // publish). Env (`AGENT_SERVING_*`, falling back to the market vars) or an
  // injected `deployConfig` supplies the registry wiring; a missing runner
  // URL answers 503, not a silent success.
  app.post("/api/packs/:id/versions/:version/deploy", express.json({ limit: "64kb" }), async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const id = req.params.id;
    const isAuthor = registry.authorEmail(id) === user.email;
    // Private packs deploy for their owner (and admins) only — creators-group
    // strangers get the same not-found a nonexistent pack gives.
    const packRowRec = registry.packRowPublic(id);
    if (packRowRec?.visibility === "private" && !registry.visibleTo(packRowRec, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    if (!isAuthor && !isCreator(user)) return res.status(403).json({ error: "Pack author or creator group required" });

    const version = registry.getVersion(id, req.params.version);
    if (!version) return res.status(404).json({ error: "Pack version not found" });

    const cfg = deployConfig();
    if (!cfg.runnerBaseUrl) {
      return res.status(503).json({ error: "Agent serving is not configured on this deployment (AGENT_SERVING_RUNNER_URL)" });
    }
    // Rhythm overrides (add-agent-residency D7): { "<agentId>": entries | null }
    // — deployer-set effective rhythm, validated under the same rules the
    // manifest enforces (one shape definition, two enforcement points).
    const rhythms = req.body?.rhythms;
    if (rhythms !== undefined) {
      if (!rhythms || typeof rhythms !== "object" || Array.isArray(rhythms)) {
        return res.status(400).json({ error: "rhythms must be an object of { agentId: rhythm entries }" });
      }
      for (const [agentId, entries] of Object.entries(rhythms)) {
        if (entries === null) continue; // explicit clear back to none
        const errs = validateRhythm(entries);
        if (errs.length > 0) {
          return res.status(400).json({ error: `rhythm override for '${agentId}' is invalid: ${errs[0].error}` });
        }
      }
    }
    // Turn-budget overrides (add-serving-budgets D2): { "<agentId>": minutes }
    // — the deployer's per-agent ceiling, validated under the same rule the
    // contract declares with. null = clear back to the contract declaration
    // (else absent → the runner's deployment default).
    const budgets = req.body?.budgets;
    if (budgets !== undefined) {
      if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
        return res.status(400).json({ error: "budgets must be an object of { agentId: minutes }" });
      }
      for (const [agentId, minutes] of Object.entries(budgets)) {
        if (minutes === null) continue; // explicit clear back to the contract
        const err = budgetMinutesError(minutes);
        if (err) {
          return res.status(400).json({ error: `budget override for '${agentId}' is invalid: ${err}` });
        }
      }
    }
    // Notification channel bindings (add-agent-notifications D2): { "<agentId>":
    // channel | null } — one admin-pre-bound channel name per serving agent.
    // Shape-validated here (a name the channel table can hold); existence is
    // NOT checked at deploy time — the channel table is live platform data and
    // an unknown/removed channel is refused structurally at send time by the
    // relay. null unbinds explicitly; an omitted agent keeps its live binding
    // (resolved against the registry entry inside deployToRegistry).
    const notifyChannel = req.body?.notifyChannel;
    if (notifyChannel !== undefined) {
      if (!notifyChannel || typeof notifyChannel !== "object" || Array.isArray(notifyChannel)) {
        return res.status(400).json({ error: "notifyChannel must be an object of { agentId: channel | null }" });
      }
      for (const [agentId, channel] of Object.entries(notifyChannel)) {
        if (channel === null) continue; // explicit unbind
        if (typeof channel !== "string" || !NOTIFY_CHANNEL_RE.test(channel)) {
          return res.status(400).json({
            error: `notifyChannel for '${agentId}' is invalid: a channel name matches [a-z0-9][a-z0-9._-]{0,63}`,
          });
        }
      }
    }
    // Model choices (agent-service-config / ADR-0019): { "<agentId>": model |
    // null } — a deploy-time model rides the SAME write-time validation as a
    // later config write (shape here; whitelist + billing lanes below, once
    // the deployment keys resolved). null clears back to the declaration.
    const servingIds = new Set((version.manifest.agents ?? []).filter((a) => a?.serving).map((a) => a.id));
    const models = req.body?.models;
    if (models !== undefined) {
      if (!models || typeof models !== "object" || Array.isArray(models)) {
        return res.status(400).json({ error: "models must map agentId to a model identifier or null" });
      }
      for (const [agentId, model] of Object.entries(models)) {
        if (model === null) continue;
        if (!servingIds.has(agentId)) {
          return res.status(400).json({ error: `models.${agentId}: '${agentId}' is not a serving agent of this pack` });
        }
        const err = modelIdError(model);
        if (err) return res.status(400).json({ error: `models.${agentId}: ${err}` });
        const whitelist = (version.manifest.agents ?? []).find((a) => a.id === agentId)?.serving?.modelWhitelist;
        const wlErr = modelChoiceError({ model, whitelist, lanes: null });
        if (wlErr) return res.status(400).json({ error: `models.${agentId}: ${wlErr}` });
      }
    }
    // ── Platform billing linkage (add-agent-platform-ops D1–D3; revised by
    // revise-billing-key-acquisition) ─────────────────────────────────────
    // Degrades to the pre-③ behavior when no admin key is wired: no gate,
    // no keys — any pasted billingKeys are IGNORED (logged, never silent)
    // and the deploy proceeds on the runner's shared quota.
    // Linked, keys arrive FROM the deployer (paste flow): body.billingKeys
    // maps agentId → "sk-…" (minted by the deployer in their own panel
    // session via Logto SSO) or null (unbind — non-serving agents only).
    // Every serving agent MUST end up bound: no shared-quota fallback. The
    // platform never holds a sub2api password.
    const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
    const panelUrl = process.env.SUB2API_PANEL_URL || "https://your-billing-panel.example";
    let billing = { linked: false };
    let billingKeys = {}; // agentId → pk_ reference (descriptor carries these)
    const billingKeyValues = new Map(); // keyRef → plaintext (never logged)
    const agentKeyValues = new Map(); // agentId → plaintext deployment key (lane checks only)
    const providedKeys = req.body?.billingKeys;
    const keyInvalid = (reason, detail) =>
      res.status(400).json({
        error: `billing key rejected (${reason})${detail ? `: ${detail}` : ""}`,
        code: "BILLING_KEY_INVALID",
        reason,
      });
    if (providedKeys !== undefined && (!providedKeys || typeof providedKeys !== "object" || Array.isArray(providedKeys))) {
      return res.status(400).json({ error: "billingKeys must map agentId to an sk-… key or null" });
    }
    if (sub2api && !sub2api.degraded()) {
      const check = await sub2api.selfCheck();
      if (!check.ok) {
        console.warn(`[packs] sub2api self-check failed — billing degraded: ${check.reason}`);
        if (providedKeys && Object.keys(providedKeys).length > 0) {
          console.warn("[packs] billing degraded — ignoring pasted billingKeys for this deploy");
        }
      } else {
        let account = null;
        try {
          account = await sub2api.findUserByEmail(user.email);
        } catch (err) {
          return res.status(502).json({ error: `billing account check failed: ${err.message}` });
        }
        if (!account) {
          return res.status(402).json({
            error: "no sub2api account for your email yet — sign in once via Logto at the billing panel to create it, then retry",
            code: "NO_SUB2API_ACCOUNT",
            panelUrl,
          });
        }
        registry.saveBillingAccount({ email: user.email, userId: account.userId });
        const floor = Number(process.env.DEPLOY_BALANCE_FLOOR ?? 0.5);
        let balance;
        try {
          balance = (await sub2api.readUser(account.userId)).balance;
        } catch (err) {
          return res.status(502).json({ error: `billing balance read failed: ${err.message}` });
        }
        if (balance <= floor) {
          return res.status(402).json({
            error: `insufficient balance (${balance.toFixed(2)}) — the deploy gate needs more than ${floor}. Recharge path: contact the operator.`,
            code: "INSUFFICIENT_BALANCE",
            balance,
            floor,
          });
        }
        billing = { linked: true, balance, floor };

        // Binding lifecycle (design D3): explicit null unbinds — non-serving
        // agents only, a serving key can only be replaced; omission keeps the
        // existing binding (revalidated below); bindings for agents that no
        // longer serve are dropped with the redeploy.
        const existing = new Map(registry.deploymentKeysForPack(id).map((k) => [k.agentId, k]));
        for (const [agentId, value] of Object.entries(providedKeys ?? {})) {
          if (!servingIds.has(agentId)) {
            if (value === null && existing.has(agentId)) {
              registry.deleteDeploymentKey(id, agentId);
              continue;
            }
            return keyInvalid("unknown-agent", agentId);
          }
          if (value === null) {
            return res.status(400).json({
              error: `billingKeys.${agentId}: a serving agent's key can only be replaced, not removed`,
              code: "BILLING_KEY_REQUIRED",
            });
          }
        }
        for (const agentId of existing.keys()) {
          if (!servingIds.has(agentId)) registry.deleteDeploymentKey(id, agentId);
        }

        // Kept bindings: serving agents absent from this request ride their
        // existing reference into the new descriptor — after a liveness
        // revalidation (below, once the cheap layers passed). A dead kept key
        // refuses the deploy with replace guidance (the paste flow cannot
        // re-deliver an old value: the platform never echoes key values back).
        const kept = new Map();
        for (const agentId of servingIds) {
          if (providedKeys && Object.hasOwn(providedKeys, agentId)) continue;
          const k = existing.get(agentId);
          if (k?.keyValue) kept.set(agentId, k);
        }

        // Pasted keys: shape first (cheap), then duplicates — the network
        // layers (liveness → ownership) run last, each a short-circuit
        // (design D2).
        const pasted = new Map();
        for (const [agentId, key] of Object.entries(providedKeys ?? {})) {
          if (!servingIds.has(agentId) || key === null) continue;
          if (typeof key !== "string" || !/^sk-/.test(key) || key.length > 256) {
            return keyInvalid("shape", `billingKeys.${agentId} must be a sub2api key (sk-…)`);
          }
          pasted.set(agentId, key);
        }
        const seenValues = [...kept.values()].map((k) => k.keyValue);
        for (const key of pasted.values()) {
          if (seenValues.includes(key)) {
            return keyInvalid("duplicate", "one key cannot serve two agents of this pack — create one per agent in the panel");
          }
          seenValues.push(key);
        }

        for (const [agentId, k] of kept) {
          const live = await sub2api.probeKeyLiveness(k.keyValue);
          if (!live.ok) {
            return keyInvalid("liveness", `the bound key for ${agentId} is no longer usable (${live.code ?? live.message}) — paste a fresh key from the billing panel to replace it`);
          }
          billingKeys[agentId] = k.keyRef;
          agentKeyValues.set(agentId, k.keyValue);
        }
        for (const [agentId, key] of pasted) {
          const live = await sub2api.probeKeyLiveness(key);
          if (!live.ok) {
            return keyInvalid("liveness", `the key for ${agentId} was refused by the billing panel (${live.code ?? live.message})`);
          }
          const holder = await sub2api.findUserByKey(key);
          if (!holder || holder.userId !== account.userId) {
            return keyInvalid("ownership", `the key for ${agentId} does not belong to your sub2api account`);
          }
        }
        for (const [agentId, key] of pasted) {
          const ref = `pk_${randomBytes(12).toString("hex")}`;
          billingKeys[agentId] = ref;
          billingKeyValues.set(ref, key);
          agentKeyValues.set(agentId, key);
        }

        // Every serving agent must end up with a key — the paste flow's
        // admission rule, aligned with "the deployer pays for what serves".
        for (const agentId of servingIds) {
          if (billingKeys[agentId] == null) {
            return res.status(400).json({
              error: `agent '${agentId}' is a serving agent and needs a sub2api key — create one in your billing panel (Logto sign-in) and paste it here`,
              code: "BILLING_KEY_REQUIRED",
              panelUrl,
            });
          }
        }

        // Deploy-time model choices ride the SAME lane validation as a later
        // config write (agent-service-config D2): the deployment key's live
        // sub2api group lanes ∩ the contract whitelist — a refusal here means
        // no agent entry ever carries an unauthorized lane (no boot-then-404).
        const requestedModels = Object.entries(models ?? {}).filter(([, m]) => m != null);
        if (requestedModels.length > 0) {
          const lanesByAgent = new Map();
          for (const [agentId, model] of requestedModels) {
            if (!lanesByAgent.has(agentId)) {
              let lanes;
              try {
                lanes = await sub2api.listKeyModels(agentKeyValues.get(agentId));
              } catch (err) {
                return res.status(502).json({ error: `billing lane check failed for '${agentId}': ${err.message}` });
              }
              lanesByAgent.set(agentId, lanes);
            }
            const whitelist = (version.manifest.agents ?? []).find((a) => a.id === agentId)?.serving?.modelWhitelist;
            const err = modelChoiceError({ model, whitelist, lanes: lanesByAgent.get(agentId) });
            if (err) return res.status(400).json({ error: `models.${agentId}: ${err}`, code: "MODEL_LANE_REJECTED" });
          }
        }
      }
    } else if (providedKeys && Object.keys(providedKeys).length > 0) {
      console.warn("[packs] billing not linked — ignoring pasted billingKeys for this deploy");
    }
    // No billing linkage (unlinked, degraded, or failed self-check) = no
    // deployment key = no lanes to validate model choices against — the
    // allowlist route's stance: the inactive plane refuses, never silently
    // passes unvalidated.
    if (!billing.linked && models && Object.values(models).some((m) => m != null)) {
      return res.status(503).json({ error: "billing plane not configured — model lanes cannot be validated" });
    }

    // ── Deployment secrets (add-deployment-secrets D1/D2/D5/D6) ─────────────
    // body.secrets maps agentId → { name: value | null }: arbitrary named
    // values the deployed agent needs at runtime (e.g. a content-repo token).
    // Same pipeline as billing keys — stored ONCE platform-side, an opaque ws_
    // reference rides the descriptor, the runner fetches by reference. Works
    // with or without the billing linkage. Lifecycle: omission keeps, null
    // unbinds one name, non-serving agents' bindings drop with the redeploy.
    const providedSecrets = req.body?.secrets;
    if (providedSecrets !== undefined && (!providedSecrets || typeof providedSecrets !== "object" || Array.isArray(providedSecrets))) {
      return res.status(400).json({ error: "secrets must map agentId to an object of { name: value | null }" });
    }
    const secretInvalid = (reason, detail) =>
      res.status(400).json({
        error: `deployment secret rejected (${reason})${detail ? `: ${detail}` : ""}`,
        code: "SECRET_INVALID",
        reason,
      });
    const secretRefs = {}; // agentId → { name: ref } (descriptor input)
    const secretMinted = []; // rows persisted once the registry push succeeded
    const secretDisplay = {}; // agentId → { name: design-D6 mask } (deploy surface)
    {
      const existing = new Map(); // "agentId\u0000name" → row
      for (const r of registry.deploymentSecretsForPack(id)) existing.set(`${r.agentId}\u0000${r.name}`, r);
      const requested = Object.entries(providedSecrets ?? {});
      for (const [agentId, names] of requested) {
        if (!names || typeof names !== "object" || Array.isArray(names)) {
          return secretInvalid("shape", `secrets.${agentId} must be an object of { name: value | null }`);
        }
        for (const [name, value] of Object.entries(names)) {
          const where = `secrets.${agentId}.${name}`;
          if (!SECRET_NAME_RE.test(name)) return secretInvalid("name", `${where}: a secret name is [a-z0-9_]{1,32}`);
          if (value === null) {
            // A null aimed at a non-serving agent is cleanup only when a
            // binding exists; anything else aimed at a non-serving agent
            // refuses (the same rule billing keys follow).
            if (!servingIds.has(agentId) && !existing.has(`${agentId}\u0000${name}`)) {
              return secretInvalid("unknown-agent", `${where}: '${agentId}' is not a serving agent and has no such binding`);
            }
            continue;
          }
          if (typeof value !== "string" || value.length === 0) {
            return secretInvalid("shape", `${where} must be a non-empty string or null`);
          }
          if (Buffer.byteLength(value, "utf8") > SECRET_LIMITS.valueBytes) {
            return secretInvalid("size", `${where} exceeds the ${SECRET_LIMITS.valueBytes}-byte bound`);
          }
          if (!servingIds.has(agentId)) return secretInvalid("unknown-agent", `${where}: '${agentId}' is not a serving agent of this pack`);
        }
      }

      // Resulting bindings: kept (serving agents only) − nulled, then values
      // (a re-paste replaces under a fresh reference).
      const bound = new Map(); // agentId → Map(name → { ref, value, minted? })
      const unbound = []; // rows an explicit null takes out of the store
      for (const r of existing.values()) {
        if (!servingIds.has(r.agentId)) continue; // dropped below
        if (!bound.has(r.agentId)) bound.set(r.agentId, new Map());
        bound.get(r.agentId).set(r.name, { ref: r.secretRef, value: r.secretValue });
      }
      for (const [agentId, names] of requested) {
        for (const [name, value] of Object.entries(names)) {
          if (value === null) {
            if (bound.get(agentId)?.delete(name)) unbound.push({ agentId, name });
            continue;
          }
          const ref = `ws_${randomBytes(12).toString("hex")}`;
          if (!bound.has(agentId)) bound.set(agentId, new Map());
          bound.get(agentId).set(name, { ref, value, minted: true });
        }
      }
      // The count bound applies to the RESULTING per-agent set, not the
      // request: four names now and four more later would otherwise slip past.
      for (const [agentId, names] of bound) {
        if (names.size > SECRET_LIMITS.perAgent) {
          return secretInvalid("count", `'${agentId}' would hold ${names.size} secrets — the per-agent bound is ${SECRET_LIMITS.perAgent}`);
        }
      }
      // Store mutations run only once every validation passed. Explicit nulls
      // unbind their names; stale bindings drop with the redeploy (an agent
      // that left the serving set carries no secrets into the new descriptor).
      for (const { agentId, name } of unbound) registry.deleteDeploymentSecret(id, agentId, name);
      for (const r of existing.values()) {
        if (!servingIds.has(r.agentId)) registry.deleteDeploymentSecret(id, r.agentId, r.name);
      }
      for (const [agentId, names] of bound) {
        if (names.size === 0) continue;
        secretRefs[agentId] = {};
        secretDisplay[agentId] = {};
        for (const [name, entry] of names) {
          secretRefs[agentId][name] = entry.ref;
          secretDisplay[agentId][name] = maskSecretRef(entry.ref, entry.value);
          if (entry.minted) secretMinted.push({ agentId, name, ref: entry.ref, value: entry.value });
        }
      }
    }

    // Billing unlinked (or degraded): existing bindings cannot be revalidated,
    // so the descriptors pushed below carry no billing_key_ref for agents that
    // held one — the child silently stops running on its own key. The store
    // rows survive, but nothing else in this request surfaces the loss.
    if (!billing.linked) {
      const orphaned = registry
        .deploymentKeysForPack(id)
        .filter((k) => servingIds.has(k.agentId))
        .map((k) => k.agentId);
      if (orphaned.length > 0) {
        console.warn(
          `[packs] billing unlinked — cannot revalidate key binding(s) for ${orphaned.join(", ")}; this deploy's descriptors carry no billing_key_ref`,
        );
      }
    }

    let out;
    try {
      out = await deployToRegistry({
        packId: id,
        version: version.version,
        manifest: version.manifest,
        rhythmOverrides: rhythms ?? {},
        budgetOverrides: budgets ?? {},
        modelOverrides: models ?? {},
        notifyChannels: notifyChannel ?? {},
        billingKeys,
        secretRefs,
        ...cfg,
      });
    } catch (err) {
      const status = Number.isInteger(err?.status) && err.status >= 400 ? err.status : 502;
      return res.status(status).json({ error: err.message });
    }
    for (const d of out.deployed) {
      registry.recordDeployment({
        packId: id,
        agentId: d.agentId,
        version: version.version,
        agentPath: d.agentPath,
        skillPaths: d.skills,
        email: user.email,
      });
      // Persist the minted key value once the registry push succeeded. The
      // map was built keyed by agent id; missing entry = degraded minting.
      const keyRef = billingKeys[d.agentId];
      if (keyRef != null && billingKeyValues.has(keyRef)) {
        registry.recordDeploymentKey({
          packId: id, agentId: d.agentId, keyRef,
          keyValue: billingKeyValues.get(keyRef),
          deployer: user.email,
        });
      }
    }
    // Minted secret values persist only after the registry push succeeded —
    // the same rule deployment_keys follow. Kept bindings are already rows.
    const deployedIds = new Set(out.deployed.map((d) => d.agentId));
    for (const s of secretMinted) {
      if (!deployedIds.has(s.agentId)) continue;
      registry.recordDeploymentSecret({
        packId: id, agentId: s.agentId, name: s.name,
        secretRef: s.ref, secretValue: s.value,
        deployer: user.email,
      });
    }
    res.json({
      deployed: out.deployed.map((d) => ({
        agentId: d.agentId, agentPath: d.agentPath, skills: d.skills, card: d.card,
        ...(billingKeys[d.agentId] != null ? { billingKeyRef: billingKeys[d.agentId] } : {}),
        // Which secret names are bound rides the deploy surface; the value
        // and the plain reference never do (design D6 masks at most).
        ...(secretDisplay[d.agentId] ? { secretRefs: secretDisplay[d.agentId] } : {}),
      })),
      billing,
      effectiveWithinSecs: out.effectiveWithinSecs,
    });
  });

  // The deployer's own billing state (add-agent-platform-ops D3; revised by
  // revise-billing-key-acquisition): the deploy surface's three-state readout
  // — account unresolved ("none"), resolved with balance ("ok"), or billing
  // unlinked (degraded). The mapping row is a cache: with no row, the
  // directory is consulted live and a hit is persisted for the deploy gate.
  app.get("/api/packs/billing/me", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const cfg = deployConfig();
    const panelUrl = process.env.SUB2API_PANEL_URL || "https://your-billing-panel.example";
    const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
    if (!sub2api || sub2api.degraded()) return res.json({ linked: false, balance: null, accountState: null, panelUrl });
    let account = registry.billingAccount(user.email);
    if (!account) {
      try {
        const found = await sub2api.findUserByEmail(user.email);
        if (found) {
          registry.saveBillingAccount({ email: user.email, userId: found.userId });
          account = registry.billingAccount(user.email);
        }
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }
    }
    if (!account) return res.json({ linked: true, balance: null, accountState: "none", panelUrl });
    try {
      const u = await sub2api.readUser(account.user_id);
      res.json({ linked: true, balance: u.balance, accountState: "ok", panelUrl });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Per-pack key binding state for the deploy surface: which of the pack's
  // currently-serving agents have a bound key. Booleans only — key values
  // and references never leave the platform.
  app.get("/api/packs/:id/billing-bindings", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const pack = registry.get(req.params.id, { includeUnlisted: true });
    if (!pack || !registry.visibleTo({ visibility: pack.visibility, author_email: pack.authorEmail }, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    const bound = new Set(registry.deploymentKeysForPack(req.params.id).map((k) => k.agentId));
    const out = {};
    for (const a of pack.manifest.agents ?? []) {
      if (a?.serving) out[a.id] = bound.has(a.id);
    }
    res.json(out);
  });

  // Per-pack secret binding state for the deploy surface (spec: bindings are
  // visible, values are not): which names are bound per serving agent. Names
  // ONLY — references, values, and masks never leave this route.
  app.get("/api/packs/:id/secret-bindings", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const pack = registry.get(req.params.id, { includeUnlisted: true });
    if (!pack || !registry.visibleTo({ visibility: pack.visibility, author_email: pack.authorEmail }, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    const out = {};
    for (const a of pack.manifest.agents ?? []) {
      if (a?.serving) out[a.id] = [];
    }
    for (const r of registry.deploymentSecretsForPack(req.params.id)) {
      if (out[r.agentId]) out[r.agentId].push(r.name);
    }
    for (const names of Object.values(out)) names.sort();
    res.json(out);
  });

  // Billing board (add-agent-platform-ops D5): one read for the ops console —
  // deployed agents with their key refs, per-deployer balances, and the
  // linkage state. Authenticated like the internal key route (runner service
  // credential) or by an admin user.
  app.get("/api/packs/billing/board", async (req, res) => {
    const cfg = deployConfig();
    const token = cfg?.token || "";
    const asAdmin = (() => {
      const user = resolveUser(req);
      return user && adminGroups.some((g) => (user.groups || []).includes(g));
    })();
    if (!asAdmin && (!token || req.headers.authorization !== `Bearer ${token}`)) {
      return res.status(401).json({ error: "admin or runner service credential required" });
    }
    const keys = registry.listDeploymentKeys();
    let balances = [];
    let degraded = true;
    const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
    if (sub2api && !sub2api.degraded()) {
      try {
        const emails = [...new Set(keys.map((k) => k.deployer))];
        balances = await Promise.all(
          emails.map(async (email) => {
            const acct = registry.billingAccount(email);
            if (!acct) return { email, balance: null };
            const u = await sub2api.readUser(acct.user_id);
            return { email, balance: u.balance, status: u.status };
          }),
        );
        degraded = false;
      } catch (e) {
        console.warn(`[packs] billing board balance read failed: ${e.message}`);
      }
    }
    res.json({ degraded, keys, balances });
  });

  // Internal: the runner fetches a deployed agent's billing key by reference
  // (add-agent-platform-ops D2). Authenticated by the runner's REGISTRY
  // service credential — the same trust plane the runner already uses for
  // packs data; NOT a public predicate. Every fetch is audit-logged.
  app.get("/api/packs/internal/llm-key/:keyRef", (req, res) => {
    const token = deployConfig()?.token || "";
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      return res.status(401).json({ error: "runner service credential required" });
    }
    const rec = registry.deploymentKeyByRef(req.params.keyRef);
    if (!rec || !rec.keyValue) return res.status(404).json({ error: "unknown or unkeyed deployment" });
    console.log(`[packs] llm-key fetched by runner (ref ${req.params.keyRef}, agent ${rec.agentId})`);
    res.json({ keyRef: req.params.keyRef, agentId: rec.agentId, keyValue: rec.keyValue });
  });

  // Internal: the runner fetches ONE deployment secret by reference
  // (add-deployment-secrets D3) — the same service-credential gate and audit
  // shape as the llm-key route above, one request per secret (simple, and the
  // audit stays per-secret). The audit line and every log use the D6 mask;
  // the value exists only in this response body.
  app.get("/api/packs/internal/secret/:ref", (req, res) => {
    const token = deployConfig()?.token || "";
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      return res.status(401).json({ error: "runner service credential required" });
    }
    const rec = registry.deploymentSecretByRef(req.params.ref);
    if (!rec) return res.status(404).json({ error: "unknown secret reference" });
    console.log(`[packs] deployment secret fetched by runner (ref ${maskSecretRef(rec.secretRef, rec.secretValue)}, agent ${rec.agentId}, name ${rec.name})`);
    res.json({ secretRef: rec.secretRef, agentId: rec.agentId, name: rec.name, secretValue: rec.secretValue });
  });

  // Internal: serving-plane deployment lookups (add-facet-platform S0). The
  // 万星 facade reads deployment bookkeeping over these read-only routes
  // instead of process-local registry access — extracting the marketplace
  // into the facet service (S1) repoints the facade's base-URL env and
  // nothing else. Same service-credential gate and shape as llm-key/secret
  // above. Registered BEFORE /api/packs/:id/deployments so the literal
  // "internal" path never falls into the :id capture.
  const internalAuth = (req, res) => {
    const token = deployConfig()?.token || "";
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: "runner service credential required" });
      return false;
    }
    return true;
  };
  app.get("/api/packs/internal/deployments", (req, res) => {
    if (!internalAuth(req, res)) return;
    res.json({ deployments: registry.allDeployments() });
  });
  app.get("/api/packs/internal/deployments/:id", (req, res) => {
    if (!internalAuth(req, res)) return;
    res.json({ deployments: registry.deployments(req.params.id) });
  });
  app.get("/api/packs/internal/author/:id", (req, res) => {
    if (!internalAuth(req, res)) return;
    res.json({ authorEmail: registry.authorEmail(req.params.id) });
  });

  // Internal: deployment-level host settlement (wanxing add-agent-chat-lane
  // D5). The wanxing facade settles chat-lane turns whose settler is the
  // host's allowance here — the deployment's billing key never travels to
  // the facade. Same per-deployment addressing convention as the config
  // twin (packId + agentId, both URL-encoded single segments). Body
  // {usage_id, minutes, rate_usd_per_min?}: minutes are the facade's
  // minute-rounded billable duration; the rate defaults to the facade's own
  // default so both planes stay one env apart. Idempotent by usage_id: a
  // replay answers duplicate without deducting (the upstream deduction is
  // idempotency-keyed the same way, so a crash between the upstream success
  // and the local insert still lands once).
  app.post("/api/packs/internal/deployments/:packId/:agentId/host-settle", express.json({ limit: "4kb" }), async (req, res) => {
    if (!internalAuth(req, res)) return;
    const { usage_id, minutes, rate_usd_per_min } = req.body ?? {};
    if (typeof usage_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(usage_id)) {
      return res.status(400).json({ error: "usage_id must be a short identifier string" });
    }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      return res.status(400).json({ error: "minutes must be an integer in [1, 1440]" });
    }
    const rate = rate_usd_per_min === undefined
      ? Number(process.env.WANXING_RATE_PER_MIN ?? 0.1)
      : Number(rate_usd_per_min);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 10) {
      return res.status(400).json({ error: "rate_usd_per_min must be a positive number ≤ 10" });
    }
    if (registry.hostSettlement(usage_id)) {
      return res.json({ settled: true, duplicate: true });
    }
    const key = registry.deploymentKeyForAgent(decodeURIComponent(req.params.packId), decodeURIComponent(req.params.agentId));
    if (!key) return res.status(404).json({ error: "no such deployment" });
    const sub2api = deployConfig().sub2api ? createSub2apiClient(deployConfig().sub2api) : null;
    if (!sub2api || sub2api.degraded()) {
      return res.status(503).json({ error: "billing plane not configured" });
    }
    const amount = Number((minutes * rate).toFixed(4));
    let holder;
    try {
      holder = await sub2api.findUserByKey(key.keyValue);
    } catch (err) {
      return res.status(502).json({ error: `key holder resolution failed: ${err.message}` });
    }
    if (!holder) return res.status(404).json({ error: "billing key no longer resolves to an account" });
    try {
      await sub2api.adjustBalance({
        userId: holder.userId,
        amountUsd: amount,
        operation: "subtract",
        idempotencyKey: usage_id,
      });
    } catch (err) {
      // A retry whose deduction already landed upstream surfaces as a
      // duplicate refusal — that IS settled, matching the facade's own
      // trySettle semantics; anything else is a retryable failure.
      if (!/duplicate|idempoten/i.test(String(err?.message || ""))) {
        return res.status(502).json({ error: `deduction failed: ${err.message}` });
      }
    }
    try {
      registry.recordHostSettlement({
        usageId: usage_id, agentPath: `/${decodeURIComponent(req.params.packId)}/${decodeURIComponent(req.params.agentId)}`,
        minutes, amountUsd: amount, deployer: key.deployer,
      });
    } catch { /* concurrent twin already inserted — still exactly one deduction */ }
    console.log(`[packs] host-settle ${usage_id}: ${minutes}min $${amount} on ${req.params.packId}/${req.params.agentId} (deployer ${key.deployer})`);
    res.json({ settled: true, duplicate: false, amountUsd: amount });
  });

  // Deployed roles of a pack (3.3): the unpublish warning's and the deploy
  // button's data. Online/offline health itself comes from the registry via
  // the catalog's a2a entries — this list is the "deployed" fact. The paused
  // flag (add-agent-residency) is a best-effort live read of each entry's
  // metadata; unreachable registry ⇒ flags omitted, never an error.
  app.get("/api/packs/:id/deployments", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const rows = registry.deployments(req.params.id);
    const cfg = deployConfig();
    const paused = {};
    if (cfg.registryUrl) {
      for (const r of rows) {
        try {
          // cfg.fetchImpl (tests) wins; prod builds the real registry call.
          const doFetch =
            cfg.fetchImpl ??
            ((p, init = {}) =>
              fetch(`${cfg.registryUrl.replace(/\/+$/, "")}${p}`, {
                ...init,
                headers: { ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}), ...(init.headers ?? {}) },
              }));
          const entry = await (await doFetch(`/api/agents${r.agentPath}`)).json();
          paused[r.agentId] = entry?.metadata?.paused === true;
        } catch { /* flag omitted */ }
      }
    }
    res.json({ deployments: rows.map((r) => ({ ...r, paused: paused[r.agentId] ?? false })) });
  });

  // Pause/resume (add-agent-residency D5): deployer-facing, reversible — the
  // registry entry's metadata flag is the truth the runner polls. Kill = the
  // platform emergency stop writing the SAME flag through an admin gate; the
  // resume path is identical regardless of who paused. Undeploy is untouched.
  const pauseAction = (paused) => async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const id = req.params.id;
    const isAuthor = registry.authorEmail(id) === user.email;
    if (!isAuthor && !isCreator(user)) return res.status(403).json({ error: "Pack author or creator group required" });
    const row = registry.deployments(id).find((d) => d.agentId === req.params.agentId);
    if (!row) return res.status(404).json({ error: "Deployment not found" });
    const cfg = deployConfig();
    if (!cfg.registryUrl) return res.status(503).json({ error: "Agent serving is not configured on this deployment" });
    try {
      const out = await setAgentPaused({ ...cfg, agentPath: row.agentPath, paused });
      res.json({ ...out, effectiveWithinSecs: 300 });
    } catch (err) {
      res.status(Number.isInteger(err?.status) ? err.status : 502).json({ error: err.message });
    }
  };
  app.post("/api/packs/:id/deployments/:agentId/pause", pauseAction(true));
  app.post("/api/packs/:id/deployments/:agentId/resume", pauseAction(false));

  // The platform emergency stop (add-agent-residency D5): admin-gated, writes
  // the same paused flag — a deployer resume restores.
  app.post("/api/packs/:id/deployments/:agentId/kill", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!isAdmin(user)) return res.status(403).json({ error: "Admin group required" });
    const row = registry.deployments(req.params.id).find((d) => d.agentId === req.params.agentId);
    if (!row) return res.status(404).json({ error: "Deployment not found" });
    const cfg = deployConfig();
    if (!cfg.registryUrl) return res.status(503).json({ error: "Agent serving is not configured on this deployment" });
    try {
      const out = await setAgentPaused({ ...cfg, agentPath: row.agentPath, paused: true });
      res.json({ ...out, by: "platform", effectiveWithinSecs: 300 });
    } catch (err) {
      res.status(Number.isInteger(err?.status) ? err.status : 502).json({ error: err.message });
    }
  });

  // ── Service config (agent-service-config): the deployment's rewriteable
  // run-parameter surface. Gated to the deployment's OWN deployer (the row's
  // deployed_by) or a platform admin — an author who never deployed cannot
  // rewrite someone else's service. The registry entry's metadata is the
  // store; writes merge three-state into config_overrides and re-resolve the
  // effective fields through the ONE precedence function the descriptor
  // compose uses.
  //
  // One core, two doors: the user-facing route (session identity) and an
  // internal twin under the packs-internal service credential carrying the
  // console-verified actor in x-acting-user/x-acting-groups. The 万星 console
  // proxies through the internal door so lane/whitelist enforcement exists
  // exactly once — the console cannot read the deployed manifest anyway.
  const configRow = (id, agentId, actor) => {
    const row = registry.deployments(id).find((d) => d.agentId === agentId);
    if (!row) return { error: [404, "Deployment not found"] };
    const admin = adminGroups.some((g) => (actor.groups || []).includes(g));
    if (row.deployedBy !== actor.email && !admin) {
      return { error: [403, "The deployment's deployer or an admin is required"] };
    }
    const cfg = deployConfig();
    if (!cfg.registryUrl) return { error: [503, "Agent serving is not configured on this deployment"] };
    return { row, cfg };
  };
  const registryFetchFor = (cfg) =>
    cfg.fetchImpl ??
    ((p, init = {}) =>
      fetch(`${cfg.registryUrl.replace(/\/+$/, "")}${p}`, {
        ...init,
        headers: {
          // Body-bearing calls (config write GET-merge-PUT) hit the real
          // registry's strict parser: without this the PUT arrives as
          // text/plain and pydantic 422s the whole entry (live probe
          // 2026-10-07). Same default the deploy client (pick) carries.
          "Content-Type": "application/json",
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
          ...(init.headers ?? {}),
        },
      }));

  // The manifest + serving block of the DEPLOYED version (overrides resolve
  // against the declaration the deployment actually carries, not latest).
  const deployedServing = (id, row) => {
    const version = registry.getVersion(id, row.version);
    const agent = (version?.manifest?.agents ?? []).find((a) => a.id === row.agentId);
    return { serving: agent?.serving ?? {}, manifest: version?.manifest ?? null };
  };

  const configReadCore = async ({ id, agentId, actor, res }) => {
    const found = configRow(id, agentId, actor);
    if (found.error) return res.status(found.error[0]).json({ error: found.error[1] });
    const { row, cfg } = found;
    try {
      const doFetch = registryFetchFor(cfg);
      const entry = await (await doFetch(`/api/agents${row.agentPath}`)).json();
      const overrides = entry?.metadata?.config_overrides ?? {};
      const { serving } = deployedServing(id, row);
      const resolved = resolveServiceConfig({ serving, overrides });
      const dimension = (pinned, declared, effective) => ({
        effective,
        source: pinned !== undefined ? "override" : declared !== undefined && declared !== null ? "declared" : "default",
        declared: declared ?? null,
        override: pinned ?? null,
      });
      // The model picker's option set (design D5): the deployment key's live
      // lanes, best-effort — an unavailable billing plane omits them rather
      // than failing the read (the write path still refuses unvalidated models).
      let lanes = null;
      try {
        const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
        const key = registry.deploymentKeysForPack(id).find((k) => k.agentId === row.agentId)?.keyValue;
        if (sub2api && !sub2api.degraded() && key) lanes = await sub2api.listKeyModels(key);
      } catch { /* advisory only */ }
      res.json({
        config: {
          rhythm: dimension(overrides.rhythm, serving.rhythm, resolved.rhythm),
          budgetMinutes: dimension(overrides.budgetMinutes, serving.budget?.turnMinutes, resolved.budgetMinutes),
          model: dimension(overrides.model, serving.model, resolved.model),
        },
        lanes,
        packVersion: row.version,
        effectiveWithinSecs: 300,
      });
    } catch (err) {
      res.status(Number.isInteger(err?.status) ? err.status : 502).json({ error: err.message });
    }
  };

  const configWriteCore = async ({ id, agentId, actor, body, res }) => {
    const found = configRow(id, agentId, actor);
    if (found.error) return res.status(found.error[0]).json({ error: found.error[1] });
    const { row, cfg } = found;
    const unknown = Object.keys(body).filter((k) => !["rhythm", "budgetMinutes", "model"].includes(k));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `unknown config key(s): ${unknown.join(", ")} (only rhythm, budgetMinutes, model)` });
    }
    // Shape layer (cheap): the same validators the manifest and the deploy
    // route enforce — one shape definition, three enforcement points.
    if (body.rhythm !== undefined && body.rhythm !== null) {
      const errs = validateRhythm(body.rhythm);
      if (errs.length > 0) return res.status(400).json({ error: `rhythm is invalid: ${errs[0].error}` });
    }
    if (body.budgetMinutes !== undefined && body.budgetMinutes !== null) {
      const err = budgetMinutesError(body.budgetMinutes);
      if (err) return res.status(400).json({ error: `budgetMinutes is invalid: ${err}` });
    }
    const { serving, manifest } = deployedServing(id, row);
    if (body.model !== undefined && body.model !== null) {
      const err = modelIdError(body.model);
      if (err) return res.status(400).json({ error: `model is invalid: ${err}` });
      if (!manifest) return res.status(404).json({ error: "Deployed pack version no longer readable" });
      // Lane layer (the same one the deploy route runs): deployment key's
      // live sub2api group lanes ∩ the contract whitelist. The inactive
      // plane refuses — an unvalidatable model never lands on a live agent.
      const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
      if (!sub2api || sub2api.degraded()) {
        return res.status(503).json({ error: "billing plane not configured — model lanes cannot be validated" });
      }
      const key = registry.deploymentKeysForPack(id).find((k) => k.agentId === row.agentId)?.keyValue;
      if (!key) return res.status(503).json({ error: "the deployment has no billing key bound — model lanes cannot be validated" });
      let lanes;
      try {
        lanes = await sub2api.listKeyModels(key);
      } catch (err) {
        return res.status(502).json({ error: `billing lane check failed: ${err.message}` });
      }
      const laneErr = modelChoiceError({ model: body.model, whitelist: serving.modelWhitelist, lanes });
      if (laneErr) return res.status(400).json({ error: laneErr, code: "MODEL_LANE_REJECTED" });
    }
    try {
      const doFetch = registryFetchFor(cfg);
      // GET-merge-PUT (setAgentPaused's discipline): the entry carries
      // whatever else the registry holds; config_overrides merge three-state
      // — a present key writes (null included: an explicit reset), an
      // omitted key keeps what the deployment already carries.
      const g = await doFetch(`/api/agents${row.agentPath}`);
      if (!g.ok) throw Object.assign(new Error(`registry GET ${row.agentPath} failed (${g.status})`), { status: 502 });
      const entry = await g.json();
      const overrides = { ...(entry?.metadata?.config_overrides ?? {}) };
      for (const key of ["rhythm", "budgetMinutes", "model"]) {
        if (Object.prototype.hasOwnProperty.call(body, key)) overrides[key] = body[key];
      }
      for (const key of Object.keys(overrides)) {
        if (overrides[key] === undefined) delete overrides[key];
      }
      entry.metadata = { ...(entry.metadata ?? {}), config_overrides: overrides };
      const resolved = resolveServiceConfig({ serving, overrides });
      if (resolved.rhythm) entry.metadata.effective_rhythm = resolved.rhythm;
      else delete entry.metadata.effective_rhythm;
      if (resolved.budgetMinutes != null) entry.metadata.effective_budget_minutes = resolved.budgetMinutes;
      else delete entry.metadata.effective_budget_minutes;
      if (resolved.model) entry.metadata.effective_model = resolved.model;
      else delete entry.metadata.effective_model;
      const put = await doFetch(`/api/agents${row.agentPath}`, { method: "PUT", body: JSON.stringify(entry) });
      if (!put.ok) {
        // The register route is the create-side twin of the upsert: the
        // registry's PUT validates a narrower payload shape than its own GET
        // returns (live finding 2026-10-07, 422 model_attributes_type — the
        // GET-expanded entry carries proxy fields PUT rejects), so a failed
        // PUT falls back to register — the exact ladder setAgentPaused rides.
        const reg = await doFetch("/api/agents/register", { method: "POST", body: JSON.stringify(entry) });
        if (!reg.ok) {
          const detail = await reg.json().catch(() => ({}));
          throw Object.assign(new Error(`registry write failed (${put.status}/${reg.status}): ${JSON.stringify(detail).slice(0, 200)}`), { status: 502 });
        }
      }
      console.log(`[packs] service config updated: ${row.agentPath} (${Object.keys(body).join(", ") || "no-op"}) by ${actor.email}`);
      res.json({ ok: true, config: overrides, effectiveWithinSecs: 300 });
    } catch (err) {
      res.status(Number.isInteger(err?.status) ? err.status : 502).json({ error: err.message });
    }
  };

  app.get("/api/packs/:id/deployments/:agentId/config", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    return configReadCore({ id: req.params.id, agentId: req.params.agentId, actor: user, res });
  });

  app.put("/api/packs/:id/deployments/:agentId/config", express.json({ limit: "64kb" }), async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    return configWriteCore({ id: req.params.id, agentId: req.params.agentId, actor: user, body: req.body ?? {}, res });
  });

  // Internal twin (the 万星 console's door): the packs-internal service
  // credential plus the actor the console already verified (its Logto
  // identity — email + groups). The actor headers are trustworthy BECAUSE the
  // service credential is: only the platform's own units hold it.
  const internalActor = (req, res) => {
    if (!internalAuth(req, res)) return null;
    const email = String(req.headers["x-acting-user"] || "").trim();
    if (!email) {
      res.status(400).json({ error: "x-acting-user required" });
      return null;
    }
    const groups = String(req.headers["x-acting-groups"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { email, groups };
  };
  app.get("/api/packs/internal/deployments/:id/:agentId/config", async (req, res) => {
    const actor = internalActor(req, res);
    if (!actor) return;
    return configReadCore({ id: req.params.id, agentId: req.params.agentId, actor, res });
  });
  app.put("/api/packs/internal/deployments/:id/:agentId/config", express.json({ limit: "64kb" }), async (req, res) => {
    const actor = internalActor(req, res);
    if (!actor) return;
    return configWriteCore({ id: req.params.id, agentId: req.params.agentId, actor, body: req.body ?? {}, res });
  });

  // Unpublish: author-checked unlist. Unknown pack and foreign pack answer
  // identically (the revoke pattern — probing teaches nothing). Deployed
  // Agent Services are NOT cascaded (spec: undeploy is independent) — the
  // response names them so the UI can warn.
  app.post("/api/packs/:id/unpublish", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!registry.setUnlisted({ email: user.email, id: req.params.id })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    res.json({ ok: true, deployments: registry.deployments(req.params.id) });
  });

  // Subscribe: records the subscription and hands back the full manifest of
  // the current version so the browser can drive its cell's install in one
  // round trip. Unlisted packs take no new subscribers.
  app.post("/api/packs/:id/subscribe", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    // Private packs install for their owner (and admins) only — everyone
    // else gets the not-found answer (openspec: pack-visibility).
    const pack = registry.packRowPublic(req.params.id);
    if (!registry.visibleTo(pack, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    const sub = registry.subscribe({ email: user.email, id: req.params.id });
    if (!sub) return res.status(404).json({ error: "Pack not found" });
    res.json({ packId: req.params.id, version: sub.version, manifest: sub.manifest });
  });

  app.delete("/api/packs/:id/subscribe", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    registry.unsubscribe({ email: user.email, id: req.params.id });
    res.json({ ok: true });
  });
}
