// platform-chart-bind-bridge.js — the dsh plugin behind `chart_bind`.
//
// Registers ONE read-only model-facing tool that DECLARES which MCP call
// produced the chart the agent just drew, so the platform can keep that chart
// fed from its data source from then on. It is the strongest of the three
// binding sources (declared > confirmed > inferred): the agent knows the call
// it made, while inference can only witness it.
//
// Read-only by construction, and deliberately so: declaring a binding never
// executes the declared tool, never installs anything, and never mutates an
// extension, credential or session. It records intent over the cell's loopback
// bridge (the cron-mcp pattern) and the platform does the rest on its own
// schedule.
//
// Validation happens where the truth is:
//   * the roster check reads `ctx.tools.schemas(exec.agent)` — the SAME
//     per-agent projection `tool_search` uses, so a name the model can see is
//     exactly a name this accepts, and nothing unmounted can be declared;
//   * the allowlist check reads the deployment's replay allowlist file, copied
//     next to this plugin by dsh-profile.js — a tool that may never be
//     replayed must not become a binding in the first place.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolSchemas, searchToolRecords } from "./tool-discovery.js";

const name = "chart-bind-bridge";
const inject = ["tools"];

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = process.env.CHART_REPLAY_ALLOWLIST_PATH || join(HERE, "chart-replay-allowlist.json");

// The platform server's own bind address/port, inherited through the dsh
// child's environment (same derivation as the cron bridge). 0.0.0.0/:: are
// bind-any addresses, not connect addresses — map them to loopback.
function bridgeOrigin() {
  if (process.env.CHART_BRIDGE_URL) return process.env.CHART_BRIDGE_URL.replace(/\/$/, "");
  const raw = process.env.HOST || "localhost";
  const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${process.env.PORT || 3000}`;
}

// A missing or unreadable allowlist file is NOT "allow everything": it is the
// same documented default the server's own replay gate falls back to
// (`ALLOWLIST_FALLBACK` in chart-bindings.js), so a deployment that somehow
// lost the file refuses every other server and tool instead of accepting any
// declaration. Default-deny is the contract (task 1.5).
const ALLOWLIST_FALLBACK = { "fd-open-data-mcp": ["read_series"] };

function allowlist() {
  try {
    return JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"))?.servers ?? {};
  } catch {
    return ALLOWLIST_FALLBACK;
  }
}

function textBlocks(lines) {
  // Only {type:"text"} blocks reach the model (observed live: a plain string
  // render is dropped, leaving an empty tool result).
  return lines.map((line) => ({ type: "text", text: line }));
}

// The tool arguments the model wrote, as an object. dsh delivers them parsed,
// but JSON text is accepted too. Anything that is not a JSON OBJECT (an array,
// a scalar) is refused rather than coerced: a binding whose arguments are not
// the call's arguments would replay the wrong data forever.
function normalizeArgs(value) {
  if (value == null) return {};
  let parsed = value;
  if (typeof value !== "object") {
    try {
      parsed = JSON.parse(String(value));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

function parseDeclaration(args) {
  const tool = typeof args?.tool === "string" ? args.tool.trim() : "";
  if (!tool) return { ok: false, reason: "`tool` is required: the exact MCP tool name, e.g. mcp__fd-open-data-mcp__read_series" };
  const parsed = /^mcp__([^_].*?)__(.+)$/.exec(tool);
  if (!parsed) {
    return { ok: false, reason: `"${tool}" is not an MCP tool name — the form is mcp__<server>__<tool>` };
  }
  const callArgs = normalizeArgs(args.args ?? {});
  if (callArgs === null) return { ok: false, reason: "`args` must be a JSON object of the call's arguments" };
  const map = args.map === undefined || args.map === null ? null : normalizeArgs(args.map);
  if (map === null && args.map != null) return { ok: false, reason: "`map` must be a JSON object when provided" };
  return { ok: true, tool, server: parsed[1], leaf: parsed[2], callArgs, map };
}

function declare(args, exec, ctx) {
  const parsed = parseDeclaration(args);
  if (!parsed.ok) return { ok: false, message: parsed.reason };

  // 1. The roster: the exact name must be callable by THIS agent right now.
  const schemas = ctx.tools.schemas(exec.agent);
  const records = parseToolSchemas(schemas);
  if (!records.some((r) => r.name === parsed.tool)) {
    const near = searchToolRecords(records, { query: parsed.leaf, limit: 3 }).map((e) => e.record.name);
    return {
      ok: false,
      message:
        `"${parsed.tool}" is not in this session's tool roster, so nothing was bound. ` +
        (near.length
          ? `Closest callable names: ${near.join(", ")}. Retry with the exact name, or use tool_search to inspect the roster.`
          : "No similar tool is available in this session. Do not guess another name."),
    };
  }

  // 2. The replay allowlist: only a tool that may be replayed can be bound.
  const servers = allowlist();
  if (servers && !Array.isArray(servers[parsed.server])) {
    return { ok: false, message: `${parsed.server} is not a supported data source on this deployment, so nothing was bound.` };
  }
  if (servers && Array.isArray(servers[parsed.server]) && !servers[parsed.server].includes(parsed.leaf)) {
    return {
      ok: false,
      message:
        `${parsed.tool} is not on this deployment's read-only replay allowlist ` +
        `(${parsed.server} allows: ${servers[parsed.server].join(", ") || "nothing"}), so nothing was bound. ` +
        "Tell the user the data source is not enabled for automatic refresh.",
    };
  }

  return parsed;
}

