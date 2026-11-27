// ── Local roster feed + deployment store (add-local-fleet-control-plane) ─────
//
// The desktop's management plane: cell owns WHICH serving agents exist on this
// machine (local_fleet_deployments) and exposes them in the shape agent-runner
// already consumes from the public registry — so the runner needs ZERO code
// changes, only a pointer swap (supervisor/descriptors.js).
//
// Contract source of truth: openspec/changes/add-local-fleet-control-plane/
// specs/local-agent-registry-feed/spec.md. The endpoint shapes mirror
// agent-runner/registry.js's consumption exactly:
//   GET  {base}/api/agents?limit&offset   → { agents, total_count, has_next }
//   GET  {base}/api/skills<path>/content  → { content }
// Auth is a loopback Bearer minted by first-run (WANXING_LOCAL_FEED_TOKEN) —
// not an account credential: it never leaves the machine and is unreadable
// from the renderer.
//
// Entries are COMPOSED, never stored: row × installed manifest →
// composeDescriptor/composeAgentCard (the same functions the cloud deploy
// path uses), so the local and cloud entry shapes cannot drift.

import crypto from "node:crypto";
import express from "express";
import { getDb, isDbReady, listInstalledPacks } from "../db.js";
import { composeAgentCard, composeDescriptor, listServingAgents } from "../lib/agent-serving.js";
import { isLoopbackAddress } from "./auth.js";

// Mounted OUTSIDE the registry-colliding prefixes: the runner appends
// /api/agents and /api/skills… to whatever base URL it is given.
export const LOCAL_FEED_BASE = "/local-registry";

const DEFAULT_MAX_CHILDREN = 4;

function nowIso() {
  return new Date().toISOString();
}

function requireDb() {
  if (!isDbReady()) {
    throw Object.assign(new Error("local fleet store unavailable (database not ready)"), { status: 503 });
  }
  return getDb();
}

// ── Deployment rows ─────────────────────────────────────────────────────────

// source (add-unified-fleet-console): 'manual' = established by a user action
// on this machine (wins over the cloud desired set, forever, until the row is
// removed); 'cloud' = applied by the desired-state merge and still following
// the cloud's expectation. v108 defaults existing rows to 'manual' — the only
// source that existed before the merge.
export function listDeployments() {
  if (!isDbReady()) return [];
  return getDb()
    .prepare(
      `SELECT agent_path AS agentPath, pack_id AS packId, agent_id AS agentId,
              enabled, config_overrides AS configOverrides, source,
              created_at AS createdAt, updated_at AS updatedAt
         FROM local_fleet_deployments
        ORDER BY created_at ASC`,
    )
    .all()
    .map((r) => ({ ...r, enabled: r.enabled !== 0, source: r.source === "cloud" ? "cloud" : "manual" }));
}

export function getDeployment(agentPath) {
  if (!isDbReady()) return null;
  const row = getDb()
    .prepare(
      `SELECT agent_path AS agentPath, pack_id AS packId, agent_id AS agentId,
              enabled, config_overrides AS configOverrides, source,
              created_at AS createdAt, updated_at AS updatedAt
         FROM local_fleet_deployments WHERE agent_path = ?`,
    )
    .get(String(agentPath ?? ""));
  return row ? { ...row, enabled: row.enabled !== 0, source: row.source === "cloud" ? "cloud" : "manual" } : null;
}

// The runner's capacity unit is the CHILD PROCESS, not the deployment row
// (spike 1.1, F2): pod mode co-hosts every agent of one pack in one child, so
// a pack counts once; solo mode counts per agent. Capacity compares GROUPS.
export function capacityInfo(env = process.env) {
  const cap = Number(env.AGENT_RUNNER_MAX_CHILDREN) > 0
    ? Number(env.AGENT_RUNNER_MAX_CHILDREN)
    : DEFAULT_MAX_CHILDREN;
  const podMode = ["1", "true", "yes"].includes(String(env.AGENT_RUNNER_POD_MODE || "").toLowerCase());
  const enabledRows = listDeployments().filter((d) => d.enabled);
  const groups = podMode ? new Set(enabledRows.map((d) => d.packId)) : new Set(enabledRows.map((d) => d.agentPath));
  return { used: groups.size, cap, unit: "groups", podMode };
}

// The group key a NEW deployment would join: pod mode groups by pack, solo
// mode is its own group. Used by the write face to decide "does this consume
// a slot".
function groupKeyOf(packId, agentPath, podMode) {
  return podMode ? `pack:${packId}` : `agent:${agentPath}`;
}

export function agentPathFor(packId, agentId) {
  // Same convention the cloud deploy path writes (unique across deployments).
  return `packs/${packId}/${agentId}`;
}

