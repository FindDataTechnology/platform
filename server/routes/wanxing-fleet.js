// ── Desktop fleet console lane (add-desktop-fleet-console) ───────────────────
//
// The desktop fleet page's read face: the cell server proxies the LOCAL
// runner's /health (loopback, same machine) and — since
// add-local-fleet-control-plane — reads its CATALOG from the cell's own local
// roster feed by default, with the public registry kept as an explicit
// read-only bridge. No new desktop credentials are introduced and the renderer
// never crosses origins.
//
// Write face (add-local-fleet-control-plane): deploy / stop / start / remove
// all land on the local deployment store via server/local-agent-feed.js and
// become visible through the same feed the runner polls — never a direct
// runner call, never a cloud write.
//
// Every endpoint degrades honestly: a runner that is not enabled/running, a
// registry that is not configured, or a local store without deployments are
// 503/empty + a machine-readable code the page renders as guidance.

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJsonSync } from "../../lib/persistence.js";
import { listInstalledPacks } from "../../db.js";
import { listServingAgents } from "../../lib/agent-serving.js";
import { readDesiredBeacon } from "../fleet-desired-merge.js";
import {
  composeLocalEntries,
  convergeLocalCluster,
  convergenceReport,
  deployLocalAgent,
  listDeployments,
  localFleetSnapshot,
  removeDeployment,
  setDeploymentEnabled,
} from "../local-agent-feed.js";
import { importPresetBundle, listPresetBundles, presetBundlesDir } from "../preset-bundles.js";
import * as packStore from "../../pack-store.js";
import { reportInstance } from "../../lib/supply-instance-report.js";

const RUNNER_TIMEOUT_MS = 2000;

