// lib/license-gate.js — 转正许可门（add-official-adopted-agents D3 / task 1.3）
//
// 为什么要单独一个模块：货架的 licenseState 恒为 "unknown"（SkillHub API 无
// 许可字段、Smithery 许可在上游仓库），所以许可判定**不能**读货架字段，必须
// 从上游证据（LICENSE 文件原文 / package.json 的 license 字段 / 仓库元数据的
// spdx id）分类。
//
// 实测坑（2026-10-31 spike）：GitHub 仓库元数据对 modelcontextprotocol/servers
// 返回 license.spdx_id = "NOASSERTION"、name = "Other"，而其 LICENSE 原文明确是
// MIT → Apache-2.0 的过渡双许可。→ 元数据字段不可作为唯一依据，原文优先。
//
// 三态输出与 ecosystem-curation / external-skill-sources 的既有语汇对齐：
//   admitted / rejected / not-declared

// 允许再分发 + 商业托管的宽松许可（按 SPDX id）。匹配用大小写无关子串，
// 因为上游原文里写法极多（"Apache License, Version 2.0" / "Apache-2.0" …）。
const PERMISSIVE = [
  { id: "MIT", re: /\bMIT\b(?!\s*(?:No|Non))/i, mustAlsoMiss: null },
  { id: "Apache-2.0", re: /Apache(?: License)?[,]?\s*(?:Version\s*)?2\.0/i },
  { id: "BSD-2-Clause", re: /BSD\s*2-?Clause|Simplified BSD/i },
  { id: "BSD-3-Clause", re: /BSD\s*3-?Clause|New BSD|Modified BSD/i },
  { id: "ISC", re: /\bISC License\b/i },
];

// 明确拒绝的许可（copyleft 强感染 / 非商用 / 源码可得但禁商用）。命中即拒，
// 但若同时命中宽松许可，按 spec「多许可取最宽松」处理并在 notes 里留痕。
const FORBIDDEN = [
  { id: "AGPL", re: /GNU Affero General Public License|AGPL/i, axis: "copyleft-network" },
  { id: "GPL", re: /GNU General Public License|\bGPLv?[23]?\b/i, axis: "copyleft" },
  { id: "LGPL", re: /GNU Lesser General Public License|LGPL/i, axis: "copyleft-weak" },
  { id: "SSPL", re: /Server Side Public License|SSPL/i, axis: "non-open" },
  { id: "BUSL", re: /Business Source License|BUSL/i, axis: "non-open" },
  { id: "CC-BY-NC", re: /CC[- ]BY[- ]NC|NonCommercial|non-commercial/i, axis: "non-commercial" },
];

// 专有 / 保留所有权利。这不是第三种 copyleft，而是「声明了、但声明的是不给」。
// 2026-11-03 实测动机：anthropics/skills 的 pdf/docx/pptx/xlsx 四个技能 LICENSE.txt
// 通篇是 "© … All rights reserved." + "may not distribute / create derivative works"，
// 一个已知许可 id 都不命中 —— 旧实现把它归进 not-declared，于是拒绝理由写成
// 「上游未声明许可」，与事实相反（规范要求点名的轴必须是真的那个）。
//
// 只在**既无宽松也无已知禁止**时生效：很多宽松许可的样板文字里也带
// "All rights reserved"（MIT 变体常见），宽松优先的既有裁决不能被打翻。
const PROPRIETARY = [
  /(?:^|[^a-z])(?:proprietary|all rights reserved)(?:[^a-z]|$)/i,
  /\b(?:may|must|shall)\s+not\b[^.]{0,240}\b(?:distribut|sublicens|create derivative|reproduc|transfer)/i,
];

/**
 * 从一段文本里识别命中的许可 id（宽松与拒绝分开返回）。
 * 纯函数，无 IO，便于单测。
 */
export function scanLicenseText(text) {
  const s = typeof text === "string" ? text : "";
  const permissive = PERMISSIVE.filter((p) => p.re.test(s)).map((p) => p.id);
  const forbidden = FORBIDDEN.filter((f) => f.re.test(s)).map((f) => ({ id: f.id, axis: f.axis }));
  const proprietary = PROPRIETARY.some((re) => re.test(s));
  return { permissive, forbidden, proprietary };
}

