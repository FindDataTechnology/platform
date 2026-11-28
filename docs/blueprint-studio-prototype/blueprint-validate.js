// [PROTOTYPE · 非权威] fleet-blueprint-studio Slice 1
// apply 时落点：server/blueprint-validate.js（import 路径保持现状即可）
//
// Blueprint validation chain + cast assembly.
// Hard rule (design D3): reuse the EXISTING chain — no second validator.
// Order: shape gate → parseFleetTemplate (single { ok:false, error } return —
// do NOT expect an array; resolveFleetTemplateParams returns arrays and is
// NOT used by the blueprint leg per requester calibration) →
// validatePackManifest ([{ error, entry? }]) → tool-face consult leg
// (lib/publish-tool-gate.js toolFaceErrors / toolClosureErrors, sync).
// The async probe-backed toolGateErrors stays AT THE PUBLISH DOOR — this file
// never calls it (consult ≠ invoking network probes from the studio).

import { parseFleetTemplate } from "./fleet-template.js";
import { validatePackManifest } from "../lib/pack-manifest.js";
import { toolFaceErrors, toolClosureErrors } from "../lib/publish-tool-gate.js";

const FORBIDDEN_KEY_RE = /(token|secret|password|api[_-]?key|private[_-]?key|endpoint|url|headers)/i;
const SECRET_VALUE_RE = /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;
const REGISTRY_NAME_RE = /^[a-z][a-z0-9-]*$/;

function isRegistryName(v) {
  return typeof v === "string" && REGISTRY_NAME_RE.test(v);
}

// ── 1 · blueprint shape gate ─────────────────────────────────────────────
// Blueprint-only concerns no existing checker covers: credential hygiene and
// the six sections having the keys the studio needs to reason over.

export function blueprintShapeErrors(content) {
  const errors = [];
  const err = (pathLoc, msg) => errors.push({ path: pathLoc, error: msg });

  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return [{ path: "$", error: "blueprint content must be an object" }];
  }

  const boundary = content.boundary ?? {};
  if (!boundary.name || typeof boundary.name !== "string") err("boundary.name", "板块边界：缺名称");
  if (!boundary.oneLine || typeof boundary.oneLine !== "string") err("boundary.oneLine", "板块边界：缺一句话用途");
  if (!boundary.outOfScope || typeof boundary.outOfScope !== "string") err("boundary.outOfScope", "板块边界：缺「不做什么」");

  const sources = content.dataSources ?? [];
  if (!Array.isArray(sources) || sources.length === 0) {
    err("dataSources", "数据来源：至少一路引用（在册 server 名或内部库逻辑名）");
  } else {
    sources.forEach((s, i) => {
      const ref = typeof s === "string" ? s : s?.ref;
      if (!isRegistryName(ref)) err(`dataSources[${i}]`, "数据来源只接受在册 server 名或内部库逻辑名（禁端点/网址）");
    });
  }

  // Credential sweep across the whole payload — key names that look
  // secret-bearing fail (contract keys are whitelisted per the publish-door
  // and fleet-template shapes), plus secret-looking string literals.
  const walk = (node, pathLoc) => {
    if (node == null) return;
    if (typeof node === "object" && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        const p = pathLoc ? `${pathLoc}.${k}` : k;
        if (FORBIDDEN_KEY_RE.test(k) && !["target", "registryName", "allowTools", "requiredGroup"].includes(k)) {
          err(p, `禁带凭据键「${k}」——蓝图只承载引用名，不含端点与密钥`);
        }
        walk(v, p);
      }
    } else if (Array.isArray(node)) {
      node.forEach((v, i) => { walk(v, `${pathLoc}[${i}]`); });
    } else if (typeof node === "string" && SECRET_VALUE_RE.test(node)) {
      err(pathLoc, "疑似密钥字面值——蓝图只承载引用，不藏凭据");
    }
  };
  walk(content, "");

  if (!content.fleet || typeof content.fleet !== "object") err("fleet", "缺岗位编制段");
  // 铸造 manifest 过不了发布门的硬下限「a pack must contain at least one
  // skill, MCP reference, agent, or bot」——蓝图不改写 fleet 引用即补内联件，
  // 作者的编制必须自带至少一份内联物件（技能/参考/agent/bot 任一）。
  const hasInlinePayload =
    (Array.isArray(content.skills) && content.skills.length > 0) ||
    (Array.isArray(content.agents) && content.agents.length > 0) ||
    (Array.isArray(content.mcpServers) && content.mcpServers.length > 0) ||
    (Array.isArray(content.bots) && content.bots.length > 0);
  if (!hasInlinePayload) {
    err("content", "编制必带至少一份内联物件（skills / agents / mcpServers / bots 任一非空，否则铸造过不了发布门 a pack must contain at least one skill, MCP reference, agent, or bot）");
  }
  if (!Array.isArray(content.acceptance) || content.acceptance.length === 0) {
    err("acceptance", "验收断言：至少一条（试跑验收以它为真源）");
  }
  if (!content.monitoring || typeof content.monitoring !== "object") {
    err("monitoring", "缺监控判据段（异常判据与 escalate 阈值）");
  }
  return errors;
}