export function registerWanxingFleetRoutes(ctx) {
  const router = Router();
  const env = ctx.env || process.env;
  // Injection seam for tests; production always uses the global fetch.
  const doFetch = ctx.fleetFetchImpl || ((u, i) => fetch(u, i));
  const runnerBase = () =>
    String(env.WANXING_RUNNER_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
  const registryBase = () =>
    String(env.AGENT_SERVING_REGISTRY_URL || "").replace(/\/+$/, "");
  const registryToken = () => String(env.AGENT_SERVING_REGISTRY_TOKEN || "");
  const seatId = () => String(env.WANXING_PLUGIN_RUNNER_ID || "") || null;
  // The Wanxing console the desktop pairs against (slice ③): the redeem call
  // carries no console session — the six-digit code is the entire proof, so
  // the server-side call never needs a forwarded identity.
  const consoleBase = () =>
    String(env.WANXING_CONSOLE_URL || "https://wanxing.finddatatech.cloud").replace(/\/+$/, "");
  const settingsPath = () => {
    const dataDir = env.PLATFORM_DATA_DIR || "";
    return dataDir ? path.join(dataDir, "settings.json") : null;
  };

  router.get("/live", async (_req, res) => {
    try {
      const r = await doFetch(`${runnerBase()}/health`, { signal: AbortSignal.timeout(RUNNER_TIMEOUT_MS) });
      if (!r.ok) {
        return res.status(503).json({ error: "runner_not_running", status: r.status });
      }
      const body = await r.json();
      return res.json(body);
    } catch {
      // Not enabled, still booting, or gone: the page's guidance state.
      return res.status(503).json({ error: "runner_not_running" });
    }
  });

  // Catalog source selection (design D5): the local feed is the default —
  // management of THIS machine's cluster must not depend on any cloud
  // reachability. The public directory stays available as a read-only bridge
  // when a registry credential is configured AND the caller asks for it.
  router.get("/catalog", async (req, res) => {
    const source = String(req.query.source || "local");

    if (source !== "registry") {
      // Local roster: what is deployed here + what COULD be deployed from the
      // already-installed packs (the write face's candidate list). Registry
      // metadata internals never reach the renderer. add-unified-fleet-
      // console: each candidate also carries its row's `source` and the
      // cloud-desired state when the machine is paired+pulling (the desired
      // beacon is null otherwise) — the page renders provenance and the
      // desired-vs-actual divergence marker from these two fields.
      const deployed = composeLocalEntries({ runnerId: seatId() });
      const deploymentRows = listDeployments();
      const deployedByPath = new Set(deploymentRows.filter((d) => d.enabled).map((d) => d.agentPath));
      const deployedAll = new Set(deploymentRows.map((d) => d.agentPath));
      const rowByPath = new Map(deploymentRows.map((d) => [d.agentPath, d]));
      const desiredBeacon = readDesiredBeacon(env);
      const desiredByPath = new Map(
        (desiredBeacon?.entries ?? []).map((e) => [`packs/${e.packId}/${e.agentId}`, e.enabled !== false]),
      );
      const candidates = [];
      for (const pack of listInstalledPacks()) {
        for (const agent of listServingAgents(pack.manifest)) {
          const agentPath = `packs/${pack.packId}/${agent.id}`;
          candidates.push({
            path: agentPath,
            packId: pack.packId,
            agentId: agent.id,
            name: agent.name ?? agent.id,
            description: agent.serving?.card?.description ?? null,
            deployed: deployedAll.has(agentPath),
            enabled: deployedByPath.has(agentPath),
            source: rowByPath.get(agentPath)?.source ?? null,
            desiredEnabled: desiredByPath.has(agentPath) ? desiredByPath.get(agentPath) : null,
          });
        }
      }
      return res.json({
        source: "local",
        agents: deployed.map((a) => ({
          path: a.path ?? null,
          name: a.name ?? null,
          description: a.description ?? null,
          version: a.version ?? null,
          tags: Array.isArray(a.tags) ? a.tags : [],
        })),
        candidates,
        capacity: localFleetSnapshot({ env }).capacity,
      });
    }

    if (!registryBase()) {
      return res.status(503).json({ error: "registry_not_configured" });
    }
    try {
      // Paginated read (registry-list-completeness): the 8s budget covers the
      // whole walk; on timeout the partial rows are still served (this is a
      // read-only projection, better half a fleet than a 502) with a warning.
      const headers = {
        Accept: "application/json",
        ...(registryToken() ? { Authorization: `Bearer ${registryToken()}` } : {}),
      };
      const rows = [];
      let offset = 0;
      let truncated = false;
      const PAGE = 500;
      const deadline = Date.now() + 7500; // leave the response path 500ms
      for (let page = 0; page < 100; page += 1) {
        const r = await doFetch(`${registryBase()}/api/agents?limit=${PAGE}&offset=${offset}`, {
          headers,
          signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())),
        });
        if (!r.ok) {
          return res.status(502).json({ error: "registry_unreachable", status: r.status });
        }
        const doc = await r.json();
        const pageRows = Array.isArray(doc) ? doc : (doc?.agents ?? doc?.items ?? []);
        rows.push(...pageRows);
        const total = Number.isFinite(Number(doc?.total_count)) ? Number(doc.total_count) : null;
        const hasNext =
          typeof doc?.has_next === "boolean"
            ? doc.has_next
            : total !== null
              ? rows.length < total
              : pageRows.length >= PAGE;
        if (!hasNext || pageRows.length === 0) break;
        if (Date.now() >= deadline) {
          truncated = true;
          break;
        }
        offset += pageRows.length;
      }
      if (truncated) {
        console.warn(
          `[wanxing-fleet] /api/agents: truncated catalog read — retrieved ${rows.length} entries within the time budget`,
        );
      }
      // Read-only projection: metadata internals never reach the renderer.
      const agents = rows
        .filter((a) => a && a.is_enabled !== false && String(a.supported_protocol || "").toLowerCase() === "a2a")
        .map((a) => ({
          path: a.path ?? null,
          name: a.name ?? null,
          description: a.description ?? null,
          version: a.version ?? null,
          tags: Array.isArray(a.tags) ? a.tags : [],
        }));
      return res.json({ source: "registry", agents });
    } catch {
      return res.status(502).json({ error: "registry_unreachable" });
    }
  });

  // ── Local deployment write face (add-local-fleet-control-plane 3.1) ──────
  //
  // All four actions mutate the local store only; the runner converges on its
  // next poll (same cadence as the cloud path). Responses carry the LANDED
  // fact, never a runtime state — the UI reads /live for that (no fake green).

  // Preinstalled starter bundles (change 4): the installer may ship official
  // starters. REGISTERING them is not installing them — the list is a
  // catalogue, and the import below is the explicit user action.
  router.get("/presets", async (_req, res) => {
    try {
      const bundles = await listPresetBundles({ env });
      return res.json({ bundles, dir: presetBundlesDir(env) });
    } catch (e) {
      return res.status(503).json({ error: "presets_unavailable", message: e?.message });
    }
  });

  router.post("/presets/import", async (req, res) => {
    const file = String(req.body?.file || "");
    if (!file) return res.status(400).json({ error: "file is required" });
    try {
      const out = await importPresetBundle({
        file,
        env,
        user: req.user ?? null,
        installPack: packStore.installPack,
        hooks: {
          onMcpChanged: () => ctx.broadcast?.({ type: "extensions_changed", resource: "mcp", action: "pack-import", name: file }),
          onCatalogChanged: () => {
            ctx.broadcast?.({ type: "catalog_changed" });
            void ctx.syncCatalogAgentPresets?.();
          },
        },
      });
      await ctx.dshUpdateSkills?.().catch((e) => console.warn(`[wanxing-fleet] skills patch update failed: ${e.message}`));
      return res.json(out);
    } catch (e) {
      return res.status(e?.status || 500).json({ error: e?.code || "preset_import_failed", message: e?.message });
    }
  });

  // Convergence report (add-desktop-residency-hardening 4.x): what the last
  // resident boot restored/pruned, plus the current expectation.
  router.get("/convergence", (_req, res) => {
    try {
      return res.json({ last: convergenceReport(), current: convergeLocalCluster({ env }) });
    } catch (e) {
      return res.status(e?.status || 503).json({ error: e?.code || "convergence_unavailable", message: e?.message });
    }
  });

  // Instance report (close-supply-loop-interfaces 2.2): fire-and-forget — the
  // response path never awaits it and its failures are invisible to users
  // (spec: 登记通道失败诚实降级不阻塞部署).
  const reportDeployment = (dep) => {
    void reportInstance(dep, { env, seatId: seatId() }).catch(() => {});
  };

  router.get("/deployments", (_req, res) => {
    try {
      return res.json(localFleetSnapshot({ env }));
    } catch (e) {
      return res.status(e?.status || 503).json({ error: e?.code || "local_store_unavailable", message: e?.message });
    }
  });

  router.post("/deployments", (req, res) => {
    const { packId, agentId, runnerId } = req.body || {};
    if (!packId || !agentId) {
      return res.status(400).json({ error: "packId and agentId are required" });
    }
    const out = deployLocalAgent({
      packId: String(packId),
      agentId: String(agentId),
      externalRunnerId: runnerId && runnerId !== seatId() ? String(runnerId) : null,
    });
    if (out.error) return res.status(out.error.status ?? 400).json(out.error);
    reportDeployment(out.deployment);
    return res.status(out.reused ? 200 : 201).json({ deployment: out.deployment, reused: out.reused, capacity: localFleetSnapshot({ env }).capacity });
  });

  const enabledChange = (enabled) => (req, res) => {
    const agentPath = String(req.body?.agentPath || "");
    if (!agentPath) return res.status(400).json({ error: "agentPath is required" });
    const out = setDeploymentEnabled(agentPath, enabled);
    if (out.error) return res.status(out.error.status ?? 400).json(out.error);
    reportDeployment(out.deployment);
    return res.json({ deployment: out.deployment, capacity: localFleetSnapshot({ env }).capacity });
  };
  router.post("/deployments/stop", enabledChange(false));
  router.post("/deployments/start", enabledChange(true));

  router.post("/deployments/remove", (req, res) => {
    const agentPath = String(req.body?.agentPath || "");
    if (!agentPath) return res.status(400).json({ error: "agentPath is required" });
    const out = removeDeployment(agentPath);
    if (out.error) return res.status(out.error.status ?? 400).json(out.error);
    if (out.removed) {
      void reportInstance(
        { id: agentPath, agentPath, enabled: false, status: "removed" },
        { env, seatId: seatId() },
      ).catch(() => {});
    }
    return res.json({ removed: out.removed, capacity: localFleetSnapshot({ env }).capacity });
  });

  // Pairing (slice ③): the user pastes a six-digit code minted in the Wanxing
  // console. The cell redeems it server-side (the seat id rides the process
  // env, planted by first-run bootstrap) and PERSISTS the returned uplink
  // credentials straight into settings.json — the token transits the renderer
  // as a success flag only, never as a value to re-submit.
  router.post("/pair", async (req, res) => {
    const runnerId = String(env.WANXING_PLUGIN_RUNNER_ID || "");
    if (!/^desktop-[A-Za-z0-9._-]{1,60}$/.test(runnerId)) {
      return res.status(503).json({ error: "seat_id_missing", message: "restart the app once so first-run seeds the seat id" });
    }
    const code = String(req.body?.code || "").trim();
    const machineName = String(req.body?.machineName || "").slice(0, 80) || null;
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "bad_code", message: "the pairing code is six digits" });
    }
    const file = settingsPath();
    if (!file) {
      return res.status(503).json({ error: "settings_unwritable", message: "no PLATFORM_DATA_DIR on this deployment" });
    }
    let doc;
    try {
      doc = await doFetch(`${consoleBase()}/api/wanxing/v1/console/devices/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, runnerId, machineName }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return res.status(502).json({ error: "console_unreachable" });
    }
    if (!doc.ok) {
      const body = await doc.json().catch(() => ({}));
      return res.status(doc.status === 401 ? 401 : 502).json({ error: body.error || "redeem_failed" });
    }
    const { fleetUrl, fleetToken } = await doc.json();
    // Merge into settings.json atomically: the desktop supervisor reads these
    // keys at construction (a runner restart applies them without an app
    // restart when the plugin is already on).
    let current = {};
    try {
      current = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { /* absent/corrupt — start fresh, the seeder re-adds defaults */ }
    atomicWriteJsonSync(file, { ...current, AGENT_RUNNER_FLEET_URL: fleetUrl, AGENT_RUNNER_FLEET_TOKEN: fleetToken });
    res.json({ ok: true, fleetUrl, runnerId });
  });

  ctx.app.use("/api/wanxing/fleet", router);
}
