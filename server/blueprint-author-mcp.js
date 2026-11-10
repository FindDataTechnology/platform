// Blueprint author MCP child (add-builder-team-templates) — a thin stdio
// client over the loopback bridge (/api/blueprint-author,
// server/blueprint-author.js). Same credential model as the fleet-architect
// child: loopback is its credential, the bridge resolves the acting OWNER
// server-side. Business lives in the bridge; this file declares three tools
// and relays. Toolset is deliberately narrow: drafts_list / validate / save —
// NO approve, NO cast, NO trial, NO delete (those are the owner's gestures in
// the Blueprint Studio). The tool descriptions carry the discipline.
//
// The stdio channel IS the protocol: stdout must carry JSON-RPC and nothing
// else.
console.log = (...args) => console.error(...args);

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

function bridgeOrigin() {
  if (process.env.BLUEPRINT_AUTHOR_MCP_URL) return process.env.BLUEPRINT_AUTHOR_MCP_URL.replace(/\/$/, "");
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
  }, { timeoutMs: 15_000 });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

const DISCIPLINE =
  "Blueprint authoring tools (vertical-pack TEMPLATES, not live teams). Compose the blueprint JSON strictly per the schema discipline (boundary/dataSources/fleet/agents/mcpServers/monitoring/acceptance/board); data sources are registry server names or internal store logical names ONLY — no endpoints, no credentials. ALWAYS blueprint_validate first and show the user every finding; blueprint_save only after the user approves saving. You manage templates — for changes to a LIVE team hand over to the fleet architect (团队架构师); approval, minting and trials happen in the Blueprint Studio by the owner, never through you.";

const TOOLS = [
  {
    name: "blueprint_drafts_list",
    description: `${DISCIPLINE} List the owner's blueprint drafts: id, name, version, status.`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "blueprint_validate",
    description: `${DISCIPLINE} Dry-run one blueprint through the full existing validation chain. Nothing is persisted. Returns ok plus per-finding errors (field-named) and the manifest preview when green.`,
    inputSchema: {
      type: "object",
      properties: { content: { type: "object", description: "The blueprint object (boundary/dataSources/fleet/agents/mcpServers/monitoring/acceptance/board)." } },
      required: ["content"],
    },
  },
  {
    name: "blueprint_save",
    description: `${DISCIPLINE} Save a validation-green blueprint into the owner's draft pool (the SAME pool the Blueprint Studio's paste channel writes). Refuses to land a red draft. Saving is not approving: the owner approves, mints and trials in the Studio.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Scene name (defaults to boundary.name / fleet.name)." },
        content: { type: "object", description: "The blueprint object." },
      },
      required: ["content"],
    },
  },
];

function textOut(text) {
  return { content: [{ type: "text", text }] };
}
function errOut(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const server = new Server({ name: "blueprint-author", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  try {
    switch (name) {
      case "blueprint_drafts_list":
        return textOut(JSON.stringify((await call("GET", "/api/blueprint-author/drafts")).drafts, null, 2));
      case "blueprint_validate":
        return textOut(JSON.stringify(await call("POST", "/api/blueprint-author/validate", { content: args.content }), null, 2));
      case "blueprint_save": {
        const out = await call("POST", "/api/blueprint-author/save", { name: args.name, content: args.content });
        return textOut(`Saved to the draft pool: ${out.blueprint.name} (${out.blueprint.id}, v${out.blueprint.version}). The owner reviews, approves and mints in the Blueprint Studio.`);
      }
      default:
        return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
