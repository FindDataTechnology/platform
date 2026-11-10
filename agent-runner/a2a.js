// ── A2A HTTP adapter (add-a2a-agent-serving 4.3/4.5) ────────────────────────
//
// The registry's reverse proxy maps /agent/{path}/** onto the registered
// URL's ORIGIN (upstream #1734 drops the URL's path — one agent per origin),
// so the runner serves EACH agent on its own port (see agentPortFor) with the
// A2A-spec flat layout:
//   GET  /.well-known/agent-card.json  — the card as registered
//   POST /                             — JSON-RPC message/send | message/stream
//
// Everything (card included) sits behind the backend-credential check: the
// gateway strips the caller's X-Authorization after /validate and forwards
// the caller's standard Authorization end-to-end (upstream's egress trust
// model — the gateway is not a credential broker), so the credential is the
// out-of-band A2A secret this deployment's clients carry. A request without
// it is rejected, gateway-proxied or not. Unsupported methods answer -32601;
// v1 emits text parts only.

import express from "express";
import { sessionKeyFor } from "./child.js";
import { agentPortFor } from "../lib/agent-serving.js";

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textOf(message) {
  const parts = message?.parts ?? [];
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("")
    .trim();
}

// Visitor scope (add-matter-visitor-scope D1b): the AUTHENTICATED caller's
// opaque scope, supplied by the facade (chat lane) as message metadata. Takes
// precedence over the session derivation — the same visitor sees their matters
// across conversations, different visitors never see each other. A2A callers
// without a facade (direct API) stay on the session/unscoped path.
function visitorScopeOf(message) {
  const v = message?.metadata?.visitor_scope ?? message?.metadata?.visitorScope;
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : null;
}

function assistantMessage(contextId, text) {
  return {
    role: "assistant",
    message_id: `m-${Date.now().toString(36)}`,
    context_id: contextId,
    kind: "message",
    parts: [{ kind: "text", text }],
  };
}

