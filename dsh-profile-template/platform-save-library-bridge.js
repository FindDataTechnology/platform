// platform-save-library-bridge.js — the dsh plugin behind `save_to_library`.
//
// Registers ONE tool that ingests workspace files into the resource library
// (the 成果 page), so a file the model just produced reaches the library even
// when the automatic capture rule cannot see how it was produced (a script
// writing a csv internally, for example — the produced-file rule's biggest
// blind spot, openspec: add-save-to-library-tool).
//
// The tool is a thin client over the platform's loopback save route
// (POST /api/resources/save-declared, the fourth loopback-only bridge): the
// route is the truth layer — the per-call path cap, the workspace gate, the
// size cap and the content dedupe all live server-side — and this plugin only
// shapes arguments and renders the per-path results the model relays to the
// user.
//
// The tool result says what to tell the user, mirroring the chart_bind
// precedent: per-path saved / already-saved / refused with a reason.

import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "save-library-bridge";
const inject = ["tools"];

// The per-call cap, mirrored from the route (routes/resources.js). The route
// stays the truth layer — this copy only lets the tool refuse early with the
// same reason instead of burning a round-trip.
const MAX_PATHS = 10;

// The platform server's own bind address/port, inherited through the dsh
// child's environment (same derivation as the chart-bind bridge). 0.0.0.0/::
// are bind-any addresses, not connect addresses — map them to loopback.
function bridgeOrigin() {
  if (process.env.SAVE_BRIDGE_URL) return process.env.SAVE_BRIDGE_URL.replace(/\/$/, "");
  const raw = process.env.HOST || "localhost";
  const host = raw === "0.0.0.0" || raw === "::" ? "127.0.0.1" : raw;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `http://${bracketed}:${process.env.PORT || 3000}`;
}

function textBlocks(lines) {
  // Only {type:"text"} blocks reach the model (observed live: a plain string
  // render is dropped, leaving an empty tool result).
  return lines.map((line) => ({ type: "text", text: line }));
}

// The model's `paths` arrives as a parsed array — defineTool validates against
// the declared schema BEFORE execute runs, so anything else (a JSON text
// string, a bare scalar) never reaches this function.
function normalizePaths(value) {
  if (!Array.isArray(value)) return null;
  const paths = value.filter((p) => typeof p === "string" && p.trim());
  if (!paths.length) return null;
  return paths.map((p) => p.trim());
}

function renderResults(results) {
  const saved = results.filter((r) => r.status === "saved");
  const known = results.filter((r) => r.status === "already-saved");
  const refused = results.filter((r) => r.status === "refused");
  const lines = [];
  if (saved.length) {
    lines.push(`Saved to the library: ${saved.map((r) => r.path).join(", ")}.`);
  }
  if (known.length) {
    lines.push(
      `Already in the library (same content, no duplicate created): ${known.map((r) => r.path).join(", ")}.`,
    );
  }
  for (const r of refused) {
    lines.push(`Not saved — ${r.path}: ${r.message || r.reason || "refused"}.`);
  }
  if (saved.length || known.length) {
    lines.push("Tell the user these files are now in the 成果 (resource library), downloadable from there.");
  }
  if (!results.length) {
    lines.push("Nothing was saved.");
  }
  return textBlocks(lines);
}

function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "save_to_library",
      description:
        "Save workspace files you produced into the user's resource library (the 成果 page), where they are kept " +
        "as durable copies and can be downloaded later. Call it in the same turn for every file you deliver by " +
        "markdown link — the platform's automatic capture cannot always tell that a script produced a file, so " +
        "an explicit save is the reliable way. Repeated calls are harmless: identical content is deduplicated " +
        "and reported as already in the library. Each call accepts at most 10 paths; directories and files " +
        "outside the workspace are refused with a reason.",
      parameters: {
        paths: {
          type: "array",
          items: { type: "string" },
          required: true,
          description:
            "The workspace-relative (or workspace-absolute) paths of the files to save, e.g. " +
            '["reports/周报.pdf", "data.csv"]. At most 10 per call; save more in a second call.',
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
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
        render: (_args, value) => renderResults(value.results || []),
      },
      async execute(args) {
        const paths = normalizePaths(args?.paths);
        if (!paths) {
          return {
            ok: false,
            results: [],
            _render: textBlocks([
              "`paths` must be a non-empty list of workspace file paths, e.g. [\"reports/周报.pdf\"].",
            ]),
          };
        }
        const early = [];
        if (paths.length > MAX_PATHS) {
          for (const p of paths.slice(MAX_PATHS)) {
            early.push({ path: p, status: "refused", reason: "too_many_paths", message: `每次调用最多 ${MAX_PATHS} 个路径` });
          }
        }
        const usable = paths.slice(0, MAX_PATHS);
        let posted = { ok: false, results: [] };
        try {
          const res = await fetch(`${bridgeOrigin()}/api/resources/save-declared`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paths: usable }),
            signal: AbortSignal.timeout(30_000),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            posted = {
              ok: false,
              results: usable.map((p) => ({
                path: p,
                status: "refused",
                reason: data?.error ? "route_error" : "route_error",
                message: data?.error || `save failed (${res.status})`,
              })),
            };
          } else {
            posted = data;
          }
        } catch (err) {
          posted = {
            ok: false,
            results: usable.map((p) => ({
              path: p,
              status: "refused",
              reason: "route_unreachable",
              message: `保存通道不可达：${err.message}`,
            })),
          };
        }
        return { ok: posted.ok, results: [...posted.results, ...early] };
      },
    }),
  );
}

export { apply, inject, name };
