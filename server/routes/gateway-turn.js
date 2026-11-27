// ── Synchronous post turn, for the gateway's room seats ─────────────────────
//
// A Zhiyu room calls an agent seat SYNCHRONOUSLY:
//
//   const { text } = await callAgent(member, { text, contextId, onDelta })
//   (gateway/zhiyu/index.js:180)
//
// The cell could only do this by enqueuing a task (POST /api/fleets/:id/dispatch
// → a taskId, result somewhere else), which is the wrong shape — a room wants
// one answer, now. The capability already existed in-process: `server/bots.js`
// runs exactly this (collectTurn + dshBridge.prompt + await collected) for every
// bot reply. This endpoint is that capability, exposed to the ONE caller that
// needs it.
//
// Why not just reuse dispatch + polling: dispatch carries a 3-per-15min cap
// (server/routes/fleets.js `429 dispatch cap reached`) and returns no text. A
// conversation would exhaust it in seconds.
//
// Trust boundary: the gateway secret only. A browser must never reach this —
// it can make a runtime run a turn as any post in the owner's fleet, which is
// strictly more than the dispatch face allows. `fromGateway` is the same guard
// the neighbouring /api/gateway routes use (binding-mint); absence of the
// configured secret degrades to the loopback-trusted posture those routes
// already accept, so a single-process dev box keeps working.

import express from "express";
import { collectTurn, parkPersonaForTurn, switchPresetForJob, waitForIdle } from "../cron-runner.js";
import { rosterPresetId } from "../../dsh-profile.js";

const MAX_BODY = "32kb";
// A post's turn is a model call plus tool work; the bot lane budgets the same
// order of magnitude. Kept as a knob because a deployment with a slow provider
// is a real deployment, not a bug.
const DEFAULT_TIMEOUT_MS = 180_000;

function fromGateway(req) {
  const secret = String(process.env.CELL_GATEWAY_SECRET || "");
  return !secret || req.headers["x-cloud-gateway-secret"] === secret;
}

const bad = (res, status, code, error) => res.status(status).json({ ok: false, code, error });

