// platform-tool-description.js — model-facing tool description enrichment
// (add-tool-description-enrichment, design D1/D2).
//
// Config arrives as tool-description.json beside this file, materialized by
// the host (dsh-profile.js writeToolDescriptionOverlay) from the annotation
// layer's canonical briefs (add-mcp-annotation-overlay):
//   { "descriptions": { "<server>": { "<leaf>": { "brief", "source",
//       "updatedAt" } } }, "meta": { "enriched", "source", "generatedAt" } }
// An absent file, unparsable content, or an empty map means NO enrichment —
// every pre-change composition registers byte-identical descriptions.
//
// The seam mirrors the register-shadow (add-tool-scope-register-shadow): an
// instance-level wrapper on the shared ToolRuntime's `register` rewrites the
// DESCRIPTION of MCP tools carrying an overlay entry, at registration time —
// so the model face AND every downstream consumer of the registered schema
// (the platform's discovery index included, via the same schema events) read
// the same enriched text. Names are NEVER touched: the callable name, server
// attribution, and parameter schema pass through untouched (只增强不改名 —
// the closure gate and tool discovery key on names, which is why this stays
// description-only).
//
// Policy (design D2): upstream description non-empty → APPEND (upstream
// first, the curated brief after, separated by a blank line so the two are
// machine-distinguishable); upstream empty/missing → REPLACE with the brief.
// Re-registering an already-enriched description is a no-op (idempotent under
// resync). Any seam surprise degrades to the original registration exactly.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// tool-description.json lives beside this module by default (the profile dir
// once copied). TOOL_DESCRIPTION_PATH re-anchors it — the same seam
// platform-tool-scope's TOOL_FILTER_PATH provides, for tests.
const DESCRIPTION_FILE = process.env.TOOL_DESCRIPTION_PATH
  || join(dirname(fileURLToPath(import.meta.url)), "tool-description.json");

// mcp__<serverName>__<rawName> — the dsh-mcp-client public naming convention.
const MCP_NAME_PREFIX = "mcp__";

function mcpNameParts(name) {
  if (typeof name !== "string" || !name.startsWith(MCP_NAME_PREFIX)) return null;
  const rest = name.slice(MCP_NAME_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const leaf = rest.slice(sep + 2);
  if (!server || !leaf) return null;
  return { server, leaf };
}

// Read the materialized overlay (per invocation — a registration is
// LLM-paced, and per-read keeps an HMR'd composition from serving a stale
// brief). Shape-tolerant: anything unexpected reads as "no overlay".
export function readToolDescriptionOverlay() {
  try {
    const doc = JSON.parse(readFileSync(DESCRIPTION_FILE, "utf8"));
    if (!doc || typeof doc !== "object") return null;
    const descriptions = doc.descriptions;
    if (!descriptions || typeof descriptions !== "object" || Array.isArray(descriptions)) return null;
    return doc;
  } catch {
    return null;
  }
}

// The curated brief for one server/leaf, with its provenance suffix. Null
// when no overlay entry or a blank brief (nothing to add).
export function overlayBriefFor(server, leaf) {
  const doc = readToolDescriptionOverlay();
  const entry = doc?.descriptions?.[server]?.[leaf];
  if (!entry || typeof entry.brief !== "string" || !entry.brief.trim()) return null;
  const provenance = typeof entry.source === "string" && entry.source ? ` [${entry.source}]` : "";
  return `${entry.brief.trim()}${provenance}`;
}

// The append/replace policy (design D2), pure for the tests: non-empty
// upstream appends (upstream first), empty upstream replaces. Idempotent —
// a description already carrying the brief returns unchanged.
export function enrichDescription(upstream, brief) {
  const base = typeof upstream === "string" ? upstream : "";
  if (!base.trim()) return brief;
  if (base.includes(brief)) return upstream;
  return `${base}\n\n${brief}`;
}

// Install the registration-time rewriter. Chains AFTER the scope shadow
// (installed later = outermost): the wrapped call flows description-rewrite →
// scope allowlist drop → original register, so an enriched schema is what a
// passing registration actually registers. Unlike the scope shadow (which
// bails on an existing own `register` to avoid double-wrapping itself), this
// installer CHAINS: it wraps whatever register currently is (the prototype
// method or the scope's own shadow) and restores exactly that on dispose.
export function installMcpToolDescriptionOverlay(ctx) {
  let inst;
  try {
    inst = Reflect.get(ctx.get("tools"), Symbol.for("cordis.original"));
  } catch {
    return;
  }
  if (!inst || typeof inst.register !== "function") return;
  const previous = inst.register;
  const previousWasOwn = Object.hasOwn(inst, "register");
  const shadow = function register(definition, ...rest) {
    try {
      const parts = mcpNameParts(definition?.name);
      if (parts) {
        const brief = overlayBriefFor(parts.server, parts.leaf);
        if (brief) {
          const enriched = enrichDescription(definition?.description, brief);
          if (enriched !== definition.description) {
            definition = { ...definition, description: enriched };
          }
        }
      }
    } catch {
      // the wrapper must never cost a healthy registration
    }
    return previous.call(this, definition, ...rest);
  };
  ctx.effect(() => {
    inst.register = shadow;
    return () => {
      if (inst.register !== shadow) return; // someone else chained on top
      if (previousWasOwn) inst.register = previous;
      else delete inst.register;
    };
  }, "platform.tool-description.overlay");
}
