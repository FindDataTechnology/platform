// ── Mission Control bridge ───────────────────────────────────────────────────
//
// The cell-side console integration (spec: mission-control-bridge; 指挥层 ④).
// Opt-in via env (MC_BRIDGE=1 + MC_URL + MC_API_KEY); inert otherwise — zero
// outbound traffic, zero behavior change. When enabled, the cell registers as
// ONE console agent (agent ↔ cell, never persona), heartbeats, polls its task
// queue, and maps each claimed console task to an engine manual-trigger task
// (title=persona, description=prompt convention), posting outcomes back.
//
// All traffic is OUTBOUND (the registry-bridge pattern): the console gains no
// inbound reach into the cell. Console outages back off and never affect cell
// capabilities. The three pinned MC endpoints are alpha-API — shape drift is a
// claim error (backoff + log), never a cell failure.

import * as engine from "../task-engine.js";
import * as chatHistory from "../chat-history.js";
import os from "node:os";

// Internal override for tests (fast ticks); production default 5s.
const POLL_MS = Math.max(50, Number(process.env.MC_POLL_MS) || 5_000);
const POLL_MAX_MS = 5 * 60_000;
const HEARTBEAT_EVERY_TICKS = 6; // ~30s at the base cadence
const RESULT_TIMEOUT_MS = 10_000;

function bridgeEnabled() {
  return (
    process.env.MC_BRIDGE === "1" &&
    Boolean(process.env.MC_URL) &&
    Boolean(process.env.MC_API_KEY)
  );
}

async function mcFetch(base, key, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(RESULT_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

// attachMcBridge(ctx): synchronous, never boot-blocking. Returns a handle for
// tests/shutdown.
export function attachMcBridge(ctx) {
  if (!bridgeEnabled()) {
    return { enabled: false };
  }
  const base = process.env.MC_URL.replace(/\/$/, "");
  const key = process.env.MC_API_KEY;
  const agentName = process.env.MC_AGENT_NAME || `cell-${os.hostname()}`;

  console.log(`[mc-bridge] enabled, console=${base}, agent=${agentName}`);
  let stopped = false;
  let pollMs = POLL_MS;
  let ticks = 0;
  let registered = false;
  let agentId = null;
  let polling = false;
  let handle = null;
  // Self-scheduling timer: one live handle at a time, re-armed each tick so
  // backoff changes take effect; unref'd so the bridge never holds the loop.
  const schedule = (delayMs = pollMs) => {
    if (!stopped) {
      handle = setTimeout(() => void tick(), delayMs);
      handle.unref?.();
    }
  };

  async function call(method, path, body) {
    return mcFetch(base, key, method, path, body);
  }

  // Registration is idempotent and OPTIONAL: a per-agent mca_ key already
  // implies the identity (agent:self scope) and cannot re-register — treat
  // failure as non-fatal and poll anyway. (Verified live 2026-09-30: the
  // role enum has no "cell" — use "agent"; the answer carries {agent:{id}}.)
  async function ensureRegistered() {
    if (registered) return true;
    try {
      const data = await call("POST", "/api/agents/register", {
        name: agentName,
        role: "agent",
        framework: "paas-cell",
        capabilities: ["task-execution"],
      });
      agentId = data?.agent?.id ?? null;
      console.log("[mc-bridge] registered with the console");
    } catch (err) {
      console.warn(`[mc-bridge] registration skipped (${err.message}) — polling as the provided key's agent`);
    }
    registered = true;
    return true;
  }

  async function heartbeat() {
    if (!agentId) return; // id-based endpoint; unavailable without registration
    try {
      await call("POST", `/api/agents/${agentId}/heartbeat`, {});
    } catch {
      // Alpha-API shape drift on heartbeat is non-fatal: registration and
      // queue polling carry the integration.
    }
  }

  // Claim one console task. Idempotent by origin.mc: a re-seen console id
  // maps to the existing cell task (restart mid-claim never double-creates).
  function findExisting(mcId) {
    return engine.allRecords().find((t) => t.origin?.mc === mcId) ?? null;
  }

  async function claim(mcTask) {
    const mcId = String(mcTask.id);
    const persona = String(mcTask.title ?? "").trim();
    const prompt = String(mcTask.description ?? "").trim();
    if (findExisting(mcId)) return; // already ours

    if (!persona || !prompt) {
      await report(mcId, { state: "failed", error: "task must carry title=<persona> and description=<prompt>" });
      return;
    }
    // Persona must exist on this cell's roster (design D2).
    const roster = (await ctx.getAgentPresets?.()) ?? [];
    const known = roster.some((p) => p.id === persona);
    if (!known) {
      await report(mcId, { state: "failed", error: `unknown persona on this cell: ${persona}` });
      return;
    }
    engine.createManualTask({
      prompt,
      persona,
      sessionTitle: `MC ${mcId}`,
      origin: { mc: mcId },
    });
    console.log(`[mc-bridge] claimed console task ${mcId} → persona ${persona}`);
  }

  // Post a terminal outcome (at-least-once: mcReportedAt marks done posts;
  // failures retry on later ticks). Verified live 2026-09-30: outcomes go to
  // PUT /api/tasks/{id} — "done" is gated behind Aegis approval, so terminal
  // outcomes land in `quality_review` with the bridge's facts in metadata
  // (state/output/error/usage) for the operator to review and close.
  async function report(mcId, payload) {
    await call("PUT", `/api/tasks/${encodeURIComponent(mcId)}`, {
      status: "quality_review",
      ...(payload.error ? { error: payload.error } : {}),
      metadata: { paasBridge: payload },
    });
  }

  async function postOutcomes() {
    for (const t of engine.allRecords()) {
      if (!t.origin?.mc || t.mcReportedAt) continue;
      if (!["done", "failed", "interrupted"].includes(t.state)) continue;
      let output = null;
      try {
        const sess = await chatHistory.getSession(t.sessionId);
        const asst = (sess?.messages || []).filter((m) => m.role === "assistant");
        if (asst.length) output = asst[asst.length - 1].content || null;
      } catch { /* session may not exist for spawn failures */ }
      const last = t.history?.[t.history.length - 1];
      await report(String(t.origin.mc), {
        state: t.state,
        output,
        error: t.error ?? null,
        usage: last?.tokens ?? null,
      });
      t.mcReportedAt = new Date().toISOString();
      await engine.saveTasks();
    }
  }

  async function tick() {
    if (stopped || polling) return;
    polling = true;
    try {
      await ensureRegistered();
      if (++ticks % HEARTBEAT_EVERY_TICKS === 0) await heartbeat();
      const data = await call("GET", `/api/tasks/queue?agent=${encodeURIComponent(agentName)}`);
      // Queue shapes seen in the wild: {tasks:[...]} (docs), {task:{...}}
      // (live 2026-09-30 — a GET claims ONE task), bare array.
      const queued = Array.isArray(data?.tasks)
        ? data.tasks
        : Array.isArray(data)
          ? data
          : data?.task
            ? [data.task]
            : [];
      for (const mcTask of queued) await claim(mcTask);
      await postOutcomes();
      pollMs = POLL_MS; // success resets the backoff
    } catch (err) {
      pollMs = Math.min(pollMs * 2, POLL_MAX_MS);
      console.warn(`[mc-bridge] console call failed (${err.message}); next poll in ${Math.round(pollMs / 1000)}s`);
    } finally {
      polling = false;
      schedule();
    }
  }

  // First tick immediately (register at boot); later ticks at the cadence.
  schedule(0);

  return {
    enabled: true,
    agentName,
    stop: () => {
      stopped = true;
      clearTimeout(handle);
    },
  };
}