export function registerGatewayTurnRoutes(app, ctx) {
  app.post("/api/gateway/sync-turn", express.json({ limit: MAX_BODY }), async (req, res) => {
    if (!fromGateway(req)) return bad(res, 401, "unauthorized", "gateway secret required");

    const owner = String(req.headers["x-forwarded-email"] || "").trim().toLowerCase();
    if (!owner) return bad(res, 400, "no_owner", "x-forwarded-email identifies the cell");

    const { fleetId, memberId, text, timeoutMs = DEFAULT_TIMEOUT_MS } = req.body || {};
    if (typeof fleetId !== "string" || !fleetId) return bad(res, 400, "invalid_input", "fleetId is required");
    if (typeof memberId !== "string" || !memberId) return bad(res, 400, "invalid_input", "memberId is required");
    if (typeof text !== "string" || !text.trim()) return bad(res, 400, "invalid_input", "text is required");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
      return bad(res, 400, "invalid_input", "timeoutMs must be 1..600000");
    }

    // Ownership is the cell's own question, asked here rather than trusted from
    // the header: a gateway bug must not become a way to drive someone else's
    // fleet. Unknown fleet and someone else's fleet answer identically — the
    // same honest-absence rule the team-serving read face uses.
    let fleet;
    let memberRec;
    try {
      const mod = await import("./fleets-db.js");
      const fleetDb = mod.getFleetDatabase();
      fleet = fleetDb.getFleet(fleetId);
      memberRec = fleet ? fleetDb.getMember(memberId) : null;
    } catch (err) {
      return bad(res, 500, "store_unavailable", `fleet store unavailable: ${err.message}`);
    }
    if (!fleet || fleet.ownerEmail !== owner) return bad(res, 404, "not_found", "no such fleet");
    if (!memberRec || memberRec.fleetId !== fleetId) {
      return bad(res, 404, "not_found", "no such post in this fleet");
    }

    // The runtime must be up: the room already answered "收到" to the human, so
    // a turn that cannot start must say so rather than hang for the full timeout.
    if (!ctx?.dshBridge?.isReady?.()) {
      return bad(res, 503, "runtime_not_ready", "the agent runtime is not ready yet");
    }

    // Preset switch + prompt are ONE serialized mutation on the runtime
    // (switchPresetTo already takes runExclusiveRuntimeMutation); a room
    // addressing two posts at once queues, it does not interleave.
    // Preset id shape: the fleet stores the CATALOG id (`user.preset-4`, dots),
    // while the runtime roster only accepts `[a-z0-9-]` (`user-preset-4`). Every
    // other lane folds at its entry (delegation.js, fleet-handoffs.js); this one
    // did not, so every persona seat answered `Unknown agent mode: user.preset-4`
    // on the first live room turn (2026-11-24). Fold here — the runtime can only
    // resolve the folded id.
    const preset = memberRec.targetId ? rosterPresetId(memberRec.targetId) : null;
    if (!preset) return bad(res, 409, "no_target", "this post has no persona to run");

    // Session id: the collector key MUST equal the id the runtime is prompted
    // with (notifications route by it). One per call — a room turn is not a
    // conversation thread that outlives the call.
    const childSessionId = `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const chatHistory = await import("../chat-history.js");
      chatHistory.createSession?.(childSessionId, owner);
    } catch { /* the turn can run without a history row; the room keeps its own */ }

    // `activeTurns` is the abort registry, and it is a MAP of sessionId →
    // abort(reason) — collectTurn calls `.set`, so a Set here throws
    // "activeTurns.set is not a function" on the first turn (measured).
    const activeTurns = new Map();
    const collected = collectTurn(
      ctx,
      childSessionId,
      timeoutMs,
      activeTurns,
      ctx.sessionCollectors,
      childSessionId,
      { earlyStop: false },
    );

    const abortTurn = () => {
      // The registry holds an abort callback once the collector is armed; use it
      // so the collector settles instead of waiting out its timeout.
      const fire = activeTurns.get(childSessionId);
      if (typeof fire === "function") {
        try { fire("room caller gave up"); } catch { /* already settled */ }
      }
      activeTurns.delete(childSessionId);
      try { ctx.sessionCollectors?.delete?.(childSessionId); } catch { /* best effort */ }
    };

    try {
      // Persona composition: PARK it on this turn's brand-new session, then
      // fall back to the restart ladder only when the child cannot park. The
      // cron lane made the same move (server/cron-runner.js:1629) after the
      // restart path was measured to be the expensive one — and here a restart
      // would ALSO yank the owner's own chat onto the post's persona, which a
      // room turn has no business doing. Parking leaves the cell's live session
      // untouched; the room's turn composes its own.
      const park = await parkPersonaForTurn(ctx, preset, childSessionId);
      if (park.legacy) {
        console.warn(`[gateway-turn] preset park unavailable (${park.legacy}); falling back to restart`);
        const switched = await switchPresetForJob(ctx, preset, timeoutMs);
        if (switched && switched.ok === false) {
          abortTurn();
          return bad(res, 409, "preset_unavailable", switched.error || `cannot switch to preset ${preset}`);
        }
      } else {
        await waitForIdle(ctx, timeoutMs);
      }
      ctx.setStreaming?.(childSessionId, true);
      await ctx.dshBridge.prompt(childSessionId, [{ type: "text", text }]);
      const out = await collected;
      if (out?.error) return res.json({ ok: false, code: "turn_failed", error: String(out.error) });
      return res.json({ ok: true, text: String(out?.text ?? "") });
    } catch (err) {
      abortTurn();
      return res.json({ ok: false, code: "turn_failed", error: err?.message || String(err) });
    } finally {
      ctx.setStreaming?.(childSessionId, false);
    }
  });
}
