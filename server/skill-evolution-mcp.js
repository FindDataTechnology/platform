// Skill evolution MCP child (add-skill-self-evolution) — a thin stdio client
// over the loopback bridge (/api/skill-evolution). ONE tool, deliberately:
// skill_propose lands a CANDIDATE. Evaluation, promotion and rejection are
// the OWNER's gestures (REST face, human-gated) and have no tool here — the
// double key (AI evidence, human signature) is structural, not prompted.
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
  if (process.env.SKILL_EVOLUTION_MCP_URL) return process.env.SKILL_EVOLUTION_MCP_URL.replace(/\/$/, "");
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
  "Skill self-evolution. Propose a skill candidate ONLY after a turn genuinely succeeded via a repeatable path — the candidate must carry evidence (which turn/task it helped, what it solves, its applicability boundary). Name matches [A-Za-z0-9._-]. Do NOT propose against pack-installed skills (they are not evolvable) or anything resembling runtime/permission changes. Proposing does NOT take effect: the owner evaluates (A/B gate) and promotes manually.";

const TOOLS = [
  {
    name: "skill_propose",
    description: `${DISCIPLINE} Land a skill candidate: name, description (≤2000 chars), body (SKILL.md-shaped guidance, ≥30 chars), evidence { source: "turn/task reference", solved: "what it solved", boundary: "when it applies" }, optional supersedes (an existing USER skill name this improves on — never a pack skill).`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        body: { type: "string" },
        evidence: {
          type: "object",
          properties: {
            source: { type: "string" },
            solved: { type: "string" },
            boundary: { type: "string" },
          },
          required: ["source", "solved"],
        },
        supersedes: { type: "string" },
      },
      required: ["name", "description", "body", "evidence"],
    },
  },
];

function textOut(text) {
  return { content: [{ type: "text", text }] };
}
function errOut(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const server = new Server({ name: "skill-evolution", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  try {
    switch (name) {
      case "skill_propose": {
        const out = await call("POST", "/api/skill-evolution/propose", args);
        return textOut(`Candidate landed: ${out.candidate.name} (${out.candidate.id}). It is a CANDIDATE — the owner reviews, evaluates (A/B gate) and promotes it manually. It does not affect any running turn.`);
      }
      default:
        return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
