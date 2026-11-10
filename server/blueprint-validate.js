// 蓝图校验桥（add-blueprint-studio Slice 1, design D3/D5；v1 兼容层已摘除——
// remove-blueprint-v1-compat）。
//
// 零第二造：本模块的每一则校验错误都来自既有校验器原文——
//   parseFleetTemplate      fleet 段（server/fleet-template.js，含编排成环）
//   validatePackManifest    manifest 段（lib/pack-manifest.js，发布门同函数）
//   toolFaceErrors/toolClosureErrors
//                           发布工具闸的 consult 复用（lib/publish-tool-gate.js
//                           同步导出；异步带探针的 toolGateErrors 留在发布门，
//                           design「实施口径对账」D3 补充）
// 唯一本地生成的发现是 shape 闸（凭据扫描 + dataSources 契约），粒度同样
// 逐字段指名——spec「错误文案不得超过既有校验器原文的字段粒度」。
//
// 形状纪律（spec 蓝图不含凭据）：dataSources 只收 registry 在册 server 名或
// 内部库逻辑名；端点/凭据在存储层另有硬拒（blueprints-db.js assertStorable）。

import { parseFleetTemplate } from "./fleet-template.js";
import { validatePackManifest, deriveCode } from "../lib/pack-manifest.js";
import { toolFaceErrors, toolClosureErrors } from "../lib/publish-tool-gate.js";
import { buildUserProviderEntries, getDefault } from "../llm-providers.js";
import { normalizeKnowledgeProfile } from "./knowledge-profile.js";

// ── Shape gate: 凭据扫描（存储层与 validate 路由共用） ─────────────────────

// 键名禁带：子串匹配长词（token/secret/…），短小通用词用精确集合避免误伤
// （"headline" 不吃 "headers" 这类亏）。契约白名单里的键永不判罚。
const FORBIDDEN_KEY_PARTS = /token|secret|password|credential|api[-_]?key|private[-_]?key/i;
const FORBIDDEN_KEY_EXACT = new Set(["endpoint", "url", "headers", "baseurl", "base_url", "base-url", "host"]);
const CONTRACT_KEY_WHITELIST = new Set(["target", "registryName", "allowTools", "requiredGroup", "fullSurface", "reason"]);

// 秘密字面值：命中常见的真凭据形态；普通 URL/散文不匹配。
const SECRET_LITERAL_RE =
  /(sk-[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|bearer\s+[A-Za-z0-9._-]{12,})/i;

export function credentialFindings(content) {
  const findings = [];
  const walk = (node, at) => {
    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, `${at}[${i}]`);
      return;
    }
    if (!node || typeof node !== "object") {
      if (typeof node === "string" && SECRET_LITERAL_RE.test(node)) {
        findings.push({ error: `secret-like literal is not allowed in a blueprint`, entry: at || "$", code: "credential_secret_literal" });
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const entry = at ? `${at}.${key}` : key;
      if (
        !CONTRACT_KEY_WHITELIST.has(key) &&
        (FORBIDDEN_KEY_PARTS.test(key) || FORBIDDEN_KEY_EXACT.has(key.toLowerCase()))
      ) {
        findings.push({ error: `key '${key}' may not carry endpoints or credentials in a blueprint`, entry, code: "credential_forbidden_key" });
        continue; // 命中禁键即名之，不再下探该子树（错误归主键）。
      }
      walk(value, entry);
    }
  };
  walk(content, "");
  return findings;
}

// ── Shape gate: dataSources 契约（只在册名/逻辑名/知识库集合，禁端点禁凭据） ──

const DATASOURCE_REF_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
// Third ref kind (add-knowledge-memory-surface 3.1): a knowledge-base
// collection pinned into the blueprint. `library:<collectionId>` makes the
// materialized member a KB-scoped agent (its library tools see that collection
// ∪ shared, per document-library-tools' boundary). This module stays DB-free,
// so it validates the SHAPE here and takes an optional `resolveLibrary(id)`
// callback from the caller that owns DB access — returning true (visible), a
// string (why not) or false (dangling/invisible).
const LIBRARY_REF_RE = /^library:([A-Za-z0-9_-]{1,64})$/;

