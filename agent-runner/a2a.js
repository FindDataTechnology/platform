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
export function createAgentApp({ entry, manager, config, log = console }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

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

    try {
      const child = await manager.acquire(entry);
      if (method === "message/send") {
        const out = await child.turn(sessionId, text);
        return res.json({ jsonrpc: "2.0", id, result: assistantMessage(contextId ?? sessionId, out.text) });
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let acc = "";
      const out = await child.turn(sessionId, text, {
        onDelta: (delta) => {
          acc += delta;
          send("delta", { context_id: contextId ?? sessionId, kind: "message", parts: [{ kind: "text", text: acc }] });
        },
      });
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
