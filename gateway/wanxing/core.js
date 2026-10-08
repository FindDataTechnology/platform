// ── Wanxing facade kernel (add-wanxing-serving-api design D3/D6–D9) ──────────
//
// The protocol-agnostic core of the external front door (ADR-0014): caller-key
// authentication, per-caller rate bounds, (caller, agent) turn slots,
// Idempotency-Key deduplication, and boundary settlement of the caller's
// sub2api key by duration. It knows nothing about A2A — the protocol faces
// (a2a.js today, other protocols later) only call into it.
//
// Settlement direction (probed live 2026-10-03, scripts/probe-wanxing-settle.mjs):
// negative "add" is rejected by sub2api's validation; `operation: "subtract"`
// with a positive amount is the deduction form. The usage-row id rides the
// Idempotency-Key so a retried deduction lands exactly once.

import { createHash, randomBytes } from "node:crypto";

const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");

export function maskKey(key) {
  const s = String(key || "");
  return s ? `…${s.slice(-4)}` : "";
}

// The external agent slug — the deployment's registry path, normalized the
// same way the runner derives its agent key, lowercased and stable across
// in-place upgrades (path carries pack+agent identity).
export function slugFor(agentPath) {
  return String(agentPath || "").replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
}

export function createWanxingCore({ store, sub2api, config = {} }) {
  const cfg = {
    ratePerMin: config.ratePerMin ?? Number(process.env.WANXING_RATE_PER_MIN ?? 0.1),
    rpmMax: config.rpmMax ?? Number(process.env.WANXING_RPM_MAX ?? 30),
    keyCacheTtlMs: config.keyCacheTtlMs ?? 60_000,
    negCacheTtlMs: config.negCacheTtlMs ?? 15_000,
    suspendAfterFailures: config.suspendAfterFailures ?? Number(process.env.WANXING_SUSPEND_AFTER_FAILURES ?? 3),
    idemWindowMs: config.idemWindowMs ?? 86_400_000,
  };

  // In-memory verdict cache keyed by sha256(key) — the key itself is never a
  // Map key or a stored value (log/audit surfaces only ever see maskKey()).
  const verdicts = new Map();
  const rpmBuckets = new Map(); // userId → { windowStart, count }
  const inflightSlots = new Set(); // `${userId}|${slug}`
  const flights = new Map(); // `${userId}|${slug}|${idemKey}` → promise (single-flight)

  const authError = (status, code, message, extra = {}) => ({ ok: false, status, code, message, ...extra });

  async function authenticate(rawKey) {
    // Fail-closed: without the billing plane the facade has no admission
    // rule (same philosophy as the deploy-time balance gate).
    if (!sub2api || sub2api.degraded()) {
      return authError(503, "WANXING_BILLING_UNAVAILABLE", "the billing plane is not configured on this deployment");
    }
    const key = String(rawKey || "").trim();
    if (!/^sk-/.test(key) || key.length > 256) return authError(401, "INVALID_KEY", "a sub2api caller key (sk-…) is required");

    const digest = sha256(key);
    const cached = verdicts.get(digest);
    if (cached && Date.now() - cached.at < (cached.ok ? cfg.keyCacheTtlMs : cfg.negCacheTtlMs)) {
      return cached.verdict;
    }

    // The liveness probe IS the billing gate: GET /v1/models runs the full
    // balance/group/quota check at zero cost, and returns the gateway's own
    // refusal code when the key is dead or broke.
    const probe = await sub2api.probeKeyLiveness(key);
    if (!probe.ok) {
      const broke = /BALANCE/i.test(String(probe.code || "") + String(probe.message || ""));
      const verdict = authError(broke ? 402 : 401, broke ? "INSUFFICIENT_BALANCE" : (probe.code || "INVALID_KEY"), probe.message || "the caller key was refused by the billing gate");
      verdicts.set(digest, { at: Date.now(), ok: false, verdict });
      return verdict;
    }
    const holder = await sub2api.findUserByKey(key);
    if (!holder || !holder.userId) {
      const verdict = authError(401, "UNRESOLVED_KEY", "the caller key cannot be resolved to a sub2api account");
      verdicts.set(digest, { at: Date.now(), ok: false, verdict });
      return verdict;
    }
    const state = store.callerState(holder.userId);
    if (state?.suspended_reason) {
      return authError(402, "CALLER_SUSPENDED", `suspended: ${state.suspended_reason}`);
    }
    const verdict = { ok: true, caller: { userId: holder.userId, email: holder.email ?? "" } };
    verdicts.set(digest, { at: Date.now(), ok: true, verdict });
    return verdict;
  }

  // Rolling per-caller RPM bound across agents (in-memory: anti-abuse
  // backstop; the financial hard cap lives on the key's sub2api windows).
  function checkRpm(userId) {
    const nowTs = Date.now();
    let b = rpmBuckets.get(userId);
    if (!b || nowTs - b.windowStart >= 60_000) {
      b = { windowStart: nowTs, count: 0 };
      rpmBuckets.set(userId, b);
    }
    b.count += 1;
    return b.count <= cfg.rpmMax;
  }

  // One in-flight turn per (caller, agent): the single-writer discipline at
  // the facade. A second concurrent request is refused with a retry hint,
  // never interleaved into the running turn.
  function acquireSlot(userId, slug) {
    const k = `${userId}|${slug}`;
    if (inflightSlots.has(k)) return false;
    inflightSlots.add(k);
    return true;
  }
  function releaseSlot(userId, slug) {
    inflightSlots.delete(`${userId}|${slug}`);
  }

  // Agent admission: visibility first (public = any solvent key), then the
  // private allowlist; paused answers its state explicitly, never a timeout.
  function admit(caller, agent) {
    if (!agent.exists) return authError(404, "AGENT_NOT_FOUND", "no such agent is deployed on this platform");
    if (agent.paused) return authError(423, "AGENT_PAUSED", "this agent is paused");
    if (agent.visibility === "private" && !store.allowlistHas(agent.slug, caller.userId)) {
      return authError(403, "CALLER_NOT_AUTHORIZED", `caller ${caller.email || caller.userId} is not on this agent's allowlist`);
    }
    return { ok: true };
  }

  // Idempotency for message/send: replay the recorded outcome inside the
  // window; concurrent duplicates join the single in-process flight. The
  // ledger row is written before execution, so a crash mid-turn still leaves
  // `running` — treated as absent after the window, never replayed half-done.
  async function idempotentSend({ callerId, slug, idemKey, exec }) {
    if (!idemKey) return { replayed: false, ...(await exec()) };
    const existing = store.requestGet(callerId, slug, idemKey);
    if (existing && existing.state !== "running" && Date.now() - existing.created_at < cfg.idemWindowMs) {
      return { replayed: true, response: JSON.parse(existing.response) };
    }
    const flightKey = `${callerId}|${slug}|${idemKey}`;
    const running = flights.get(flightKey);
    if (running) {
      await running;
      const row = store.requestGet(callerId, slug, idemKey);
      return { replayed: true, response: row?.response ? JSON.parse(row.response) : null };
    }
    if (!store.requestStart(callerId, slug, idemKey)) {
      // Lost an insert race (only possible across processes; keep symmetric).
      await Promise.resolve();
    }
    const flight = (async () => {
      try {
        const out = await exec();
        store.requestFinish(callerId, slug, idemKey, "done", JSON.stringify(out.response ?? out));
        return { replayed: false, ...out };
      } catch (e) {
        store.requestFinish(callerId, slug, idemKey, "error", JSON.stringify({ error: { code: e.code ?? -32032, message: String(e?.message || e) } }));
        throw e;
      } finally {
        flights.delete(flightKey);
      }
    })();
    flights.set(flightKey, flight);
    return flight;
  }

  // Admission triage for the protocol face: a finished request replays from
  // the ledger (no slot, no RPM — it is a read), a running flight is JOINED
  // (the turn is already admitted; spec: concurrent duplicates both receive
  // its outcome), and only a genuinely new turn goes through rate + slot.
  function idempotencyState({ callerId, slug, idemKey }) {
    if (!idemKey) return "new";
    if (flights.has(`${callerId}|${slug}|${idemKey}`)) return "running";
    const row = store.requestGet(callerId, slug, idemKey);
    if (row && Date.now() - row.created_at < cfg.idemWindowMs) {
      return row.state === "running" ? "running" : "done";
    }
    return "new";
  }

  // ── Boundary settlement (spec: platform-billing) ─────────────────────────
  // Minutes round UP — a 5-second turn bills one minute unit (the rate table
  // is per started minute). outcome=error rows are recorded but waived: the
  // caller is never charged for a turn that produced nothing.
  function recordUsage({ caller, slug, idemKey, startedAt, endedAt, outcome }) {
    const durationMs = Math.max(0, endedAt - startedAt);
    const billable = outcome === "ok";
    const minutesBilled = billable ? Math.max(1, Math.ceil(durationMs / 60_000)) : 0;
    const row = {
      id: `wu_${randomBytes(12).toString("hex")}`,
      callerId: caller.userId,
      callerEmail: caller.email,
      agentSlug: slug,
      idemKey: idemKey || "",
      startedAt,
      endedAt,
      durationMs,
      outcome,
      minutesBilled,
      rateUsd: cfg.ratePerMin,
      settlementStatus: billable ? "pending" : "waived",
    };
    store.usageInsert(row);
    return row;
  }

  async function trySettle(row) {
    const amount = Number((row.minutesBilled * row.rateUsd).toFixed(4));
    try {
      await sub2api.adjustBalance({
        userId: row.callerId,
        amountUsd: amount,
        operation: "subtract",
        idempotencyKey: row.id,
      });
      store.usageMarkSettled(row.id);
      store.clearCaller(row.callerId);
      return true;
    } catch (e) {
      // A retry whose deduction already landed (crash between the upstream
      // success and the local mark) comes back as a duplicate refusal — that
      // IS the settled state, not a new failure.
      if (/duplicate|idempoten/i.test(String(e?.message || ""))) {
        store.usageMarkSettled(row.id);
        store.clearCaller(row.callerId);
        return true;
      }
      const failures = store.recordSettlementFailure(row.callerId, e?.message || "settlement failed");
      if (failures >= cfg.suspendAfterFailures) {
        store.suspendCaller(row.callerId, `settlement failed ${failures}× (${e?.message || e})`);
      }
      return false;
    }
  }

  // Boot/timer sweep: retry everything still pending. The row id's
  // Idempotency-Key makes retries safe — a deduction that already landed is
  // refused upstream as a duplicate, which adjustBalance surfaces as an
  // error; treat idempotent-duplicate replies as settled.
  async function settlePending() {
    for (const raw of store.usagePending()) {
      const row = { ...raw, callerId: raw.caller_id, minutesBilled: raw.minutes_billed, rateUsd: raw.rate_usd };
      try {
        await trySettle(row);
      } catch { /* logged by the failure counter */ }
    }
  }

  return {
    config: cfg,
    authenticate,
    checkRpm,
    acquireSlot,
    releaseSlot,
    admit,
    idempotentSend,
    idempotencyState,
    recordUsage,
    trySettle,
    settlePending,
  };
}
