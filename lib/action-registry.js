// ── Action registry (add-line-boards-and-action-gate) ────────────────────────
//
// Central declaration of all gated actions: id, line, underlying tool, risk,
// target requirements, impact template, and preflight hook. Risk determines the
// confirmation tier; unregistered actions MUST NOT be executed by the copilot.
//
// v1 entries (design D3):
//   facet.pack.publish           → publish    → cloud     → async approval
//   facet.pack.visibility        → write      → cloud     → inline confirm
//   facet.pack.curation          → publish    → cloud     → async approval
//   facet.agent.toggle           → write      → cloud     → inline confirm
//   wanxing.agent.pause          → write      → cloud     → inline confirm
//   wanxing.agent.resume         → write      → cloud     → inline confirm
//   wanxing.callers.add          → write      → cloud     → inline confirm
//   wanxing.callers.remove       → write      → cloud     → inline confirm
//   wanxing.agent.deploy         → destructive→ cloud/desktop → second confirm + impact
//
// Each facet/wanxing entry names its hosting `server` (the registry entry
// name) so the executor routes it declaratively; the credential it executes
// with follows lib/action-executor's precedence (action declaration → line
// fixed → the hosting server's registry declaration). facet-market-mcp
// declares `facet-market` (the user's market device token); facet-ops-mcp
// declares none (the user's registry token). The four wanxing ops entries pin
// `wanxing-caller` explicitly — the operator baseline presents that key to
// wanxing-ops-mcp, not the registry token (see WANXING_CALLER below).
// Tool names are verbatim from the live registry tool_list snapshots
// (2026-10-21: facet-market-mcp 7, facet-ops-mcp 6, wanxing-ops-mcp 7).
// `wanxing_agent_deploy` does not exist upstream yet (task 6.2), so that entry
// deliberately names no server and fails `tool_unroutable` until it does.
//
// wire entries (add-wire-line-board, design D2): ids are verbatim fd-wire
// REGISTRY ids; tool + risk are pinned to lib/wire-tool-risk.js (the vendored
// tool_risk snapshot) by scripts/test-wire-tool-risk.mjs. Every wire action
// executes with the user's own wire-customer credential, so preflight refuses
// when that credential is absent.
//
// `userFilledArgs` (design D5): parameters the USER must type at confirmation.
// The gate strips any model-supplied value for these keys at propose time and
// only accepts them from the approve body — the mechanism behind "never
// auto-fill the compliance fields".
//
// `argKeys` / `requiredArgs` / `argAliases` (validate-propose-arg-keys): every
// entry pins its tool's parameter names verbatim from the tool's source —
// facet_ops_mcp/tools_marketplane.py + tools_market.py, wanxing_ops_mcp/
// tools_fleet.py, wire_ops_mcp/tools_console.py (read 2026-10-22). All of them
// are FastMCP/pydantic-typed: a key the signature does not name is a 422 at
// execution, and a missing one renders「undefined」in the impact text. The gate
// therefore lands the model's spelling on the tool's name (filterKnownArgs) and
// refuses a proposal that lacks a required key before it is stored
// (routes/actions.js), instead of leaving an un-executable pending row.

import { requireChatwootCredential, requireExecutionCredential, requireLineCredential, } from "./action-preflight.js";

const RISK = Object.freeze({
  read: "read",
  write: "write",
  destructive: "destructive",
  cost: "cost",
  publish: "publish",
});

const TARGET = Object.freeze({
  cloud: "cloud",
  desktop: "desktop",
  any: "any",
});

// Mapping from risk to confirmation tier (spec: action-gate).
const riskToTier = {
  [RISK.read]: "auto",
  [RISK.write]: "inline",
  [RISK.destructive]: "second",
  [RISK.cost]: "second",
  [RISK.publish]: "async",
};

// v1 action roster (nine items). Each entry is immutable after registration.
const FACET_MARKET = "facet-market-mcp";
const FACET_OPS = "facet-ops-mcp";
const WANXING_OPS = "wanxing-ops-mcp";

