// ── Action gate routes (add-line-boards-and-action-gate) ────────────────────
//
// POST /api/actions/propose — create a proposal (model or board button)
// POST /api/actions/:id/approve — approve (owner-only); body may carry userArgs
// POST /api/actions/:id/reject — reject
// GET /api/actions/:id — query proposal
//
// All executions go through a single executor path (lib/action-executor.js,
// add-wire-line-board D3); audit is written here. No secrets in logs or
// responses.

import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { getDb, nowIso } from "../../db.js";
import {
  filterKnownArgs,
  getAction,
  isRegistered,
  riskToTierMap,
  stripUserFilledArgs,
  userFilledArgsFor,
  validateArgs,
  validateUserFilledArgs,
} from "../../lib/action-registry.js";
import { preflightAction } from "../../lib/action-preflight.js";
import { executeRegisteredAction, ExecutorError } from "../../lib/action-executor.js";
import { DECISION } from "../../lib/personal-mandate.js";
import { getFleetDatabase } from "./fleets-db.js";
import { secretMatches } from "../auth.js";
import { gateOutboundMessage } from "../../lib/outbound-message.js";

/**
 * Mandate context for a proposal (add-personal-mandate 3.1/3.4).
 *
 * Only the loopback actions-mcp child may claim a mandate: a cookie caller
 * asking for `mandateDomain` would be granting itself authority, and the whole
 * point of the gate is that authority is not self-served. Browser callers
 * therefore always resolve to null → preflight is byte-identical to before.
 *
 * `usage` is left at zero here; the ledger-derived counter lands with the audit
 * columns (task 5.x). Until then the quota axis is inert, which is the safe
 * direction: absent evidence of consumption, the mode is not upgraded.
 */
export function resolveMandateContext(req) {
  if (!req.user?.internal) return null;
  const domain = typeof req.body?.mandateDomain === "string" ? req.body.mandateDomain : null;
  if (!domain) return null;
  let policy = null;
  try {
    const db = getFleetDatabase?.();
    const fleetId = typeof req.body?.mandateFleetId === "string" ? req.body.mandateFleetId : null;
    policy = fleetId ? db?.getFleetMandatePolicy?.(fleetId) ?? null : db?.getCellMandatePolicy?.() ?? null;
  } catch (err) {
    console.error("[actions] mandate policy unavailable:", err.message);
    return null;
  }
  if (!policy) return null;
  return {
    policy,
    domain,
    principal: { kind: "agent" },
    usage: { count: 0, amount: 0 },
    declaredSources: Array.isArray(req.body?.disclosedSources) ? req.body.disclosedSources : [],
  };
}

/**
 * SHA256 digest of JSON stringified args (for audit, never returns raw args).
 */
/**
 * sha256 of the outbound text a mandate authorized (5.2). The text itself is
 * deliberately not stored: a second copy of "what the agent said in your name"
 * would be a new sensitive surface, and the digest is enough to prove later
 * that a specific message was (or was not) the one authorized.
 */
function outboundDigest(action, args) {
  const keys = Array.isArray(action?.contentArgs) ? action.contentArgs : [];
  const text = keys.map((k) => {
    const v = args?.[k];
    if (v === null || v === undefined) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  }).join("\n");
  if (!text.trim()) return null;
  return crypto.createHash("sha256").update(text).digest("hex");
}

function argsDigest(args) {
  const json = JSON.stringify(args ?? {});
  return crypto.createHash("sha256").update(json).digest("hex");
}

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

// Owner check: the approver must be the proposer. With auth off there is one
// machine owner and no identity on either side, so the match is trivially true
// (same convention as ctx.requireMcpManage).
function isOwner(req, row) {
  if (req.ctx && !req.ctx.authEnabled) return true;
  const userEmail = normEmail(req.user?.email);
  const proposer = normEmail(row.proposer_email);
  return Boolean(userEmail) && Boolean(proposer) && userEmail === proposer;
}

