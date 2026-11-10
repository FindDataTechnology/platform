// Internal (service-credential) pack routes — extracted from gateway/packs.js
// under optimize-paas-module-audit N-9.
//
// These routes are the serving plane's read/write face: 万星's facade and the
// runner fleet read deployment bookkeeping and open visitor matters here instead
// of touching the registry in-process, so extracting the marketplace into the
// facet service only repoints a base URL. They share exactly one thing with the
// rest of the router — `registry` — plus the service-credential gate built from
// `deployConfig()`, which is why they lift out cleanly while the publish/billing
// halves (which thread ~30 closures) do not yet.
//
// Behavior is byte-identical to the in-place block: same order (the literal
// "internal" paths must be registered before `/api/packs/:id/...` captures),
// same gate, same shapes. The route-surface guard
// (scripts/test-packs-route-surface.mjs) pins that nothing moved out of the
// inventory. A verbatim copy-paste twin of the serving-capability probe used to
// sit in this block and never dispatched — that dead registration is gone.

import express from "express";
import { createSub2apiClient } from "../lib/sub2api-admin.js";

// The service-credential gate. Exported because two config routes stayed in
// packs.js (their handlers thread a console-verified-actor helper) and must
// answer 401 on exactly the same rule — one implementation, two mount points.
export function createInternalAuth(deployConfig) {
  return (req, res) => {
    const token = deployConfig()?.token || "";
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: "runner service credential required" });
      return false;
    }
    return true;
  };
}