export function dataSourceFindings(content, resolveLibrary = null) {
  const findings = [];
  const sources = content?.dataSources;
  if (sources === undefined || sources === null) return findings;
  if (!Array.isArray(sources)) {
    return [{ error: "dataSources must be an array of { ref } entries naming registry servers, internal libraries, or knowledge collections (library:<id>)", entry: "dataSources", code: "datasources_invalid" }];
  }
  sources.forEach((src, i) => {
    const entry = `dataSources[${i}]`;
    if (!src || typeof src !== "object" || Array.isArray(src)) {
      findings.push({ error: `data source must be an object of { ref, note? } naming a registry server, an internal-library logical name, or a knowledge collection (library:<id>)`, entry, code: "datasource_entry_invalid" });
      return;
    }
    const ref = src.ref;
    const isLibrary = typeof ref === "string" && LIBRARY_REF_RE.test(ref);
    if (typeof ref !== "string" || (!DATASOURCE_REF_RE.test(ref) && !isLibrary)) {
      findings.push({
        error: `data source ref '${ref}' must be a registry server name, an internal-library logical name, or a knowledge collection (library:<id>) — no endpoints, no credentials`,
        entry: `${entry}.ref`,
        code: "datasource_ref_invalid",
      });
      return;
    }
    // Resolution: when the caller can check the collection, a dangling or
    // invisible id is refused BY NAME (spec: 悬空引用指名拒绝).
    if (isLibrary && typeof resolveLibrary === "function") {
      const id = ref.slice("library:".length);
      const verdict = resolveLibrary(id);
      if (verdict !== true) {
        findings.push({
          error: `data source ${entry}.ref 'library:${id}' does not name a collection you can see${typeof verdict === "string" ? ` (${verdict})` : ""}`,
          entry: `${entry}.ref`,
          code: "datasource_library_unresolved",
        });
      }
    }
    if (src.note !== undefined && typeof src.note !== "string") {
      findings.push({ error: `data source note must be a string when present`, entry: `${entry}.note`, code: "datasource_note_invalid" });
    }
  });
  return findings;
}

export function shapeFindings(content) {
  return [...credentialFindings(content), ...dataSourceFindings(content)];
}

// ── Shape gate: knowledge profile（add-member-knowledge-profile） ──────────
//
// content.knowledge 是成员知识画像的蓝图默认段（memory 面 + 钉死的集合）。
// 形状与错误码全在 server/knowledge-profile.js 的 normalizeKnowledgeProfile
// （同一函数也被部署级覆盖合并与运行时装配消费——三处对「什么合法」必须
// 零分歧，所以这里不复制规则，只做映射）。
//
// 缺席/null 合法（缺省即默认），照 dataSources 的先例不产生任何 finding。
// resolveCollection 与 dataSourceFindings 的 resolveLibrary 同源：validate
// 主入口从同一个 DB 侧回调取「可见/为何不可见/悬空」判决；回调缺席时只验
// 形状（纯形状校验不得猜 DB 事实）。
export function knowledgeFindings(content, resolveCollection = null) {
  const raw = content?.knowledge;
  if (raw === undefined || raw === null) return [];
  const res = normalizeKnowledgeProfile(raw, { resolveCollection });
  if (res.ok) return [];
  return res.errors.map((e) => ({
    error: e.message,
    entry: e.path ? `knowledge.${e.path}` : "knowledge",
    code: e.code,
  }));
}