/**
 * Create a proposal.
 * Body: { actionId, args, proposerSession?, proposerEmail? }
 * Returns: { proposalId, state: "pending", impact, risk, target, tier, userFilledArgs }
 *
 * Identity: an authenticated browser caller is the proposer; the loopback
 * actions-mcp child (auth.js isInternalActionsBridge) names the proposer in the
 * body from the per-user profile env (design D4). The body value is only
 * honoured for that internal caller — a cookie-authenticated user can never
 * propose as someone else.
 */
/**
 * Count the attempts a mandate blocked (4.4). Silent failure is the failure
 * mode we are avoiding: `disclose_out_of_scope` on every attempt for a day
 * looks exactly like "the agent did nothing" unless it is counted.
 */
function recordBlockedMandateAttempt(verdict) {
  const reasons = Array.isArray(verdict?.reasons) ? verdict.reasons : [];
  const kind = reasons.includes("read_out_of_scope")
    ? "read"
    : reasons.includes("disclose_out_of_scope")
      ? "disclose"
      : reasons.includes("quota_exhausted")
        ? "quota"
        : null;
  if (!kind) return;
  try {
    getFleetDatabase?.()?.recordMandateViolation?.(verdict.mandateRef?.domain ?? null, kind);
  } catch (err) {
    console.error("[actions] mandate violation counter failed:", err.message);
  }
}

