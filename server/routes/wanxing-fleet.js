// ── Desktop fleet console lane (add-desktop-fleet-console) ───────────────────
//
// The desktop fleet page's read face: the cell server proxies the LOCAL
// runner's /health (loopback, same machine) and the PUBLIC registry's a2a
// directory (with the seat's existing registry credential). No new desktop
// credentials are introduced and the renderer never crosses origins.
//
// Both endpoints degrade honestly: a runner that is not enabled/running and a
// registry that is not configured are 503 + a machine-readable code the page
// renders as guidance, not an error toast.

import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJsonSync } from "../../lib/persistence.js";

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

  router.get("/catalog", async (_req, res) => {
    if (!registryBase()) {
      return res.status(503).json({ error: "registry_not_configured" });
    }
    try {
      const r = await doFetch(`${registryBase()}/api/agents?limit=500`, {
        headers: {
          Accept: "application/json",
          ...(registryToken() ? { Authorization: `Bearer ${registryToken()}` } : {}),
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        return res.status(502).json({ error: "registry_unreachable", status: r.status });
      }
      const doc = await r.json();
      const rows = Array.isArray(doc) ? doc : (doc?.agents ?? doc?.items ?? []);
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
      return res.json({ agents });
    } catch {
      return res.status(502).json({ error: "registry_unreachable" });
    }
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
