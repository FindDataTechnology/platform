// ── Wanxing facade, A2A protocol face (add-wanxing-serving-api design D2/D5) ─
//
// The v1 wire protocol of the external front door: native A2A JSON-RPC at
// per-agent routes, the public catalog and cards, forwarded to the agent's
// runtime route through the registry proxy on the platform's internal dual
// credentials (X-Authorization service credential + Authorization backend
// token — both platform-held; the caller's sub2api key never travels past
// this module). Everything auth/limit/idempotency/settlement-shaped is
// delegated to the protocol-agnostic core.

import express from "express";
import { createHash, randomBytes } from "node:crypto";

const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const EXTERNAL_CONTEXT_PREFIX = "wx:"; // the runner's reap pass keys on this (design D10)

const textOf = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
  return text || null;
};

const jsonRpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

// Context derivation: caller-supplied context_id passes through untouched; a
// send without one gets a fresh external context derived from the idempotency
// key (stable across replays — a replayed request resumes the same context),
// a stream without one gets a one-shot context. All derived ids carry the
// external prefix so the runner can reap them.
export function contextIdFor(message, idemKey) {
  const supplied = message?.context_id ?? message?.contextId ?? null;
  if (supplied) return String(supplied);
  if (idemKey) return `${EXTERNAL_CONTEXT_PREFIX}${sha256(idemKey).slice(0, 16)}`;
  return `${EXTERNAL_CONTEXT_PREFIX}${randomBytes(8).toString("hex")}`;
}