export async function proposeAction(req, res) {
  if (!req.body || typeof req.body.actionId !== "string") {
    return res.status(400).json({ error: "actionId required" });
  }
  const { actionId, proposerSession } = req.body;
  const proposerEmail = resolveProposerEmail(req);

  // Check registration
  if (!isRegistered(actionId)) {
    return res.status(400).json({ error: "action not registered" });
  }
  const action = getAction(actionId);

  // User-filled parameters (design D5): whatever the model put there is dropped
  // before anything else sees it — digest, impact text, storage.
  const args = filterKnownArgs(actionId, stripUserFilledArgs(actionId, req.body.args));
  const userFilledArgs = userFilledArgsFor(actionId);

  // Preflight (real checks: line credential for wire, deployer key for cloud,
  // seat online for desktop) — then the mandate, if this caller holds one.
  // The `actionPreflight` seam mirrors `actionExecutorDeps`: tests (and a future
  // alternate host) can substitute the prerequisite layer without weakening the
  // production path, which always resolves to the real preflightAction.
  const mandateCtx = resolveMandateContext(req);
  let mandateVerdict = null;
  const runPreflight = req.ctx?.actionPreflight ?? preflightAction;
  try {
    const pf = await runPreflight(action, { email: proposerEmail, mandate: mandateCtx }, args);
    if (!pf.ok) {
      return res.status(400).json({
        error: "preflight failed",
        details: pf.details,
        ...(pf.connectPath ? { connectPath: pf.connectPath } : {}),
        ...(pf.credentialRef ? { credentialRef: pf.credentialRef } : {}),
      });
    }
    mandateVerdict = pf.mandate ?? null;
  } catch (err) {
    console.error("[actions] preflight failed:", err.message);
    return res.status(500).json({ error: "preflight error" });
  }

  // `advise`: the domain permits judgement only. Nothing is stored — a pending
  // row the owner could approve would be an action the mandate never allowed.
  // A blocked attempt is still counted (4.4): a domain that fails all day must
  // look different from an idle one.
  if (mandateVerdict?.decision === DECISION.ADVISE) {
    recordBlockedMandateAttempt(mandateVerdict);
    return res.json({
      state: "advised",
      impact: action.impact(args),
      risk: action.risk,
      target: action.target,
      mandate: { decision: mandateVerdict.decision, reasons: mandateVerdict.reasons, domain: mandateVerdict.mandateRef?.domain },
    });
  }

  // After preflight (the connect card outranks a key typo), before anything is
  // stored: a proposal missing a required key renders「undefined」and can never
  // execute, so it must not become a pending row the owner cannot approve.
  const shape = validateArgs(actionId, args);
  if (!shape.ok) {
    return res.status(400).json({
      error: "invalid args",
      details: `missing required args for ${actionId}: ${shape.missing.join(", ")} (expected keys: ${shape.argKeys.join(", ")})`,
      missing: shape.missing,
      expected: shape.argKeys,
    });
  }

  const proposalId = randomUUID();
  const created = nowIso();
  const db = getDb();
  if (!db) {
    return res.status(503).json({ error: "database unavailable" });
  }

  const stmtInsert = db.prepare(`
    INSERT INTO action_proposals (
      proposal_id, line, action_id, args_digest, args_json, risk, target, impact_text,
      proposer_session, proposer_email, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  const impact = action.impact(args);
  try {
    stmtInsert.run(
      proposalId,
      action.line,
      action.id,
      argsDigest(args),
      JSON.stringify(args),
      action.risk,
      action.target,
      impact,
      proposerSession ?? null,
      proposerEmail ?? null,
      created,
      created
    );
  } catch (err) {
    console.error("[actions] insert failed:", err.message);
    return res.status(500).json({ error: "insert failed" });
  }

  const tier = riskToTierMap()[action.risk] ?? "unknown";

  // `execute` (act-notify / act-silent): the mandate already answered the
  // confirmation question, so the proposal is approved by the mandate itself
  // and runs immediately. The approver is recorded as `mandate:<domain>` — the
  // ledger must never claim a human approved something a human never saw.
  if (mandateVerdict?.decision === DECISION.EXECUTE) {
    const approver = `mandate:${mandateVerdict.mandateRef?.domain ?? "?"}:${mandateVerdict.mode}`;
    db.prepare(`
      UPDATE action_proposals SET state = 'approved', approver_email = ?, approved_at = ?, updated_at = ?
      WHERE proposal_id = ?
    `).run(approver, created, created, proposalId);

    const outcome = await executeAction(proposalId, {
      email: proposerEmail,
      ctx: req.ctx ?? null,
      mandate: mandateVerdict,
    });

    if (mandateVerdict.notify) {
      // act-notify: the通报 window IS the撤销 window — a silent auto-action
      // would make the revoke promise meaningless.
      const minutes = mandateVerdict.mandateRef?.revokeWindowMinutes ?? null;
      req.ctx?.broadcast?.({
        type: "mandate_action_executed",
        domain: mandateVerdict.mandateRef?.domain ?? null,
        actionId: action.id,
        proposalId,
        impact,
        mode: mandateVerdict.mode,
        ok: outcome.ok === true,
        reversibleUntil: minutes ? Date.now() + minutes * 60_000 : null,
      });
    }

    return res.json({
      proposalId,
      state: outcome.ok ? "executed" : "failed",
      impact,
      risk: action.risk,
      target: action.target,
      tier,
      userFilledArgs,
      resultSummary: outcome.summary ?? outcome.message ?? null,
      mandate: {
        decision: mandateVerdict.decision,
        mode: mandateVerdict.mode,
        notify: mandateVerdict.notify,
        domain: mandateVerdict.mandateRef?.domain ?? null,
      },
    });
  }

  // A draft that exists only because disclosure was out of scope is a blocked
  // send, not a normal draft — count it before returning.
  if (mandateVerdict) recordBlockedMandateAttempt(mandateVerdict);

  return res.json({
    proposalId,
    state: "pending",
    impact,
    risk: action.risk,
    target: action.target,
    tier,
    userFilledArgs,
    // `draft` means the mandate allowed a proposal but not a send: the owner's
    // approval is the missing step, which is exactly what `pending` already is.
    ...(mandateVerdict
      ? { mandate: { decision: mandateVerdict.decision, mode: mandateVerdict.mode, reasons: mandateVerdict.reasons } }
      : {}),
  });}

function resolveProposerEmail(req) {
  if (req.user?.internal) {
    // Loopback bridge: the child names the user (profile-injected env).
    const fromBody = normEmail(req.body?.proposerEmail);
    return fromBody || null;
  }
  const fromSession = normEmail(req.user?.email);
  return fromSession || null;
}

/**
 * Approve a proposal (owner-only).
 * Body: { userArgs? } — values for the action's userFilledArgs (design D5).
 * Returns: { state: "approved"|"executed", resultSummary?, ... }
 */
export async function approveAction(req, res) {
  const { id: proposalId } = req.params;
  const db = getDb();
  if (!db) {
    return res.status(503).json({ error: "database unavailable" });
  }

  // Get proposal
  const row = db.prepare(`
    SELECT * FROM action_proposals WHERE proposal_id = ?
  `).get(proposalId);
  if (!row) {
    return res.status(404).json({ error: "proposal not found" });
  }
  if (row.state !== "pending") {
    return res.status(400).json({ error: `proposal already ${row.state}` });
  }

  if (!isOwner(req, row)) {
    return res.status(403).json({ error: "only owner can approve" });
  }

  // Merge user-filled values (only declared keys, required ones present).
  const check = validateUserFilledArgs(row.action_id, req.body?.userArgs);
  if (!check.ok) {
    return res.status(400).json({ error: "invalid user args", details: check.error });
  }
  let args;
  try {
    args = row.args_json ? JSON.parse(row.args_json) : {};
  } catch {
    return res.status(500).json({ error: "invalid args_json" });
  }
  const finalArgs = { ...args, ...check.values };
  const approverEmail = normEmail(req.user?.email) || row.proposer_email || null;
  const approvedAt = nowIso();

  // Update to approved with the final args (digest now covers user values)
  db.prepare(`
    UPDATE action_proposals
    SET approver_email = ?, approved_at = ?, state = 'approved', updated_at = ?,
        args_json = ?, args_digest = ?
    WHERE proposal_id = ?
  `).run(approverEmail, approvedAt, approvedAt, JSON.stringify(finalArgs), argsDigest(finalArgs), proposalId);

  // Execute immediately for non-async tiers (read/write/destructive/cost)
  // Async (publish) stays in approved state until external approval flow completes
  const tier = riskToTierMap()[row.risk];

  if (tier === "async") {
    // Publish tier: wait for async approval (not implemented in v1)
    return res.json({ state: "approved", resultSummary: "awaiting async approval" });
  }

  const outcome = await executeAction(proposalId, { email: row.proposer_email, ctx: req.ctx });
  if (outcome.ok) {
    return res.json({ state: "executed", resultSummary: outcome.summary });
  }
  // Execution failure is 'failed' (inspectable, re-proposable) — never
  // 'rejected', which means the human said no (main 4e06e955).
  return res.status(outcome.httpStatus).json({
    error: "execution failed",
    state: "failed",
    code: outcome.code,
    message: outcome.message,
    ...(outcome.fields ? { fields: outcome.fields } : {}),
    ...(outcome.credentialInvalidated ? { credentialInvalidated: true, credentialRef: outcome.ref } : {}),
  });
}

/**
 * Reject a proposal.
 * Returns: { state: "rejected" }
 */
export async function rejectAction(req, res) {
  const { id: proposalId } = req.params;
  const db = getDb();
  if (!db) {
    return res.status(503).json({ error: "database unavailable" });
  }

  const row = db.prepare(`SELECT * FROM action_proposals WHERE proposal_id = ?`).get(proposalId);
  if (!row) {
    return res.status(404).json({ error: "proposal not found" });
  }
  if (row.state !== "pending") {
    return res.status(400).json({ error: `proposal already ${row.state}` });
  }

  if (!isOwner(req, row)) {
    return res.status(403).json({ error: "only owner can reject" });
  }

  db.prepare(`
    UPDATE action_proposals SET state = 'rejected', updated_at = ? WHERE proposal_id = ?
  `).run(nowIso(), proposalId);

  return res.json({ state: "rejected" });
}

/**
 * Query proposal by id.
 */
export async function getActionProposal(req, res) {
  const { id: proposalId } = req.params;
  const db = getDb();
  if (!db) {
    return res.status(503).json({ error: "database unavailable" });
  }

  const row = db.prepare(`
    SELECT proposal_id, line, action_id, risk, target, impact_text, state,
           proposer_session, proposer_email, approved_at, expired_at, result_summary,
           created_at, updated_at
    FROM action_proposals WHERE proposal_id = ?
  `).get(proposalId);

  if (!row) {
    return res.status(404).json({ error: "proposal not found" });
  }

  // Never return args_json or args_digest to client (audit sensitivity)
  return res.json({ ...row, userFilledArgs: userFilledArgsFor(row.action_id) });
}

/**
 * Single execution path for all actions (design D3/D4 of add-wire-line-board).
 *
 * Reads the approved proposal, runs the registered action through the MCP
 * executor with the PROPOSER's line credential, writes the audit row, and
 * transitions the proposal to executed / failed. Returns
 *   { ok: true, summary }
 *   { ok: false, httpStatus, code, message, fields?, credentialInvalidated?, ref? }
 * and never throws for an execution outcome — only for a corrupt proposal.
 */
export async function executeAction(proposalId, { email = null, ctx = null, deps = undefined, mandate = null } = {}) {
  const db = getDb();
  if (!db) throw new Error("database unavailable");

  const row = db.prepare(`
    SELECT * FROM action_proposals WHERE proposal_id = ?
  `).get(proposalId);

  if (!row) throw new Error("proposal not found");
  if (row.state !== "approved") throw new Error("proposal not approved");

  const action = getAction(row.action_id);
  if (!action) throw new Error("action not found");

  // Reconstruct args from JSON storage
  let args;
  try {
    args = row.args_json ? JSON.parse(row.args_json) : {};
  } catch {
    throw new Error("invalid args_json");
  }

  const proposerEmail = email ?? row.proposer_email ?? null;
  // Dependency seam: tests (and a future alternate executor) hang stubs on ctx.
  const executorDeps = deps ?? ctx?.actionExecutorDeps ?? undefined;
  const started = Date.now();
  let summary = null;
  let errorText = null;
  let server = null;
  let failure = null;

  try {
    const result = await executeRegisteredAction({ action, args, email: proposerEmail, deps: executorDeps });
    summary = typeof result.summary === "string" ? result.summary : JSON.stringify(result.summary);
    server = result.server ?? null;
  } catch (err) {
    const ex = err instanceof ExecutorError ? err : new ExecutorError("executor_error", err?.message || String(err));
    errorText = `${ex.code}: ${ex.message}`;
    server = ex.server ?? null;
    failure = ex;
  }
  const durationMs = Date.now() - started;
  const now = nowIso();

  // Audit (task 1.3): one row per execution attempt, success or failure. The
  // ledger carries the args DIGEST only — never the args themselves, never
  // the bearer (spec: 参数摘要; main 4e06e955).
  try {
    db.prepare(`
      INSERT INTO action_audit (
        proposal_id, line, action_id, args_digest, args_json, risk, target, impact_text,
        executor_info, duration_ms, error_text, result_summary, created_at,
        mandate_ref, mandate_domain, mandate_mode, disclose_level, reversible_until, content_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposalId,
      row.line,
      row.action_id,
      row.args_digest,
      null,
      row.risk,
      row.target,
      row.impact_text,
      JSON.stringify({
        proposer: row.proposer_email ?? null,
        approver: row.approver_email ?? null,
        approvedAt: row.approved_at ?? null,
        server,
        code: failure?.code ?? "ok",
      }),
      durationMs,
      errorText,
      failure ? `execution failed: ${failure.message}` : summary ?? `executed ${action.id}`,
      now,
      // Mandate lineage (5.2). A human-approved action carries nulls here, which
      // is the honest record: no mandate existed, so nothing may claim one.
      mandate ? JSON.stringify({ domain: mandate.mandateRef?.domain ?? null, action: action.id }) : null,
      mandate?.mandateRef?.domain ?? null,
      mandate?.mode ?? null,
      mandate?.disclose && !mandate.disclose.ok && mandate.disclose.violations.length
        ? mandate.disclose.violations[mandate.disclose.violations.length - 1].level
        : null,
      mandate?.mandateRef?.revokeWindowMinutes
        ? started + mandate.mandateRef.revokeWindowMinutes * 60_000
        : null,
      mandate ? outboundDigest(action, args) : null
    );
  } catch (err) {
    console.error("[actions] audit insert failed:", err.message);
  }

  if (!failure) {
    db.prepare(`
      UPDATE action_proposals SET state = 'executed', result_summary = ?, updated_at = ?
      WHERE proposal_id = ?
    `).run(summary ?? `executed ${action.id}`, now, proposalId);
    ctx?.broadcast?.({ type: "board_changed", line: row.line, resources: [row.action_id.split(".")[1] ?? row.action_id] });
    return { ok: true, summary: summary ?? `executed ${action.id}` };
  }

  console.error(`[actions] execution failed (${failure.code}):`, failure.message);
  // 'failed' keeps the action inspectable and re-proposable; 'rejected' is
  // reserved for the human saying no.
  db.prepare(`
    UPDATE action_proposals SET state = 'failed', result_summary = ?, updated_at = ?
    WHERE proposal_id = ?
  `).run(`execution failed: ${failure.message}`, now, proposalId);
  if (failure.credentialInvalidated && failure.ref) {
    ctx?.broadcast?.({ type: "line_credential_stale", line: failure.ref });
  }
  return {
    ok: false,
    httpStatus: httpStatusFor(failure),
    code: failure.code,
    message: failure.message,
    fields: Array.isArray(failure.fields) && failure.fields.length ? failure.fields : undefined,
    credentialInvalidated: failure.credentialInvalidated === true,
    ref: failure.ref ?? undefined,
  };
}

