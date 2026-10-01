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
import { PACK_LIMITS, validatePackManifest as validateManifest } from "../lib/pack-manifest.js";
import { deployToRegistry } from "../lib/agent-serving.js";

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
    unlisted INTEGER NOT NULL DEFAULT 0
  )`);
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
    };
  }

  return {
    // First publish: mint an id and store version 1.
    publish({ email, manifest }) {
      const id = mintId();
      db.prepare(`INSERT INTO packs (id, author_email, created_at) VALUES (?, ?, ?)`).run(id, email, now());
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
    getVersion(id, version) {
      const pack = packRow(id);
      if (!pack) return null;
      const row = versionRow(id, Number(version));
      if (!row) return null;
      return { id, version: row.version, manifest: JSON.parse(row.manifest) };
    },

    // Paginated listing of live (not unlisted) packs, newest publish first.
    // `search` matches name/description substrings; `tag` matches a tag
    // exactly (stored as a JSON array, matched textually for v1 volumes).
    list({ search = "", tag = "", page = 1, pageSize = 50 } = {}) {
      const size = Math.min(Math.max(1, Number(pageSize) || 50), 100);
      const pageNum = Math.max(1, Number(page) || 1);
      const where = ["p.unlisted = 0"];
      const params = [];
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
  rateMax = 10,
  rateWindowMs = 60 * 60_000,
  jsonLimit = "1mb",
  deployConfig: deployConfigOpt = null,
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
    };
  };
  const publishAllowed = createPublishRateLimiter({ windowMs: rateWindowMs, max: rateMax });
  const isCreator = (user) => creatorGroups.some((g) => (user.groups || []).includes(g));
  const auth = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    return user;
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
    const user = auth(req, res);
    if (!user) return;
    const { search = "", tag = "", page, pageSize } = req.query;
    res.json(registry.list({ search: String(search), tag: String(tag), page, pageSize }));
  });

  // Latest-version detail. An unlisted pack stays visible to its author and
  // active subscribers; the author additionally sees the subscriber count.
  app.get("/api/packs/:id", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const id = req.params.id;
    const isAuthor = registry.authorEmail(id) === user.email;
    const isSubscriber = Boolean(registry.subscription(user.email, id));
    const pack = registry.get(id, { includeUnlisted: isAuthor || isSubscriber });
    if (!pack) return res.status(404).json({ error: "Pack not found" });
    if (isAuthor) pack.subscriberCount = registry.subscriberCount(id);
    res.json(pack);
  });

  // A stored version is always retrievable, listed or not.
  app.get("/api/packs/:id/versions/:version", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const v = registry.getVersion(req.params.id, req.params.version);
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
    if (!isAuthor && !isCreator(user)) return res.status(403).json({ error: "Pack author or creator group required" });

    const version = registry.getVersion(id, req.params.version);
    if (!version) return res.status(404).json({ error: "Pack version not found" });

    const cfg = deployConfig();
    if (!cfg.runnerBaseUrl) {
      return res.status(503).json({ error: "Agent serving is not configured on this deployment (AGENT_SERVING_RUNNER_URL)" });
    }
    let out;
    try {
      out = await deployToRegistry({
        packId: id,
        version: version.version,
        manifest: version.manifest,
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
    }
    res.json({
      deployed: out.deployed.map((d) => ({ agentId: d.agentId, agentPath: d.agentPath, skills: d.skills, card: d.card })),
      effectiveWithinSecs: out.effectiveWithinSecs,
    });
  });

  // Deployed roles of a pack (3.3): the unpublish warning's and the deploy
  // button's data. Online/offline health itself comes from the registry via
  // the catalog's a2a entries — this list is the "deployed" fact.
  app.get("/api/packs/:id/deployments", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    res.json({ deployments: registry.deployments(req.params.id) });
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
