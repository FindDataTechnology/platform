// Persona evolution MCP child (add-persona-self-evolution) — a thin stdio
// client over the loopback bridge (/api/persona-evolution). ONE tool,
// deliberately: persona_amend lands a CANDIDATE. Evaluation, promotion and
// rejection are the OWNER's gestures (REST face, human-gated) and have no
// tool here — the double key (AI evidence, human signature) is structural,
// not prompted.
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
  if (process.env.PERSONA_EVOLUTION_MCP_URL) return process.env.PERSONA_EVOLUTION_MCP_URL.replace(/\/$/, "");
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
  "Persona self-evolution. Propose a role-definition amendment ONLY after a turn genuinely showed the current persona mishandling a repeatable situation — the candidate must carry evidence (which turn/task exposed the gap, what the amendment fixes, its applicability boundary). The amendment is PERSONA TEXT ONLY: never propose model changes, skill/tool references, runtime, permissions, or anything addressing another owner's assets. Proposing does NOT take effect: the owner evaluates (A/B gate) and accepts manually — a custom preset is rewritten; a pack persona becomes a fork draft.";

const TOOLS = [
  {
    name: "persona_amend",
    description: `${DISCIPLINE} Land a persona amendment candidate: targetKind ("preset" with targetRef = preset id, or "pack" with targetRef = packId + agentId), amendedPersona (the FULL amended role text, ≤8000 chars), evidence { source: "turn/task reference", fixed: "what the amendment fixes", boundary: "when it applies" }.`,
    inputSchema: {
      type: "object",
      properties: {
        targetKind: { type: "string", enum: ["preset", "pack"] },
        targetRef: { type: "string" },
        agentId: { type: "string" },
        amendedPersona: { type: "string" },
        evidence: {
          type: "object",
          properties: {
            source: { type: "string" },
            fixed: { type: "string" },
            boundary: { type: "string" },
          },
          required: ["source", "fixed"],
        },
      },
      required: ["targetKind", "targetRef", "amendedPersona", "evidence"],
    },
  },
];

function textOut(text) {
  return { content: [{ type: "text", text }] };
}
function errOut(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const server = new Server({ name: "persona-evolution", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  try {
    switch (name) {
      case "persona_amend": {
        const out = await call("POST", "/api/persona-evolution/propose", args);
        return textOut(`Amendment candidate landed: ${out.candidate.id} (target ${out.candidate.target_kind}:${out.candidate.target_ref}). It is a CANDIDATE — the owner reviews, evaluates (A/B gate) and accepts manually. No live or parked session persona changes.`);
      }
      default:
        return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
