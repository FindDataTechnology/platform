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
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";
import { shapeCronList, CRON_LIST_LIMIT, CRON_LIST_MAX, CRON_SCOPES } from "./cron-list-view.js";

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
  // Outbound call discipline: shared deadline wrapper — a stalled bridge fails
  // as a structured retryable FetchTimeoutError instead of hanging the tool.
  const res = await fetchWithTimeout(`${bridgeOrigin()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }, { timeoutMs: 10_000 });
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
      "Schedule a task that runs the given prompt. Three schedule forms, mutually exclusive: recurring cron " +
      "(five-field), recurring interval (every N minutes/hours/days/weeks), or one-shot (absolute ISO `when`, OR " +
      "`delayMinutes` relative to now — ALWAYS use delayMinutes for phrases like「20 分钟后」and NEVER compute a wall " +
      "time yourself: the server anchors the relative delay to its own clock, while a client-computed time that has " +
      "already passed can silently roll a year forward). Set `maxRuns` on a recurring form to retire the task after N " +
      "runs. For single-agent tasks it runs under the CURRENT agent persona in its own dedicated session. For cluster " +
      "tasks pass a clusterId. Prefer cron five-field syntax in the USER's timezone — pass their IANA timezone as `tz` " +
      "whenever they name a local time.",
    inputSchema: {
      type: "object",
      properties: {
        cron: { type: "string", description: "Five-field cron expression (mutually exclusive with `when`/`delayMinutes`/`interval`)." },
        when: { type: "string", description: "ISO-8601 absolute time for a one-shot task (mutually exclusive with `cron`/`interval`)." },
        delayMinutes: { type: "integer", description: "One-shot delay in whole minutes from now (1–525600). The SERVER resolves it against its real clock — do not compute a wall time yourself. Mutually exclusive with `cron`/`when`/`interval`." },
        interval: {
          type: "object",
          description: "Every-N recurring rule (mutually exclusive with `cron`/`when`/`delayMinutes`). Use it when a five-field cron cannot express the step (e.g. every 40 days).",
          properties: {
            number: { type: "integer", description: "1–200." },
            unit: { type: "string", enum: ["minute", "hour", "day", "week"], description: "Step unit." },
          },
          required: ["number", "unit"],
        },
        maxRuns: { type: "integer", description: "Retire the task after this many completed runs (recurring forms only)." },
        prompt: { type: "string", description: "The prompt to run on the schedule." },
        tz: { type: "string", description: "IANA timezone the cron expression is evaluated in (e.g. Asia/Shanghai). Defaults to the cell's local timezone." },
        name: { type: "string", description: "Short human label; becomes the dedicated session's title." },
        // Cluster-aware fields (agent-cluster-platform)
        clusterId: { type: "string", description: "Dynamic cluster ID to run across multiple agents (optional)." },
        executionPolicy: {
          type: "object",
          description: "Execution policy for cluster tasks.",
          properties: {
            allowParallel: { type: "boolean", description: "Run agents concurrently (default: false = sequential)." },
            timeoutMinutes: { type: "number", description: "Max duration per agent run." },
            resultAggregation: { type: "string", enum: ["first", "all", "summary"], description: "How to combine results." }
          }
        },
        targetAgents: { 
          type: "array", 
          items: { type: "string" },
          description: "Override which agents in the cluster to run (defaults to all defaultAgents)."
        }
      },
      required: ["prompt"],
    },
  },
  {
    name: "cron_list",
    description:
      "List scheduled tasks (id, schedule, timezone, status, last outcome; cluster tasks also show cluster name and agent count). " +
      "SCOPED by default to the operator's own tasks: a cell's fleet posts each materialize a cadence task, which belong to the fleet " +
      "surface (fleet_list / fleet_spec_read) — pass scope='fleet' to see just those, or 'all' for an audit. Paged (default " +
      `${CRON_LIST_LIMIT}, cap ${CRON_LIST_MAX}); the header always states the totals and what is not shown.`,
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: CRON_SCOPES, description: "user (default) | fleet | all." },
        limit: { type: "number", description: `Tasks per page (default ${CRON_LIST_LIMIT}, cap ${CRON_LIST_MAX}).` },
        offset: { type: "number", description: "Page offset (the header prints the next one)." },
      },
    },
  },
  {
    name: "cron_update",
    description:
      "Edit a scheduled task in place by id — change its prompt, name, timezone, schedule (any of `cron`/`when`/`delayMinutes`/`interval`), or `maxRuns`. " +
      "The task id, its execution history, and its paused state are preserved. Same schedule-form rules as cron_create (mutually exclusive forms; " +
      "`delayMinutes` is resolved by the server, never compute a wall time yourself).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job id from cron_list." },
        cron: { type: "string", description: "New five-field cron expression." },
        when: { type: "string", description: "New ISO-8601 absolute one-shot time." },
        delayMinutes: { type: "integer", description: "New one-shot delay in whole minutes from now (server-anchored)." },
        interval: {
          type: "object",
          properties: {
            number: { type: "integer", description: "1–200." },
            unit: { type: "string", enum: ["minute", "hour", "day", "week"] },
          },
          required: ["number", "unit"],
          description: "New every-N recurring rule.",
        },
        maxRuns: { type: "integer", description: "New run cap (retires the task at it)." },
        prompt: { type: "string", description: "New prompt." },
        name: { type: "string", description: "New label." },
        tz: { type: "string", description: "New IANA timezone." },
      },
      required: ["id"],
    },
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

async function toolCreate({ cron, when, prompt, tz, name, clusterId, executionPolicy, targetAgents, delayMinutes, interval, maxRuns }) {
  // add-cron-automation-parity: three mutually exclusive schedule forms. A
  // relative one-shot is sent as delayMinutes and anchored SERVER-side; the
  // tool never computes a wall time (a past one would silently roll a year out).
  const forms = [cron ? "cron" : null, when ? "when" : null, delayMinutes != null ? "delay" : null, interval ? "interval" : null].filter(Boolean);
  if (forms.length === 0) return errOut("provide one of `cron`, `when`, `delayMinutes`, or `interval`");
  if (forms.length > 1) return errOut(`schedule forms are mutually exclusive: ${forms.join(" + ")}`);

  const body = {
    cron: cron ?? undefined,
    when: when ?? undefined,
    prompt,
    tz,
    sessionTitle: name || null,
  };
  if (delayMinutes != null) body.delayMinutes = delayMinutes;
  if (interval) body.interval = interval;
  if (maxRuns != null) body.maxRuns = maxRuns;
  
  // Add cluster fields if provided (agent-cluster-platform)
  if (clusterId) {
    body.clusterId = clusterId;
    if (executionPolicy) {
      body.executionPolicy = executionPolicy;
    }
    if (targetAgents && Array.isArray(targetAgents)) {
      body.targetAgents = targetAgents;
    }
  }
  
  const { job } = await call("POST", "/api/cron", body);
  const when_ = cron
    ? `${describeCron(cron)} (${tzLabel(job.tz)})`
    : `once at ${new Date(when).toISOString()}`;
  
  let output = `Scheduled task created.\n` +
    `- id: ${job.id}\n` +
    `- schedule: ${when_}\n`;
  
  if (job.clusterId) {
    output += `- cluster: ${job.clusterName || job.clusterId}\n` +
      `- agents: ${job.agentCount || "multiple"}\n` +
      `- execution: ${job.executionPolicy?.allowParallel ? "parallel" : "sequential"}\n`;
  } else {
    output += `- agent: ${job.preset ?? "the cell's current agent"}\n`;
  }
  
  output += `- output session: ${job.sessionTitle || "dedicated session"}\n` +
    `Tell the user it is set up; they can manage it on the scheduled-tasks page.`;
    
  return textOut(output);
}

async function toolList(args = {}) {
  const { jobs } = await call("GET", "/api/cron");
  if (!jobs.length) return textOut("No scheduled tasks.");
  // Scoped + paged (fix-cron-list-scope): one cell held 816 tasks, 658 of them
  // fleet cadences — 112KB per call, and four fifths of it was noise for
  // "what are my scheduled tasks". See server/cron-list-view.js.
  const view = shapeCronList(jobs, { scope: args.scope, limit: args.limit, offset: args.offset });
  if (!view.jobs.length) {
    return textOut(`${view.header}\n(no task in this page — scope=${args.scope ?? "user"}${view.total ? `, ${view.total} exist` : ""})`);
  }
  return textOut(
    `${view.header}\n` +
    view.jobs
      .map((j) => {
        const schedule = j.interval
          ? `every ${j.interval.number} ${j.interval.unit}(s)`
          : j.type === "recurring"
            ? `${describeCron(j.cron)} (${tzLabel(j.tz)})`
            : `once at ${j.when}`;
        const cap = j.maxRuns != null ? ` (${j.runs ?? 0}/${j.maxRuns})` : "";
        const last = j.history?.length ? (j.history.at(-1).success ? "ok" : `failed: ${j.history.at(-1).error || "?"}`) : "never run";

        let line = `- ${j.id} [${j.status}]${j.paused ? " (paused)" : ""}: ${schedule}${cap} — "${j.prompt.slice(0, 80)}" | last: ${last}`;
        
        // Add cluster info if applicable (agent-cluster-platform)
        if (j.clusterId) {
          line += ` [cluster: ${j.clusterName || j.clusterId}, agents: ${j.agentCount || "?"}]`;
        }
        
        return line;
      })
      .join("\n"),
  );
}

async function toolPause({ id }) {
  const { ok } = await call("POST", `/api/cron/${encodeURIComponent(id)}/pause`);
  return ok ? textOut(`Task ${id} paused.`) : errOut(`task ${id} not found`);
}

// In-place edit (add-cron-automation-parity 2.2): only provided fields change;
// id + history + paused state survive.
async function toolUpdate({ id, cron, when, delayMinutes, interval, maxRuns, prompt, name, tz }) {
  if (!id) return errOut("`id` is required");
  const forms = [cron ? "cron" : null, when ? "when" : null, delayMinutes != null ? "delay" : null, interval ? "interval" : null].filter(Boolean);
  if (forms.length > 1) return errOut(`schedule forms are mutually exclusive: ${forms.join(" + ")}`);
  const body = {};
  if (cron !== undefined) body.cron = cron;
  if (when !== undefined) body.when = when;
  if (delayMinutes !== undefined) body.delayMinutes = delayMinutes;
  if (interval !== undefined) body.interval = interval;
  if (maxRuns !== undefined) body.maxRuns = maxRuns;
  if (prompt !== undefined) body.prompt = prompt;
  if (name !== undefined) body.sessionTitle = name;
  if (tz !== undefined) body.tz = tz;
  if (Object.keys(body).length === 0) return errOut("nothing to update");
  const { job } = await call("PATCH", `/api/cron/${encodeURIComponent(id)}`, body);
  return textOut(`Task ${id} updated. New schedule: ${job.interval ? `every ${job.interval.number} ${job.interval.unit}(s)` : job.cron ? describeCron(job.cron) : `once at ${job.when}`}${job.maxRuns ? ` (cap ${job.runs ?? 0}/${job.maxRuns})` : ""}`);
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
      case "cron_list": return await toolList(args);
      case "cron_update": return await toolUpdate(args);
      case "cron_pause": return await toolPause(args);
      case "cron_delete": return await toolDelete(args);
      default: return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
