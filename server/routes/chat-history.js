// Chat history endpoints. Sessions are persisted to SQLite; the UI lists and
// views them read-only. Every session-scoped route is ownership-gated
// (add-session-ownership): the list is scoped to the requester, and
// read/delete/rename refuse a session the requester neither owns nor is
// admin for. With auth off there is one user (the machine owner) and the
// routes behave exactly as before.

import express from "express";

export function registerChatHistoryRoutes(ctx) {
  const { app, chatHistory } = ctx;

  // The REST gate: 403 on a foreign session, 404 on an unknown id. Auth-off
  // always passes (single-user contract).
  const gate = (req, id) => {
    const access = chatHistory.accessSession(req.user, id, {
      authEnabled: ctx.authEnabled,
      isAdmin: ctx.isAdminUser?.(req.user),
    });
    if (access.ok) return null;
    return access.reason === "forbidden"
      ? { status: 403, body: { error: "Session owner required" } }
      : { status: 404, body: { error: "session not found" } };
  };

  app.get("/api/chat-history/sessions", async (req, res) => {
    try {
      const scope = ctx.authEnabled
        ? ctx.isAdminUser?.(req.user)
          ? { includeAll: true }
          : { owner: req.user?.email ?? "" }
        : undefined;
      res.json({
        sessions: await chatHistory.listSessions(scope),
        current: chatHistory.currentSessionId(),
      });
    } catch (err) {
      console.error("[chat-history] list error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/chat-history/sessions/:id", async (req, res) => {
    const denial = gate(req, req.params.id);
    if (denial) return res.status(denial.status).json(denial.body);
    try {
      const sess = await chatHistory.getSession(req.params.id);
      if (!sess) return res.status(404).json({ error: "Not found" });
      res.json(sess);
    } catch (err) {
      console.error("[chat-history] get error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/chat-history/sessions", async (req, res) => {
    try {
      // Stamp the requester as owner (add-session-ownership): an ownerless
      // row is admin-only under auth-on, so an identity-less create would
      // hand back a session its own requester can never open.
      const owner = ctx.authEnabled ? req.user?.email ?? null : null;
      const id = await ctx.startNewSession(null, owner);
      res.json({ id });
    } catch (err) {
      console.error("[chat-history] new error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Hard-delete a session by id. 409 if the id is the currently-active session
  // (caller must switch first). 404 if the id does not exist. 403 if the
  // requester neither owns the session nor is admin. On success, every
  // connected client receives a refreshed, per-user-scoped `sessions` list so
  // the sidebar row disappears without a manual refetch.
  app.delete("/api/chat-history/sessions/:id", async (req, res) => {
    const { id } = req.params;
    const denial = gate(req, id);
    if (denial) return res.status(denial.status).json(denial.body);
    try {
      await chatHistory.deleteSession(id);
      ctx.sessionVersion = (ctx.sessionVersion || 0) + 1;
      res.json({ ok: true });
      void ctx.broadcastSessions();
    } catch (err) {
      if (err?.code === "active") return res.status(409).json({ error: err.message });
      if (err?.code === "not_found") return res.status(404).json({ error: err.message });
      console.error("[chat-history] delete error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Rename a session's title. 400 on validation (empty / overlong / control
  // chars); 404 if the id is unknown; 403 on a foreign session. The
  // `session_renamed` event reaches the connections viewing that session.
  app.patch("/api/chat-history/sessions/:id", express.json(), async (req, res) => {
    const { id } = req.params;
    const denial = gate(req, id);
    if (denial) return res.status(denial.status).json(denial.body);
    try {
      const title = chatHistory.setTitle(id, req.body?.title);
      ctx.sessionVersion = (ctx.sessionVersion || 0) + 1;
      res.json({ id, title });
      ctx.sendToViewers(id, { type: "session_renamed", id, title });
    } catch (err) {
      if (err?.code === "not_found") return res.status(404).json({ error: err.message, code: err.code });
      if (err?.code === "empty" || err?.code === "too_long" || err?.code === "control_chars") {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      console.error("[chat-history] rename error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
