// server/team-serving.js — the team's a2a endpoint (openspec:
// add-team-as-a2a-agent, 3.3–3.5, 4.x, 5.x).
//
// One door, one decision path. Everything a call can be refused for is decided
// HERE, in the same order, for every entry point (the platform gateway today, a
// registry gateway in phase 2):
//
//   identity → publication exists → not private → team state → reception →
//   authorization → depth → quota → dispatch
//
// The transport is JSON-RPC `message/stream` over SSE, with the SAME event
// vocabulary the existing agent a2a adapter already speaks (`delta`, `message`,
// `error`, `done`) and the SAME `x-delegation-depth` inbound header. A generic
// a2a client that can call a single agent can call a team; nothing about the
// team's internals is required to form the request.
//
// What this module deliberately does NOT do: orchestrate. `dispatch` is
// injected — phase 1 wires it to the fleet's existing round/dispatch machinery
// (task 3.4), and the transport's contract stays identical when that changes.
// That separation is why "换入口 MUST NOT 要求服务端语义变更" is checkable: the
// semantics live here, the entry point does not.

import { createCallerIdentity } from "./caller-identity.js";
import { decideServing, SERVING_HTTP_STATUS, servingError } from "./team-serving-policy.js";
import {
  ensureTeamQuotaTables,
  takeCallSlot,
  chargeUsage,
  finishCall,
  readUsage,
  getCall as getCallById,
  quotaResetAtFor,
} from "./team-serving-quota.js";
import { getPublication } from "./team-card.js";

const JSON_RPC_VERSION = "2.0";

/** JSON-RPC error codes (existing a2a vocabulary, plus one team-specific). */
export const RPC = Object.freeze({
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  // -32000 block: the agent adapter already uses -32010 (paused), -32011
  // (depth), -32003 (failure). Teams use -32020.. so the two surfaces never
  // collide on a code the client might special-case.
  refusal: -32020,
});

const MAX_TEXT_CHARS = 16_000;

/** Sentinel for "the sync window elapsed first". */
const ASYNC = Symbol("async");

/** Resolves to ASYNC after `ms`; unref'd so it never holds the process open. */
function afterMs(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(ASYNC), Math.max(0, ms));
    t.unref?.();
  });
}

/** The ONE result shape: a sync reply and a delivered task carry the same object. */
function messageResult(text, callId, base) {
  return { role: "assistant", message_id: `m-${callId}`, kind: "message", parts: [{ kind: "text", text }], ...base };
}

/** Rough token estimate for the MID-STREAM guard only (4 chars ≈ 1 token). */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? "").length / 4));
}

function errorBody(code, extra = {}) {
  const err = servingError(code, extra);
  const { ok: _ok, ...body } = err;
  return body;
}

