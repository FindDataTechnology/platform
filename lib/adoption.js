// lib/adoption.js — 官方精选转正管线（add-official-adopted-agents 2.3 / 2.4 / 2.5）
//
// 一条链，从「货架条目」到「可直接发布的官方 Agent manifest 草稿」：
//
//   取包(fetchPackage) → 采许可证据(collectUpstreamLicenseEvidence)
//     → 许可门(assertLicenseAdmissible)         ← 不过就整条失败，零副作用
//     → 钉定上游 revision(resolvePinnedRevision)
//     → 组装 manifest(技能内联 + persona + serving.toolFace=chat + provenance)
//     → 自检(validatePackManifest)              ← 用发布门同一套规则
//
// 三条不可让步的设计约束（对应 spec）：
//
//   1. **不引用货架**：技能正文与辅助文件整棵内联进 manifest，运行期不回源。
//      上游 404 时转正资产仍完整可用（D2）。provenance.revision 只是审计锚点。
//   2. **工具面默认收窄**：产物声明 serving.toolFace = "chat"，无 shell/文件/
//      浏览器/子代理触手。第三方正文是不可信文本，先关在「只能说」的范围里（D4）。
//   3. **不自带官方身份**：manifest.provenance 只是来源标注。official 仍由部署
//      roster 决定（gateway/packs.js），本模块永远不写任何「我是官方」字段（D1）。
//
// 本模块不落库、不发布：它产出一份 manifest 草稿与一份转换报告，发布仍走既有
// publish 通道（所以 roster、定价门、审核门一条都不绕过）。

import { assertLicenseAdmissible, evaluateLicense } from "./license-gate.js";
import { collectUpstreamLicenseEvidence } from "./upstream-license.js";
import { parseGitTreeUrl, outboundFetch } from "../external-sources.js";
import { validatePackManifest } from "./pack-manifest.js";
import { sanitizeFrontmatter } from "../external-install.js";
import { safePackagePath } from "./skill-files.js";

// 转正产出的接待角色 id。固定值，便于运营与 UI 一致引用。
export const ADOPTED_AGENT_ID = "curator";

