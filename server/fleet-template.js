// Fleet template manifest parsing + validation (agent-fleet-templates).
//
// A pack's optional `fleet` section IS the template. This module is the single
// parser/validator for it: shape gates (members/ref tree/cadence/targets),
// cycle rejection over parentRef edges, cron sanity, the optional
// `orchestration` section (validated by the SAME pure validator the live
// write face uses — server/fleet-orchestration.js — over the template member
// set), and the normalization every consumer (pack pre-validation,
// provisioner, exporter round-trip) shares. Packs WITHOUT a fleet section are
// plain packs — every entry point short-circuits on absence and behaves
// exactly as before (D1/D2 risk note).

import cronParser from "cron-parser";
// Pure leaf module (zero imports of its own) — importing it here keeps this
// file gateway-safe (no task-engine module graph rides along).
import { validateOrchestration } from "./fleet-orchestration.js";

// Minimal cron check (the engine's own parser, applied standalone): this
// module is also imported by the GATEWAY process (pack pre-validation), so it
// must not pull the task engine's module graph along.
function validateCron(expr, tz) {
  try {
    cronParser.parseExpression(expr, { tz: tz || undefined });
    return null;
  } catch {
    return `invalid cron expression: ${expr}`;
  }
}

export const TEMPLATE_TARGET_KINDS = ["pack-preset", "existing-persona", "existing-cluster", "existing-a2a", "tool", "bot", "auditor"];
// `auditor`（审计官）是 2026-11-09 新增的第五种岗位承载。模板能表达它，才谈得上
// 「一键起一支带审计的个人幕僚团」——否则每个想用审计官的人都得手工建岗。

// Template target kind → live-fleet targetKind. The orchestration validator
// speaks the LIVE member vocabulary (persona/cluster/a2a/tool/bot), so the
// template's members are projected through this map before validation — the
// member REFS stand in for the not-yet-minted member ids (design D3: same
// validator, member set swapped for the template's).
const TARGET_KIND_TO_MEMBER_KIND = {
  "pack-preset": "persona",
  "existing-persona": "persona",
  "existing-cluster": "cluster",
  "existing-a2a": "a2a",
  tool: "tool",
  bot: "bot",
  auditor: "auditor",
};

// The live face's 'server::tool' contract (server/tool-turn.js owns the
// canonical regex; this local mirror keeps this module gateway-pure — the
// canonical module pulls chat-history along).
const TOOL_TARGET_SHAPE_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)::([A-Za-z0-9][A-Za-z0-9._-]*)$/;
export const TEMPLATE_MEMBER_LIMIT = 50;

// Display-locale overlay shape (add-pack-locale-tracks D5) — same locale-tag
// rule as the pack manifest overlay (lib/pack-manifest.js LOCALE_KEY_RE).
const LOCALE_KEY_RE = /^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;
// Overlay values are display text (a template name, a post title, a slot
// label) — a generous single cap keeps abuse out without policing wording.
const LOCALE_DISPLAY_CHARS = 200;
const displayOverride = (v) => typeof v === "string" && !!v.trim() && v.length <= LOCALE_DISPLAY_CHARS;

// ── 参数槽 (agent-fleet-templates delta: 模板可声明默认参数槽) ────────────────
// `fleet.params` 是可选扩展段 — 旧模板不声明时一切行为逐字节。占位引用形如
// `${name}` 只允许出现在白名单位置（fleet.name / member.target.{id,packId,
// presetId} / member.cadence.{cron,promptTemplate}）——参数不能改写结构
// （成员数/边/槽位键），只能调「值」。
export const TEMPLATE_PARAM_TYPES = ["string", "number", "boolean", "enum"];
const PARAM_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const PLACEHOLDER_RE = /\$\{([a-z][a-zA-Z0-9_]{0,31})\}/g;