function rpcError(id, code, message, data) {
  return { jsonrpc: JSON_RPC_VERSION, id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function textOf(message) {
  const parts = message?.parts ?? [];
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

export function createTeamServing({
  db,
  fleetDb,
  cellId,
  callerIdentity,
  dispatch,
  approvalsFor = () => [],
  onNeedsApproval = null,
  deliver = null,
  maxDepth = Number.isFinite(Number(process.env.DELEGATION_DEPTH_MAX)) ? Number(process.env.DELEGATION_DEPTH_MAX) : 3,
  syncWindowMs = 20_000,
  now = () => Date.now(),
  // The cell owner's email, for the audit read only. `cellId()` is the HASHED
  // public id, so comparing a caller's email to it can never match.
  ownerEmail = null,
  log = console,
}) {
  ensureTeamQuotaTables(db);

  const identity = callerIdentity ?? createCallerIdentity({ adapters: [] });

  // 5.2/5.3: delivery goes through whatever notification lane the deployment
  // already has (injected). Its contract returns `{exists: boolean}` — a lane
  // that is not configured is "no delivery", not a silent success.
  const deliverSafely = async (payload) => {
    if (typeof deliver !== "function") return { exists: false, reason: "no_lane" };
    try {
      const out = await deliver(payload);
      return { exists: out?.delivered === true, reason: out?.reason ?? null };
    } catch (err) {
      log.error(`[team-serving] delivery failed for ${payload.callId}: ${err?.message || err}`);
      return { exists: false, reason: "threw" };
    }
  };

  /** The published card's call surface, for the UI to render before calling. */
  function quotaSurface(publication) {
    const usage = readUsage(db, { cellId: cellId(), handle: publication.handle, now: now() });
    return {
      quota: publication.quota,
      usage: { calls: usage.calls, tokens: usage.tokens, usd: usage.usdMicros / 1_000_000 },
      resetsAt: quotaResetAtFor(now()),
    };
  }

  /**
   * One call. Returns `{jsonrpc, result}` / `{jsonrpc, error}` for
   * `message/send`, or drives an SSE response for `message/stream`.
   */
  async function handlePost(req, res) {
    const body = req.body ?? {};
    const id = body.id ?? null;
    if (body.jsonrpc !== JSON_RPC_VERSION || typeof body.method !== "string") {
      return res.status(400).json(rpcError(id, RPC.invalidRequest, "Invalid Request"));
    }
    if (body.method !== "message/send" && body.method !== "message/stream") {
      return res.status(200).json(rpcError(id, RPC.methodNotFound, "Method not found"));
    }

    const handle = String(req.params?.handle ?? "").trim().toLowerCase();
    const message = body.params?.message ?? body.params;
    const text = textOf(message);
    if (!text) return res.status(400).json(rpcError(id, RPC.invalidParams, "empty message"));

    // ── identity (2.1–2.2) ────────────────────────────────────────────────
    const resolved = await identity.resolve({ headers: req.headers, session: req.ssoUser ?? req.user ?? null });
    if (!resolved.ok) {
      return res.status(401).json({ jsonrpc: JSON_RPC_VERSION, id, error: { code: RPC.refusal, message: "Caller identity could not be resolved", data: errorBody("unauthorized") } });
    }
    const caller = resolved.caller;

    // ── publication / team ────────────────────────────────────────────────
    const publication = getPublication(db, cellId(), handle);
    const fleet = publication ? fleetDb.getFleet(publication.fleetId) : null;
    const members = fleet ? fleetDb.listMembers(fleet.id) : [];
    const depth = Math.max(0, Number(req.headers["x-delegation-depth"]) || 0);

    const decision = decideServing({
      publication,
      caller,
      fleetState: fleet?.state ?? "archived",
      ownerEmail: publication?.publishedBy,
      usage: publication ? readUsage(db, { cellId: cellId(), handle, now: now() }) : undefined,
      approvals: publication ? approvalsFor(handle) : [],
      depth,
      maxDepth,
      now,
    });

    if (!decision.ok) {
      // 7.2: a `needs_approval` refusal must LEAVE A TRACE. Telling a caller to
      // "wait for approval" while giving the owner nothing to approve is a dead
      // end — and an approval queued here is what the cockpit later resolves.
      if (decision.code === "needs_approval" && typeof onNeedsApproval === "function") {
        try {
          await onNeedsApproval({ handle, caller: caller.subject });
        } catch (err) {
          log.warn(`[team-serving] could not queue approval for ${handle}: ${err?.message || err}`);
        }
      }
      // 3.5: unpublished / withdrawn / private / unknown share ONE body.
      const data = { code: decision.code, ...(decision.detail ? { detail: decision.detail } : {}) };
      return res
        .status(SERVING_HTTP_STATUS[decision.code] ?? 500)
        .json({ jsonrpc: JSON_RPC_VERSION, id, error: { code: RPC.refusal, message: decision.message, data } });
    }

    // ── quota slot + call record, atomically (4.1/4.3) ────────────────────
    const slot = takeCallSlot(db, {
      cellId: cellId(),
      handle,
      caller: caller.subject,
      quota: publication.quota,
      depth,
      now: now(),
    });
    if (!slot.ok) {
      const data = { code: slot.code, ...(slot.detail ? { detail: slot.detail } : {}) };
      return res
        .status(SERVING_HTTP_STATUS[slot.code] ?? 500)
        .json({ jsonrpc: JSON_RPC_VERSION, id, error: { code: RPC.refusal, message: servingError(slot.code).message, data } });
    }
    const { callId } = slot;

    // ── dispatch ──────────────────────────────────────────────────────────
    const reception = members.find((m) => m.id === publication.reception) ?? null;
    const baseResult = { contextId: message?.context_id ?? message?.contextId ?? null, resetsAt: quotaResetAtFor(now()) };

    let abortedField = null;
    const charge = (deltaText) => {
      const out = chargeUsage(db, {
        cellId: cellId(),
        handle,
        callId,
        tokens: estimateTokens(deltaText),
        quota: publication.quota,
        now: now(),
      });
      if (!out.ok) {
        abortedField = out.field;
        return false;
      }
      return true;
    };

    const runDispatch = async (onDelta) =>
      dispatch({
        fleet,
        members,
        reception,
        text,
        caller,
        callId,
        depth,
        onDelta,
      });

    if (body.method === "message/send") {
      // Non-streaming: quota-guarded, one call record, and the sync WINDOW
      // (5.1). A dispatch that outlives the window is NOT cancelled — the
      // caller gets a task id at once and the work finishes in the background,
      // because hanging the connection until a proxy times out is the failure
      // the spec forbids.
      const task = runDispatch(null);
      const first = await Promise.race([task, afterMs(syncWindowMs)]);
      if (first === ASYNC) {
        res.json({
          jsonrpc: JSON_RPC_VERSION,
          id,
          result: {
            kind: "task",
            task_id: callId,
            status: "working",
            parts: [{ kind: "text", text: "" }],
            ...baseResult,
          },
        });
        // Background half: charge what was produced, then deliver through the
        // caller's existing notification lane (5.2). A delivery that fails is
        // RECORDED (5.3) — a task the caller never heard about must not read
        // as "ok".
        void task
          .then(async (out) => {
            const text = out?.text ?? "";
            const charged = chargeUsage(db, {
              cellId: cellId(),
              handle,
              callId,
              tokens: estimateTokens(text),
              quota: publication.quota,
              now: now(),
            });
            if (!charged.ok) {
              finishCall(db, { callId, status: "quota_aborted", errorCode: "quota_exceeded", now: now() });
            }
            const status = charged.ok ? "ok" : "quota_aborted";
            const delivered = await deliverSafely({ handle, callId, caller: caller.subject, status, result: messageResult(text, callId, baseResult) });
            finishCall(db, {
              callId,
              status: delivered.exists ? status : "undelivered",
              errorCode: delivered.exists ? (charged.ok ? null : "quota_exceeded") : "delivery_failed",
              now: now(),
            });
          })
          .catch(async (err) => {
            log.error(`[team-serving] ${handle} background call failed: ${err?.message || err}`);
            const delivered = await deliverSafely({ handle, callId, caller: caller.subject, status: "failed", result: { error: "internal_error" } });
            finishCall(db, { callId, status: delivered.exists ? "failed" : "undelivered", errorCode: delivered.exists ? "internal_error" : "delivery_failed", now: now() });
          });
        return;
      }
      try {
        const text = first?.text ?? "";
        const charged = chargeUsage(db, {
          cellId: cellId(),
          handle,
          callId,
          tokens: estimateTokens(text),
          quota: publication.quota,
          now: now(),
        });
        if (!charged.ok) {
          finishCall(db, { callId, status: "quota_aborted", errorCode: "quota_exceeded", now: now() });
          return res.status(SERVING_HTTP_STATUS.quota_exceeded).json(
            rpcError(id, RPC.refusal, "Daily quota exhausted", errorBody("quota_exceeded", { detail: { field: charged.field } })),
          );
        }
        finishCall(db, { callId, status: "ok", now: now() });
        return res.json({
          jsonrpc: JSON_RPC_VERSION,
          id,
          result: {
            role: "assistant",
            message_id: `m-${callId}`,
            kind: "message",
            parts: [{ kind: "text", text }],
            ...baseResult,
          },
        });
      } catch (err) {
        finishCall(db, { callId, status: "failed", errorCode: "internal_error", now: now() });
        log.error(`[team-serving] ${handle} dispatch failed: ${err?.message || err}`);
        return res.status(500).json(rpcError(id, RPC.internal, "Team call failed", { code: "internal_error" }));
      }
    }

    // SSE stream. Headers go out only after every refusal above has been
    // decided, so a refusal is always a normal HTTP response with a status.
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let acc = "";

    try {
      const out = await runDispatch((delta) => {
        if (!delta) return;
        if (abortedField) return; // already refused — stop forwarding
        acc += delta;
        if (!charge(delta)) {
          send("error", errorBody("quota_exceeded", { detail: { field: abortedField } }));
          return;
        }
        send("delta", { context_id: baseResult.contextId, kind: "message", parts: [{ kind: "text", text: acc }] });
      });

      if (abortedField) {
        finishCall(db, { callId, status: "quota_aborted", errorCode: "quota_exceeded", now: now() });
        send("done", { status: "quota_aborted", field: abortedField });
        return res.end();
      }

      // A dispatcher that never streamed still owes the caller its text.
      const finalText = typeof out?.text === "string" && out.text.length > 0 ? out.text : acc;
      if (finalText && finalText !== acc) {
        if (!charge(finalText.slice(acc.length))) {
          finishCall(db, { callId, status: "quota_aborted", errorCode: "quota_exceeded", now: now() });
          send("error", errorBody("quota_exceeded", { detail: { field: abortedField } }));
          send("done", { status: "quota_aborted" });
          return res.end();
        }
      }
      finishCall(db, { callId, status: "ok", now: now() });
      send("message", {
        role: "assistant",
        message_id: `m-${callId}`,
        kind: "message",
        parts: [{ kind: "text", text: finalText }],
        ...baseResult,
      });
      send("done", { status: "ok" });
      return res.end();
    } catch (err) {
      log.error(`[team-serving] ${handle} stream failed: ${err?.message || err}`);
      finishCall(db, { callId, status: "failed", errorCode: "internal_error", now: now() });
      send("error", errorBody("internal_error"));
      send("done", { status: "failed" });
      return res.end();
    }
  }

  /** GET on the endpoint: a card-shaped read of the call surface (no My own). */
  function handleGet(req, res) {
    const handle = String(req.params?.handle ?? "").trim().toLowerCase();
    const publication = getPublication(db, cellId(), handle);
    if (!publication || publication.visibility === "private") {
      return res.status(404).json({ error: errorBody("not_found") });
    }
    return res.json({ v: 1, handle, ...quotaSurface(publication), visibility: publication.visibility });
  }

  /** A caller's own task lookup (5.3): the row, and only for its caller or the owner. */
  function getCallFor(subject, callId) {
    const row = getCallById(db, callId);
    if (!row) return null;
    if (row.caller !== subject && (!ownerEmail || subject !== ownerEmail)) return null;
    return row;
  }

  return { handlePost, handleGet, quotaSurface, getCallFor, maxDepth };
}