// One express app per hosted agent, bound by the manager to agentPortFor(key).
// `getEntry` (optional) resolves the agent's CURRENT registry entry per
// request: the listener outlives in-place upgrades while the manager refreshes
// entries on every poll, so a captured object would keep serving the stale
// descriptor (and stale card) after a redeploy — an upgrade, a secret rebind,
// or a notify-channel change would never reach composition. Falls back to the
// captured `entry` for direct/test callers.
export function createAgentApp({ entry, getEntry, manager, config, log = console }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  const currentEntry = () => (typeof getEntry === "function" ? getEntry() : entry);
  // In-flight asks on this agent's streams (add-serving-ask-bridge): askId →
  // "no longer pending" settler. The answer route (or the deadline backstop)
  // calls it so the stream's keepalive stops the moment the ask resolves —
  // comment frames ride only while an ask is pending.
  const liveAsks = new Map();
  const keepaliveMs = Number(config.askKeepaliveMs ?? process.env.SERVING_ASK_KEEPALIVE_MS) || 15_000;

  let warnedOpen = false;
  app.use((req, res, next) => {
    if (!config.backendToken) {
      if (!warnedOpen) {
        log.warn("[agent-runner] AGENT_RUNNER_BACKEND_TOKEN unset — accepting unauthenticated requests (dev mode)");
        warnedOpen = true;
      }
      return next();
    }
    if (req.headers.authorization === `Bearer ${config.backendToken}`) return next();
    return res.status(401).json({ error: "missing agent credential" });
  });

  app.get("/.well-known/agent-card.json", (_req, res) => {
    const entry = currentEntry();
    res.json({
      name: entry.name,
      description: entry.description,
      version: entry.version,
      provider: entry.provider ?? { organization: "paas-pack", url: config.registryUrl },
      capabilities: entry.capabilities ?? { streaming: true },
      skills: entry.skills ?? [],
      tags: entry.tags ?? [],
      default_input_modes: entry.default_input_modes ?? ["text"],
      default_output_modes: entry.default_output_modes ?? ["text"],
      preferred_transport: entry.preferred_transport ?? "jsonrpc",
      url: `${config.registryUrl}/agent${entry.path}/`,
    });
  });

  app.post("/", async (req, res) => {
    const entry = currentEntry();
    const { id, method, params } = req.body ?? {};
    if (req.body?.jsonrpc !== "2.0" || typeof method !== "string") {
      return res.status(200).json(jsonRpcError(id, -32600, "Invalid Request"));
    }
    if (method !== "message/send" && method !== "message/stream") {
      return res.status(200).json(jsonRpcError(id, -32601, "Method not found"));
    }
    const message = params?.message ?? params;
    const text = textOf(message);
    if (!text) return res.status(200).json(jsonRpcError(id, -32604, "empty message"));
    const contextId = message?.context_id ?? message?.contextId ?? null;
    const sessionId = sessionKeyFor(contextId ?? `${entry.path}`);

    // Paused agents answer explicitly (add-agent-residency: never a timeout,
    // never a cold start) — the check precedes acquire on purpose.
    if (manager.isPaused?.(entry)) {
      return res.status(200).json(jsonRpcError(id, -32010, "agent paused"));
    }
    // Delegation bound (add-agent-delegation-a2a): a chained call at or past
    // the depth cap is refused BEFORE any spawn — the cross-request cycle
    // breaker (ADR-0013).
    const depth = Math.max(0, Number(req.headers["x-delegation-depth"]) || 0);
    if (depth >= (config.delegationDepthMax ?? 3)) {
      return res.status(200).json(jsonRpcError(id, -32011, `delegation depth bound (${config.delegationDepthMax ?? 3}) reached`));
    }
    try {
      if (method === "message/send") {
        // No answerer on a synchronous turn: the harness declines any ask at
        // once (caller-cannot-answer), so the reply arrives on its usual path.
        const out = await manager.turn(entry, sessionId, text, { kind: "message", delegationDepth: depth, visitorScope: visitorScopeOf(message) });
        return res.json({ jsonrpc: "2.0", id, result: assistantMessage(contextId ?? sessionId, out.text) });
      }
      // 流式与披露闸在语义上不兼容 (add-principal-disclosure-gate 1.7)：delta 是
      // 边生成边发的，出口闸拿到全文时前半句已经到了对端。要么破坏流式（缓冲全
      // 部 delta 再一次性发），要么破坏闸（放行已发出的半句）。两者都不接受，
      // 所以对外车道（声明了 mandateDomain）直接不提供流式。
      //
      // 这不是降级，是划界：能逐段评估的东西才能流式发。
      const streamDomain = entry?.mandateDomain ?? null;
      if (streamDomain) {
        return res.status(200).json(
          jsonRpcError(id, -32013, "streaming is unavailable for outbound lanes: a disclosure verdict covers the whole message, and deltas leave before it can be obtained"),
        );
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let acc = "";
      // Ask lane (add-serving-ask-bridge D3): only a caller that opted in by
      // header receives in-flight asks — every other stream leaves the ask
      // to the harness's immediate decline, so an unaware consumer's timing
      // never changes. While an ask is pending the stream carries keepalive
      // comment frames so idle proxies between here and the caller hold on
      // through a human-paced pause.
      const askCapable = String(req.headers["x-serving-ask"] ?? "") === "1";
      let pendingAsk = null; // { askId, stop }
      const settleAsk = () => {
        if (!pendingAsk) return;
        pendingAsk.stop();
        pendingAsk = null;
      };
      const onAsk = (ask) => {
        settleAsk();
        send("ask", ask);
        const ka = setInterval(() => {
          if (!res.writableEnded) res.write(": keepalive\n\n");
        }, keepaliveMs);
        // Backstop: the harness cancels the ask at its deadline; a beat later
        // it is no longer pending by construction even if no answer route
        // call ever arrived.
        const backstop = setTimeout(() => settleAsk(), Math.max(0, (Number(ask.deadlineAt) || Date.now()) - Date.now() + 1_000));
        backstop.unref?.();
        const askId = ask.askId;
        pendingAsk = {
          askId,
          stop: () => {
            clearInterval(ka);
            clearTimeout(backstop);
            liveAsks.delete(askId);
          },
        };
        liveAsks.set(askId, () => {
          if (pendingAsk?.askId === askId) settleAsk();
        });
      };
      let out;
      try {
        out = await manager.turn(entry, sessionId, text, {
          delegationDepth: depth,
          visitorScope: visitorScopeOf(message),
          onDelta: (delta) => {
            acc += delta;
            send("delta", { context_id: contextId ?? sessionId, kind: "message", parts: [{ kind: "text", text: acc }] });
          },
          ...(askCapable ? { onAsk } : {}),
        });
      } finally {
        settleAsk();
      }
      send("message", assistantMessage(contextId ?? sessionId, out.text));
      res.write("event: done\ndata: {}\n\n");
      return res.end();
    } catch (e) {
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ code: e.code ?? -32003, message: e.message })}\n\n`);
        return res.end();
      }
      return res.status(200).json(jsonRpcError(id, e.code ?? -32003, e.message || "agent failure"));
    }
  });

  // Ask answers (add-serving-ask-bridge D2): the side route for an in-flight
  // ask — same credential gate as the turn methods (the app-level check above
  // runs first). The receipt is the runtime's own: `{accepted: true}` for the
  // first submission that lands, `{accepted: false, reason}` for an unknown or
  // already-resolved ask — first-wins, relayed as-is. Either way the ask is no
  // longer pending on its stream, so its keepalive stops here.
  app.post("/ask-answer", async (req, res) => {
    const entry = currentEntry();
    const body = req.body ?? {};
    const askId = typeof body.askId === "string" ? body.askId : "";
    const cancelled = body.cancelled === true;
    if (!askId || (!cancelled && !Array.isArray(body.answers))) {
      return res.status(400).json({ error: "askId plus answers[] or cancelled:true required" });
    }
    const receipt = await manager.answerAsk(entry, askId, cancelled ? { cancelled: true } : { answers: body.answers });
    liveAsks.get(askId)?.();
    return res.json(receipt);
  });

  return app;
}

// The runner's MAIN listener: ops/registry health surface only (the registry's
// per-agent health checks hit each agent's own port; this one is the board's).
export function createOpsApp({ manager }) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => res.json(manager.health()));
  return app;
}

export { agentPortFor };