export function registerInternalPackRoutes(app, { registry, deployConfig }) {
  const internalAuth = createInternalAuth(deployConfig);
app.get("/api/packs/internal/deployments", (req, res) => {
  if (!internalAuth(req, res)) return;
  res.json({ deployments: registry.allDeployments() });
});
app.get("/api/packs/internal/deployments/:id", (req, res) => {
  if (!internalAuth(req, res)) return;
  res.json({ deployments: registry.deployments(req.params.id) });
});
app.get("/api/packs/internal/author/:id", (req, res) => {
  if (!internalAuth(req, res)) return;
  res.json({ authorEmail: registry.authorEmail(req.params.id) });
});

// Internal: the runner fleet (add-runner-fleet-sharding D2) — placement
// surfaces (console deploy picker, facade) read the machines and their
// port geometry over the same service-credential gate as the deployments.
app.get("/api/packs/internal/runners", (req, res) => {
  if (!internalAuth(req, res)) return;
  res.json({ runners: registry.runnerList() });
});

// Internal: deployment-level host settlement (wanxing add-agent-chat-lane
// D5). The wanxing facade settles chat-lane turns whose settler is the
// host's allowance here — the deployment's billing key never travels to
// the facade. Same per-deployment addressing convention as the config
// twin (packId + agentId, both URL-encoded single segments). Body
// {usage_id, minutes, rate_usd_per_min?}: minutes are the facade's
// minute-rounded billable duration; the rate defaults to the facade's own
// default so both planes stay one env apart. Idempotent by usage_id: a
// replay answers duplicate without deducting (the upstream deduction is
// idempotency-keyed the same way, so a crash between the upstream success
// and the local insert still lands once).
app.post("/api/packs/internal/deployments/:packId/:agentId/host-settle", express.json({ limit: "4kb" }), async (req, res) => {
  if (!internalAuth(req, res)) return;
  const { usage_id, minutes, rate_usd_per_min } = req.body ?? {};
  if (typeof usage_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(usage_id)) {
    return res.status(400).json({ error: "usage_id must be a short identifier string" });
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    return res.status(400).json({ error: "minutes must be an integer in [1, 1440]" });
  }
  const rate = rate_usd_per_min === undefined
    ? Number(process.env.WANXING_RATE_PER_MIN ?? 0.1)
    : Number(rate_usd_per_min);
  if (!Number.isFinite(rate) || rate <= 0 || rate > 10) {
    return res.status(400).json({ error: "rate_usd_per_min must be a positive number ≤ 10" });
  }
  if (registry.hostSettlement(usage_id)) {
    return res.json({ settled: true, duplicate: true });
  }
  const key = registry.deploymentKeyForAgent(
    decodeURIComponent(req.params.packId),
    decodeURIComponent(req.params.agentId),
    typeof req.body?.deployed_by === "string" && req.body.deployed_by ? req.body.deployed_by : null,
  );
  if (!key) {
    // Distinguish "no such deployment" from "deployment exists but was never
    // issued a billing key" (fix-zhiyu-seat-settle-missing-billing-key D2): one
    // flat 404 hid the real cause, so a seat answered happily while every turn
    // went unbilled. Callers get a code they can act on and annotate.
    const packId = decodeURIComponent(req.params.packId);
    const agentId = decodeURIComponent(req.params.agentId);
    const deployer = typeof req.body?.deployed_by === "string" && req.body.deployed_by ? req.body.deployed_by : null;
    let exists = false;
    try {
      exists = registry.deployments(packId).some((d) => d.agentId === agentId && (!deployer || d.deployedBy === deployer));
    } catch {
      exists = false; // an unreadable registry is not a deployment
    }
    if (exists) {
      return res.status(409).json({ error: "no billing key for this deployment", code: "NO_BILLING_KEY", packId, agentId, deployer });
    }
    return res.status(404).json({ error: "no such deployment", code: "NO_SUCH_DEPLOYMENT" });
  }
  const sub2api = deployConfig().sub2api ? createSub2apiClient(deployConfig().sub2api) : null;
  if (!sub2api || sub2api.degraded()) {
    return res.status(503).json({ error: "billing plane not configured" });
  }
  const amount = Number((minutes * rate).toFixed(4));
  let holder;
  try {
    holder = await sub2api.findUserByKey(key.keyValue);
  } catch (err) {
    return res.status(502).json({ error: `key holder resolution failed: ${err.message}` });
  }
  if (!holder) return res.status(404).json({ error: "billing key no longer resolves to an account" });
  try {
    await sub2api.adjustBalance({
      userId: holder.userId,
      amountUsd: amount,
      operation: "subtract",
      idempotencyKey: usage_id,
    });
  } catch (err) {
    // A retry whose deduction already landed upstream surfaces as a
    // duplicate refusal — that IS settled, matching the facade's own
    // trySettle semantics; anything else is a retryable failure.
    if (!/duplicate|idempoten/i.test(String(err?.message || ""))) {
      return res.status(502).json({ error: `deduction failed: ${err.message}` });
    }
  }
  try {
    registry.recordHostSettlement({
      usageId: usage_id, agentPath: `/${decodeURIComponent(req.params.packId)}/${decodeURIComponent(req.params.agentId)}`,
      minutes, amountUsd: amount, deployer: key.deployer,
    });
  } catch { /* concurrent twin already inserted — still exactly one deduction */ }
  console.log(`[packs] host-settle ${usage_id}: ${minutes}min $${amount} on ${req.params.packId}/${req.params.agentId} (deployer ${key.deployer})`);
  res.json({ settled: true, duplicate: false, amountUsd: amount });
});

// Internal: matters (add-matter-threads D6). The serving runner's facade
// tool trio calls these — open (the reception escalates a visitor's
// question), list (matter_status), read one (matter_read). Same
// per-deployment addressing and service-credential gate as host-settle;
// the deployer for the row is the deployment's bookkeeping deployer, not
// the caller. Matter text never enters a log line here or in the runner.
app.post("/api/packs/internal/matters/:packId/:agentId/open", express.json({ limit: "8kb" }), (req, res) => {
  if (!internalAuth(req, res)) return;
  const packId = decodeURIComponent(req.params.packId);
  const agentId = decodeURIComponent(req.params.agentId);
  // Deploy tenancy: (pack, agent) is ambiguous across deployers — the
  // runner supplies the descriptor's agent_path (unique); old runners
  // without it fall back to the (pack, agent, first-row) legacy shape.
  const agentPathRaw = typeof req.body?.agent_path === "string" ? req.body.agent_path : "";
  const deps = registry.deployments(packId);
  const dep = (agentPathRaw ? deps.find((d) => d.agentPath === agentPathRaw) : null)
    ?? deps.find((d) => d.agentId === agentId);
  if (!dep) return res.status(404).json({ error: "no such deployment" });
  const summary = typeof req.body?.summary === "string" ? req.body.summary.trim() : "";
  if (!summary || summary.length > 2000) {
    return res.status(400).json({ error: "summary must be a non-empty string of at most 2000 characters" });
  }
  const visitorHintRaw = typeof req.body?.visitor_hint === "string" ? req.body.visitor_hint.trim().slice(0, 300) : "";
  // Visitor scope (add-matter-visitor-scope): the runner supplies the calling
  // session's opaque scope when it has one; absent = unscoped (v1 shape —
  // the boundary must never block the escalation outlet itself).
  const scopeRaw = typeof req.body?.visitor_scope === "string" ? req.body.visitor_scope.trim().slice(0, 128) : "";
  const out = registry.matterOpen({
    packId, agentId, deployer: dep.deployedBy, summary,
    visitorHint: visitorHintRaw,
    ...(scopeRaw ? { scopeKey: scopeRaw } : {}),
  });
  res.json(out);
});
app.get("/api/packs/internal/matters/:packId/:agentId", (req, res) => {
  if (!internalAuth(req, res)) return;
  // Least-privilege degradation: a sessionless reader sees only the unscoped
  // v1 rows; a scoped reader sees its own plus those. (Owner routes are a
  // different surface and stay unfiltered.)
  const scope = typeof req.query.visitor_scope === "string" ? req.query.visitor_scope.slice(0, 128) : "";
  res.json({
    matters: registry.mattersForDeployment(
      decodeURIComponent(req.params.packId),
      decodeURIComponent(req.params.agentId),
      scope || "__sessionless__",
    ),
  });
});
app.get("/api/packs/internal/matters/:packId/:agentId/:mid", (req, res) => {
  if (!internalAuth(req, res)) return;
  const m = registry.matterRead(req.params.mid);
  const packOk = m && m.packId === decodeURIComponent(req.params.packId) && m.agentId === decodeURIComponent(req.params.agentId);
  if (!packOk) return res.status(404).json({ error: "no such matter" });
  const scope = typeof req.query.visitor_scope === "string" ? req.query.visitor_scope.slice(0, 128) : "";
  if (m.scopeKey != null && m.scopeKey !== scope) {
    // Another session's matter: same-shape 404 — existence itself is the
    // disclosure boundary (add-matter-visitor-scope).
    return res.status(404).json({ error: "no such matter" });
  }
  res.json({ matter: m });
});
}
