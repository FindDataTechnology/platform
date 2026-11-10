// ── Plugin catalogue read + 申请供应 (unify-material-market) ──────────────────
//
// Two routes, both cell-side and both inside the "supply stays build-time"
// red line:
//
//   GET  /api/plugin-catalog           the curated catalogue with each row's
//                                      derived supply state and request state.
//   POST /api/plugin-supply-requests   record one ask for an unsupplied plugin.
//
// A request row is a NOTE TO THE OPERATOR, not an action: it never installs,
// downloads, unpacks, resolves, builds, or executes a plugin package. The
// operator's supply pipeline (profile manifest bundle list + dsh install
// matrix) is the only thing that puts a plugin on the deployment; this
// module's writes end at a JSON row. Accordingly this module performs no
// network I/O at all — the guard test enforces that.
//
// Persistence: one JSON file at <data>/plugin-supply-requests.json, written
// with the project's atomic temp+rename convention (gateway/mp-bindings.js,
// gateway/fleet-machines-store.js). It is a tiny append-only request list with
// no relational queries, so a sqlite table would add a migration for no gain.
// A JSON file survives restart, is inspectable by the supply pipeline, and
// lands beside the other cell data. PLUGIN_SUPPLY_REQUESTS_FILE overrides the
// path (the same family as DB_PATH / CRON_STORAGE_PATH).
//
// De-duplication is per (pluginId, deployment). Each deployment owns its own
// data dir, so the file alone separates deployments; the row still carries
// deploymentId so a merged/exported store stays unambiguous.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { storeDir } from "../../paths.js";
import { deriveRequestState, loadPluginCatalog, pluginSupplyState } from "../plugin-catalog.js";

const DEFAULT_DEPLOYMENT_ID = "local";

// Loaded lazily and exactly once per process. The write side serializes through
// a promise chain so two concurrent asks cannot interleave temp files; the
// in-memory list is the read source after `ready()`.
export function createPluginSupplyStore({ file }) {
  let rows = [];
  let loaded = null;
  let flushing = Promise.resolve();

  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      rows = Array.isArray(raw?.requests) ? raw.requests.filter((r) => r && typeof r.pluginId === "string") : [];
    } catch {
      // First boot or unreadable file: start empty. Requests are advisory
      // rows, not money — a corrupt file must not take the route down.
      rows = [];
    }
    return rows;
  }

  function ready() {
    loaded ??= load();
    return loaded;
  }

  function persist() {
    flushing = flushing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify({ requests: rows }, null, 2));
      await rename(tmp, file);
    });
    return flushing;
  }

  function list() {
    return rows.map((r) => ({ ...r }));
  }

  function find(pluginId, deploymentId) {
    return (
      rows.find(
        (r) => r.pluginId === pluginId && (r.deploymentId ?? DEFAULT_DEPLOYMENT_ID) === deploymentId,
      ) ?? null
    );
  }

  async function add(row) {
    rows.push(row);
    await persist();
    return { ...row };
  }

  return { ready, list, find, add, file };
}

export function registerPluginSupplyRoutes(ctx = {}, opts = {}) {
  const app = ctx.app;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const deploymentId = String(
    opts.deploymentId ?? env.PLUGIN_DEPLOYMENT_ID ?? DEFAULT_DEPLOYMENT_ID,
  );

  const storeFile = env.PLUGIN_SUPPLY_REQUESTS_FILE
    ? path.resolve(env.PLUGIN_SUPPLY_REQUESTS_FILE)
    : path.join(storeDir("data"), "plugin-supply-requests.json");
  const store = opts.store ?? createPluginSupplyStore({ file: storeFile });

  // The catalogue is the row set; the roster is the authority on supply. Both
  // are read per request — no caching, so an operator's catalogue edit or a
  // composition change is visible on the next read (the spec's point-in-time
  // snapshot contract).
  const catalogFn = opts.catalogFn ?? (() => loadPluginCatalog({ env }));
  const listBundles =
    opts.listBundles ??
    (async () => {
      const inventory = await ctx.getPluginBundles?.();
      return inventory?.bundles ?? ctx.pluginBundles ?? [];
    });

  // Auth off (dev / desktop / e2e machine owner) has no req.user; the
  // machine's owner email is the same fallback the assembled-context identity
  // path uses, and "owner@local" is the final, honest stand-in.
  const requesterOf = (req) => req.user?.email || ctx.cellUserEmail || "owner@local";

  const fail = (res, err) => {
    const status = err?.status || 500;
    res.status(status).json({ error: err?.message || "Internal error" });
  };

  app.get("/api/plugin-catalog", async (_req, res) => {
    try {
      const catalog = await Promise.resolve(catalogFn());
      const entries = Array.isArray(catalog) ? catalog : (catalog?.plugins ?? []);
      const bundles = await listBundles();
      await store.ready();
      const plugins = entries.map((entry) => {
        const state = pluginSupplyState(entry, bundles);
        const row = store.find(entry.id, deploymentId);
        const requestState = deriveRequestState(row, state);
        const view = { ...entry, state };
        if (requestState) view.requestState = requestState;
        if (requestState === "declined") view.declineReason = row.declineReason ?? null;
        return view;
      });
      res.json({ plugins });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/plugin-supply-requests", async (req, res) => {
    try {
      const pluginId = typeof req.body?.pluginId === "string" ? req.body.pluginId.trim() : "";
      if (!pluginId) return res.status(400).json({ error: "pluginId is required" });

      const catalog = await Promise.resolve(catalogFn());
      const entries = Array.isArray(catalog) ? catalog : (catalog?.plugins ?? []);
      const catalogVersion = Array.isArray(catalog) ? null : (catalog?.version ?? null);
      const entry = entries.find((e) => e?.id === pluginId);
      // An unknown id is a client bug or a stale tab whose catalogue moved on;
      // answering 400 keeps the requestable set exactly the catalogue.
      if (!entry) return res.status(400).json({ error: `Unknown plugin: ${pluginId}` });

      const bundles = await listBundles();
      if (pluginSupplyState(entry, bundles) !== "unsupplied") {
        // Already supplied: nothing to ask for, and writing a row would make
        // the operator's pipeline chase an item the deployment already has.
        return res.status(409).json({ error: "This plugin is already supplied with this deployment" });
      }

      await store.ready();
      const existing = store.find(pluginId, deploymentId);
      // Idempotent per (pluginId, deployment): the original row wins, its
      // requester and requested-at untouched. 200 (not 201) says "here it is".
      if (existing) return res.json({ request: existing });

      const row = await store.add({
        pluginId,
        deploymentId,
        catalogVersion,
        requester: requesterOf(req),
        requestedAt: now(),
        state: "requested",
        declineReason: null,
      });
      return res.status(201).json({ request: row });
    } catch (err) {
      return fail(res, err);
    }
  });

  return { store, deploymentId };
}