function validateParamShape(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "each param must be an object";
  if (typeof p.name !== "string" || !PARAM_NAME_RE.test(p.name)) return "each param needs a name matching /^[a-z][a-zA-Z0-9_]{0,31}$/";
  if (!TEMPLATE_PARAM_TYPES.includes(p.type)) return `param '${p.name}' type must be one of ${TEMPLATE_PARAM_TYPES.join(", ")}`;
  if (p.type === "enum") {
    if (!Array.isArray(p.options) || p.options.length === 0 || p.options.some((o) => typeof o !== "string" || !o.trim())) {
      return `param '${p.name}' enum needs a non-empty options array of strings`;
    }
  } else if (p.options !== undefined) return `param '${p.name}' options only meaningful for enum`;
  if (p.default !== undefined) {
    const err = valueFitsType(p.default, p);
    if (err) return `param '${p.name}' default ${err}`;
    // 嵌套占位不解析（单遍替换纪律）：默认值里再引槽位 = 声明期就拒, 不让
    // 半成品出到运行面 (形状诚实胜过语法糖)。
    if ((p.type === "string" || p.type === "enum") && /\$\{/.test(String(p.default))) {
      return `param '${p.name}' default may not itself reference a parameter (nesting is not substituted)`;
    }
  }
  if (p.label !== undefined && (typeof p.label !== "string" || !p.label.trim())) return `param '${p.name}' label must be a non-empty string`;
  return null;
}

function valueFitsType(value, p) {
  if (p.type === "string" && typeof value !== "string") return `must be a string`;
  if (p.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `must be a finite number`;
  if (p.type === "boolean" && typeof value !== "boolean") return `must be a boolean`;
  if (p.type === "enum" && (typeof value !== "string" || !(p.options ?? []).includes(value))) {
    return `must be one of ${(p.options ?? []).join(", ")}`;
  }
  return null;
}

const PARAM_SLOTS = 16;

// Params normalization used by the parse output. Returns
// { ok, params } | { ok: false, error }.
function parseParams(params) {
  if (params === undefined || params === null) return { ok: true, params: null };
  if (!Array.isArray(params)) return { ok: false, error: "fleet.params must be an array" };
  if (params.length > PARAM_SLOTS) return { ok: false, error: `fleet.params is capped at ${PARAM_SLOTS}` };
  const seen = new Set();
  const out = [];
  for (const p of params) {
    const err = validateParamShape(p);
    if (err) return { ok: false, error: err };
    if (seen.has(p.name)) return { ok: false, error: `duplicate param '${p.name}'` };
    seen.add(p.name);
    out.push({
      name: p.name,
      type: p.type,
      ...(p.options ? { options: p.options } : {}),
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.required === true ? { required: true } : {}),
      ...(typeof p.label === "string" ? { label: p.label } : {}),
    });
  }
  return { ok: true, params: out.length ? out : null };
}

// 占位引用的登记: the string contains ${…} refs → each must name a declared
// param. Presence short-circuits the position's own shape checks at parse
// time (post-substitution re-parse is the structural gate).
function collectPlaceholderError(str, declared) {
  PLACEHOLDER_RE.lastIndex = 0;
  let match = PLACEHOLDER_RE.exec(str);
  while (match) {
    if (!declared.has(match[1])) return `references undeclared param '${match[1]}'`;
    match = PLACEHOLDER_RE.exec(str);
  }
  return null;
}

// Resolve a normalized template against caller-provided values: coerce + 必填
// gate + default backfill, then substitute EVERY whitelisted placeholder. Post-
// substitution structure is the caller's job to re-parse (provisioner 同缝).
// Returns { ok, errors: [{name, error}] , resolved } — resolved = {
//   template: substituted template object (deep clone), values }.
export function resolveFleetTemplateParams(template, provided = {}) {
  const params = template.params ?? [];
  const errors = [];
  const values = {};
  for (const p of params) {
    const raw = provided ? provided[p.name] : undefined;
    if (raw === undefined || raw === null || raw === "") {
      if (p.required === true && p.default === undefined) {
        errors.push({ name: p.name, error: "required" });
        continue;
      }
      values[p.name] = p.default !== undefined ? p.default : undefined;
    } else {
      const fit = valueFitsType(raw, p);
      if (fit) {
        errors.push({ name: p.name, error: fit });
        continue;
      }
      values[p.name] = raw;
    }
  }
  if (errors.length) return { ok: false, errors };

  const substitute = (str) =>
    String(str).replace(PLACEHOLDER_RE, (_, name) => {
      const v = values[name];
      if (v === undefined || v === null) return "";
      return typeof v === "boolean" || typeof v === "number" ? String(v) : String(v);
    });
  const clone = JSON.parse(JSON.stringify(template));
  if (typeof clone.name === "string") clone.name = substitute(clone.name);
  for (const m of clone.members ?? []) {
    if (typeof m.title === "string") m.title = substitute(m.title);
    for (const key of ["id", "packId", "presetId"]) {
      if (m.target && typeof m.target[key] === "string") m.target[key] = substitute(m.target[key]);
    }
    if (m.cadence) {
      if (typeof m.cadence.cron === "string") m.cadence.cron = substitute(m.cadence.cron);
      if (typeof m.cadence.promptTemplate === "string") m.cadence.promptTemplate = substitute(m.cadence.promptTemplate);
    }
  }
  delete clone.params;
  return { ok: true, resolved: { template: clone, values } };
}
export function parseFleetTemplate(manifest) {
  if (!manifest || typeof manifest !== "object") return { ok: false, error: "manifest must be an object" };
  const section = manifest.fleet;
  if (section === undefined || section === null) return { ok: false, error: "no fleet section", code: "fleet_missing" };
  if (typeof section !== "object" || Array.isArray(section)) {
    return { ok: false, error: "fleet section must be an object" };
  }
  const { name, nameKey, cover, members, requires } = section;
  const display = name ?? nameKey;
  // 参数槽段先行 — 成员的占位引用只许指向已声明槽位（占位不过关参数本身
  // 也过不了声明期）。
  const paramsParsed = parseParams(section.params);
  if (!paramsParsed.ok) return { ok: false, error: `fleet.params: ${paramsParsed.error}` };
  const declaredParams = new Set((paramsParsed.params ?? []).map((p) => p.name));
  if (typeof display !== "string" || !display.trim()) {
    return { ok: false, error: "fleet.name (or nameKey) is required" };
  }
  const namePlaceholderError = declaredParams.size ? collectPlaceholderError(display, declaredParams) : null;
  if (namePlaceholderError) return { ok: false, error: `fleet.name ${namePlaceholderError}` };
  if (!Array.isArray(members) || members.length === 0) {
    return { ok: false, error: "fleet.members must be a non-empty array", code: "fleet_members_empty" };
  }
  if (members.length > TEMPLATE_MEMBER_LIMIT) {
    return { ok: false, error: `fleet.members is capped at ${TEMPLATE_MEMBER_LIMIT}` };
  }

  const seenRefs = new Set();
  const pending = [];
  for (const m of members) {
    if (!m || typeof m !== "object") return { ok: false, error: "each member must be an object" };
    const ref = m.ref;
    if (typeof ref !== "string" || !ref.trim()) return { ok: false, error: "each member needs a ref", code: "fleet_member_needs_ref" };
    if (seenRefs.has(ref)) return { ok: false, error: `duplicate member ref '${ref}'` };
    seenRefs.add(ref);
    const title = m.title ?? m.titleKey;
    if (typeof title !== "string" || !title.trim()) {
      return { ok: false, error: `member '${ref}' needs a title (or titleKey)`, code: "fleet_member_needs_title" };
    }
    const target = m.target;
    if (!target || typeof target !== "object") return { ok: false, error: `member '${ref}' needs a target`, code: "fleet_member_needs_target" };
    if (!TEMPLATE_TARGET_KINDS.includes(target.kind)) {
      return { ok: false, error: `member '${ref}' target.kind must be one of ${TEMPLATE_TARGET_KINDS.join(", ")}`, code: "fleet_target_kind_invalid" };
    }
    // 参数占位（agent-fleet-templates delta）：白名单位置里的 ${param} 引用
    // 只许指向已声明槽位；占位在场的位置其形状检查后置到替换后重解析。
    for (const key of ["id", "packId", "presetId"]) {
      if (typeof target[key] === "string" && PLACEHOLDER_RE.test(target[key])) {
        PLACEHOLDER_RE.lastIndex = 0;
        const err = collectPlaceholderError(target[key], declaredParams);
        if (err) return { ok: false, error: `member '${ref}' target.${key} ${err}` };
      }
    }
    const hasPlaceholder = (s) => {
    if (typeof s !== "string") return false;
    PLACEHOLDER_RE.lastIndex = 0;
    return PLACEHOLDER_RE.test(s);
  };
    if (target.kind === "pack-preset") {
      if (
        typeof target.packId !== "string" || !target.packId.trim() ||
        typeof target.presetId !== "string" || !target.presetId.trim()
      ) {
        return { ok: false, error: `member '${ref}' pack-preset target needs packId and presetId` };
      }
    } else if (typeof target.id !== "string" || !target.id.trim()) {
      return { ok: false, error: `member '${ref}' ${target.kind} target needs an id` };
    }
    if (target.kind === "tool" && !hasPlaceholder(target.id) && !TOOL_TARGET_SHAPE_RE.test(target.id)) {
      // Shape gate only (mirrors the live face's 'server::tool' contract);
      // whether the server is routable stays an instantiation-time fact.
      return { ok: false, error: `member '${ref}' tool target.id must be 'server::tool' (got '${target.id}')`, code: "fleet_tool_target_shape" };
    }
    if (m.kpiSlots !== undefined) {
      if (!Array.isArray(m.kpiSlots) || m.kpiSlots.length > 8) {
        return { ok: false, error: `member '${ref}' kpiSlots must be an array of at most 8` };
      }
      for (const slot of m.kpiSlots) {
        const label = slot?.label ?? slot?.labelKey;
        if (typeof slot?.key !== "string" || !slot.key.trim() || typeof label !== "string" || !label.trim()) {
          return { ok: false, error: `member '${ref}' kpiSlots need key and label` };
        }
      }
    }
    if (m.cadence !== undefined && m.cadence !== null) {
      const c = m.cadence;
      if (typeof c !== "object" || typeof c.cron !== "string") {
        return { ok: false, error: `member '${ref}' cadence must be {cron, tz?, promptTemplate}` };
      }
      if (!hasPlaceholder(c.cron)) {
        const invalid = validateCron(c.cron, c.tz ?? null);
        if (invalid) return { ok: false, error: `member '${ref}': ${invalid}` };
      } else {
        const err = collectPlaceholderError(c.cron, declaredParams);
        if (err) return { ok: false, error: `member '${ref}' cadence.cron ${err}` };
      }
      if (typeof c.promptTemplate !== "string" || !c.promptTemplate.trim()) {
        return { ok: false, error: `member '${ref}' cadence needs a promptTemplate` };
      }
      if (hasPlaceholder(c.promptTemplate)) {
        const err = collectPlaceholderError(c.promptTemplate, declaredParams);
        if (err) return { ok: false, error: `member '${ref}' cadence.promptTemplate ${err}` };
      }
      // Tool posts (add-tool-posts): the cadence prompt IS the tool's
      // arguments — a JSON object, deterministically (mirror of the live
      // write face's toolCadenceError; kept local for gateway purity).
      if (target.kind === "tool" && !hasPlaceholder(c.promptTemplate)) {
        try {
          const parsed = JSON.parse(c.promptTemplate);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        } catch {
          return { ok: false, error: `member '${ref}' is a tool post — its cadence.promptTemplate must be a JSON object (the tool's arguments)` };
        }
      }
    }
    pending.push(m);
  }

  // parentRef edges: must name known refs, must not form a cycle (walk up with
  // a visited guard — same contract as the runtime's post-tree).
  const byRef = new Map(pending.map((m) => [m.ref, m]));
  for (const m of pending) {
    if (m.parentRef === undefined || m.parentRef === null) continue;
    if (typeof m.parentRef !== "string" || !byRef.has(m.parentRef)) {
      return { ok: false, error: `member '${m.ref}' parentRef names no member`, code: "handoff_unknown_parent" };
    }
    let cursor = m.parentRef;
    const walked = new Set();
    while (cursor != null) {
      if (cursor === m.ref || walked.has(cursor)) {
        return { ok: false, error: `member '${m.ref}' parentRef chain forms a cycle`, code: "handoff_cycle" };
      }
      walked.add(cursor);
      cursor = byRef.get(cursor)?.parentRef ?? null;
    }
  }

  if (requires !== undefined && requires !== null) {
    if (!Array.isArray(requires)) return { ok: false, error: "fleet.requires must be an array" };
    for (const r of requires) {
      if (!r || typeof r.name !== "string" || !r.name.trim()) {
        return { ok: false, error: "each require needs a name" };
      }
    }
  }

  // Display locale overlay (add-pack-locale-tracks D5): `fleet.i18n` carries
  // secondary-language text for the template's DISPLAY fields only — name,
  // member titles, KPI slot labels. Structure (members/cadence/kpiSlots keys/
  // orchestration edges) is untouched, and content-layer text (promptTemplate,
  // persona) may never ride here. Built-in templates keep their nameKey/
  // titleKey/labelKey mechanism — the two channels coexist, never merge.
  if (section.i18n !== undefined) {
    const i18n = section.i18n;
    if (!i18n || typeof i18n !== "object" || Array.isArray(i18n)) {
      return { ok: false, error: "fleet.i18n must be an object mapping locale tags to display-field overrides" };
    }
    const locales = Object.keys(i18n);
    if (locales.length === 0) {
      return { ok: false, error: "fleet.i18n must carry at least one locale block (omit the key instead)" };
    }
    for (const locale of locales) {
      if (!LOCALE_KEY_RE.test(locale)) {
        return { ok: false, error: `fleet.i18n locale '${locale}' must be a lower-case BCP-47 tag` };
      }
      if (locale === "zh" || locale.startsWith("zh-")) {
        return { ok: false, error: `fleet.i18n may not declare '${locale}' — Chinese is the main track` };
      }
      const block = i18n[locale];
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return { ok: false, error: `fleet.i18n.${locale} must be an object of display-field overrides` };
      }
      for (const key of Object.keys(block)) {
        if (key !== "name" && key !== "members") {
          return { ok: false, error: `fleet.i18n.${locale} has unknown key '${key}' (only name, members)` };
        }
      }
      if (block.name !== undefined && !displayOverride(block.name)) {
        return { ok: false, error: `fleet.i18n.${locale}.name must be a non-empty string of at most ${LOCALE_DISPLAY_CHARS} characters` };
      }
      if (block.members === undefined) continue;
      if (!block.members || typeof block.members !== "object" || Array.isArray(block.members)) {
        return { ok: false, error: `fleet.i18n.${locale}.members must be an object mapping member refs to overrides` };
      }
      for (const [ref, ov] of Object.entries(block.members)) {
        const member = byRef.get(ref);
        if (!member) {
          return { ok: false, error: `fleet.i18n.${locale}.members references '${ref}', which the template does not declare` };
        }
        if (!ov || typeof ov !== "object" || Array.isArray(ov)) {
          return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'] must be an object of { title, kpiSlots }` };
        }
        for (const key of Object.keys(ov)) {
          if (key !== "title" && key !== "kpiSlots") {
            return {
              ok: false,
              error: `fleet.i18n.${locale}.members['${ref}'] has unknown key '${key}' (only title, kpiSlots — cadence/promptTemplate are content and not localizable)`,
            };
          }
        }
        if (ov.title !== undefined && !displayOverride(ov.title)) {
          return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].title must be a non-empty string of at most ${LOCALE_DISPLAY_CHARS} characters` };
        }
        if (ov.kpiSlots === undefined) continue;
        if (!ov.kpiSlots || typeof ov.kpiSlots !== "object" || Array.isArray(ov.kpiSlots)) {
          return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].kpiSlots must be an object mapping slot keys to { label }` };
        }
        const slotKeys = new Set((member.kpiSlots ?? []).map((s) => s?.key).filter((k) => typeof k === "string"));
        for (const [slotKey, slotOv] of Object.entries(ov.kpiSlots)) {
          if (!slotKeys.has(slotKey)) {
            return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].kpiSlots references '${slotKey}', which member '${ref}' does not declare` };
          }
          if (!slotOv || typeof slotOv !== "object" || Array.isArray(slotOv)) {
            return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].kpiSlots['${slotKey}'] must be an object of { label }` };
          }
          for (const key of Object.keys(slotOv)) {
            if (key !== "label") {
              return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].kpiSlots['${slotKey}'] has unknown key '${key}' (only label)` };
            }
          }
          if (slotOv.label !== undefined && !displayOverride(slotOv.label)) {
            return { ok: false, error: `fleet.i18n.${locale}.members['${ref}'].kpiSlots['${slotKey}'].label must be a non-empty string of at most ${LOCALE_DISPLAY_CHARS} characters` };
          }
        }
      }
    }
  }

  // Orchestration section (add-mixed-fleet-packs D3): the SAME validator the
  // live write face uses, with the template members projected into the live
  // member vocabulary (ref stands in for the future member id) — one source,
  // the member set swapped. Present-but-null passes trivially (the live face
  // treats null as "explicitly no edges"); ABSENT short-circuits entirely so
  // the section-less parse output stays byte-identical.
  if (section.orchestration !== undefined) {
    // `parentRef` IS the template's parent link (the provisioner maps it to the
    // member's parentId), so project it — the report-edge rule reads parentId.
    const projected = pending.map((m) => ({
      id: m.ref,
      parentId: m.parentRef ?? null,
      targetKind: TARGET_KIND_TO_MEMBER_KIND[m.target.kind],
    }));
    const check = validateOrchestration({ members: projected, orchestration: section.orchestration });
    if (!check.ok) {
      return {
        ok: false,
        error: `fleet.orchestration: ${check.errors[0].error}`,
        errors: check.errors,
      };
    }
  }

  return {
    ok: true,
    template: {
      name: String(display).trim(),
      ...(cover ? { cover: String(cover) } : {}),
      // 参数槽（无声明段 = null, 与无参数旧模板逐字节同形）。
      ...(paramsParsed.params ? { params: paramsParsed.params } : {}),
      members: pending.map((m) => ({
        ref: m.ref,
        title: String(m.title ?? m.titleKey).trim(),
        parentRef: m.parentRef ?? null,
        target: m.target,
        kpiSlots: (m.kpiSlots ?? []).map((s) => ({ ...s, label: String(s.label ?? s.labelKey).trim() })),
        cadence: m.cadence ?? null,
      })),
      requires: (requires ?? []).map((r) => ({ kind: r.kind ?? "a2a", name: String(r.name).trim(), optional: r.optional === true })),
      ...(section.orchestration !== undefined ? { orchestration: section.orchestration } : {}),
    },
  };
}

// The export whitelist (3.3): the ONLY fields an exported manifest carries.
// Reports, decisions, sessions, owners, credentials never enter this shape.
// The live orchestration section survives verbatim (spec: 导出保留现役编导
// 段) — its edges already speak member ids, and the export's refs ARE those
// ids, so the section re-parses as a template unchanged.
export function exportFleetToTemplate(fleet, members, { plugins = [] } = {}) {
  // Team plugin declaration (add-fleet-plugin-declaration 4.1): the exported
  // template carries the same `plugins[]` the source pack declared, so a pack is
  // self-describing wherever it travels. Shape only — whether the receiving
  // machine bakes them is the IMPORT face's question, not the exporter's.
  const memberFor = (targetKind) =>
    targetKind === "cluster"
      ? "existing-cluster"
      : targetKind === "a2a"
        ? "existing-a2a"
        : targetKind === "tool" || targetKind === "bot" || targetKind === "auditor"
          ? targetKind
          : "existing-persona";
  return {
    fleet: {
      name: fleet.name,
      members: members.map((m) => ({
        ref: m.id,
        title: m.title,
        parentRef: members.find((x) => x.id === m.parentId)?.id ?? null,
        target: { kind: memberFor(m.targetKind), id: m.targetId },
        kpiSlots: m.kpiSlots ?? [],
        ...(m.cadence
          ? { cadence: { cron: m.cadence.cron, tz: m.cadence.tz ?? null, promptTemplate: m.cadence.promptTemplate } }
          : {}),
      })),
      requires: [],
      // Declaration travels with the template (4.1). Absent ⇒ byte-identical to
      // the pre-change export.
      ...(Array.isArray(plugins) && plugins.length > 0
        ? { plugins: plugins.map((p) => (p?.version ? { id: p.id, version: p.version } : { id: p.id })) }
        : {}),
      ...(fleet.orchestration ? { orchestration: fleet.orchestration } : {}),
    },
  };
}
