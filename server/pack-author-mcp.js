// Pack author MCP child (add-builder-team-templates) — a thin stdio client
// over the loopback bridge (/api/pack-author, server/pack-author.js). Same
// credential model as the fleet-architect child. Toolset is deliberately
// narrow: drafts_list / market_servers / validate / save — NO publish, NO
// pricing, NO deploy, NO packId minting (the publish gate is the owner's, in
// the pack editor). MCP references are PICKED from market_servers, never
// typed. The tool descriptions carry the discipline.
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
  if (process.env.PACK_AUTHOR_MCP_URL) return process.env.PACK_AUTHOR_MCP_URL.replace(/\/$/, "");
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
  "Pack authoring tools (general capability packs, not facades — for AI-facade packs hand over to the Facade Builder 分身工坊). Interview the owner about the capability domain, then compose a pack manifest: skills (name/description/content), agents (id/name/persona), and MCP references PICKED from market_servers (never invent a registryName, never add endpoints or credentials). ALWAYS pack_validate first and show the user every error; pack_save only after the user approves saving. Saving lands an EDITABLE DRAFT — publish, pricing and deploy happen through the pack editor's publish gate by the owner, never through you.";

const TOOLS = [
  {
    name: "pack_drafts_list",
    description: `${DISCIPLINE} List the owner's pack drafts: id, name, entry counts, published pack id if any.`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pack_market_servers",
    description: `${DISCIPLINE} List the registry-sourced MCP servers available for picking (name + description). The ONLY legal source for mcpServers[].registryName.`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pack_validate",
    description: `${DISCIPLINE} Dry-run one manifest through the same validator the install path applies. Nothing is persisted; errors are per-item and field-named.`,
    inputSchema: {
      type: "object",
      properties: { manifest: { type: "object", description: "The pack manifest (name/description/tags/skills/agents/mcpServers/guide)." } },
      required: ["manifest"],
    },
  },
  {
    name: "pack_save",
    description: `${DISCIPLINE} Save a validation-green manifest as an EDITABLE DRAFT in the owner's draft pool (optionally updating an existing draft by id). Refuses a red manifest. Saving is not publishing.`,
    inputSchema: {
      type: "object",
      properties: {
        manifest: { type: "object", description: "The pack manifest." },
        draftId: { type: "string", description: "Existing draft id to update (from pack_drafts_list); omit to create a new draft." },
      },
      required: ["manifest"],
    },
  },
];

function textOut(text) {
  return { content: [{ type: "text", text }] };
}
function errOut(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const server = new Server({ name: "pack-author", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  try {
    switch (name) {
      case "pack_drafts_list":
        return textOut(JSON.stringify((await call("GET", "/api/pack-author/drafts")).drafts, null, 2));
      case "pack_market_servers":
        return textOut(JSON.stringify((await call("GET", "/api/pack-author/market-servers")).servers, null, 2));
      case "pack_validate":
        return textOut(JSON.stringify(await call("POST", "/api/pack-author/validate", { manifest: args.manifest }), null, 2));
      case "pack_save": {
        const out = await call("POST", "/api/pack-author/save", { manifest: args.manifest, draftId: args.draftId });
        return textOut(`${out.draft.name} (${out.draft.id}) saved as an editable draft. ${out.note}`);
      }
      default:
        return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