// The wanxing ops actions pin their credential explicitly: the registry entry
// declares none (would fall to the registry token), but the operator baseline
// (platform-mcp-config) and the fleet's own auth model present the user's
// wanxing-caller key — 萬星's platform token — to this server. Presenting the
// registry token instead would 401 AND wrongly stale the user's market
// credential, so the entry overrides the data-driven resolution.
const WANXING_CALLER = "wanxing-caller";

const ACTIONS = Object.freeze([
  {
    id: "facet.pack.publish",
    line: "facet",
    server: FACET_MARKET,
    tool: "facet_market_pack_publish",
    risk: RISK.publish,
    target: TARGET.cloud,
    // Disclosure surface (add-personal-mandate 4.1): the manifest text goes
    // public. `contentArgs` names which arguments carry "what is being said" so
    // the disclosure gate reads the real text instead of guessing.
    outbound: true,
    contentArgs: ["manifest"],
    impact: (args) => `发布/更新包「${args.manifest?.name || args.packId || "未命名"}」v${args.manifest?.version || "new"} 到市场`,
    // Creators-group membership is the market's own judgement at call time.
    preflight: requireExecutionCredential(),
    // facet_market_pack_publish(manifest: dict, packId: str | None) — the one
    // market tool whose id parameter is camelCase upstream.
    argKeys: ["manifest", "packId"],
    requiredArgs: ["manifest"],
  },
  {
    id: "facet.pack.visibility",
    line: "facet",
    server: FACET_MARKET,
    tool: "facet_market_pack_visibility",
    risk: RISK.write,
    target: TARGET.cloud,
    // Visibility is a disclosure decision even though the risk tier is `write`:
    // flipping a pack to public is the moment its content leaves the owner's
    // circle, so the gate must see the target visibility value.
    outbound: true,
    contentArgs: ["visibility"],
    impact: (args) => `将包「${args.id}」可见性改为 ${args.visibility}`,
    preflight: requireExecutionCredential(),
    // facet_market_pack_visibility(id: str, visibility: str). Models reach for
    // `packId` first (publish's spelling), so it is accepted as an alias.
    argKeys: ["id", "visibility"],
    requiredArgs: ["id", "visibility"],
    argAliases: { id: ["packId", "pack_id"] },
  },
  {
    id: "facet.pack.curation",
    line: "facet",
    server: FACET_MARKET,
    tool: "facet_market_pack_curation",
    risk: RISK.publish,
    target: TARGET.cloud,
    outbound: true,
    contentArgs: ["category", "featured"],
    impact: (args) => `策展包「${args.id}」（category=${args.category ?? "不变"}，featured=${args.featured ?? "不变"}）`,
    preflight: requireExecutionCredential(),
    // facet_market_pack_curation(id: str, category: str | None, featured: bool | None)
    argKeys: ["id", "category", "featured"],
    requiredArgs: ["id"],
    argAliases: { id: ["packId", "pack_id"] },
  },
  {
    id: "facet.agent.toggle",
    line: "facet",
    server: FACET_OPS,
    tool: "facet_agent_toggle",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `将 agent「${args.path}」${args.enabled ? "启用" : "停用"}`,
    preflight: requireExecutionCredential(),
    // facet_agent_toggle(path: str, enabled: bool)
    argKeys: ["path", "enabled"],
    requiredArgs: ["path", "enabled"],
  },
  {
    id: "wanxing.agent.pause",
    line: "wanxing",
    server: WANXING_OPS,
    credentialRef: WANXING_CALLER,
    tool: "wanxing_agent_pause",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `暂停 agent「${args.agent_id}」(pack=${args.pack_id})`,
    preflight: requireExecutionCredential(),
    // wanxing_agent_pause(pack_id: str, agent_id: str) — the fleet tools are
    // snake_case upstream; camelCase spellings normalize in filterKnownArgs.
    argKeys: ["pack_id", "agent_id"],
    requiredArgs: ["pack_id", "agent_id"],
  },
  {
    id: "wanxing.agent.resume",
    line: "wanxing",
    server: WANXING_OPS,
    credentialRef: WANXING_CALLER,
    tool: "wanxing_agent_resume",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `恢复 agent「${args.agent_id}」(pack=${args.pack_id})`,
    preflight: requireExecutionCredential(),
    // wanxing_agent_resume(pack_id: str, agent_id: str)
    argKeys: ["pack_id", "agent_id"],
    requiredArgs: ["pack_id", "agent_id"],
  },
  {
    id: "wanxing.callers.add",
    line: "wanxing",
    server: WANXING_OPS,
    credentialRef: WANXING_CALLER,
    tool: "wanxing_callers_add",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `向 agent「${args.agent_id}」(pack=${args.pack_id}) 允许清单添加 caller ${args.email}`,
    preflight: requireExecutionCredential(),
    // wanxing_callers_add(pack_id: str, agent_id: str, email: str)
    argKeys: ["pack_id", "agent_id", "email"],
    requiredArgs: ["pack_id", "agent_id", "email"],
  },
  {
    id: "wanxing.callers.remove",
    line: "wanxing",
    server: WANXING_OPS,
    credentialRef: WANXING_CALLER,
    tool: "wanxing_callers_remove",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `从 agent「${args.agent_id}」(pack=${args.pack_id}) 允许清单移除 caller ${args.user_id}`,
    preflight: requireExecutionCredential(),
    // wanxing_callers_remove(pack_id: str, agent_id: str, user_id: int)
    argKeys: ["pack_id", "agent_id", "user_id"],
    requiredArgs: ["pack_id", "agent_id", "user_id"],
  },
  {
    id: "wanxing.agent.deploy",
    line: "wanxing",
    // No `server`: the tool is not on wanxing-ops-mcp yet (task 6.2), so the
    // executor fails tool_unroutable rather than calling a name that is not
    // there. Preflight (target → deployer key / seat) is preflightDeploy via
    // the dispatcher.
    tool: "wanxing_agent_deploy",
    risk: RISK.destructive,
    target: TARGET.any,
    impact: (args) => `部署 agent「${args.agent_id}」(pack=${args.pack_id}) 到 ${args.target === "cloud" ? "云端" : args.target}`,
    preflight: async (_ctx) => ({ ok: true }),
    // Not upstream yet; keys follow the fleet tools' snake_case so the
    // declaration holds when the tool lands. preflightDeploy reads `target`.
    argKeys: ["pack_id", "agent_id", "target"],
    requiredArgs: ["pack_id", "agent_id", "target"],
  },

  // ── crm（客服台，add-crm-desk-bridge D6/D7）──────────────────────────────
  {
    id: "crm.message.send",
    line: "crm",
    // The hosting server is a bundled STDIO entry (platform.bundle.json), not
    // a registry catalog server: the executor takes its stdio branch, spawning
    // the pinned mcp-chatwoot dist per execution with envRefs-resolved env.
    server: "chatwoot",
    tool: "messages_create",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => {
      const content = String(args.content ?? "");
      const excerpt = content.length > 60 ? `${content.slice(0, 60)}…` : content;
      return `向客服会话 #${args.conversation_id ?? "?"} 发送回复：「${excerpt}」`;
    },
    // First-party shared-credential line (D7): the A tenant is 寻数's own
    // account and every platform user shares one inbox BY DESIGN — execution
    // uses the deployment env pair, NOT a per-user credential ref. This is the
    // declared first-party exception to the "谦面/萬星以用户自己的凭据执行"
    // requirement; B 面 (multi-tenant merchants) replaces it with per-tenant
    // BYOK. Send-class tools stay out of every agent face
    // (lib/operator-tool-face.js) — propose_action is the ONLY route here.
    // Dual credential (add-crm-desk-pack-embed D3): the user's own Chatwoot
    // token when connected; the deployment env pair only for the machine owner.
    credentialRef: "chatwoot",
    preflight: requireChatwootCredential(),
    // messages_create(account_id: number, conversation_id: number, content:
    // string, ...) — verbatim from mcp-chatwoot src/tools/messages.ts; the
    // skill pins account_id=1 (the server does not read an ACCOUNT_ID env).
    argKeys: ["account_id", "conversation_id", "content"],
    requiredArgs: ["account_id", "conversation_id", "content"],
  },

  // ── wire（柏讯）──────────────────────────────────────────────────────────
  {
    id: "wire.demand.submit",
    line: "wire",
    tool: "wire_demand_submit",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => {
      const what = String(args.description || "").trim().slice(0, 40);
      return `提交需求单「${what}${what.length >= 40 ? "…" : ""}」（公开源 URL 与公开数据声明由你亲自填写，不采纳模型取值）`;
    },
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    // Verbatim from wire_ops_mcp.tools_console.wire_demand_submit — the MCP
    // signature is strict (pydantic), so an unknown key (a model inventing
    // "title", which fd-wire's DemandCreate does not have) is a 422 at
    // execution. Known keys only.
    argKeys: ["description", "contact_email", "company", "indicator_code"],
    requiredArgs: ["description", "contact_email"],
    // Field names verbatim from fd-wire api/fd_wire_api/demands/schemas.py
    // DemandCreate (source_urls: list[SourceUrl] min 1; public_data_asserted: bool must be true).
    userFilledArgs: [
      { key: "source_urls", label: "公开源 URL", kind: "url[]", required: true },
      { key: "public_data_asserted", label: "公开数据声明", kind: "boolean", required: true },
    ],
  },
  {
    id: "wire.market.subscribe",
    line: "wire",
    tool: "wire_market_subscribe",
    risk: RISK.cost,
    target: TARGET.cloud,
    impact: (args) => `订阅市场数据集「${args.dataset_id ?? ""}」（产生费用；approval 档数据集将转为访问申请）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    argKeys: ["dataset_id"],
    requiredArgs: ["dataset_id"],
  },
  {
    id: "wire.market.unsubscribe",
    line: "wire",
    tool: "wire_market_unsubscribe",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `退订市场数据集「${args.dataset_id ?? ""}」`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    argKeys: ["dataset_id"],
    requiredArgs: ["dataset_id"],
  },
  {
    id: "wire.dataset.create",
    line: "wire",
    tool: "wire_dataset_create",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `创建数据集「${args.name || ""}」（免费档走 CSV 导入，其余档位建列声明空集——由柏讯按档位判定）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    // wire_dataset_create(name: str, csv_content: str | None, columns: list[dict] | None).
    // `source` was never a parameter here (it belongs to wire_dataset_correct);
    // declaring it dropped the CSV body and the column list on the floor.
    argKeys: ["name", "csv_content", "columns"],
    requiredArgs: ["name"],
  },
  {
    id: "wire.artifact.publish",
    line: "wire",
    tool: "wire_artifact_publish",
    risk: RISK.write,
    target: TARGET.cloud,
    // Outbound to the whole line (the artifact body lives upstream, so the
    // identifier is what the gate can see).
    outbound: true,
    contentArgs: ["artifact_id"],
    impact: (args) => `发布产物 #${args.artifact_id ?? ""}（队内可见；对外分享需另经柏讯审批）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    argKeys: ["artifact_id"],
    requiredArgs: ["artifact_id"],
  },
  {
    id: "wire.artifact.archive",
    line: "wire",
    tool: "wire_artifact_archive",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `归档产物 #${args.artifact_id ?? ""}（可逆：可在柏讯控制台 restore）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    argKeys: ["artifact_id"],
    requiredArgs: ["artifact_id"],
  },
  {
    id: "wire.pack.subscribe",
    line: "wire",
    tool: "wire_pack_subscribe",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `订阅源包 ${args.pack_id ?? ""}（订阅免费，随时可退订；目录更新即跟踪）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    argKeys: ["pack_id"],
    requiredArgs: ["pack_id"],
  },
  {
    id: "wire.pack.unsubscribe",
    line: "wire",
    tool: "wire_pack_unsubscribe",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `退订源包 ${args.pack_id ?? ""}（幂等；「源包」页可重新订阅）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    argKeys: ["pack_id"],
    requiredArgs: ["pack_id"],
  },
  {
    id: "wire.dataset.correct",
    line: "wire",
    tool: "wire_dataset_correct",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `对数据集「${args.dataset_id ?? ""}」写入一条修正（${args.op || "insert/update/delete"}，须带 source 来源标记）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    argKeys: ["dataset_id", "op", "row_id", "column", "value", "values", "artifact_id", "source"],
    requiredArgs: ["dataset_id", "op"],
  },
  {
    id: "wire.dataset.correction.revert",
    line: "wire",
    tool: "wire_dataset_correction_revert",
    risk: RISK.write,
    target: TARGET.cloud,
    impact: (args) => `撤销数据集「${args.dataset_id ?? ""}」的修正 #${args.correction_id ?? ""}（只置 reverted_at，基行不改写）`,
    preflight: requireLineCredential("wire-customer", { label: "柏讯（操作）" }),
    argKeys: ["dataset_id", "correction_id"],
    requiredArgs: ["dataset_id", "correction_id"],
  },
]);

