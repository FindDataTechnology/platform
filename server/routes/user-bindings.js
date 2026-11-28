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

  // ── Personal-data export (privacy: portability) ───────────────────────────
  //
  // Read-only by design. The audit's finding was "no export/erase/minimisation
  // implementation point"; export is the half that destroys nothing, so it
  // lands first and the erase cascade stays a product decision (what a delete
  // MAY destroy is not a call the implementation can make).
  //
  // Scope is exactly the rows keyed by this identity across the cells' personal
  // tables, plus session OWNERSHIP facts (id/title/timestamps — not message
  // bodies: those belong to the session archive, and copying them here would
  // quietly widen this endpoint into a transcript dump). Deployment-global
  // state is NOT personal data and is excluded on purpose:
  //   user_preferences  — keys like agent.preset / llm.effort.<provider>
  //   user_presets      — the shared custom-preset roster
  //   chart_bindings    — lineage-keyed, no identity column
  // Credential VALUES are masked; the export is a record of what is held, not
  // a second copy of the secrets.
  const PERSONAL_TABLES = [
    "user_model_bindings",
    "user_mcp_bindings",
    "user_registry_credentials",
    "user_connector_credentials",
    "user_search_credentials",
    "user_facet_market_devices",
    "user_paper_trading_credentials",
    "user_line_credentials",
    "user_ciyuan_account",
  ];

  const SECRET_COL = /(token|secret|key|password|credential|cookie|hash|dsn|url)$/i;
  const maskRow = (row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        SECRET_COL.test(k) && typeof v === "string" && v.length > 0 ? "<held>" : v,
      ]),
    );

  app.get("/api/users/me/export", (req, res) => {
    const user = requireIdentity(req, res);
    if (!user) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "User data is disabled (database unavailable)" });
    }
    const email = user.email;
    const data = {};
    for (const table of PERSONAL_TABLES) {
      data[table] = db.listPersonalRows(table, email).map(maskRow);
    }
    res.json({
      identity: { email },
      exportedAt: new Date().toISOString(),
      // What this file is and is not, so a reader never mistakes it for a full
      // account archive.
      scope: {
        personalTables: PERSONAL_TABLES,
        excludes: ["user_preferences", "user_presets", "chart_bindings", "session message bodies"],
        secrets: "masked",
      },
      data,
      // Ownership facts only (id/title/timestamps/workspace), never bodies:
      // message content lives in the session archive and is not this endpoint's to copy.
      sessions: db.listChatSessions({ owner: email }),
    });
  });

  // ── Personal-data erase (privacy: the destructive half) ───────────────────
  //
  // Scope decision, made explicit because it is not the implementation's to
  // invent: PERSONAL ROWS GO, CONVERSATION CONTENT STAYS, and the only thing
  // that happens to sessions is that their ownership is detached — the row says
  // "someone ran these turns", which is a personal fact, while the transcript
  // may be shared material a teammate still reads.
  //
  // Requires an explicit confirmation token. A destructive endpoint that fires
  // on a bare DELETE is one stray retry away from wiping a real account, and the
  // UI's own ConfirmDialog already carries the human acknowledgement.
  app.delete("/api/users/me/data", (req, res) => {
    const user = requireIdentity(req, res);
    if (!user) return;
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "User data is disabled (database unavailable)" });
    }
    const confirm = req.body?.confirm ?? req.query?.confirm;
    if (confirm !== "erase") {
      return res.status(400).json({
        error: 'Confirmation required: send { "confirm": "erase" }',
        scope: {
          deletes: "rows keyed by your identity in the personal tables",
          detaches: "session ownership (conversation content is kept)",
          keeps: ["user_preferences", "user_presets", "chart_bindings", "session messages and documents"],
        },
      });
    }
    const result = db.erasePersonalRows?.(user.email) ?? null;
    if (!result) return res.status(503).json({ error: "User data is disabled" });
    console.log(`[privacy] erased personal rows for ${user.email}: ${JSON.stringify(result.deleted)}, detached ${result.detachedSessions} session(s)`);
    res.json({
      erased: true,
      deleted: result.deleted,
      detachedSessions: result.detachedSessions,
      kept: ["user_preferences", "user_presets", "chart_bindings", "session messages and documents"],
    });
  });

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