// 货架归一化 Entry 的标识字段是 `id`（normalizeEntry 把上游 slug 映射到 id），
// 不是 `slug`。转正管线内部一律用 entrySlug() 取值，兼容 id/slug/name 三种来源。
function entrySlug(entry) {
  const v = entry?.slug ?? entry?.id ?? entry?.name ?? null;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// 名字归一化到 dsh 技能文法（与 external-install 同一目标文法）。
function slugifySkillName(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// 包内文件 → manifest 的 skills[].files。
// 两道门与发布校验器同源：SKILL.md 必须剔除（渲染时由 content 生成，留着会被
// 校验器判冲突）；路径必须过 safePackagePath（逃逸即弃）。
function inlinableFiles(files) {
  const out = {};
  if (!files || typeof files !== "object") return out;
  for (const [rawPath, text] of Object.entries(files)) {
    const safe = safePackagePath(rawPath);
    if (!safe || typeof text !== "string") continue;
    const base = safe.split("/").pop() || safe;
    if (/^SKILL\.md$/i.test(base)) continue; // generated from content
    out[safe] = text;
  }
  return out;
}

// 版本号：转正首发一律 1.0.0；上游变更走 vN+1（D6），由发布通道递增。
const INITIAL_VERSION = 1;

/**
 * 探测技能是否**需要执行能力**（shell / 二进制 / CLI）。
 *
 * 为什么必须有这一步（2026-10-31 真机发现，首个真实候选 nano-pdf 实证）：默认
 * toolFace=chat 会裁掉全部触手，而大量热门技能靠 CLI 干活——nano-pdf 正文第一行
 * 就是 `nano-pdf edit deck.pdf 1 "..."`。不探测就会静默产出「能说不能做」的残废
 * Agent：对话里叫用户跑命令，它自己却没 shell。
 *
 * 强信号：frontmatter 声明 required bins（agentskills/openclaw 的 requires.bins 惯例）
 *         → 直接判定需要执行能力。
 * 弱信号：正文出现 shell 代码块或反引号命令 → 只作提示，不强拒（有些技能只是举例）。
 *
 * @returns {{requiresExecution: boolean, bins: string[], shellHints: boolean}}
 */
export function detectCapabilityNeeds(pack) {
  const fm = pack?.frontmatter && typeof pack.frontmatter === "object" ? pack.frontmatter : {};
  const bins = new Set();
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    const req = node.requires;
    if (req && typeof req === "object" && Array.isArray(req.bins)) {
      for (const b of req.bins) if (typeof b === "string" && b.trim()) bins.add(b.trim());
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") visit(v, depth + 1);
  };
  visit(fm);

  const body = String(pack?.body ?? "");
  const shellHints = /```(?:bash|sh|shell|zsh|console)\b|`[A-Za-z][A-Za-z0-9._-]*\s+[A-Za-z-]/.test(body);

  return { requiresExecution: bins.size > 0, bins: [...bins], shellHints };
}

/**
 * 解析上游钉定 revision：把分支/标签 ref 解析成 commit sha。
 *
 * 拿不到 sha 时**不抛**，退回落到的 ref 名字并在报告里标记 `revisionKind`。
 * 理由：revision 是审计锚点，不是可用性依赖（内容已内联）；但必须如实告诉
 * 运营「这条钉的是分支还是提交」，不能假装钉住了。
 */
export async function resolvePinnedRevision(entry, { fetchImpl = outboundFetch } = {}) {
  const originUrl = entry?.originUrl ?? null;
  const parsed = originUrl ? parseGitTreeUrl(originUrl) : null;
  if (!parsed) return { revision: null, revisionKind: "none", repo: null };
  const { owner, repo, ref, subPath } = parsed;
  const repoLabel = `${owner}/${repo}`;
  // 已经是 40 位 sha（或 7-39 位短 sha）就直接用，省一次请求。
  if (/^[0-9a-f]{7,40}$/i.test(ref)) {
    return { revision: ref, revisionKind: "commit", repo: repoLabel, subPath };
  }
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
    if (res.ok) {
      const doc = await res.json();
      const sha = typeof doc?.sha === "string" ? doc.sha : null;
      if (sha) return { revision: sha, revisionKind: "commit", repo: repoLabel, subPath };
    }
  } catch {
    // 网络/限额失败 → 落到下面的 ref 回落，不中断转正
  }
  return { revision: ref || null, revisionKind: "ref", repo: repoLabel, subPath };
}

// 由技能正文与描述起草一个最小 persona。**这是草稿**：运营须定稿后再发布。
// 起草纪律对齐 facade-builder：只答技能覆盖的、覆盖不到就如实说、不编造。
function draftPersona({ displayName, skillDescriptions }) {
  const coverage = skillDescriptions.filter(Boolean).map((d) => `- ${d}`).join("\n") || "- （待补充）";
  return [
    `你是「${displayName}」——把这个技能的能力直接交付给用户的助手。`,
    "",
    "你的工作方式与边界由本包内联的技能定义：",
    coverage,
    "",
    "纪律：",
    "- 只按技能里写明的流程与方法作答；技能没覆盖的问题，如实说「这个不在我的能力范围内」，不要编造。",
    "- 不承诺技能之外的能力，不替用户对外许诺价格、合同或交付日期。",
    "- 引用技能里的步骤时给出可执行的下一步，而不是复述概念。",
  ].join("\n");
}

/**
 * 组装转正 manifest（纯函数，便于测试）。
 *
 * @param {{pack: object, entry: object, license: object, pin: object, operator: string, reviewer: string, now?: string, displayName?: string, widenFullToolFace?: boolean}} args
 * @returns {{manifest: object, report: object}}
 */
export function buildAdoptedManifest({ pack, entry, license, pin, operator, reviewer, now, displayName, widenFullToolFace = false }) {
  const upstreamName = entry?.name ?? entry?.displayName ?? "adopted-skill";
  const name = displayName || entry?.displayName || entry?.name || upstreamName;
  const skillName = slugifySkillName(upstreamName) || "adopted-skill";

  const auxFiles = inlinableFiles(pack?.files);
  // sanitizeFrontmatter 返回 null 表示"清洗后什么都不剩"（最常见的形态：上游
  // frontmatter 只有 name + description，两个键都被行owns）。这里必须落成 {}：
  // 早年直接 Object.keys(null) 会把这种技能整体崩掉（2026-11-03 实测 skill-creator
  // 第一条就 TypeError），而不是产出一个没有 frontmatter 的合法包。
  const frontmatter = sanitizeFrontmatter(pack?.frontmatter) ?? {};
  const needs = detectCapabilityNeeds(pack);
  // 需要执行能力时，chat 面会让产物「能说不能做」：正文教用户跑命令，Agent 自己
  // 没有 shell。此时必须由审校者显式选择放宽（widenFullToolFace: true），否则
  // adoptExternalSkill 会在自检前就拒绝。
  const toolFace = needs.requiresExecution && widenFullToolFace ? undefined : "chat";

  const skills = [
    {
      name: skillName,
      description: String(pack?.frontmatter?.description || entry?.description || name).slice(0, 300),
      content: pack.body,
      // 辅助文件整棵内联（有才带，空不带）——与 preset-pack-bridge 的既有形状一致。
      ...(Object.keys(auxFiles).length > 0 ? { files: auxFiles } : {}),
      ...(Object.keys(frontmatter).length > 0 ? { frontmatter } : {}),
    },
  ];

  const manifest = {
    name,
    description: String(entry?.description || pack?.frontmatter?.description || name).slice(0, 2000),
    tags: Array.isArray(entry?.tags) ? entry.tags.filter((t) => typeof t === "string").slice(0, 10) : [],
    visibility: "public",
    version: INITIAL_VERSION,
    skills,
    agents: [
      {
        id: ADOPTED_AGENT_ID,
        name,
        description: `由「${upstreamName}」转正的官方助手`,
        persona: draftPersona({ displayName: name, skillDescriptions: skills.map((s) => s.description) }),
        serving: {
          // toolFace 只能挂在 serving 上；chat = 无 shell/文件/浏览器/子代理触手。
          // 需要执行能力的技能在审校者显式放宽时**不声明** toolFace（= 全工具面），
          // 因为 SERVING_TOOL_FACES 目前只有 "chat" 一个收窄档位。
          protocol: "a2a",
          ...(toolFace ? { toolFace } : {}),
          card: {
            name,
            description: String(entry?.description || name).slice(0, 300),
            // 校验器要求 1-3 条示例（serving.card.examples）。转正产物没有人为
            // 撰写的试问，用一个由技能名生成的最小示例占位；运营可在定稿时替换。
            examples: [`用「${name}」帮我处理一个任务`].map((s) => s.slice(0, 200)),
          },
        },
      },
    ],
    provenance: {
      kind: "official-adopted",
      upstreamUrl: String(entry?.originUrl || ""),
      upstreamName: String(upstreamName).slice(0, 200),
      license: license.governing,
      revision: pin.revision,
      adoptedBy: operator,
      reviewedBy: reviewer,
      reviewedAt: now || new Date().toISOString(),
    },
    notes: [
      `转正自 ${entry?.source ?? "external"}/${entrySlug(entry) ?? upstreamName}`,
      `钉定 ${pin.revisionKind === "commit" ? "提交" : "引用"} ${pin.revision}`,
      toolFace === "chat"
        ? "工具面 chat（无 shell/文件/浏览器/子代理）。"
        : "工具面已由审校者放宽为全工具面（需要执行能力）。",
    ].join("；"),
  };

  const report = {
    upstreamName,
    source: entry?.source ?? null,
    slug: entrySlug(entry),
    originUrl: entry?.originUrl ?? null,
    repo: pin.repo,
    revision: pin.revision,
    revisionKind: pin.revisionKind,
    license: license.governing,
    licenseObserved: license.observed,
    licenseNotes: license.notes,
    toolFace: toolFace ?? "full",
    capabilityNeeds: needs,
    inlinedSkillFiles: Object.keys(pack?.files ?? {}),
    // 明确告知运营这是草稿：persona 需要人看一遍。
    personaDrafted: true,
    mustReview: [
      "persona 是否贴合上游技能的职责边界",
      "技能正文是否需要删改平台内部信息",
      ...(needs.requiresExecution ? [`该技能依赖外部命令 ${needs.bins.join("/")}；已按审校者授权放宽工具面，务必复核`] : []),
      ...(needs.shellHints && !needs.requiresExecution ? ["正文疑似含命令示例（未声明 required bins）；确认 chat 面是否足够"] : []),
    ],
  };

  return { manifest, report };
}

/**
 * 完整转正：取包 → 许可 → 钉定 → 组装 → 自检。
 *
 * 任一步失败即抛，且**零副作用**（本模块不写库、不发布）。错误对象带
 * `code`，便于端点层映射：license-rejected / upstream-not-found / manifest-invalid。
 *
 * @param {{source: string, slug: string, registry: object, operator: string, reviewer: string,
 *          fetchImpl?: Function, now?: string, displayName?: string, widenFullToolFace?: boolean}} args
 */
export async function adoptExternalSkill({
  source,
  slug,
  registry,
  operator,
  reviewer,
  fetchImpl = outboundFetch,
  now,
  displayName,
  widenFullToolFace = false,
} = {}) {
  if (!operator || !reviewer) {
    throw Object.assign(new Error("adoption requires an operator and a reviewer (attributability)"), {
      code: "adoption-unattributed",
      status: 400,
    });
  }

  // 1. 取包（复用既有链路，不新增适配器）
  const pack = await registry.fetchPackage(source, slug);
  if (!pack) {
    throw Object.assign(new Error(`Unknown or disabled source: ${source}`), { code: "unknown-source", status: 404 });
  }
  const entry = await registry.getEntry(source, slug).then((r) => r?.entry ?? null).catch(() => null);
  if (!entry) {
    throw Object.assign(new Error(`External entry not found: ${source}/${slug}`), { code: "upstream-not-found", status: 502 });
  }

  // 2. 许可证据 + 门（货架 licenseState 不参与判定）
  const evidence = await collectUpstreamLicenseEvidence({ source, slug, entry, pack }, { fetchImpl });
  const license = assertLicenseAdmissible(evidence);

  // 3. 钉定 revision
  const pin = await resolvePinnedRevision(entry, { fetchImpl });
  if (!pin.revision) {
    throw Object.assign(
      new Error("adoption requires a pinnable upstream revision (no commit/ref resolvable from the origin URL)"),
      { code: "unpinnable-upstream", status: 422, licenseState: license.state },
    );
  }

  // 3.5 能力探测：需要执行能力却只给 chat 面 = 静默产出残废 Agent（真机实证：
  // nano-pdf 依赖 CLI，chat 面下它叫用户跑命令却没有 shell）。此时必须由审校者
  // 显式放宽；否则拒绝，而不是产出一个看起来正常的坏包。
  const needs = detectCapabilityNeeds(pack);
  if (needs.requiresExecution && !widenFullToolFace) {
    throw Object.assign(
      new Error(
        `adoption refused: the skill requires external commands (${needs.bins.join(", ")}) but the default chat tool face cannot run them; pass widenFullToolFace with a reviewer's justification`,
      ),
      { code: "toolface-insufficient", status: 422, bins: needs.bins },
    );
  }

  // 4. 组装
  const { manifest, report } = buildAdoptedManifest({
    pack,
    entry,
    license,
    pin,
    operator,
    reviewer,
    now,
    displayName,
    widenFullToolFace,
  });

  // 5. 用发布门同一套规则自检——转正产物必须是个合法包
  const errors = validatePackManifest(manifest);
  if (errors.length > 0) {
    throw Object.assign(new Error(`adopted manifest failed validation: ${errors[0].error}`), {
      code: "manifest-invalid",
      status: 422,
      errors,
    });
  }

  return { manifest, report, evidence: { count: evidence.length, license } };
}

// 供端点做「先预览不转正」：只评估许可与可钉定性，不组装产物。
export async function previewAdoption({ source, slug, registry, fetchImpl = outboundFetch } = {}) {
  const pack = await registry.fetchPackage(source, slug);
  if (!pack) {
    throw Object.assign(new Error(`Unknown or disabled source: ${source}`), { code: "unknown-source", status: 404 });
  }
  const entry = await registry.getEntry(source, slug).then((r) => r?.entry ?? null).catch(() => null);
  if (!entry) {
    throw Object.assign(new Error(`External entry not found: ${source}/${slug}`), { code: "upstream-not-found", status: 502 });
  }
  const evidence = await collectUpstreamLicenseEvidence({ source, slug, entry, pack }, { fetchImpl });
  const license = evaluateLicense(evidence);
  const pin = await resolvePinnedRevision(entry, { fetchImpl });
  const needs = detectCapabilityNeeds(pack);
  return {
    entry: { source, slug, name: entry.name, displayName: entry.displayName, originUrl: entry.originUrl },
    license,
    evidence: evidence.map((e) => e.source),
    pinnable: Boolean(pin.revision),
    revision: pin.revision,
    revisionKind: pin.revisionKind,
    inlinedFiles: Object.keys(pack.files ?? {}).length,
    bodyChars: String(pack.body ?? "").length,
    hasScripts: Array.isArray(pack.inventory) && pack.inventory.some((f) => f.script && f.action === "stored"),
    // 转正前就告诉运营：这个技能需要执行能力，默认 chat 面装不下它。
    capabilityNeeds: needs,
    // 一句话裁决建议，省得运营自己拼。
    verdict: adoptionVerdict({ license, pin, needs }),
  };
}

// 预览的一句话裁决：能不能转正、卡在哪。
export function adoptionVerdict({ license, pin, needs }) {
  if (license.state === "rejected") return `拒绝：许可 ${license.axis} 不可再分发`;
  if (license.state === "not-declared") return "拒绝：上游未声明许可";
  if (!pin.revision) return "拒绝：上游不可钉定（origin 不是可解析的仓库树）";
  if (needs.requiresExecution) return `需审校者放宽工具面：技能依赖外部命令 ${needs.bins.join("/")}`;
  return "可转正（chat 面，草稿待审校）";
}