/**
 * Get an action by id. Returns null if not found.
 */
export function getAction(id) {
  return ACTIONS.find((a) => a.id === id) ?? null;
}

// ── Load-time disclosure completeness (add-personal-mandate, design D4) ─────
//
// An outbound action that does not name the arguments carrying its text would
// let the disclosure gate run blind: no text to inspect means every send looks
// clean. Fail the load instead — a broken registry is loud, an unguarded
// outbound path is silent.
for (const entry of ACTIONS) {
  const gateable = entry.outbound === true || entry.risk === RISK.publish;
  if (!gateable) continue;
  if (!Array.isArray(entry.contentArgs) || entry.contentArgs.length === 0) {
    throw new Error(
      `action-registry: outbound action "${entry.id}" must declare contentArgs (the disclosure gate cannot read what it cannot locate)`,
    );
  }
}

/**
 * List actions filtered by line. Optional: only include those matching target.
 */
export function listActions({ line, target } = {}) {
  let out = ACTIONS;
  if (line) out = out.filter((a) => a.line === line);
  if (target) out = out.filter((a) => a.target === target || a.target === TARGET.any);
  return out;
}

/**
 * Check if an action is registered.
 */
export function isRegistered(id) {
  return !!getAction(id);
}

/**
 * The user-filled parameter schema for an action ([] when it declares none).
 */