function httpStatusFor(ex) {
  switch (ex.code) {
    case "upstream_422":
      return 422;
    case "upstream_401":
    case "credential_missing":
      return 409; // the user's connection, not this request, is what must change
    case "tool_unroutable":
    case "credential_ref_unknown":
    case "endpoint_unresolved":
      return 501;
    default:
      return 502;
  }
}

// Register routes
/**
 * 裁决端点 (add-principal-disclosure-gate 1.5)：runner 在把对外文本交出去之前，
 * 问 cell「这段能不能发」。
 *
 * 为什么是「问 cell」而不是在 runner 侧缓存策略：缓存的过期窗口就是越权窗口，
 * 而越权窗口无法被测试覆盖。
 *
 * 鉴权：部署注入的 bearer，常数时间比较，未配置即 503——**未配置的部署拒绝，
 * 不是放行**。这与 AUTH_EXEMPT_PREFIXES 里其他自带凭据的路径同款。
 *
 * 失败关闭：任何异常都返回 verdict=block，绝不返回「放行」。
 */
export async function mandateVerdict(req, res) {
  const expected = String(process.env.MANDATE_VERDICT_TOKEN ?? "");
  if (!expected) return res.status(503).json({ error: "mandate verdict channel not configured" });
  const provided = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!provided || !secretMatches(provided, expected)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const domain = typeof req.body?.domain === "string" ? req.body.domain : null;
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const declaredSources = Array.isArray(req.body?.declaredSources) ? req.body.declaredSources : [];
    if (!domain || !text.trim()) {
      return res.status(400).json({ error: "domain and text are required" });
    }
    const db = getFleetDatabase?.();
    const policy = db?.getCellMandatePolicy?.() ?? null;
    if (!policy) {
      // 没有策略 = 没有授权。不回「放行」。
      return res.json({ ok: false, decision: "draft", reason: "no_policy", violations: [] });
    }
    const gate = gateOutboundMessage({
      policy,
      domain,
      text,
      principal: { kind: "agent", email: req.body?.principal ?? null },
      declaredSources,
      channelRevocable: req.body?.channelRevocable === true,
      levelSamples: req.body?.levelSamples ?? null,
    });
    return res.json({
      ok: gate.ok === true,
      decision: gate.decision,
      reason: gate.reason ?? null,
      level: gate.levelGate?.level ?? null,
      // 越界项原样回给 runner：主人要能看懂「哪一条不能说」，否则只会看到
      // 一句笼统的「被拦」，无从改写。
      violations: gate.disclosure?.violations ?? [],
      contentDigest: gate.ledger?.contentDigest ?? null,
    });
  } catch (err) {
    console.error("[actions] mandate verdict error:", err.message);
    // 失败关闭：出错时宁可拦住，也不让一段未经裁决的话发出去。
    return res.json({ ok: false, decision: "draft", reason: "verdict_error", violations: [] });
  }
}