// ── 2 · fleet segment → parseFleetTemplate (zero translation) ────────────
// Blueprint fleet segment is fleet-template-shaped byte-for-byte; the checker
// is the SAME one the publish door and provisioner use. It answers a single
// { ok:false, error } — surface it verbatim.

export function fleetSegmentErrors(content) {
  if (content?.fleet == null) return [{ path: "fleet", error: "缺岗位编制段" }];
  const parsed = parseFleetTemplate({
    fleet: content.fleet,
    agents: content.agents ?? [],
    mcpServers: content.mcpServers ?? [],
  });
  if (!parsed || parsed.ok === false) {
    return [{ path: "fleet", error: parsed?.error ?? "fleet template invalid" }];
  }
  return [];
}

// ── 3 · cast assembly → validatePackManifest + tool-face consult ─────────
// The cast manifest is the pack-publish-door shape. Category stays "fleet"
// (category id is contract; only DISPLAY text follows the cluster wash).

export function assembleManifest(blueprintContent) {
  const c = blueprintContent ?? {};
  const boundary = c.boundary ?? {};
  const manifest = {
    name: `${boundary.name ?? "未命名"}集群（模板）`,
    description: c.description ?? `${boundary.oneLine ?? ""}（蓝图构造间铸造。${boundary.outOfScope ? `不做什么=${boundary.outOfScope}` : ""}）`,
    tags: Array.isArray(c.tags) ? c.tags : ["集群", "模板", boundary.name].filter(Boolean).slice(0, 10),
    visibility: c.visibility ?? "public",
    category: "fleet",
    skills: c.skills ?? [],
    agents: c.agents ?? [],
    mcpServers: c.mcpServers ?? [],
    fleet: c.fleet,
    notes: c.notes,
    _casting: {
      source: "fleet-blueprint-studio",
      blueprint: boundary.name ?? null,
      version: null, // filled by the route at cast time
      approvedBy: null,
      approvedAt: null,
    },
  };
  return manifest;
}

export function manifestErrors(manifest) {
  const res = validatePackManifest(manifest);
  if (!Array.isArray(res) || res.length === 0) return [];
  return res.map((e) => ({ path: e?.entry ? `manifest.${e.entry}` : "manifest", error: e?.error ?? String(e) }));
}

// Fourth leg, sync consult: tool-face + closure over what the skills NAME.
// Same two functions the publish door shares before its probe phase — reuse,
// not re-implement (design D3 supplement).
export function toolFaceLegErrors(manifest) {
  return [...toolFaceErrors(manifest), ...toolClosureErrors(manifest)].map((e) => ({
    path: e?.entry ? `manifest.${e.entry}` : "manifest",
    error: e?.error ?? String(e),
  }));
}

// ── full chain (order matters — stop at the first failing stage) ─────────

export function runBlueprintValidation(content) {
  const shape = blueprintShapeErrors(content);
  if (shape.length) return { ok: false, stage: "shape", errors: shape };
  const fleet = fleetSegmentErrors(content);
  if (fleet.length) return { ok: false, stage: "fleet", errors: fleet };
  const manifest = assembleManifest(content);
  const mErr = manifestErrors(manifest);
  if (mErr.length) return { ok: false, stage: "manifest", errors: mErr, manifest };
  const tErr = toolFaceLegErrors(manifest);
  if (tErr.length) return { ok: false, stage: "toolface", errors: tErr, manifest };
  return { ok: true, errors: [], manifest };
}

// ── normalized diff for the approval surface ─────────────────────────────

export function diffBlueprint(prev, next) {
  const lines = [];
  const push = (k, a, b) => lines.push({ field: k, from: a ?? null, to: b ?? null });
  const section = (key, fmt) => {
    const a = prev?.[key], b = next?.[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) push(key, fmt ? fmt(a) : a, fmt ? fmt(b) : b);
  };
  section("boundary", (v) => v && `${v.name ?? "?"} / ${v.oneLine ?? ""}`);
  section("dataSources", (v) => (Array.isArray(v) ? v.map((s) => (typeof s === "string" ? s : s?.ref)).filter(Boolean) : v));
  section("fleet", (v) => v && { members: (v.members ?? []).length, edges: (v.orchestration?.edges ?? []).length });
  section("agents", (v) => (Array.isArray(v) ? v.length : v));
  section("mcpServers", (v) => (Array.isArray(v) ? v.length : v));
  section("acceptance", (v) => (Array.isArray(v) ? v.length : v));
  section("monitoring", (v) => (v ? { thresholds: Object.keys(v).length } : v));
  section("board", (v) => (v ? { lanes: Object.keys(v).length } : v));
  return lines;
}