export function userFilledArgsFor(id) {
  const action = getAction(id);
  return Array.isArray(action?.userFilledArgs) ? action.userFilledArgs : [];
}

/**
 * Drop every user-filled key from model-supplied args (design D5: the model's
 * value for a compliance field is discarded, never surfaced). Returns a new
 * object; the input is not mutated.
 */
export function stripUserFilledArgs(id, args) {
  const schema = userFilledArgsFor(id);
  const out = { ...(args && typeof args === "object" ? args : {}) };
  for (const field of schema) delete out[field.key];
  return out;
}

/**
 * The parameter names the underlying tool accepts ([] when undeclared), and
 * the subset a proposal cannot do without.
 */
export function argKeysFor(id) {
  const action = getAction(id);
  return Array.isArray(action?.argKeys) ? action.argKeys : [];
}

export function requiredArgsFor(id) {
  const action = getAction(id);
  return Array.isArray(action?.requiredArgs) ? action.requiredArgs : [];
}

const camelOf = (key) => key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const snakeOf = (key) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * Keep only the arguments the underlying tool actually accepts (design D2/D3).
 * Every upstream is pydantic-strict: an invented key such as `title` on the
 * demand tool is a 422, not a harmless extra. Each declared key takes the first
 * spelling present — verbatim, then its camelCase/snake_case twin, then the
 * entry's `argAliases` (e.g. `packId` for the market's `id`) — so the model's
 * habitual spelling lands on the tool's name; everything else is dropped before
 * the digest, impact text and storage. Entries without `argKeys` pass through.
 */
