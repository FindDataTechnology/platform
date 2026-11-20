// ── Actions MCP server (add-line-boards-and-action-gate, task 6.1) ───────────
//
// Exposes the propose_action tool to dsh agents. It is a thin client over the
// /api/actions/propose loopback REST bridge. The child only names an action;
// everything a proposal needs — the user's email, preflight checks, risk tier —
// lives HERE in host configuration.
//
// The tool returns {proposalId, state:"pending", impact, risk, target, tier}.
// The model can then render a confirmation card; the user's approve/reject
// decisions are NOT part of this channel — they ride WS messages back to the
// cell and resolve through routes/actions.js.
//
// Identity (add-wire-line-board D4): the per-user effective profile injects
// ACTIONS_MCP_PROPOSER_EMAIL into this child's env; every proposal names that
// user so the owner-only approve can match it. The loopback route trusts the
// value only on POST /api/actions/propose (server/auth.js).

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Declarations only — the registry's import chain opens no database until a
// handler asks for one, so the child stays a thin stdio process.
import { argKeysFor, listActions, requiredArgsFor } from "../lib/action-registry.js";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

console.log = (...args) => console.error(...args);

export const PROPOSER_EMAIL_ENV = "ACTIONS_MCP_PROPOSER_EMAIL";

export function proposerEmailFromEnv(env = process.env) {
  const v = String(env[PROPOSER_EMAIL_ENV] || "").trim().toLowerCase();
  return v || null;
}

function bridgeOrigin() {
  if (process.env.ACTIONS_MCP_URL) return process.env.ACTIONS_MCP_URL.replace(/\/$/, "");
  const raw = process.env.HOST || "localhost";
  const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${process.env.PORT || 3000}`;
}

async function call(method, path, body) {
  // Outbound call discipline: shared deadline wrapper — a stalled bridge fails
  // as a structured retryable FetchTimeoutError instead of hanging the tool.
  const res = await fetchWithTimeout(`${bridgeOrigin()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }, { timeoutMs: 10_000 });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // `details` is what lets the model self-correct in the same turn (the
    // expected key list, the connect path) — "invalid args" alone would not.
    const reason = data.details ? `${data.error}: ${data.details}` : data.error;
    throw new Error(reason || `${method} ${path} failed (${res.status})`);
  }
  return data;
}

// One entry per action, parameter names verbatim from the registry (* =
// required), so the model reads the tool's keys instead of guessing them.
export const ARG_SPEC = listActions()
  .map((a) => {
    const required = new Set(requiredArgsFor(a.id));
    const keys = argKeysFor(a.id).map((k) => (required.has(k) ? `${k}*` : k));
    return `${a.id} {${keys.join(", ")}}`;
  })
  .join("; ");

const TOOLS = [
  {
    name: "propose_action",
    description:
      "Propose an action that requires human confirmation before execution. " +
      "The proposal enters a pending state with a unique ID; the caller should " +
      "render a confirmation card showing the impact and risk tier. Approval " +
      "and rejection happen outside this channel via WebSocket messages. " +
      "Pass exactly the argument keys declared for the action (listed under " +
      "args): unknown keys are dropped and a missing required key is rejected " +
      "with the expected list — do not guess names.",
    inputSchema: {
      type: "object",
      required: ["actionId", "args"],
      properties: {
        actionId: {
          type: "string",
          description: "Registered action id (e.g., 'facet.pack.visibility', 'wanxing.agent.pause')",
        },
        args: {
          type: "object",
          description: `Action-specific arguments, keys exactly as declared (* = required): ${ARG_SPEC}`,
        },
      },
    },
  },
];

export async function createServer() {
  // capabilities.tools is REQUIRED: the dsh client's connect() asserts it
  // before any tools/list — an empty capabilities object kills the child at
  // startup ("Server does not support tools"), which is exactly what the
  // first live stdio handshake on the demo pod caught (2026-10-21).
  const server = new Server({ name: "actions-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "propose_action") {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
    }

    try {
      const { actionId, args: actionArgs } = args || {};
      if (!actionId || !actionArgs) {
        return { content: [{ type: "text", text: "actionId and args required" }], isError: true };
      }

      const result = await call("POST", "/api/actions/propose", {
        actionId,
        args: actionArgs,
        proposerEmail: proposerEmailFromEnv(),
        proposerSession: process.env.DSH_SESSION_ID || process.env.ACTIONS_MCP_SESSION || null,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              proposalId: result.proposalId,
              state: result.state,
              impact: result.impact,
              risk: result.risk,
              target: result.target,
              tier: result.tier,
              userFilledArgs: result.userFilledArgs ?? [],
            }),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: err.message || "propose_action failed" }], isError: true };
    }
  });

  return server;
}

async function run() {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the stdio server when launched as the MCP child; importing the
// module (tests, profile tooling) must stay side-effect free.
const launchedDirectly = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (launchedDirectly) {
  run().catch((err) => {
    console.error("[actions-mcp] fatal:", err.message);
    process.exit(1);
  });
}