/**
 * 评估一组上游许可证据。
 *
 * evidences: [{ source, text, tier?: "primary"|"declared" }]
 *
 * **分层裁决（核心）**：许可文件（LICENSE / COPYING）是**授权凭证**，作者在
 * frontmatter / package.json / 仓库元数据里的 license 字段只是**自述**。两者冲突
 * 时以凭证为准——否则一个 SKILL.md 里写 `license: MIT` 就能把 AGPL 仓库洗白。
 *   - 有 primary 证据 → 只看 primary，declared 仅入 observed 供审计。
 *   - 无 primary 证据 → 用 declared（退而求其次，并在 notes 里点明「仅作者自述」）。
 *
 * 返回 { state: "admitted"|"rejected"|"not-declared", governing, observed, axis, notes, decidedBy }
 */
export function evaluateLicense(evidences) {
  const list = Array.isArray(evidences) ? evidences : [];
  const observed = [];
  const primary = { permissive: [], forbidden: [], proprietary: false };
  const declared = { permissive: [], forbidden: [], proprietary: false };

  for (const ev of list) {
    if (!ev || typeof ev.text !== "string" || !ev.text.trim()) continue;
    const { permissive, forbidden, proprietary } = scanLicenseText(ev.text);
    if (!permissive.length && !forbidden.length && !proprietary) continue;
    const tier = ev.tier === "declared" ? "declared" : "primary";
    observed.push({
      source: ev.source || "unknown",
      tier,
      permissive,
      forbidden: forbidden.map((f) => f.id),
      ...(proprietary ? { proprietary: true } : {}),
    });
    const bucket = tier === "primary" ? primary : declared;
    for (const id of permissive) if (!bucket.permissive.includes(id)) bucket.permissive.push(id);
    for (const f of forbidden) if (!bucket.forbidden.some((x) => x.id === f.id)) bucket.forbidden.push(f);
    if (proprietary) bucket.proprietary = true;
  }

  const hasPrimary = primary.permissive.length > 0 || primary.forbidden.length > 0 || primary.proprietary;
  const decidedBy = hasPrimary ? "primary" : "declared";
  const { permissive: perm, forbidden: forb } = hasPrimary ? primary : declared;
  const proprietaryOnly = (hasPrimary ? primary : declared).proprietary;
  const notes = [];
  if (!hasPrimary && declared.permissive.length + declared.forbidden.length > 0) {
    notes.push("declared-only: no LICENSE file upstream; deciding on the author's own declaration — reviewer should confirm");
  }

  if (perm.length > 0) {
    if (forb.length > 0) {
      notes.push(
        `mixed-license: permissive ${perm.join("/")} coexists with ${forb.map((f) => f.id).join("/")} in the same evidence tier; admitted on the most permissive, reviewer must confirm the permissive license actually covers the redistributed code`,
      );
    }
    const ignoredDeclared = hasPrimary && (declared.permissive.length || declared.forbidden.length);
    if (ignoredDeclared) {
      notes.push(
        `declared-license ignored: author declaration (${[...declared.permissive, ...declared.forbidden.map((f) => f.id)].join("/")}) conflicts with the LICENSE file and does not override it`,
      );
    }
    return { state: "admitted", governing: perm[0], observed, axis: null, notes, decidedBy };
  }
  if (forb.length > 0) {
    return { state: "rejected", governing: null, observed, axis: forb[0].axis, notes, decidedBy };
  }
  // 声明了专有/保留所有权利：这是"声明了不给"，不是"没声明"。
  if (proprietaryOnly) {
    notes.push(
      "proprietary: the upstream license states the material is proprietary / all rights reserved (or forbids redistribution, sublicensing or derivative works); it is declared, and what it declares is non-redistributable",
    );
    return { state: "rejected", governing: null, observed, axis: "proprietary", notes, decidedBy };
  }
  return { state: "not-declared", governing: null, observed, axis: "license-absent", notes, decidedBy };
}

/**
 * 门禁版本：不合格即抛（带 code/axis，供调用方转 422/409），合格返回评估结果。
 * 与其它校验器一致，抛 Error 并挂结构化字段，便于端点层映射成 HTTP 文案。
 */
export function assertLicenseAdmissible(evidences) {
  const result = evaluateLicense(evidences);
  if (result.state === "admitted") return result;
  const err = new Error(
    result.state === "not-declared"
      ? "adoption rejected: no license declared upstream (cannot verify redistribution rights)"
      : `adoption rejected: license axis '${result.axis}' excluded from redistribution`,
  );
  err.code = "license-rejected";
  err.axis = result.axis;
  err.licenseState = result.state;
  err.observed = result.observed;
  throw err;
}
