// Fleet architect MCP child (agent-fleet-architect) — a thin stdio client
// over the loopback bridge (/api/fleet-architect, server/fleet-architect.js).
// Same credential model as the delegation child: loopback is its credential,
// the bridge resolves the acting OWNER server-side, so a caller cannot name
// one. Business lives in the bridge; this file only declares the five tools
// and relays. The tool descriptions carry the discipline themselves — draft
// first, show the diff + estimate, apply only after the user approves.
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
import { shapeTurnsPage, shapeFleetRoster, TURNS_PAGE_MAX } from "./fleet-turns-view.js";

function bridgeOrigin() {
  if (process.env.FLEET_ARCHITECT_MCP_URL) return process.env.FLEET_ARCHITECT_MCP_URL.replace(/\/$/, "");
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
  "Fleet organization tools. ALWAYS fleet_draft first and show the user the full diff (+ cost estimate when present); call fleet_apply ONLY after the user explicitly approves. For unfamiliar org paradigms, approximate with org-tree + cadence + passive posts and draw the structure — never refuse, never improvise writes.";

const TOOLS = [
  {
    name: "fleet_list",
    description: `${DISCIPLINE} List the owner's fleets: id, name, state, member count, open decisions, failing posts (last turn not ok).`,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fleet_spec_read",
    description: `${DISCIPLINE} Read one fleet's full structural spec: org tree (parentId), post targets, cadences, model declarations.`,
    inputSchema: {
      type: "object",
      properties: { fleetId: { type: "string", description: "Fleet id from fleet_list" } },
      required: ["fleetId"],
    },
  },
  {
    name: "fleet_draft",
    description: `${DISCIPLINE} Dry-run a spec change: server-side validation, a normalized per-post diff, and (for large adds or any new cron rhythm) a token-cost estimate. Nothing is persisted. mode=create (new fleet, members all op:add) or mode=edit (fleetId + member ops add/update/pause/resume/remove by ref).`,
    inputSchema: {
      type: "object",
      properties: {
        draft: {
          type: "object",
          description: "{ mode: 'create'|'edit', fleetId?, fleet: { name?, defaultModel? }, members: [{ op, ref?, title?, parentId?, targetKind?, targetId?, cadence?: { cron, tz, promptTemplate, enabled } | null, model?, fallbackModel? }] }",
        },
      },
      required: ["draft"],
    },
  },
  {
    name: "fleet_apply",
    description: `${DISCIPLINE} Apply a draft the user has approved. Revalidates first — if the fleet drifted since the draft, it fails honestly and nothing partial is hidden. A created fleet is born all-paused; the owner confirms start in the cockpit.`,
    inputSchema: {
      type: "object",
      properties: { draft: { type: "object", description: "The exact draft object the user approved." } },
      required: ["draft"],
    },
  },
  {
    name: "fleet_turns_read",
    description: `${DISCIPLINE} Read turn outcome events for one fleet (same store as the cockpit): filter by status ok|failed|interrupted and source cron|manual|delegation. The 'who is failing and why' view.`,
    inputSchema: {
      type: "object",
      properties: {
        fleetId: { type: "string" },
        status: { type: "string", enum: ["ok", "failed", "interrupted"] },
        source: { type: "string", enum: ["cron", "manual", "delegation", "event"] },
        limit: { type: "number", description: "Max events, default 20 (cap 100); the reply says whether it was truncated" },
      },
      required: ["fleetId"],
    },
  },
];

function textOut(text) {
  return { content: [{ type: "text", text }] };
}
function errOut(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function renderDraft(out) {
  const lines = [];
  lines.push(out.ok ? "Draft validated." : "Draft has blocking errors:");
  for (const e of out.errors ?? []) lines.push(`- ✗ ${e.error}`);
  for (const w of out.warnings ?? []) lines.push(`- ⚠ ${w}`);
  for (const d of out.diff ?? []) {
    const changes = Object.entries(d.changes ?? {})
      .map(([k, v]) => (typeof v === "object" ? `${k}=${JSON.stringify(v)}` : `${k}=${v}`))
      .join(", ");
    lines.push(`- [${d.op}]${d.ref ? ` ${d.ref}` : ""} ${d.title ?? ""}${changes ? `: ${changes}` : ""}${(d.warnings ?? []).length ? ` ⚠ ${d.warnings.join("; ")}` : ""}`);
  }
  if (out.orchestration) {
    const o = out.orchestration;
    lines.push(`- [orchestration] mode: ${o.mode ?? "(none)"}`);
    if (o.implicitDispatch) lines.push(`  · ${o.implicitDispatch}`);
    if (o.constraints) lines.push(`  · constraints: ${JSON.stringify(o.constraints)}`);
    for (const e of o.edges ?? []) {
      const args = e.args !== undefined ? ` args=${JSON.stringify(e.args).slice(0, 60)}` : "";
      lines.push(`  · [${e.kind}] ${e.from ?? "(cron)"} → ${e.to}${args}`);
    }
  }
  if (out.estimate) {
    const est = out.estimate;
    lines.push(
      `Cost estimate (${est.trigger}): ${est.turnsPerDayTotal} turns/day total; ~${est.tokensPerMonth[0].toLocaleString()}–${est.tokensPerMonth[1].toLocaleString()} tokens/month (assumes ${est.assumptions.tokenRange[0]}–${est.assumptions.tokenRange[1]} tokens/turn).`,
    );
    for (const p of est.posts) lines.push(`- ${p.title ?? p.ref ?? "post"}: ${p.cron} → ${p.turnsPerDay} turns/day`);
  }
  lines.push(out.ok ? "Nothing persisted. Show this diff to the user; apply only on their explicit approval." : "Fix the errors and re-draft.");
  return textOut(lines.join("\n"));
}

const server = new Server({ name: "fleet-architect", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params ?? {};
  try {
    switch (name) {
      case "fleet_list":
        // Compact + projected (fix-tool-result-cost): the roster ships whole —
        // a missing fleet reads as "it does not exist" — the bytes came from
        // pretty-printing, not from the content.
        return textOut(JSON.stringify(shapeFleetRoster((await call("GET", "/api/fleet-architect/fleets")).fleets)));
      case "fleet_spec_read":
        return textOut(JSON.stringify(await call("GET", `/api/fleet-architect/fleets/${encodeURIComponent(args.fleetId)}`), null, 2));
      case "fleet_draft":
        return renderDraft(await call("POST", "/api/fleet-architect/draft", args.draft));
      case "fleet_apply": {
        const out = await call("POST", "/api/fleet-architect/apply", args.draft);
        return textOut(
          `Applied (${out.mode}).${out.started === false ? " The new fleet is born all-paused — the owner confirms start in the cockpit." : ""} Members: ${out.members.length}. Reconcile: ${JSON.stringify(out.reconcile ?? {})}`,
        );
      }
      case "fleet_turns_read": {
        const q = new URLSearchParams();
        if (args.status) q.set("status", args.status);
        if (args.source) q.set("source", args.source);
        // Read the full cap from the bridge, then page locally — the view owns
        // the page size so the tool cannot drift from its description.
        q.set("limit", String(TURNS_PAGE_MAX));
        // Page + projection (fix-tool-result-cost): same view, a fraction of
        // the bytes — see server/fleet-turns-view.js for why.
        const body = await call("GET", `/api/fleet-architect/fleets/${encodeURIComponent(args.fleetId)}/turns?${q}`);
        return textOut(JSON.stringify(shapeTurnsPage(body.turns, args.limit)));
      }
      default:
        return errOut(`unknown tool: ${name}`);
    }
  } catch (err) {
    return errOut(err.message || "tool failed");
  }
});

await server.connect(new StdioServerTransport());
