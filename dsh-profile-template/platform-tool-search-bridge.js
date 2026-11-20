// platform-tool-search-bridge.js — the dsh plugin behind `tool_search`.
//
// Registers ONE read-only model-facing tool that resolves an intent or a
// (possibly malformed) tool-name fragment to the EXACT callable names in the
// calling agent's visible roster. This is the recovery path for the live
// failure mode where a weak model invents `mcp__list_concepts` while the
// effective name is `mcp__fd-open-data-mcp__list_concepts`.
//
// Source of truth is the dsh tool registry ITSELF, projected at call time
// (`ctx.tools.schemas(exec.agent)`): global tools, scoped tools, MCP tools,
// restrictions, and hot-swaps are already resolved by the registry for that
// exact agent, so the search cannot drift from what the model can actually
// call and cannot see unmounted registry entries. The matcher lives in the
// HOST tree (server/tool-discovery.js is plain JS with no dsh imports), so
// this plugin imports it by relative path — the patch generator copies the
// file next to this one (see dsh-profile.js writeToolSearchPatch).
//
// Read-only by construction: the tool executes no discovered tool, mutates no
// extension/credential state, and projects only name/description/parameters —
// never URLs, headers, credentials, or execute callbacks.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { parseToolSchemas, searchToolRecords } from "./tool-discovery.js";

const name = "tool-search-bridge";
const inject = ["tools"];

const MAX_LIMIT = 20;

function compactParams(rec) {
  const props = Object.entries(rec.properties || {});
  if (!props.length) return "(no parameters)";
  const requiredList = Array.isArray(rec.required) ? rec.required : [];
  const rows = props.map(([prop, schema]) => {
    const type = schema && typeof schema === "object" && schema.type ? schema.type : "any";
    const req = requiredList.includes(prop) ? " required" : "";
    return `  - ${prop}: ${type}${req}`;
  });
  return rows.join("\n");
}

function textBlocks(lines) {
  // The harness translates render output into tool-result content BLOCKS:
  // plain strings are dropped (observed live: an empty tool result), only
  // {type:"text",text} blocks reach the model.
  return lines.map((line) => ({ type: "text", text: line }));
}

function renderResults(entries, { query, server }) {
  if (!entries.length) {
    return textBlocks([
      `No effective tool matches ${JSON.stringify(query || "")}` +
        (server ? ` (server: ${JSON.stringify(server)})` : "") +
        `. Search covered only the tools currently available in this session — ` +
        `nothing was called or installed. Name the exact tool you were given by the user, ` +
        `or tell the user the tool appears unavailable.`,
    ]);
  }
  const blocks = entries.map((entry, index) => {
    // The execute() return is already the projected entry list — `entry` IS
    // the record-shaped object (name/server/leaf/origin/description/…).
    const rec = entry;
    const head = `${index + 1}. EXACT NAME: ${rec.name}`;
    const origin = rec.origin === "mcp" ? ` (MCP server: ${rec.server}, leaf: ${rec.leaf})` : " (built-in)";
    return `${head}${origin}\n   ${rec.description || "(no description)"}\n   Parameters:\n${compactParams(rec)}`;
  });
  return textBlocks([
    `Found ${entries.length} callable tool(s)` +
      (entries.length >= MAX_LIMIT ? " (result limit reached — narrow the query)" : "") +
      `. Invoke ONLY with the exact name shown after "EXACT NAME". ` +
      `Nothing was executed by this search.`,
    ...blocks,
  ]);
}

function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "tool_search",
      description:
        "Search the tools available in THIS session (built-ins plus every mounted MCP server's tools) " +
        "and return their EXACT callable names with parameters. Use it before calling any tool whose " +
        "full name you are not certain of — names are exact strings like mcp__<server>__<tool>; " +
        "guessing a name wastes a turn. Read-only: it never executes a found tool.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description:
            "What to look for: an intent ('World Bank GDP indicators'), a leaf name ('list_concepts'), " +
            "or even a malformed fragment ('find_data-business'); separators and wildcards are tolerated.",
        },
        server: {
          type: "string",
          description: "Optional MCP server name to scope the search to (e.g. fd-open-data-mcp).",
        },
        limit: {
          type: "number",
          description: `Maximum results to return (1-${MAX_LIMIT}, default 8).`,
        },
      },
      output: {
        // The value schema is validated and SNAPSHOT-projected before render,
        // so `results` must be declared here or the frozen value arrives
        // stripped to `{ count }` (observed: render then saw undefined
        // entries). Properties of each hit are open-ended JSON.
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            count: { type: "number", required: true },
            results: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: true,
                properties: {},
              },
            },
          },
        },
        render: (args, value) => renderResults(value.results || [], args),
      },
      execute(args, exec) {
        // The live projection for THIS agent scope is the roster the model
        // can actually call — read it per call so hot-swaps are always
        // reflected. schemas() returns deep-cloned model-facing fields only.
        const schemas = ctx.tools.schemas(exec.agent);
        const records = parseToolSchemas(schemas);
        const entries = searchToolRecords(records, {
          query: typeof args?.query === "string" ? args.query : "",
          server: typeof args?.server === "string" ? args.server : undefined,
          limit: Math.max(1, Math.min(Number(args?.limit) || 8, MAX_LIMIT)),
        }).map((entry) => ({
          name: entry.record.name,
          server: entry.record.server,
          leaf: entry.record.leaf,
          origin: entry.record.origin,
          description: entry.record.description,
          required: entry.record.required,
          properties: entry.record.properties,
          score: entry.score,
        }));
        return { count: entries.length, results: entries };
      },
    }),
  );
}

export { apply, inject, name };