export function createA2aFace({
  core,
  resolveDeployment, // async (slug) → { agentPath } | null
  listDeployments,   // async () → [{ slug, agentPath }]
  hardStale = () => false, // enumeration faces 503 when the bookkeeping snapshot is past its hard window
  ensureFresh = async () => {}, // awaited before that guard: a blocking best-effort refresh (idle-facade self-heal)
  report = null,     // optional ({kind, agent, payload, id?}) → fleet-observer (add-fleet-event-backbone 6.3)
  forwardHeaders,    // () → the platform's internal dual-credential headers
  registryFetch,     // (path, init?) → fetch Response against the registry
  config,            // { agentUrlFor(agentPath) }
  upstreamFetch = fetch, // injection seam for tests
}) {
  const note = (kind, agent, payload = {}, id = null) => {
    try {
      report?.({ kind, agent, payload, id });
    } catch { /* observability never breaks a turn */ }
  };
  // Registry-entry cache: catalog/visibility on a 60s TTL; the paused flag
  // re-reads when older than 15s so an operator's pause reflects promptly
  // (the runner itself lags up to its poll interval anyway).
  const entryTtlMs = 60_000;
  const pausedTtlMs = 15_000;
  const entryCache = new Map(); // slug → { at, entry }

  // The deployment source (packs internal API, add-facet-platform S0) being
  // unreachable is a 503, never a hang and never a silent "no agents": the
  // resolvers throw and the routes translate.
  const sourceUnavailable = (res, note) =>
    res.status(503).json({ error: { code: "DEPLOYMENT_SOURCE_UNAVAILABLE", message: `deployment source unreachable (${note})` } });

  async function entryFor(slug, dep = null) {
    const cached = entryCache.get(slug);
    if (cached && Date.now() - cached.at < entryTtlMs) return cached.entry;
    const d = dep ?? (await resolveDeployment(slug));
    if (!d) return null;
    let entry = null;
    try {
      const r = await registryFetch(`/api/agents${d.agentPath}`);
      if (r.ok) entry = await r.json();
    } catch { /* registry unreachable: fall through to the cached view */ }
    if (!entry) return cached?.entry ?? null;
    entryCache.set(slug, { at: Date.now(), entry });
    return entry;
  }

  async function agentState(slug) {
    const dep = await resolveDeployment(slug);
    if (!dep) return { exists: false, slug };
    let entry = await entryFor(slug, dep);
    const cached = entryCache.get(slug);
    if (entry && (!cached || Date.now() - cached.at >= pausedTtlMs)) {
      // A stale-enough view re-reads once so the paused flag is current; on
      // a registry hiccup the cached verdict stands.
      try {
        const r = await registryFetch(`/api/agents${dep.agentPath}`);
        if (r.ok) {
          entry = await r.json();
          entryCache.set(slug, { at: Date.now(), entry });
        }
      } catch { /* keep the cached view */ }
    }
    if (!entry) return { exists: false, slug };
    return {
      exists: true,
      slug,
      visibility: entry?.visibility === "private" ? "private" : "public",
      paused: entry?.metadata?.paused === true,
      entry,
      agentPath: dep.agentPath,
    };
  }

  function publicCard(slug, entry, req) {
    return {
      name: entry.name,
      description: entry.description,
      version: entry.version,
      provider: entry.provider ?? { organization: "paas-pack" },
      capabilities: entry.capabilities ?? { streaming: true },
      skills: entry.skills ?? [],
      tags: entry.tags ?? [],
      default_input_modes: entry.default_input_modes ?? ["text"],
      default_output_modes: entry.default_output_modes ?? ["text"],
      preferred_transport: entry.preferred_transport ?? "jsonrpc",
      // The card points callers at the facade, never at the internal runtime.
      url: `${req.protocol}://${req.get("host")}/api/wanxing/v1/a2a/${slug}`,
    };
  }

  function register(app) {
    // ── Public discovery: no credential by design (spec: card and catalog
    // are public). Private agents are simply absent from both. Both faces
    // hard-degrade on a hard-stale snapshot (design D2.1); the A2A turn
    // path never does.
    app.get("/api/wanxing/v1/agents", async (req, res) => {
      await ensureFresh().catch(() => {});
      if (hardStale()) return sourceUnavailable(res, "snapshot hard-stale");
      const out = [];
      let deps;
      try {
        deps = await listDeployments();
      } catch (e) {
        return sourceUnavailable(res, String(e?.message || e));
      }
      for (const dep of deps) {
        const entry = await entryFor(dep.slug, dep);
        if (!entry || entry.visibility === "private") continue;
        out.push({
          slug: dep.slug,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          tags: entry.tags ?? [],
          capabilities: entry.capabilities ?? { streaming: true },
          skills: entry.skills ?? [],
        });
      }
      // Pagination (add-wanxing-deployments-cache): explicit page/page_size
      // pages the public list with a total; no params keeps the legacy full
      // shape so existing callers (finddata) are untouched.
      const q = req.query ?? {};
      if (q.page === undefined && q.page_size === undefined) {
        return res.json({ agents: out });
      }
      const clamp = (v, def) => {
        const n = Number.parseInt(String(v), 10);
        return Number.isFinite(n) && n > 0 ? n : def;
      };
      const pageSize = Math.min(clamp(q.page_size, 50), 200);
      const page = clamp(q.page, 1);
      res.json({
        agents: out.slice((page - 1) * pageSize, page * pageSize),
        page,
        page_size: pageSize,
        total: out.length,
      });
    });

    app.get("/api/wanxing/v1/a2a/:agentSlug/.well-known/agent-card.json", async (req, res) => {
      await ensureFresh().catch(() => {});
      if (hardStale()) return sourceUnavailable(res, "snapshot hard-stale");
      let state;
      try {
        state = await agentState(req.params.agentSlug);
      } catch (e) {
        return sourceUnavailable(res, String(e?.message || e));
      }
      if (!state.exists || state.visibility === "private") {
        return res.status(404).json({ error: { code: "AGENT_NOT_FOUND", message: "no public agent at this route" } });
      }
      res.json(publicCard(req.params.agentSlug, state.entry, req));
    });

    // ── The A2A turn surface. Order is the kernel's admission pipeline:
    // key gate → protocol shape → agent admission → rate → slot → idempotency.
    app.post("/api/wanxing/v1/a2a/:agentSlug", express.json({ limit: "1mb" }), async (req, res) => {
      const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const auth = await core.authenticate(bearer);
      if (!auth.ok) {
        note("refused", req.params.agentSlug, { stage: "key", code: auth.code });
        return res.status(auth.status).json({ error: { code: auth.code, message: auth.message } });
      }
      const caller = auth.caller;

      const { id, method, params } = req.body ?? {};
      if (req.body?.jsonrpc !== "2.0" || typeof method !== "string") {
        return res.status(200).json(jsonRpcError(id, -32600, "Invalid Request"));
      }
      if (method !== "message/send" && method !== "message/stream") {
        return res.status(200).json(jsonRpcError(id, -32601, `Method not found: ${method}`));
      }
      const message = params?.message ?? params;
      const text = textOf(message);
      if (!text) return res.status(200).json(jsonRpcError(id, -32604, "empty message"));

      const slug = req.params.agentSlug;
      let state;
      try {
        state = await agentState(slug);
      } catch (e) {
        note("refused", slug, { stage: "source", code: "DEPLOYMENT_SOURCE_UNAVAILABLE" });
        return sourceUnavailable(res, String(e?.message || e));
      }
      const admitted = core.admit(caller, state);
      if (!admitted.ok) {
        note("refused", slug, { stage: "admission", code: admitted.code, caller: caller.email || caller.userId });
        return res.status(admitted.status).json({ error: { code: admitted.code, message: admitted.message } });
      }

      if (!core.checkRpm(caller.userId)) {
        note("refused", slug, { stage: "rate", code: "RATE_LIMITED", caller: caller.email || caller.userId });
        return res.status(429).json({ error: { code: "RATE_LIMITED", message: "caller rate limit exceeded" } });
      }

      const idemKey = (() => {
        const h = req.headers["idempotency-key"];
        return typeof h === "string" && h.trim() ? h.trim().slice(0, 200) : null;
      })();
      // Idempotency triage BEFORE the slot (send only — streams never replay):
      // a finished request replays from the ledger (a read), a running flight
      // is JOINED (the turn is already admitted; concurrent duplicates both
      // receive its outcome), and only a genuinely new turn takes the
      // (caller, agent) concurrency slot. Replays and joins never hold the
      // slot, so they cannot leak it, and they record no usage of their own.
      const prior = method === "message/send" ? core.idempotencyState({ callerId: caller.userId, slug, idemKey }) : "new";
      let holdsSlot = false;
      if (prior === "new") {
        if (!core.acquireSlot(caller.userId, slug)) {
          note("refused", slug, { stage: "slot", code: "TURN_IN_FLIGHT", caller: caller.email || caller.userId });
          res.set("Retry-After", "5");
          return res.status(409).json({ error: { code: "TURN_IN_FLIGHT", message: "a turn for this caller and agent is already running; retry after the hint" } });
        }
        holdsSlot = true;
      }

      const contextId = contextIdFor(message, idemKey);
      const startedAt = Date.now();
      if (prior !== "done") note("admitted", slug, { caller: caller.email || caller.userId, idem_key: idemKey || "", transport: method });

      // finish = THIS request's turn ended (slot-holder only): ledger row +
      // fire-and-forget settlement (the pending sweep retries, idempotently).
      // exitReadonly = a replay/join leaves without recording anything.
      const finish = (outcome) => {
        core.releaseSlot(caller.userId, slug);
        const row = core.recordUsage({ caller, slug, idemKey, startedAt, endedAt: Date.now(), outcome });
        // Deterministic event id (the usage row id): inline settle and the
        // pending sweep can both report this row — exactly once on the observer.
        if (row.settlementStatus === "waived") {
          note("settled", slug, { minutes_billed: 0, usd: 0, settlement_status: "waived", outcome }, `facade-${row.id}`);
        } else {
          void core.trySettle(row)
            .then((ok) => note("settled", slug, {
              minutes_billed: row.minutesBilled,
              usd: Number((row.minutesBilled * row.rateUsd).toFixed(4)),
              settlement_status: ok ? "settled" : "pending",
              outcome,
            }, `facade-${row.id}`))
            .catch(() => note("settled", slug, { minutes_billed: row.minutesBilled, usd: Number((row.minutesBilled * row.rateUsd).toFixed(4)), settlement_status: "pending", outcome }, `facade-${row.id}`));
        }
      };
      const exitReadonly = () => {
        if (holdsSlot) core.releaseSlot(caller.userId, slug);
      };

      const rpcBody = (m) => JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: m,
        params: { message: { role: "user", parts: [{ kind: "text", text }], context_id: contextId } },
      });

      try {
        if (method === "message/stream") {
          // Raw SSE passthrough: frames flow unmodified; the ledger closes
          // when the upstream stream ends (done or error).
          const upstream = await upstreamFetch(config.agentUrlFor(state.agentPath), {
            method: "POST",
            headers: { ...forwardHeaders(), "Content-Type": "application/json" },
            body: rpcBody("message/stream"),
          });
          const ctype = upstream.headers.get("content-type") || "";
          if (!upstream.ok || !ctype.includes("text/event-stream")) {
            const body = await upstream.text().catch(() => "");
            finish("error");
            return res.status(502).json({ error: { code: "UPSTREAM_FAILED", message: `agent route refused the turn: ${body.slice(0, 200) || upstream.status}` } });
          }
          res.status(200).set("Content-Type", "text/event-stream").set("Cache-Control", "no-cache");
          let outcome = "ok";
          try {
            const reader = upstream.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              // Decode ONCE — the decoder is stateful across chunks; an error
              // event in the frame flips the turn unbillable.
              const frame = decoder.decode(value, { stream: true });
              res.write(frame);
              if (/event:\s*error/.test(frame)) outcome = "error";
            }
          } catch {
            outcome = "error";
          } finally {
            res.end();
            finish(outcome);
          }
          return;
        }

        // message/send, with replay semantics on the idempotency key.
        const out = await core.idempotentSend({
          callerId: caller.userId,
          slug,
          idemKey,
          exec: async () => {
            const upstream = await upstreamFetch(config.agentUrlFor(state.agentPath), {
              method: "POST",
              headers: { ...forwardHeaders(), "Content-Type": "application/json" },
              body: rpcBody("message/send"),
            });
            const doc = await upstream.json().catch(() => null);
            if (!upstream.ok) {
              throw Object.assign(new Error(`agent route refused the turn (${upstream.status})`), { code: -32033 });
            }
            return { response: doc ?? { jsonrpc: "2.0", id: id ?? null, result: { message: { parts: [] } } } };
          },
        });
        // message/send: replay/join land here without a slot of their own —
        // no usage row, no settle; the flight's owner did (or will) record.
        if (!out.replayed) finish("ok");
        else exitReadonly();
        res.status(200).json(out.response);
      } catch (e) {
        if (holdsSlot) finish("error");
        else exitReadonly();
        res.status(200).json(jsonRpcError(id, Number.isInteger(e?.code) ? e.code : -32032, String(e?.message || e)));
      }
    });
  }

  return { register, entryFor, agentState };
}