// 判定模型在册校验（add-blueprint-judge-model-choice D3）：错配置要在校验面就暴露，
// 不放试跑到「装台+点火+一轮」之后才说模型不存在。名册读不到时降级为不校验
// （存储问题不该让所有蓝图无法批准）。
export function judgeModelFindings(content) {
  const wanted = content?.judgeModel;
  if (typeof wanted !== "string" || !wanted.trim()) return [];
  // 名册来源（2026-10-29 生产实证）：cell 进程有自己的 PLATFORM_DATA_DIR，
  // 其 llm-providers.json 常为空（模型配置在网关/部署侧）→ 只读 cell 名册会把
  // 「不在册」误判成「在册」。补两个来源：部署 env 的 BLUEPRINT_JUDGE_MODEL 与
  // default 指针。三者全不可知才降级为不校验（存储问题不该阻塞全部批准）。
  const known = new Set();
  try {
    for (const m of buildUserProviderEntries().models ?? []) {
      known.add(m.id);
      if (m.name) known.add(m.name);
    }
  } catch {
    // ignore — 走下面的补充来源
  }
  try {
    const d = getDefault();
    if (d?.modelId) known.add(d.modelId);
  } catch {
    // ignore
  }
  const deployed = (process.env.BLUEPRINT_JUDGE_MODEL || "").trim();
  if (deployed) known.add(deployed);
  if (known.size === 0) return [];
  if (known.has(wanted)) return [];
  return [
    {
      error: `judgeModel '${wanted}' is not in this deployment's model roster — pick one on the model settings page, or clear the field to follow the deployment default`,
      entry: "judgeModel",
      code: "judge_model_unknown",
    },
  ];
}

// ── Shape gate: v1 方言如实拒绝（remove-blueprint-v1-compat, design D1/D2） ──
//
// 平台只接受蓝图格式 v2。收到 v1 方言——出现 v1 独有键（vertical / sources /
// boards）而对应 v2 键（boundary / dataSources / board）缺位——时如实指名拒绝，
// 不归一化、不猜测。与「未知断言 kind 拒绝而非猜测」同族。
//
// 判别与 v2 键成对比较：一份合规的 v2 文档即便另带一个无害旧键也不触发（对应
// v2 键在场）。命中即返回唯一一条根因错误；调用方（validateBlueprint / 存储层）
// 须短路或硬拒，不得再叠加方言错位派生的散错。
const V1_FORMAT_ERROR = [
  // 开发者：v2 格式全文真源 = fleet-packs 仓（GitHub FindDataTechnology/fleet-packs，
  // 2026-10-30 起入版本控制）blueprints/schema.md v2；此处用户可见文案只列字段闭集，不带内部路径。
  "蓝图格式为 v1（vertical/sources/boards + 自由文本 acceptance），本平台只接受 v2。",
  "v2 字段：boundary{name, oneLine, outOfScope} / dataSources[{ref, note?}] / board[] / acceptance[{id, kind, target?, expect?, rubric?}]。",
  "迁移：把 vertical{name,tagline,non_goals[]} 换成 boundary{name, oneLine, outOfScope}、sources[].registryName 换成 dataSources[].ref、boards 换 board、自由文本断言换成五型结构化条目。",
].join("\n");

export function v1FormatFindings(content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) return [];
  const has = (k) => Object.hasOwn(content, k) && content[k] !== undefined;
  const v1Shaped =
    (has("vertical") && !has("boundary")) ||
    (has("sources") && !has("dataSources")) ||
    (has("boards") && !has("board"));
  if (!v1Shaped) return [];
  return [{ error: V1_FORMAT_ERROR, entry: "content", code: "v1_format" }];
}

// ── Manifest 组装与全链校验 ────────────────────────────────────────────────

export const MACHINE_ASSERTION_KINDS = ["post-materialized", "first-round-fired", "report-landed", "escalate-bounded"];
// llm-judged（add-blueprint-llm-assertions）：自由文本 rubric 交 judge 车道三态判定
// （pass/fail/insufficient-evidence），判绿还须 owner 签报告——双钥匙，见 design D1。
export const TRIAL_ASSERTION_KINDS = [...MACHINE_ASSERTION_KINDS, "llm-judged"];

// 成本闸（design D6）：超限如实拒，不静默截断。
export const JUDGE_ASSERTION_CAP = Number(process.env.BLUEPRINT_JUDGE_MAX || 8);

