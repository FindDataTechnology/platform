// ── Cron MCP server (stdio) ──────────────────────────────────────────────────
//
// Exposes scheduled-task management to the dsh agent as four MCP tools —
// cron_create, cron_list, cron_pause, cron_delete — declared in mcp.json and
// mounted through dsh-mcp-client as mcp__cron__<tool>, available to every
// persona preset.
//
// It is a thin client, not an engine: the live timers and the in-memory job
// table live in the platform server process, so every tool call goes over the
// /api/cron REST bridge on loopback (exempted from auth for loopback callers
// only — server/auth.js). Mutating jobs.json from here would race the
// platform's serialized write chain, and timers for child-created jobs would
// never fire; the bridge sidesteps both.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// The stdio channel IS the protocol: stdout must carry JSON-RPC and nothing
// else.
console.log = (...args) => console.error(...args);

// The platform server's own bind address/port, inherited through the dsh
// child's environment. 0.0.0.0/:: are bind-any addresses, not connect
// addresses — map them to loopback.
function bridgeOrigin() {
  if (process.env.CRON_MCP_URL) return process.env.CRON_MCP_URL.replace(/\/$/, "");
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

// Human-readable schedule for the common shapes; anything else falls back to
// the raw expression (still shown, never hidden).
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function describeCron(expr) {
  const parts = String(expr).split(/\s+/);
  if (parts.length !== 5) return `cron "${expr}"`;
  const [min, hour, dom, mon, dow] = parts;
  if (dom === "*" && mon === "*") {
    const at = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    if (dow === "*") return `daily at ${at}`;
    if (dow === "1-5") return `weekdays at ${at}`;
    const days = dow.split(",").map((d) => WEEKDAYS[Number(d)] || d).join(", ");
    if (/^\d+(,\d+)*$/.test(dow)) return `weekly on ${days} at ${at}`;
  }
  if (hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    if (min.startsWith("*/")) return `every ${min.slice(2)} minutes`;
    if (min === "*") return "every minute";
  }
  return `cron "${expr}"`;
}

const TOOLS = [
  {
    name: "cron_create",
    description:
      "Schedule a recurring task (cron expression) or a one-shot task (absolute time) that runs the given prompt " +
      "under the CURRENT agent persona, in its own dedicated chat session. The task fires even when the user is " +
      "away; output lands in that session and the user is notified in-app. Prefer cron five-field syntax " +
      "(minute hour day-of-month month day-of-week) in the USER's timezone — pass the user's IANA timezone as `tz` " +
      "whenever they name a local time. Times for one-shots are ISO-8601.",
    inputSchema: {
      type: "object",
      properties: {
        cron: { type: "string", description: "Five-field cron expression (mutually exclusive with `when`)." },
        when: { type: "string", description: "ISO-8601 absolute time for a one-shot task (mutually exclusive with `cron`)." },
        prompt: { type: "string", description: "The prompt to run on the schedule. Self-contained: no conversation context carries over." },
        tz: { type: "string", description: "IANA timezone the cron expression is evaluated in (e.g. Asia/Shanghai). Defaults to the cell's local timezone." },
        name: { type: "string", description: "Short human label; becomes the dedicated session's title." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "cron_list",
    description: "List all scheduled tasks with id, schedule, timezone, status, and last outcome.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cron_pause",
    description: "Pause a scheduled task by id (stops firing until resumed by the user).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Job id from cron_list or a previous cron_create." } },
      required: ["id"],
    },
  },
  {
    name: "cron_delete",
    description: "Permanently remove a scheduled task by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Job id from cron_list or a previous cron_create." } },
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

const cellLocalTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

function tzLabel(tz) {
  return tz || `${cellLocalTz} (cell-local default)`;
}

async function toolCreate({ cron, when, prompt, tz, name }) {
  if (!cron && !when) return errOut("provide either `cron` (recurring) or `when` (one-shot)");
  if (cron && when) return errOut("`cron` and `when` are mutually exclusive");
  const { job } = await call("POST", "/api/cron", {
    cron,
    when,
    prompt,
    tz,
    sessionTitle: name || null,
  });
  const when_ = cron
    ? `${describeCron(cron)} (${tzLabel(job.tz)})`
    : `once at ${new Date(when).toISOString()}`;
  return textOut(
    `Scheduled task created.\n` +
      `- id: ${job.id}\n` +
      `- schedule: ${when_}\n` +
      `- agent: ${job.preset ?? "the cell's current agent"}\n` +
      `- output session: ${job.sessionTitle || "dedicated session"}\n` +
      `Tell the user it is set up; they can manage it on the scheduled-tasks page.`,
  );
}

async function toolList() {
  const { jobs } = await call("GET", "/api/cron");
  if (!jobs.length) return textOut("No scheduled tasks.");
  return textOut(
    jobs
      .map((j) => {
        const schedule = j.type === "recurring" ? `${describeCron(j.cron)} (${tzLabel(j.tz)})` : `once at ${j.when}`;
        const last = j.history?.length ? (j.history.at(-1).success ? "ok" : `failed: ${j.history.at(-1).error || "?"}`) : "never run";
        return `- ${j.id} [${j.status}]${j.paused ? " (paused)" : ""}: ${schedule} — "${j.prompt.slice(0, 80)}" | last: ${last}`;
      })
      .join("\n"),
  );
}

async function toolPause({ id }) {
  const { ok } = await call("POST", `/api/cron/${encodeURIComponent(id)}/pause`);
  return ok ? textOut(`Task ${id} paused.`) : errOut(`task ${id} not found`);
}

async function toolDelete({ id }) {
  const { ok } = await call("DELETE", `/api/cron/${encodeURIComponent(id)}`);
  return ok ? textOut(`Task ${id} deleted.`) : errOut(`task ${id} not found`);
}

const server = new Server({ name: "cron", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  try {
    switch (name) {
      case "cron_create": return await toolCreate(args);
      case "cron_list": return await toolList();
      case "cron_pause": return await toolPause(args);
      case "cron_delete": return await toolDelete(args);
      default: return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