export function filterKnownArgs(id, args) {
  const action = getAction(id);
  const src = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  if (!Array.isArray(action?.argKeys)) return { ...src };
  const out = {};
  for (const key of action.argKeys) {
    const spellings = [key, camelOf(key), snakeOf(key), ...(action.argAliases?.[key] ?? [])];
    const hit = spellings.find((s) => src[s] !== undefined);
    if (hit !== undefined) out[key] = src[hit];
  }
  return out;
}

/**
 * Refuse a proposal that lacks a required key: a missing id renders「undefined」
 * in the impact text and can never execute, so the row must not be written.
 * Blank strings count as missing; false and 0 are values. Returns { ok: true }
 * or { ok: false, missing, argKeys, required } for the caller to echo back.
 */
export function validateArgs(id, args) {
  const required = requiredArgsFor(id);
  const src = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const missing = required.filter((key) => {
    const v = src[key];
    return v === undefined || v === null || (typeof v === "string" && !v.trim());
  });
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing, argKeys: argKeysFor(id), required };
}

/**
 * Validate approve-time user values against the schema. Returns
 * { ok: true, values } with only declared keys, or { ok: false, error }.
 */
export function validateUserFilledArgs(id, userArgs) {
  const schema = userFilledArgsFor(id);
  const supplied = userArgs && typeof userArgs === "object" && !Array.isArray(userArgs) ? userArgs : {};
  const allowed = new Set(schema.map((f) => f.key));
  for (const key of Object.keys(supplied)) {
    if (!allowed.has(key)) return { ok: false, error: `unexpected user arg: ${key}` };
  }
  const values = {};
  for (const field of schema) {
    const v = supplied[field.key];
    const present = !isBlank(field.kind, v);
    if (field.required && !present) return { ok: false, error: `missing required user arg: ${field.key}` };
    if (present) values[field.key] = normalizeUserValue(field.kind, v);
  }
  return { ok: true, values };
}