// 断言条目形状：{ id, kind, target?, expect? }。target = 岗位 title（缺省=全岗）。
export function normalizeAcceptance(acceptance) {
  const list = Array.isArray(acceptance) ? acceptance : [];
  const assertions = [];
  const errors = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push({ error: `acceptance[${i}] must be an object of { id, kind, target?, expect? }`, entry: `acceptance[${i}]`, code: "acceptance_entry_invalid" });
      return;
    }
    const id = typeof item.id === "string" && item.id.trim() ? item.id : `a${i + 1}`;
    const kind = item.kind;
    if (!TRIAL_ASSERTION_KINDS.includes(kind)) {
      errors.push({ error: `acceptance[${i}] '${id}' declares unsupported assertion kind '${kind ?? "(none)"}' (supported: ${TRIAL_ASSERTION_KINDS.join(", ")})`, entry: `acceptance[${i}].kind`, code: "acceptance_kind_unsupported" });
    }
    if (item.target !== undefined && typeof item.target !== "string") {
      errors.push({ error: `acceptance[${i}] '${id}' target must be a post title when present`, entry: `acceptance[${i}].target`, code: "acceptance_target_invalid" });
    }
    if (kind === "escalate-bounded" && item.expect !== undefined && !Number.isFinite(item.expect)) {
      errors.push({ error: `acceptance[${i}] '${id}' expect must be a number for escalate-bounded`, entry: `acceptance[${i}].expect`, code: "acceptance_expect_invalid" });
    }
    // llm-judged：rubric 是判据原文，必须非空——空判据等于没判据。
    let rubric = null;
    if (kind === "llm-judged") {
      if (typeof item.rubric !== "string" || !item.rubric.trim()) {
        errors.push({
          error: `acceptance[${i}] '${id}' llm-judged needs a non-empty rubric (the acceptance text the judge reads)`,
          entry: `acceptance[${i}].rubric`,
          code: "acceptance_rubric_required",
        });
      } else {
        rubric = item.rubric.trim();
      }
    }
    assertions.push({ id, kind, target: item.target ?? null, expect: item.expect ?? null, ...(rubric ? { rubric } : {}) });
  });
  const judged = assertions.filter((a) => a.kind === "llm-judged");
  if (judged.length > JUDGE_ASSERTION_CAP) {
    errors.push({
      error: `this blueprint declares ${judged.length} llm-judged assertions, over the cap of ${JUDGE_ASSERTION_CAP} (each one is a model call) — merge or drop some`,
      entry: "acceptance",
      code: "acceptance_judge_cap",
    });
  }
  return { assertions, errors };
}

// 铸造时喂给既有校验器的 manifest：名字取场景中文主名（类型由「集群模板」
// 专辑位/徽章承载，名字不背类型——产品命名决议）；category 钉 "fleet"
// （代码键零改老律：专辑显示名是市场层的词，键不动）。
export function assembleManifest(content, { name } = {}) {
  // add-agent-builder-workspace 4.1: content.kind 显式两型（缺省 = team，存量
  // 记录零迁移）。agent 型是「岗位文档」：无 boundary/fleet/acceptance，名字
  // 与一句话描述在 content.name / content.description 顶层。
  const kind = content?.kind === "agent" ? "agent" : "team";
  const sceneName =
    name ??
    (kind === "agent" ? content?.name : undefined) ??
    content?.boundary?.name ??
    content?.fleet?.name ??
    content?.fleet?.nameKey ??
    "";
  const manifest = {
    name: sceneName,
    description: (kind === "agent" ? content?.description : content?.boundary?.oneLine) ?? "",
    category: kind === "agent" ? "agent" : "fleet",
  };
  if (Array.isArray(content?.tags)) manifest.tags = content.tags;
  if (content?.agents !== undefined) manifest.agents = content.agents;
  if (content?.mcpServers !== undefined) manifest.mcpServers = content.mcpServers;
  // 4.3: skills 进蓝图 content——清单段照搬（validatePackManifest 技能段同
  // 函数），铸造/发射产物不再静默丢技能桶（批 1 的假绿缺口就此闭合）。
  if (Array.isArray(content?.skills)) manifest.skills = content.skills;
  if (kind === "team" && content?.fleet !== undefined) manifest.fleet = content.fleet;
  return manifest;
}

