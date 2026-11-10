// connect-guidance.js — classify credential- and scope-shaped failures into a
// pointer at the card that repairs them (chat-connect-guidance, design D1/D2;
// scope class added by add-connector-bindings 6.3).
//
// Three entry points, all pure classification over text plus the failing
// tool's server config:
//   turnErrorHint(message)            model-lane turn failures → the 词元 card
//   toolFailureHint(tool, resultText) failed MCP tool calls → the failing
//                                     server's credential-ref panel, or the
//                                     bindings panel with a scope pointer when
//                                     the rejection is a scope gap
//
// Classification is ADDITIVE by contract: callers attach the returned pointer
// to the WS event; they never rewrite the model-visible text.

import * as fs from "node:fs";
import * as path from "node:path";
import * as extensionStore from "../extension-store.js";
import * as credentialRefs from "../credential-refs.js";

// Credential-shaped failure text, server-side only (D2). Deliberately wider
// than the stale marker's `\b401\b|unauthoriz` in markCredentialStaleOn401:
// invalid-key failures often arrive as 400/"Incorrect API key" and still have
// the same user-side repair (re-connect). Both consumers keep their own
// breadth — they answer different questions.
const CREDENTIAL_RE =
  /\b40[13]\b|unauthoriz|invalid[ _-]?api[ _-]?key|incorrect api key|api key (?:is )?(?:invalid|missing|required)|missing[ _-]?api[ _-]?key|credential|auth(entication)? (?:failed|error)|认证失败|鉴权失败|密钥(无效|错误|缺失)|凭据(无效|缺失)|令牌(无效|过期)/i;

// Scope-shaped rejections (add-connector-bindings 6.3). The connector answers
// `{ok:false,error:{code:"action_not_allowed",message:"<actionId> is not
// included in the local action allowlist."}}` when the call falls outside the
// token's granted scope — a PERMISSION problem whose repair is granting, never
// re-connecting. Only the `_not_allowed` codes qualify: the `_blocked` codes are
// deployment policy that no user grant can move, so they must not point the
// user at a card where nothing they do helps.
//
// The two classes are mutually exclusive and scope wins, because a scope
// rejection must never surface as "your credential died" (the payload carries
// no 401, but a wrapped transport error could).
const SCOPE_NOT_ALLOWED_RE = /\b(?:action_not_allowed|connection_not_allowed)\b/;
// The failing action's id — the one fact both payload shapes carry. Only
// `scope-explain` may turn it into (provider, operationType); this module never
// guesses either from the id's text (design D2: no fabricated catalog facts).
const SCOPE_ACTION_ID_RES = [
  /"actionId"\s*:\s*"([^"]+)"/,
  // The connector's message sits inside the JSON payload, so this must match
  // anywhere — anchoring at the start only ever worked for a bare string.
  /([A-Za-z0-9_.:-]+) is not included in the local action allowlist/,
];

// Model-lane turn failures: after ciyuan-account-lane the user-side repair
// path for model credentials is the 词元 account card (binding a personal
// account also rides out a broken deployment seed key — the hint stays honest
// for both cases).
export function turnErrorHint(message) {
  if (typeof message !== "string" || !message) return null;
  return CREDENTIAL_RE.test(message) ? { panel: "ciyuan-account" } : null;
}

// Failed MCP tool calls: `mcp__<server>__<tool>` → the server's config (DB
// market install or mcp.json baseline) → its credentialRef → that ref's
// connect panel. No ref（a public server, a config without credentials）→
// no hint: there is nothing to connect.
//
// `options.scope` lets a caller that already asked `scope-explain` fill the
// pointer's (provider, operationType) — the classifier itself has no catalog
// access and will not invent them (see SCOPE_ACTION_ID_RES).
export function toolFailureHint(toolName, resultText, options = null) {
  if (!toolName || typeof resultText !== "string" || !resultText) return null;
  const config = resolveServerConfig(toolName);
  // Scope first: a permission rejection is repaired by granting, and reporting
  // it as a credential failure sends the user to the wrong card.
  if (SCOPE_NOT_ALLOWED_RE.test(resultText)) {
    const actionId = SCOPE_ACTION_ID_RES.map((re) => re.exec(resultText)?.[1]).find(Boolean) ?? null;
    const known = options?.scope && typeof options.scope === "object" ? options.scope : null;
    const provider = typeof known?.provider === "string" && known.provider.trim() ? known.provider.trim() : null;
    const operationType =
      known?.operationType === "read" || known?.operationType === "write" ? known.operationType : null;
    return {
      // The bindings card is where a grant is issued; without a resolvable ref
      // the panel is still the right destination for a connector scope gap.
      panel:
        (config && credentialRefs.refFor(config) && credentialRefs.connectPanelForRef(credentialRefs.refFor(config).refName)) ||
        "connector-bindings",
      kind: "scope",
      scope: { actionId, provider, operationType },
    };
  }
  if (!CREDENTIAL_RE.test(resultText)) return null;
  if (!config) return null;
  const entry = credentialRefs.refFor(config);
  if (!entry) return null;
  const panel = credentialRefs.connectPanelForRef(entry.refName);
  return panel ? { panel } : null;
}

// The failing server's config: DB market install first (a user override wins),
// then the mcp.json baseline. null when neither knows the name.
function resolveServerConfig(toolName) {
  const serverName = /^mcp__(.+?)__/.exec(toolName)?.[1];
  if (!serverName) return null;
  try {
    const fromStore = extensionStore.getMcpServer(serverName)?.config;
    if (fromStore) return fromStore;
  } catch {
    /* store unavailable (no DB yet) — fall through to mcp.json */
  }
  try {
    const mcpPath = path.resolve(process.env.MCP_CONFIG_PATH || "mcp.json");
    return JSON.parse(fs.readFileSync(mcpPath, "utf8")).mcpServers?.[serverName] ?? null;
  } catch {
    /* no mcp.json / unreadable — nothing more to look up */
    return null;
  }
}