function isBlank(kind, v) {
  if (v === undefined || v === null) return true;
  if (kind === "boolean") return typeof v !== "boolean";
  if (kind === "url[]") return !Array.isArray(v) || v.filter((s) => typeof s === "string" && s.trim()).length === 0;
  return typeof v !== "string" || !v.trim();
}

function normalizeUserValue(kind, v) {
  if (kind === "url[]") return v.map((s) => String(s).trim()).filter(Boolean);
  if (kind === "text") return String(v).trim();
  return v;
}

/**
 * Map risk → tier (for UI rendering and spec compliance).
 */
export function riskToTierMap() {
  return riskToTier;
}

/**
 * Get the tier for a given risk.
 */
export function tierForRisk(risk) {
  return riskToTier[risk] ?? "unknown";
}

// Export constants for tests
export { RISK, TARGET };

// ── Mandate-facing constants (add-personal-mandate, D3) ──────────────────────
//
// Re-exported here so the risk surface and the "cannot be downgraded by a
// mandate" surface sit at one boundary: anything deriving settings options from
// RISK derives NON_DOWNGRADABLE from here too, and the server enforces the same
// frozen list. It is NOT stored in the database on purpose — one UPDATE must
// never be able to unlock a destructive or publish action.
export { NON_DOWNGRADABLE, allowedModesFor } from "./personal-mandate.js";