// 提交前全套校验链（spec 要求三 + D3 consult）：shape → parseFleetTemplate
// → validatePackManifest → toolFace/toolClosure。返回按链序摊平的 errors
// （既有校验器原文逐字段）+ manifestPreview 供编辑面/铸造复用。
export function validateBlueprint(content, { resolveLibrary = null } = {}) {
  // 4.2: 校验链 kind 感知——agent 型跳过 parseFleetTemplate 段（无 fleet 可
  // 解）；凭据/数据源/清单/验收/判据段两 kind 全量照跑（缺席即空跑，出现即
  // 照检——不静默吞客户端误带的段）。
  const kind = content?.kind === "agent" ? "agent" : "team";
  const manifestPreview = assembleManifest(content);
  // v1 方言前置短路（design D1）：错方言的派生发现（逐条 acceptance 形状错、
  // 无字段归属的包级错）会淹没根因——命中即只报这一条。
  const v1 = v1FormatFindings(content);
  if (v1.length) {
    return {
      ok: false,
      errors: v1,
      findings: { v1, shape: [], knowledge: [], acceptance: [], fleet: [], manifest: [], toolFace: [], toolClosure: [] },
      manifestPreview,
    };
  }
  const shape = [...credentialFindings(content ?? {}), ...dataSourceFindings(content ?? {}, resolveLibrary)];
  // knowledge 画像段进校验链（add-member-knowledge-profile）：resolveCollection
  // 与 resolveLibrary 同源传递——两者判的都是 library:<id> 集合的可见性，共用
  // 调用方那一个 DB 回调；回调缺席时 knowledgeFindings 只做纯形状校验。
  const knowledge = knowledgeFindings(content ?? {}, resolveLibrary);
  // 验收断言段也进校验链：试跑只有五类可判绿的断言，未知 kind 在此就指名，
  // 不留到试跑才暴露。
  const acceptance = normalizeAcceptance(content?.acceptance).errors;
  const judgeModel = judgeModelFindings(content);
  const fleetParsed = kind === "team" ? parseFleetTemplate(manifestPreview) : { ok: true };
  const fleet = fleetParsed.ok ? [] : [{ error: fleetParsed.error, entry: "fleet", code: fleetParsed.code ?? deriveCode(fleetParsed.error) }];
  const manifest = validatePackManifest(manifestPreview);
  const toolFace = toolFaceErrors(manifestPreview);
  const toolClosure = toolClosureErrors(manifestPreview);
  // 5.1 收口：任何来源的 finding 都必须带稳定 code——publish-tool-gate 等
  // 未逐点补码的段在此兜底派生（原文逐字不动，code 附加）。
  const withCode = (list) => list.map((e) => (e && typeof e === "object" && !e.code ? { ...e, code: deriveCode(e.error) } : e));
  const errors = withCode([...shape, ...knowledge, ...judgeModel, ...acceptance, ...fleet, ...manifest, ...toolFace, ...toolClosure]);
  return {
    ok: errors.length === 0,
    errors,
    findings: { v1: [], shape: withCode(shape), knowledge: withCode(knowledge), judgeModel: withCode(judgeModel), acceptance: withCode(acceptance), fleet: withCode(fleet), manifest, toolFace: withCode(toolFace), toolClosure: withCode(toolClosure) },
    manifestPreview,
  };
}

// ── 归一化 diff（批准面渲染与批准凭据同源） ────────────────────────────────

const clip = (s) => {
  const text = typeof s === "string" ? s : JSON.stringify(s);
  return text && text.length > 80 ? `${text.slice(0, 77)}…` : text;
};
const countOf = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0);