/**
 * Mandate ledger read (5.3). Rows are the audit table's mandate columns, so what
 * this returns is exactly what ran — not a projection that can drift.
 */
export async function mandateLedger(req, res) {
  const db = getDb();
  if (!db) return res.status(503).json({ error: "database unavailable" });
  const domain = typeof req.query.domain === "string" ? req.query.domain : null;
  const audience = typeof req.query.audience === "string" ? req.query.audience : null;
  const principal = typeof req.query.principal === "string" ? req.query.principal : null;
  const discloseLevel = typeof req.query.discloseLevel === "string" ? req.query.discloseLevel : null;
  const reversibleOnly = req.query.reversible === "1" || req.query.reversible === "true";
  const limit = Math.min(Number(req.query.limit) > 0 ? Math.floor(Number(req.query.limit)) : 100, 500);
  try {
    const where = ["(mandate_domain IS NOT NULL OR audience IS NOT NULL)"];
    const params = [];
    if (domain) { where.push("mandate_domain = ?"); params.push(domain); }
    if (audience) { where.push("audience = ?"); params.push(audience); }
    if (principal) { where.push("principal = ?"); params.push(principal); }
    if (discloseLevel) { where.push("disclose_level = ?"); params.push(discloseLevel); }
    if (reversibleOnly) { where.push("reversible_until IS NOT NULL AND revoked_at IS NULL AND reversible_until > ?"); params.push(Date.now()); }
    const rows = db.prepare(`
      SELECT proposal_id, action_id, mandate_domain, mandate_mode, disclose_level,
             reversible_until, revoked_at, content_digest, created_at, error_text,
             principal, audience
      FROM action_audit WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC LIMIT ?
    `).all(...params, limit);
    res.json({ rows, domain, audience, principal, discloseLevel, reversibleOnly });
  } catch (err) {
    console.error("[actions] mandate ledger error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
}

/**
 * Revoke inside the window (5.4). What "revoke" can mean is per action: this
 * marks the record and emits the signal, and never claims the upstream was
 * undone when it was not. Past the window it refuses instead of pretending.
 */
/**
 * 溯源回执 (add-principal-disclosure-gate 4.3)：按台账 id 查「这句话是谁授权
 * 代理说的」。回执按需提供，不随消息附带——逐条声明会毁掉对外代理存在的意义。
 *
 * 只返回可公开的事实（授权人、代理、时间、层级、引用），不返回 digest 之外的
 * 任何内容，也不返回原文：平台侧本来就没有原文。
 */
export async function outboundReceipt(req, res) {
  const db = getDb();
  if (!db) return res.status(503).json({ error: "database unavailable" });
  try {
    const row = db.prepare(`
      SELECT proposal_id, action_id, principal, audience, mandate_domain, mandate_mode,
             disclose_level, mandate_ref, content_digest, reversible_until, revoked_at, created_at
      FROM action_audit WHERE proposal_id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: "receipt not found" });
    let mandate = null;
    try {
      mandate = row.mandate_ref ? JSON.parse(row.mandate_ref) : null;
    } catch {
      mandate = null;
    }
    res.json({
      receiptId: row.proposal_id,
      actionId: row.action_id,
      // 代表谁说的
      principal: row.principal ?? null,
      // 对谁说的（渠道:对象）
      audience: row.audience ?? null,
      domain: row.mandate_domain ?? null,
      mode: row.mandate_mode ?? null,
      discloseLevel: row.disclose_level ?? null,
      precedentRefs: Array.isArray(mandate?.precedentRefs) ? mandate.precedentRefs : [],
      // 授权依据取权威列（mandate_domain），不依赖 JSON blob 解析成功——
      // 回执说「谁授权的」这件事，不该因为一段 JSON 坏掉就变成 null。
      authorizedBy: row.mandate_domain ? "owner-mandate" : null,
      contentDigest: row.content_digest ?? null,
      issuedAt: row.created_at,
      revokedAt: row.revoked_at ?? null,
      reversibleUntil: row.reversible_until ?? null,
    });
  } catch (err) {
    console.error("[actions] receipt error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
}

export async function revokeMandateAction(req, res) {
  const db = getDb();
  if (!db) return res.status(503).json({ error: "database unavailable" });
  try {
    const row = db.prepare(`
      SELECT proposal_id, action_id, mandate_domain, reversible_until, revoked_at, audience
      FROM action_audit WHERE proposal_id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: "action not found" });
    if (row.revoked_at) return res.status(409).json({ error: "already revoked", revokedAt: row.revoked_at });
    // 无反向能力的渠道：撤回窗口本身就是 null，这里说清「为什么不可撤回」，
    // 而不是丢一句笼统的 not reversible。渠道从 audience 前缀可读出来。
    if (!row.reversible_until) {
      const channel = typeof row.audience === "string" ? row.audience.split(":")[0] : null;
      return res.status(409).json({
        error: channel ? `channel '${channel}' cannot recall a sent message` : "this action is not reversible",
        channel,
      });
    }
    if (row.reversible_until <= Date.now()) {
      return res.status(409).json({ error: "revoke window closed — the action is now irreversible" });
    }
    const at = nowIso();
    db.prepare("UPDATE action_audit SET revoked_at = ? WHERE proposal_id = ?").run(at, req.params.id);
    req.ctx?.broadcast?.({
      type: "mandate_action_revoked",
      domain: row.mandate_domain,
      actionId: row.action_id,
      proposalId: row.proposal_id,
      at,
    });
    res.json({ ok: true, revokedAt: at });
  } catch (err) {
    console.error("[actions] revoke error:", err.message);
    res.status(500).json({ error: "internal error" });
  }
}

export function registerActionsRoutes(ctx) {
  const { app } = ctx;

  // Attach ctx to requests so handlers can broadcast board_changed events
  app.use((req, _res, next) => {
    req.ctx = ctx;
    next();
  });

  app.post("/api/actions/propose", async (req, res) => {
    try {
      await proposeAction(req, res);
    } catch (err) {
      console.error("[actions/propose] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/api/actions/:id/approve", async (req, res) => {
    try {
      await approveAction(req, res);
    } catch (err) {
      console.error("[actions/approve] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/api/actions/:id/reject", async (req, res) => {
    try {
      await rejectAction(req, res);
    } catch (err) {
      console.error("[actions/reject] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/api/actions/mandate/ledger", async (req, res) => {
    try {
      await mandateLedger(req, res);
    } catch (err) {
      console.error("[actions/ledger] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/api/actions/mandate-verdict", async (req, res) => {
    try {
      await mandateVerdict(req, res);
    } catch (err) {
      console.error("[actions/verdict] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/api/actions/:id/receipt", async (req, res) => {
    try {
      await outboundReceipt(req, res);
    } catch (err) {
      console.error("[actions/receipt] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.post("/api/actions/:id/revoke", async (req, res) => {
    try {
      await revokeMandateAction(req, res);
    } catch (err) {
      console.error("[actions/revoke] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });

  app.get("/api/actions/:id", async (req, res) => {
    try {
      await getActionProposal(req, res);
    } catch (err) {
      console.error("[actions/get] error:", err.message);
      res.status(500).json({ error: "internal error" });
    }
  });
}
