// LLM provider management (Models page) + runtime model-list refresh.

import { guardDefaultLane } from "../llm-guard.js";

export function registerLlmRoutes(ctx) {
  const { app, broadcast } = ctx;

  // The LLM routes read the dsh model list / live session — until the
  // (listen-first) boot finishes the agent, they answer 503 instead of
  // serving empty state.
  const notReady = (_req, res) => res.status(503).json({ error: "initializing" });
  app.use("/api/llm", (req, res, next) => (ctx.ready.dsh ? next() : notReady(req, res)));

  // Refresh the dsh model list at runtime (design D3 / spike 2). Re-runs
  // writeLlmProfile; dsh-settings-file hot-reloads the llm-pi-ai: section so new
  // models reach the adapter without a restart. The active model is untouched.
  // Admin-gated under forward-auth (a config mutation).
  app.post("/api/models/refresh", async (req, res) => {
    if (ctx.authEnabled && !ctx.isAdminUser?.(req.user)) {
      return res.status(403).json({ error: "Admin group required" });
    }
    try {
      const models = await ctx.refreshDshModels();
      res.json({ models });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // After a provider add/edit/delete: refresh the credentials file + the
  // llm-pi-ai profile. Both are Chokidar-watched by dsh (settings-file +
  // credentials-local), so the new route and key hot-reload with no dsh
  // restart — the same path /api/models/refresh relies on. Then update
  // dshModels and broadcast so the sidebar/model chip and the Models page
  // pick up the new model ids immediately.
  async function reloadLlmProviders() {
    const dshProfile = await import("../../dsh-profile.js");
    await dshProfile.ensureCredentialsStore({ cellOwnerEmail: ctx.cellUserEmail || null });
    const { models } = await dshProfile.writeLlmProfile();
    ctx.dshModels = models;
    broadcast({ type: "models", models: await ctx.getAvailableModels() });
  }

  // The caller's own identity (session or app token). Personal providers are
  // keyed on it; a null owner simply sees the platform default, which is the
  // pre-change behaviour for every unconfigured caller.
  function ownerEmail(req) {
    if (req.user?.email) return req.user.email;
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return ctx.appAuth?.accountFromToken?.(token)?.email ?? null;
  }

  // The upstream allowlist, so the UI never hardcodes a second copy
  // (credential-tech-debt #5). A UI that offers a URL the API rejects is the
  // "configured but ineffective" failure this repository keeps re-learning.
  app.get("/api/llm/upstreams", async (_req, res) => {
    try {
      const llmProviders = await import("../../llm-providers.js");
      res.json({
        upstreams: llmProviders.KNOWN_LLM_UPSTREAMS.map(({ id, label, baseUrl }) => ({
          id, label, baseUrl,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/llm/providers", async (req, res) => {
    try {
      const llmProviders = await import("../../llm-providers.js");
      const owner = ownerEmail(req);
      // The env-generated Volces route is the reserved, always-present provider
      // (add-editable-llm-route): its roster and base URL resolve override >
      // env > baked constant, so the card shows the *effective* lane plus an
      // override indicator. Discovery persists on the override after a sync.
      const envProviders = [];
      if (process.env.LLM_API_KEY?.trim()) {
        const dshProfile = await import("../../dsh-profile.js");
        const { baseURL, hasOverride, models: envRoster } = await dshProfile.effectiveCiyuanRoute();
        const override = llmProviders.getCiyuanOverride();
        // Same per-entry metadata the user providers expose, so the roster
        // editor prefills what the runtime resolves instead of its own mirror
        // (fix-model-window-family-reconcile).
        const modelMeta = {};
        for (const m of envRoster) {
          const meta = llmProviders.effectiveModelMeta(m);
          modelMeta[m.id] = { ...meta, ...(m.metaPinned ? { pinned: true } : {}) };
        }
        envProviders.push({
          id: "ciyuan",
          name: "萬星词元",
          baseUrl: baseURL,
          type: "openai-completions",
          hasKey: true,
          reserved: true,
          models: ctx.dshModels.filter((m) => llmProviders.canonicalProviderId(m.provider) === "ciyuan").map((m) => m.id),
          modelMeta,
          lastTest: null,
          discovery: override?.discovery || null,
          override: {
            active: hasOverride,
            ...(override?.baseUrl ? { baseUrl: override.baseUrl } : {}),
            rosterSize: override?.models?.length ?? 0,
          },
        });
      }
      const personal = owner
          ? await llmProviders.listProvidersForOwner(owner)
          : llmProviders.listRawUserProviders();
        // `listProvidersForOwner` returns RAW records; `listUserProviders`
        // already applied clientRecord. Normalise: ask for raw in both branches.
        res.json({
          providers: [...envProviders, ...personal.map((p) => llmProviders.clientRecord(p))],
        });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/llm/providers", async (req, res) => {
    // Two audiences, two scopes (add-user-supplied-credentials, L1):
    //   · admin → the PLATFORM DEFAULT provider list (unchanged behaviour);
    //   · any other identified user → THEIR OWN list, which only affects them.
    // An anonymous caller gets neither, so this stays fail-closed.
    const owner = ownerEmail(req);
    // Pure predicate — requireAdmin would emit its own 403, which is wrong here:
    // a non-admin with an identity is allowed to manage their OWN providers.
    const isAdmin = ctx.authEnabled ? Boolean(ctx.isAdminUser?.(req.user)) : true;
    if (!isAdmin && !owner) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const llmProviders = await import("../../llm-providers.js");
      const record = await llmProviders.tryWithWriteLock(async () => {
        const created = isAdmin
          ? llmProviders.createProvider(req.body || {})
          : await llmProviders.createProviderForOwner(owner, req.body || {});
        await reloadLlmProviders();
        return created;
      });
      res.status(201).json({ provider: record });
    } catch (err) {
      const status =
        err?.code === "busy" ? 409 :
        err?.code === "duplicate" ? 409 :
        err?.code === "invalid" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err?.code });
    }
  });

  app.put("/api/llm/providers/:id", async (req, res) => {
    const owner = ownerEmail(req);
    // Pure predicate — requireAdmin would emit its own 403, which is wrong here:
    // a non-admin with an identity is allowed to manage their OWN providers.
    const isAdmin = ctx.authEnabled ? Boolean(ctx.isAdminUser?.(req.user)) : true;
    if (!isAdmin && !owner) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const llmProviders = await import("../../llm-providers.js");
      const record = await llmProviders.tryWithWriteLock(async () => {
        // A non-admin may only edit a provider they own; editing a platform
        // default is refused by updateProviderForOwner's not_found.
        const updated = isAdmin
          ? llmProviders.updateProvider(req.params.id, req.body || {})
          : await llmProviders.updateProviderForOwner(owner, req.params.id, req.body || {});
        await reloadLlmProviders();
        return updated;
      });
      res.json({ provider: record });
    } catch (err) {
      const status =
        err?.code === "busy" ? 409 :
        err?.code === "not_found" ? 404 :
        err?.code === "duplicate" ? 409 :
        err?.code === "invalid" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err?.code });
    }
  });

  app.delete("/api/llm/providers/:id", async (req, res) => {
    const owner = ownerEmail(req);
    // Pure predicate — requireAdmin would emit its own 403, which is wrong here:
    // a non-admin with an identity is allowed to manage their OWN providers.
    const isAdmin = ctx.authEnabled ? Boolean(ctx.isAdminUser?.(req.user)) : true;
    if (!isAdmin && !owner) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const llmProviders = await import("../../llm-providers.js");
      await llmProviders.tryWithWriteLock(async () => {
        if (isAdmin) {
          llmProviders.deleteProvider(req.params.id);
        } else if (!llmProviders.deleteOwnerProvider(owner, req.params.id)) {
          // Idempotent only for rows that exist; a foreign id must not look
          // like a successful delete (that would hide a wrong-id bug).
          throw Object.assign(new Error("provider not found for this owner"), { code: "not_found" });
        }
        await reloadLlmProviders();
      });
      res.json({ ok: true });
    } catch (err) {
      const status =
        err?.code === "busy" ? 409 :
        err?.code === "not_found" ? 404 :
        err?.code === "only_provider" ? 409 :
        err?.code === "invalid" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err?.code });
    }
  });

  // Clear the reserved route's override (add-editable-llm-route): the rollback
  // to the env/baked projection. A no-op returning ok when none is active, so
  // the UI's clear button is idempotent.
  app.post("/api/llm/providers/:id/clear-override", async (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    try {
      const llmProviders = await import("../../llm-providers.js");
      if (llmProviders.canonicalProviderId(req.params.id) !== "ciyuan") {
        return res.status(404).json({ error: `provider ${req.params.id} not found` });
      }
      await llmProviders.tryWithWriteLock(async () => {
        llmProviders.clearCiyuanOverride();
        await reloadLlmProviders();
      });
      res.json({ ok: true, cleared: true });
    } catch (err) {
      const status =
        err?.code === "busy" ? 409 :
        err?.code === "not_found" ? 404 :
        err?.code === "invalid" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err?.code });
    }
  });

  app.post("/api/llm/providers/:id/test", async (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    try {
      const llmProviders = await import("../../llm-providers.js");
      const result = await llmProviders.testProvider(req.params.id);
      res.json(result);
    } catch (err) {
      const status =
        err?.code === "not_found" ? 404 :
        err?.code === "invalid" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err?.code });
    }
  });

  // Reconcile a provider's roster against its own gateway
  // (add-llm-model-discovery). Classification runs before the write lock; the
  // merge + the same hot-reload path run inside it, so a synced id reaches
  // connected clients' pickers with no restart. The reserved env route
  // ("volces") is a dry run: classification is returned, nothing is written.
  // One long-lived request (33 ids ≈ 25–60s worst case) — an operator action,
  // the UI shows a spinner.
  app.post("/api/llm/providers/:id/sync", async (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    try {
      const llmProviders = await import("../../llm-providers.js");
      const result = await llmProviders.syncProvider(req.params.id, { reload: reloadLlmProviders });
      // Default-lane guard (design D5): a fresh classification may have just
      // marked the default dark — apply the boot fallback semantics and let
      // the model_fallback broadcast carry the substitution to clients.
      guardDefaultLane(ctx, { reason: "sync" }).catch((e) =>
        console.warn(`[llm-guard] post-sync guard failed: ${e.message}`)
      );
      res.json(result);
    } catch (err) {
      const status =
        err?.code === "busy" ? 409 :
        err?.code === "not_found" ? 404 :
        err?.code === "invalid" ? 400 : 500;
      res.status(status).json({ error: err.message, code: err?.code });
    }
  });

  app.get("/api/llm/default", async (_req, res) => {
    try {
      const llmProviders = await import("../../llm-providers.js");
      const saved = llmProviders.getDefault();
      res.json({
        providerId: saved.providerId,
        modelId: saved.modelId || ctx.defaultModel?.id || null,
        activeModelId: ctx.session?.model?.id || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/llm/default", async (req, res) => {
    if (!ctx.requireAdmin(req, res)) return;
    try {
      const llmProviders = await import("../../llm-providers.js");
      const { modelId, providerId } = req.body || {};
      const target = ctx.dshModels.find((m) => m.id === modelId);
      if (!target) return res.status(400).json({ error: `Unknown model: ${modelId}` });
      const saved = llmProviders.setDefault({ modelId, providerId: providerId || target.provider });
      ctx.defaultModel = { id: target.id, provider: target.provider, name: target.name || target.id };
      broadcast({ type: "model_changed", id: target.id });
      // Default-lane guard (design D5): verify the fresh pointer actually
      // serves; a dark choice is corrected with the same fallback semantics as
      // boot so the admin sees the substitution instead of a broken next turn.
      guardDefaultLane(ctx, { reason: "default_set" }).catch((e) =>
        console.warn(`[llm-guard] post-set guard failed: ${e.message}`)
      );
      res.json({ providerId: saved.providerId, modelId: saved.modelId });
    } catch (err) {
      res.status(err?.code === "invalid" ? 400 : 500).json({ error: err.message, code: err?.code });
    }
  });
}
