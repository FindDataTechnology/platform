// ── Delegation MCP server (stdio) ────────────────────────────────────────────
//
// Exposes task delegation to the dsh agent as three MCP tools — delegate_task,
// task_progress, task_result — declared in mcp.json and mounted through
// dsh-mcp-client as mcp__delegation__<tool>, available to every persona preset
// (spec: agent-delegation-tools).
//
// Thin client over the /api/delegation loopback REST bridge (the cron-mcp.js
// pattern): task records, the serialized queue, and the aggregation bookkeeping
// live in the platform server process; writing them from here would race the
// engine's write chain.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// The stdio channel IS the protocol: stdout must carry JSON-RPC and nothing
// else.
console.log = (...args) => console.error(...args);

function bridgeOrigin() {
  if (process.env.DELEGATION_MCP_URL) return process.env.DELEGATION_MCP_URL.replace(/\/$/, "");
  const raw = process.env.HOST || "localhost";
  const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${process.env.PORT || 3000}`;
}

async function call(method, path, body) {
  const res = await fetch(`${bridgeOrigin()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

const TOOLS = [
  {
    name: "delegate_task",
    description:
      "Delegate a self-contained task to ANOTHER agent persona in this cell — it runs in its own dedicated session, " +
      "executed immediately (serially with other work). Use for fan-out: call once per persona per subtask, e.g. one to the " +
      "stock analyst and one to the legal reviewer. Returns the task id right away (it does NOT wait for the result); when " +
      "every delegated task has finished, a summary turn with all outcomes is delivered back into THIS conversation " +
      "automatically — do not promise the results inline. The prompt must be self-contained: no conversation context carries over.",
    inputSchema: {
      type: "object",
      properties: {
        persona: { type: "string", description: "Target persona preset id (NOT the current persona). Pick from the known persona roster." },
        prompt: { type: "string", description: "The self-contained prompt the target persona will run." },
        name: { type: "string", description: "Short human label; becomes the task session's title." },
      },
      required: ["persona", "prompt"],
    },
  },
  {
    name: "task_progress",
    description:
      "Report the live status of the tasks delegated in this conversation: persona, state (queued/running/done/failed/interrupted), elapsed time, and token spend when available.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "task_result",
    description:
      "Fetch the recorded output of a FINISHED delegated task (or its error gist on failure). Use after task_progress shows a terminal state.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task id from delegate_task or task_progress." } },
      required: ["id"],
    },
  },
];

function textOut(text) {
  return { content: [{ type: "text", text }] };
}
function errOut(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function toolDelegate({ persona, prompt, name }) {
  const { task } = await call("POST", "/api/delegation/tasks", { persona, prompt, name });
  // Stable format — the chat TaskCard parses the "- id:" line (CronToolCard
  // pattern) to bind the live record.
  return textOut(
    `Task delegated.\n` +
      `- id: ${task.id}\n` +
      `- persona: ${task.target.ref}\n` +
      `- state: ${task.state}\n` +
      `- output session: ${task.sessionTitle || task.sessionId}\n` +
      `Tell the user it is queued; the summary arrives in this conversation when all delegated tasks finish.`,
  );
}

function describeTask(t) {
  const last = t.history?.length ? t.history.at(-1) : null;
  const bits = [`- ${t.id} [${t.state ?? "idle"}]: ${t.target?.ref ?? "?"} — "${(t.prompt || "").slice(0, 80)}"`];
  if (t.lastRun) bits.push(`  started ${t.lastRun}`);
  if (last?.tokens) bits.push(`  tokens: ${JSON.stringify(last.tokens)}`);
  if (t.error) bits.push(`  error: ${t.error}`);
  return bits.join("\n");
}

async function toolProgress() {
  const { tasks } = await call("GET", "/api/delegation/tasks");
  if (!tasks.length) return textOut("No delegated tasks pending in this conversation.");
  return textOut(`Delegated tasks (${tasks.length}):\n${tasks.map(describeTask).join("\n")}`);
}

async function toolResult({ id }) {
  const r = await call("GET", `/api/delegation/tasks/${encodeURIComponent(id)}/result`);
  if (r.state && !["done", "failed", "interrupted"].includes(r.state)) {
    return errOut(`task ${id} is still ${r.state}; check task_progress`);
  }
  const head = `Task ${id} — ${r.state}${r.persona ? ` (${r.persona})` : ""}${r.tokens ? ` tokens=${JSON.stringify(r.tokens)}` : ""}`;
  if (r.output) return textOut(`${head}\n\n${r.output}`);
  return textOut(`${head}\n\n${r.error ? `Error: ${r.error}` : "(no output recorded)"}`);
}

const server = new Server({ name: "delegation", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  try {
    switch (name) {
      case "delegate_task": return await toolDelegate(args);
      case "task_progress": return await toolProgress(args);
      case "task_result": return await toolResult(args);
      default: return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