async function post(body) {
  const res = await fetch(`${bridgeOrigin()}/api/resources/bind-declared`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, reason: data?.error || `binding failed (${res.status})` };
  }
  return { ok: true, ...data };
}

function renderResult(value) {
  if (value?.ok && value.binding) {
    const binding = value.binding;
    const scope = value.note ? ` Note recorded: ${value.note}` : "";
    return textBlocks([
      `Data source bound to the chart.`,
      `- source: ${binding.server} · ${binding.tool}`,
      `- arguments: ${JSON.stringify(binding.args)}`,
      `- cadence: ${binding.frequency} (periods normalize to ${binding.frequency === "yearly" ? "YYYY" : "YYYY-MM"})`,
      `- unit: ${binding.unit ?? "recorded on the first read"}`,
      `- the call was NOT executed here; the platform refreshes it on its own schedule.${scope}`,
      `Tell the user the chart is now tied to this data source and will update from it.`,
    ]);
  }
  return textBlocks([`The binding was not recorded: ${value?.message || value?.reason || "unknown reason"}`]);
}

function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "chart_bind",
      description:
        "Declare the MCP data call that produced the time-series chart you just drew, so the chart keeps updating from " +
        "that source without another model turn. Call it in the same turn, right after writing the ```echarts block, " +
        "naming the EXACT tool you called (mcp__<server>__<tool>) and the exact arguments you passed. " +
        "Read-only: it never executes the call, installs nothing, and changes no session. " +
        "Only time-series read tools of supported data sources can be bound; the platform refuses anything else with a reason.",
      parameters: {
        tool: {
          type: "string",
          required: true,
          description: "The exact MCP tool name that produced the chart's data, e.g. mcp__fd-open-data-mcp__read_series.",
        },
        args: {
          type: "string",
          required: true,
          description:
            'JSON text of the arguments you passed to it, e.g. {"concept_id":"M0_YOY","entity_type":"country","entity_id":"CN"}.',
        },
        map: {
          type: "string",
          description:
            'Optional JSON mapping from the response to the chart\'s points: {"rows","period","value","source","series"}. ' +
            "Omit it for the standard read_series/read shapes — the platform already knows them.",
        },
        note: {
          type: "string",
          description: "Optional short note to keep with the binding (e.g. what the chart shows).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            message: { type: "string" },
            binding: { type: "object", additionalProperties: true, properties: {} },
            note: { type: "string" },
          },
        },
        render: (_args, value) => renderResult(value),
      },
      async execute(args, exec) {
        const checked = declare(args, exec, ctx);
        if (!checked.ok) return { ok: false, message: checked.message };
        const note = typeof args?.note === "string" && args.note.trim() ? args.note.trim().slice(0, 300) : null;
        const result = await post({
          tool: checked.tool,
          args: checked.callArgs,
          map: checked.map,
          note,
        });
        if (!result.ok) return { ok: false, message: result.reason };
        return { ok: true, binding: result.binding, note, message: "bound" };
      },
    }),
  );
}

export { apply, inject, name };