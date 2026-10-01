// ── Resource library REST surface (openspec: add-resource-library) ───────────
//
// List, save a workspace file, rename, delete. Mutations broadcast
// `resources_changed` from the service; the event payload is deliberately thin
// (action + id + type) and clients refetch — library lists are small, and that
// removes all client-side merge logic.
//
// Byte serving is NOT here: stored files are served by the file route's
// `root=resources` (server/routes/files.js), inheriting its containment,
// disposition and Range/ETag behavior unchanged.
//
// Bound-chart routes (openspec: add-chart-data-binding) ride the same gate and
// the same broadcast event: attach from a retained candidate, detach, set the
// refresh rule, trigger a refresh, read the observation timeline, and ask for
// the chart as of a past moment. No new auth mechanism — these are the cell's
// own client API, and the declared channel uses its own loopback route.

import * as bindings from "../../chart-bindings.js";
import * as chartRefresh from "../../chart-refresh.js";
import * as db from "../../db.js";
import * as resources from "../../resources.js";

function errorResponse(res, err) {
  res.status(err.status || 500).json({ error: err.message, code: err.code || "error" });
}

function notFound(res) {
  return res.status(404).json({ error: "资源不存在", code: "resource_not_found" });
}

export function registerResourceRoutes(ctx) {
  const { app } = ctx;

  app.get("/api/resources", (req, res) => {
    const { type, q, limit, offset } = req.query ?? {};
    res.json(
      resources.list({
        type: typeof type === "string" && type ? type : null,
        q: typeof q === "string" && q.trim() ? q.trim() : null,
        limit,
        offset,
      })
    );
  });

  app.post("/api/resources", async (req, res) => {
    const body = req.body ?? {};
    try {
      const result = await resources.saveFile({
        sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
        messageId: Number.isInteger(body.messageId) ? body.messageId : null,
        path: body.path,
        // The agent workspace, same source as the file-serving route's
        // `workspace` root — a file must be inside the workspace to be saved.
        workspaceRoot: ctx.dshBridge?.getCwd?.() || process.cwd(),
      });
      // inserted=false is a success with an explanation ("already in the
      // library"), not an error — the client shows the difference.
      res.json({ inserted: result.inserted, resource: result.resource });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  // The same-turn calls a chart was drawn from, with the map each would bind
  // with. A dedicated route rather than a field on the resource: candidate
  // results are capped but large, and list responses must stay small.
  app.get("/api/resources/:id/candidates", (req, res) => {
    try {
      const row = resources.get(req.params.id);
      if (!row) return notFound(res);
      res.json({ candidates: bindings.candidatesForResource(row) });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.post("/api/resources/:id/bindings", (req, res) => {
    const body = req.body ?? {};
    try {
      // Confirmation path: the user picked one of the retained candidates.
      if (body.candidateIndex !== undefined || body.candidate === undefined) {
        const result = resources.attachFromCandidate(req.params.id, {
          candidateIndex: Number(body.candidateIndex) || 0,
          seriesIndex: Number.isInteger(body.seriesIndex) ? body.seriesIndex : 0,
          map: body.map ?? null,
        });
        return res.json({ binding: resources.bindingView(result.binding), resource: result.resource });
      }
      // Explicit path (same shape the declared channel records): a caller that
      // knows the exact call, used by tests and by the operator tooling.
      const candidate = body.candidate ?? {};
      const result = bindings.attachBinding({
        resourceId: req.params.id,
        seriesIndex: Number.isInteger(body.seriesIndex) ? body.seriesIndex : 0,
        server: candidate.server,
        tool: candidate.tool,
        args: candidate.args ?? {},
        map: body.map ?? null,
        origin: body.origin === "declared" ? "declared" : "confirmed",
        concept: candidate.args?.concept_id ?? body.concept ?? null,
        frequency: body.frequency ?? candidate.frequency ?? null,
        unit: body.unit ?? candidate.unit ?? null,
      });
      res.json({ binding: resources.bindingView(result.binding), resource: resources.get(req.params.id) });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.delete("/api/resources/:id/bindings/:bindingId", (req, res) => {
    try {
      const result = resources.detach(req.params.id, req.params.bindingId);
      res.json({ detached: true, bindingId: result.bindingId, resource: result.resource });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.patch("/api/resources/:id/bindings/:bindingId/refresh-rule", (req, res) => {
    try {
      const result = resources.setRefreshRule(req.params.id, req.params.bindingId, req.body?.refreshRule ?? null);
      res.json(result);
    } catch (err) {
      errorResponse(res, err);
    }
  });

  // One refresh, on the user's action or on open past the binding's TTL. The
  // outcome is a value, not an error: a failed refresh is a recorded fact with
  // a reason (and the chart keeps rendering its last good data).
  app.post("/api/resources/:id/bindings/:bindingId/refresh", async (req, res) => {
    try {
      const row = resources.get(req.params.id);
      if (!row) return notFound(res);
      if (!bindings.refsOf(row).some((r) => r.bindingId === req.params.bindingId)) {
        return res.status(404).json({ error: "该资源未引用此绑定", code: "binding_not_attached" });
      }
      const trigger = req.body?.trigger === "on-open" ? "on-open" : "manual";
      const result = await chartRefresh.refreshBinding(req.params.bindingId, { trigger });
      res.json({ ...result, resource: resources.get(req.params.id) });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  // The observation timeline: one entry per refresh across the resource's
  // bindings, filterable by observation time, each with its change counts.
  app.get("/api/resources/:id/observations", (req, res) => {
    try {
      const row = resources.get(req.params.id);
      if (!row) return notFound(res);
      const refs = bindings.refsOf(row);
      const { since, until, limit, offset, bindingId } = req.query ?? {};
      const wanted = bindingId ? refs.filter((r) => r.bindingId === bindingId) : refs;
      if (!wanted.length) return res.json({ items: [], total: 0, limit: Number(limit) || 50, offset: 0 });
      const cap = Math.min(Math.max(1, Number(limit) || 50), 500);
      const items = [];
      let total = 0;
      for (const ref of wanted) {
        const page = resources.observationsFor(ref.bindingId, { since, until, limit: cap, offset: 0 });
        total += page.total;
        items.push(...page.items.map((item) => ({ ...item, bindingId: ref.bindingId, seriesIndex: ref.seriesIndex })));
      }
      items.sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : a.fetchedAt > b.fetchedAt ? -1 : 0));
      const skip = Math.max(0, Number(offset) || 0);
      res.json({ items: items.slice(skip, skip + cap), total, limit: cap, offset: skip });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  // The chart as it stood at a moment: reconstructed from the point log, not
  // from a stored snapshot.
  app.get("/api/resources/:id/as-of", (req, res) => {
    try {
      const row = resources.get(req.params.id);
      if (!row) return notFound(res);
      const at = typeof req.query?.at === "string" && !Number.isNaN(Date.parse(req.query.at))
        ? new Date(req.query.at).toISOString()
        : null;
      if (!at) return res.status(400).json({ error: "at 参数需要 ISO 时间", code: "invalid_at" });
      const view = chartRefresh.asOfOption(row, at);
      if (!view) return res.status(404).json({ error: "该时刻没有可用数据", code: "no_observation" });
      res.json({ at, option: view.option, periods: view.periods });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  // The declared channel's landing point (openspec: add-chart-data-binding 3.3).
  // The dsh child's `chart_bind` tool posts here over loopback — see the auth
  // gate's loopback exemption — and the declaration lands on the chart THIS
  // turn produced: the platform's own runtime session, since the turn started.
  // A declaration can therefore never reach another session's chart, and the
  // route is rejected for anything but a loopback caller.
  app.post("/api/resources/bind-declared", (req, res) => {
    try {
      const body = req.body ?? {};
      const sessionId = ctx.dshSessionId ?? null;
      const chart = sessionId ? db.latestChartForSession(sessionId, ctx.dshTurnStartedAt ?? null) : null;
      if (!chart) {
        return res.status(404).json({
          error: "本轮还没有捕获到图表：先画出 ```echarts 图表，再声明它的数据来源",
          code: "no_chart_in_turn",
        });
      }
      const result = bindings.attachDeclared({
        resourceId: chart.id,
        tool: body.tool,
        args: body.args ?? {},
        map: body.map ?? null,
        note: typeof body.note === "string" ? body.note : null,
      });
      res.json({ ok: true, binding: resources.bindingView(result.binding), note: result.note });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.patch("/api/resources/:id", (req, res) => {
    try {
      const resource = resources.rename(req.params.id, req.body?.title);
      if (!resource) return notFound(res);
      res.json({ resource });
    } catch (err) {
      errorResponse(res, err);
    }
  });

  app.delete("/api/resources/:id", async (req, res) => {
    try {
      const removed = await resources.remove(req.params.id);
      if (!removed) return notFound(res);
      res.json({ removed: { id: removed.id, type: removed.type } });
    } catch (err) {
      errorResponse(res, err);
    }
  });
}