// Identity-scoped runtime bindings. These routes never accept an email from the
// browser; identity comes from the trusted proxy-derived request object.

function identity(req) {
  return req.ssoUser || req.user || null;
}

function requireIdentity(req, res) {
  const user = identity(req);
  if (!user?.email) {
    res.status(401).json({ error: "Authentication is required" });
    return null;
  }
  return user;
}

export function registerUserBindingRoutes(ctx) {
  const { app, db } = ctx;

  app.get("/api/users/me/bindings", (req, res) => {
    const user = requireIdentity(req, res);
    if (!user) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "User bindings are disabled (database unavailable)" });
    }
    res.json(ctx.getUserBindings(user.email));
  });

  app.put("/api/users/me/model", async (req, res) => {
    const user = requireIdentity(req, res);
    if (!user) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "User bindings are disabled (database unavailable)" });
    }
    const { providerId, modelId } = req.body || {};
    const target = ctx.dshModels.find((m) => m.id === modelId && m.provider === providerId);
    if (!target) return res.status(400).json({ error: "Unknown provider or model" });
    try {
      db.setUserModelBinding(user.email, target.provider, target.id);
      // Flip the caller's toggles/pickers off the persisted row immediately;
      // the runtime apply below only reports ok/pending.
      ctx.pushUserBindingsTo?.(user.email);
      const result = await ctx.applyUserBindings(user.email, user.groups ?? null);
      res.json({ ok: result.ok, pending: result.pending, ...(result.error ? { error: result.error } : {}), binding: db.getUserModelBinding(user.email) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/users/me/mcp/:name/enable", async (req, res) => {
    const user = requireIdentity(req, res);
    if (!user) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "User bindings are disabled (database unavailable)" });
    }
    const { name } = req.params;
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") return res.status(400).json({ error: "Missing enabled (boolean)" });
    const server = ctx.extensionStore.getMcpServer(name);
    if (!server) return res.status(404).json({ error: `MCP server "${name}" not found` });
    if (server.locked && !enabled) return res.status(400).json({ error: `MCP server "${name}" is locked and cannot be disabled` });
    // A personal preference cannot turn on something the administrator turned
    // off globally — accepting it would store a switch that changes nothing.
    if (enabled && !server.enabled) {
      return res.status(400).json({ error: `MCP server "${name}" is disabled globally` });
    }
    try {
      db.setUserMcpBinding(user.email, name, enabled);
      // Push the persisted row to the caller's sockets right away — the
      // switch reflects it in milliseconds while the runtime hot-swap
      // (settle delay / queued behind a turn) finishes in the background.
      ctx.pushUserBindingsTo?.(user.email);
      const result = await ctx.applyUserBindings(user.email, user.groups ?? null);
      res.json({ ok: result.ok, pending: result.pending, ...(result.error ? { error: result.error } : {}), binding: { name, enabled } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/users/me/bindings/apply", async (req, res) => {
    const user = requireIdentity(req, res);
    if (!user) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "User bindings are disabled (database unavailable)" });
    }
    try {
      const result = await ctx.applyUserBindings(user.email, user.groups ?? null);
      res.json({ ok: result.ok, pending: result.pending, ...(result.error ? { error: result.error } : {}) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