// The installed-pack view of one deployment input: the pack row, the agent
// declaration, and the serving eligibility. Returns a structured refusal
// (status + code) instead of throwing for the three deployability gates.
function resolveDeployable({ packId, agentId }) {
  const installed = listInstalledPacks().find((p) => p.packId === packId);
  if (!installed) {
    return { error: { status: 404, code: "pack_not_installed", message: `pack ${packId} is not installed on this machine` } };
  }
  const agent = (installed.manifest?.agents ?? []).find((a) => a?.id === agentId);
  if (!agent) {
    return { error: { status: 404, code: "agent_not_in_pack", message: `pack ${packId} declares no agent ${agentId}` } };
  }
  if (!listServingAgents(installed.manifest).includes(agent)) {
    return { error: { status: 400, code: "agent_not_serving", message: `agent ${agentId} carries no serving declaration` } };
  }
  return { installed, agent };
}

// The target seat is the local one by construction (the route refuses any
// other runner before calling here), so no seat parameter is needed: entries
// are tagged at COMPOSE time with the env's seat id.
// `source: "cloud"` is reserved for the desired-state merge (it deploys or
// reconciles WITHOUT touching the row's source). Any caller that omits it is
// a user action: a UI deploy of an existing cloud row ADOPTS it — source
// flips to 'manual' and the cloud expectation stops steering this entry
// (local-manual-wins, spec cell-lifecycle delta).
export function deployLocalAgent({ packId, agentId, externalRunnerId = null, source = null }) {
  if (externalRunnerId) {
    // v1 serves exactly this seat. A caller naming another runner is a
    // mistake (or a forged write): refuse rather than mint a local entry the
    // mesh would mis-route.
    return { error: { status: 400, code: "external_runner_unsupported", message: "the local control plane only deploys to this machine's seat" } };
  }
  const mergeMode = source === "cloud";
  const db = requireDb();
  const resolved = resolveDeployable({ packId, agentId });
  if (resolved.error) return resolved;

  const agentPath = agentPathFor(packId, agentId);
  const existing = getDeployment(agentPath);
  if (existing) {
    // Idempotent: a retry/double-click returns the existing deployment
    // (re-enabled if it had been stopped — deploy means "make it exist").
    if (!existing.enabled) {
      db.prepare("UPDATE local_fleet_deployments SET enabled = 1, updated_at = ? WHERE agent_path = ?")
        .run(nowIso(), agentPath);
    }
    if (!mergeMode && existing.source === "cloud") {
      // Adoption: the user re-deployed by hand — the cloud no longer steers it.
      db.prepare("UPDATE local_fleet_deployments SET source = 'manual', updated_at = ? WHERE agent_path = ?")
        .run(nowIso(), agentPath);
    }
    return { deployment: getDeployment(agentPath), reused: true };
  }

  const cap = capacityInfo();
  const enabled = listDeployments().filter((d) => d.enabled);
  const existingGroups = new Set(
    enabled.map((d) => groupKeyOf(d.packId, d.agentPath, cap.podMode)),
  );
  const nextGroup = groupKeyOf(packId, agentPath, cap.podMode);
  if (!existingGroups.has(nextGroup) && existingGroups.size >= cap.cap) {
    // Structured, actionable, never a silent queue (design D4).
    return {
      error: {
        status: 409,
        code: "capacity_exceeded",
        message: `all ${cap.cap} runtime groups are in use — remove a deployment to free one`,
        used: existingGroups.size,
        cap: cap.cap,
        unit: cap.unit,
      },
    };
  }

  const ts = nowIso();
  db.prepare(
    `INSERT INTO local_fleet_deployments (agent_path, pack_id, agent_id, enabled, config_overrides, source, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(agentPath, packId, agentId, null, mergeMode ? "cloud" : "manual", ts, ts);
  return { deployment: getDeployment(agentPath), reused: false };
}

export function setDeploymentEnabled(agentPath, enabled, { source = null } = {}) {
  const db = requireDb();
  const existing = getDeployment(agentPath);
  if (!existing) {
    return { error: { status: 404, code: "deployment_not_found", message: `no local deployment ${agentPath}` } };
  }
  // Re-enabling from the stopped state must pass the SAME capacity gate a
  // fresh deploy does — otherwise stop/start would be a capacity bypass.
  if (enabled && !existing.enabled) {
    const cap = capacityInfo();
    const others = listDeployments().filter((d) => d.enabled);
    const groups = new Set(others.map((d) => groupKeyOf(d.packId, d.agentPath, cap.podMode)));
    const nextGroup = groupKeyOf(existing.packId, existing.agentPath, cap.podMode);
    if (!groups.has(nextGroup) && groups.size >= cap.cap) {
      return {
        error: {
          status: 409,
          code: "capacity_exceeded",
          message: `all ${cap.cap} runtime groups are in use — remove a deployment to free one`,
          used: groups.size,
          cap: cap.cap,
          unit: cap.unit,
        },
      };
    }
  }
  // User action (no explicit source) on a cloud row = adoption → 'manual'.
  // The merge passes source:'cloud' and reconciles without flipping.
  const adopt = source !== "cloud" && existing.source === "cloud";
  if (adopt) {
    db.prepare("UPDATE local_fleet_deployments SET enabled = ?, source = 'manual', updated_at = ? WHERE agent_path = ?")
      .run(enabled ? 1 : 0, nowIso(), agentPath);
  } else {
    db.prepare("UPDATE local_fleet_deployments SET enabled = ?, updated_at = ? WHERE agent_path = ?")
      .run(enabled ? 1 : 0, nowIso(), agentPath);
  }
  return { deployment: getDeployment(agentPath) };
}

export function removeDeployment(agentPath) {
  const db = requireDb();
  const existing = getDeployment(agentPath);
  if (!existing) {
    return { error: { status: 404, code: "deployment_not_found", message: `no local deployment ${agentPath}` } };
  }
  db.prepare("DELETE FROM local_fleet_deployments WHERE agent_path = ?").run(agentPath);
  return { removed: existing };
}

// Drop rows whose pack is no longer installed (uninstall hook + feed read).
// Returns the number of orphan rows removed.
export function pruneOrphanDeployments() {
  if (!isDbReady()) return 0;
  const installed = new Set(listInstalledPacks().map((p) => p.packId));
  let removed = 0;
  const db = getDb();
  for (const d of listDeployments()) {
    if (!installed.has(d.packId)) {
      db.prepare("DELETE FROM local_fleet_deployments WHERE agent_path = ?").run(d.agentPath);
      removed += 1;
    }
  }
  return removed;
}

// ── Entry composition (row × installed manifest) ────────────────────────────

// One registry-shaped entry per ENABLED, still-installed, still-serving
// deployment. Orphans (pack uninstalled, agent removed from a newer manifest)
// are skipped — the feed never advertises what cannot be materialized.
export function composeLocalEntries({ runnerId, seatTag = true, deployments = listDeployments() } = {}) {
  const packs = new Map(listInstalledPacks().map((p) => [p.packId, p]));
  const entries = [];
  for (const d of deployments) {
    if (!d.enabled) continue;
    const installed = packs.get(d.packId);
    if (!installed) continue;
    const agent = (installed.manifest?.agents ?? []).find((a) => a?.id === d.agentId);
    if (!agent || !listServingAgents(installed.manifest).includes(agent)) continue;
    const metadata = composeDescriptor({
      packId: d.packId,
      version: installed.version,
      manifest: installed.manifest,
      agent,
      ...(runnerId ? { runnerId } : {}),
      ...(seatTag ? { desktopSeat: true } : {}),
      registryPath: d.agentPath,
      configOverrides: d.configOverrides ? safeJson(d.configOverrides) : undefined,
    });
    const card = composeAgentCard(installed.manifest, agent);
    entries.push({
      path: d.agentPath,
      name: card.name,
      description: card.description,
      url: "", // distribution-only on a desktop seat (home NAT): the runner
      proxy_pass_url: "", // binds its own loopback ports; the card is truth.
      version: String(installed.version),
      provider: { organization: "paas-pack" },
      capabilities: card.capabilities,
      streaming: true,
      skills: card.skills,
      tags: card.tags,
      supported_protocol: "a2a",
      default_input_modes: ["text"],
      default_output_modes: ["text"],
      preferred_transport: "jsonrpc",
      is_enabled: true,
      metadata,
    });
  }
  return entries;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── Skill bodies ────────────────────────────────────────────────────────────

// The runner fetches each descriptor skill path (`packs/<packId>/<skill>`) as
// content. The durable store is the custom_skills table (the materializer
// mirrors it to disk); pack-owned rows carry origin_pack_id. Returns null when
// the pack does not own that skill name.
export function skillContentFor(packId, skillName) {
  if (!isDbReady()) return null;
  const row = getDb()
    .prepare(
      `SELECT content FROM custom_skills
        WHERE origin_pack_id = ? AND name = ?
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(String(packId), String(skillName));
  return row?.content ?? null;
}

// ── Convergence after a resident boot (add-desktop-residency-hardening 4.x) ─
//
// When the steward brings the cell up (login, wake, post-update restart), the
// LOCAL cluster must land on its declared state again: the deployments table
// is the expectation, the installed packs are the material, and the feed is
// what the runner polls. Convergence is idempotent and offline-safe (it never
// touches the network) and it REPORTS what it did, so the status surface can
// show "restored N / pruned M" instead of a silent blank.
let lastConvergence = null;

export function convergeLocalCluster({ env = process.env } = {}) {
  const result = {
    at: new Date().toISOString(),
    pruned: 0,
    deployments: 0,
    enabled: 0,
    capacity: capacityInfo(env),
    ok: true,
  };
  try {
    result.pruned = pruneOrphanDeployments();
    const rows = listDeployments();
    result.deployments = rows.length;
    result.enabled = rows.filter((d) => d.enabled).length;
  } catch (e) {
    result.ok = false;
    result.error = e?.message || String(e);
  }
  lastConvergence = result;
  return result;
}

export function convergenceReport() {
  return lastConvergence;
}

// ── HTTP surface ────────────────────────────────────────────────────────────

function bearerOf(req) {
  const raw = String(req.headers.authorization || "");
  return raw.startsWith("Bearer ") ? raw.slice(7) : "";
}

function tokenMatches(expected, received) {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Feed token: minted by first-run into settings (WANXING_LOCAL_FEED_TOKEN) and
// injected into the runner's env by the supervisor descriptor. Empty on a
// deployment without a desktop bootstrap (dev/containers) → the feed stays
// OPEN on LOOPBACK ONLY, exactly like the pre-change desktop dev posture.
export function createLocalAgentFeed({ env = process.env, runnerId = null, seatTag = true, ownerEmail = null } = {}) {
  const router = express.Router();
  // The bearer comes from the SETTINGS the cell was given. On a packaged
  // desktop that is settings.json (electron/config/settings.js injects it
  // into the child's env). When it is missing — a dev/headless cell that was
  // never bootstrapped — the feed keeps its loopback-open dev posture, and
  // says so in the log rather than pretending it is protected.
  const expected = String(env.WANXING_LOCAL_FEED_TOKEN || "");
  if (!expected) {
    console.warn(
      "[local-feed] no WANXING_LOCAL_FEED_TOKEN in this cell's env — the roster feed is OPEN on loopback (dev posture)",
    );
  }

  router.use((req, res, next) => {
    // The auth gate exempts this prefix wholesale (the route authenticates
    // itself), so the address check has to live HERE or nowhere does. "Open"
    // dev posture means open to this machine, not to whatever interface the
    // cell happens to bind (a container with HOST=0.0.0.0 would otherwise
    // serve the roster — pod and seat topology — to the whole pod network
    // with no credential at all).
    if (!expected) {
      if (isLoopbackAddress(req.socket?.remoteAddress)) return next();
      return res.status(401).json({ error: "missing local feed credential" });
    }
    if (tokenMatches(expected, bearerOf(req))) return next();
    return res.status(401).json({ error: "missing local feed credential" });
  });

  router.get("/api/agents", (req, res) => {
    try {
      pruneOrphanDeployments();
      const agents = composeLocalEntries({ runnerId, seatTag });
      // Same pagination semantics the runner's client implements: total_count
      // + has_next, page size capped at its 500.
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 20));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const page = agents.slice(offset, offset + limit);
      res.json({
        agents: page,
        total_count: agents.length,
        has_next: offset + page.length < agents.length,
        // 这个 feed 属于哪个 cell 的主人（fix-disclosure-gate-reachability D2 修订）。
        // 是本 cell 自己的事实（部署行按 cell 存），不是配置项——所以由数据报出，
        // 而不是让 runner 用 env 猜、也不是让网关跨服务去查 packs。
        owner: ownerEmail ? String(ownerEmail).trim().toLowerCase() : null,
      });
    } catch (e) {
      res.status(500).json({ error: e?.message || "local feed failure" });
    }
  });

  // `packs/<packId>/<skillName>` → the pack-owned skill body.
  router.get("/api/skills/*/content", (req, res) => {
    const rest = String(req.params[0] ?? "");
    const parts = rest.split("/").filter(Boolean);
    if (parts[0] !== "packs" || parts.length < 3) {
      return res.status(404).json({ error: "unknown skill path" });
    }
    const packId = parts[1];
    const skillName = parts.slice(2).join("/");
    const content = skillContentFor(packId, skillName);
    if (content == null) return res.status(404).json({ error: "skill not found" });
    return res.json({ content });
  });

  return router;
}

// v1 exposes exactly the seat's deployment list for the console UI (the same
// shape the write face returns), plus live capacity.
export function localFleetSnapshot({ env = process.env } = {}) {
  return {
    capacity: capacityInfo(env),
    deployments: listDeployments().map((d) => ({
      ...d,
      configOverrides: d.configOverrides ? safeJson(d.configOverrides) : undefined,
    })),
  };
}