export function diffBlueprint(prev, next) {
  const diff = [];
  const pushScalar = (field, a, b) => {
    if ((a ?? "") !== (b ?? "")) diff.push({ field, before: clip(a ?? ""), after: clip(b ?? "") });
  };
  const pushCount = (field, a, b) => {
    if (countOf(a) !== countOf(b)) diff.push({ field, before: countOf(a), after: countOf(b) });
  };

  pushScalar("boundary.name", prev?.boundary?.name, next?.boundary?.name);
  pushScalar("boundary.oneLine", prev?.boundary?.oneLine, next?.boundary?.oneLine);
  pushScalar("boundary.outOfScope", prev?.boundary?.outOfScope, next?.boundary?.outOfScope);
  pushCount("dataSources", prev?.dataSources, next?.dataSources);
  pushCount("fleet.members", prev?.fleet?.members, next?.fleet?.members);
  pushCount("fleet.orchestration.edges", prev?.fleet?.orchestration?.edges, next?.fleet?.orchestration?.edges);
  pushCount("agents", prev?.agents, next?.agents);
  pushCount("mcpServers", prev?.mcpServers, next?.mcpServers);
  pushCount("acceptance", prev?.acceptance, next?.acceptance);
  pushCount("monitoring", prev?.monitoring, next?.monitoring);
  if (Boolean(prev?.board) !== Boolean(next?.board)) {
    diff.push({ field: "board", before: Boolean(prev?.board), after: Boolean(next?.board) });
  }
  return diff;
}

// ── 铸造：依赖占位补齐 + _casting 追溯 ────────────────────────────────────
//
// 占位形态（finddata fleet-packs 契约）：
//   {{PACK_ID:<name>}}  依赖包引用（纪律 pack 等）——铸造时按名字经市场解析
//                       落实 packId；解析不出 = 依赖漂移，铸造拒（design D4）。
//   {{PACK_ID}} / {{PACK_ID:self}}  包自引用——续铸（已知 cast_pack_id）回补
//                       自身谱系；首铸保持占位（paas 装台链按 presetId 物化，
//                       从不消费 target.packId——fleet-provisioner.js 实证，
//                       占位在发布后呈惰性）。

const PACK_REF_RE = /\{\{PACK_ID:([^}]+)\}\}/g;
export const SELF_REF_RE = /\{\{PACK_ID(?::self)?\}\}/g;

export function collectPackRefs(content) {
  const refs = new Set();
  const text = JSON.stringify(content ?? {});
  for (const match of text.matchAll(PACK_REF_RE)) {
    const name = match[1]?.trim();
    if (name && name !== "self") refs.add(name);
  }
  return [...refs];
}

export function buildCastManifest({ content, resolved = {}, selfPackId = null, casting }) {
  const assembled = assembleManifest(content);
  let text = JSON.stringify(assembled);
  const missing = [];
  text = text.replace(PACK_REF_RE, (whole, raw) => {
    const name = raw.trim();
    if (name === "self") return whole; // 自引用走 SELF_REF_RE 通道
    const hit = resolved[name];
    if (!hit?.packId) {
      missing.push(name);
      return whole;
    }
    return hit.packId;
  });
  let selfPending = false;
  text = text.replace(SELF_REF_RE, (whole) => {
    if (selfPackId) return selfPackId;
    selfPending = true;
    return whole;
  });
  const manifest = JSON.parse(text);
  manifest._casting = {
    source: "fleet-blueprint-studio",
    blueprintId: casting.blueprintId,
    version: casting.version,
    approvedBy: casting.approvedBy,
    approvedAt: casting.approvedAt,
    diffSummary: casting.diffSummary ?? null,
  };
  // 试跑报告随铸造追溯走（可售闸只读 manifest，不跨服务查）：只带判绿所需的
  // 三件——green / 模型判决 / 签字，不塞全量证据（体积与泄密面）。
  if (casting.trialReport) {
    const r = casting.trialReport;
    manifest._casting.trialReport = {
      green: r.green === true,
      ranAt: r.ranAt ?? null,
      ...(Array.isArray(r.judged) && r.judged.length ? { judged: r.judged.map((j) => ({ id: j.id, verdict: j.verdict, pass: j.pass })) } : {}),
      ...(r.signoff ? { signoff: r.signoff } : {}),
    };
  }
  return { manifest, missing, selfPending };
}
