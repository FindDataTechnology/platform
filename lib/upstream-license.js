// lib/upstream-license.js — 采集上游许可证据（add-official-adopted-agents task 2.2）
//
// 为什么需要它：货架的 licenseState 恒为 "unknown"（SkillHub API 无许可字段、
// Smithery 许可在上游仓库）。转正许可门（lib/license-gate.js）的输入是**证据**，
// 本模块负责把证据从上游取回来：
//
//   1. 包内 LICENSE 文件（Smithery 逐文件取树时若已在 files 里，直接复用，零额外请求）
//   2. 仓库根 LICENSE*（GitHub contents API：实测可列出 LICENSE / LICENSE.md /
//      LICENSE.txt / COPYING；也覆盖目录中间符号链接的既有解析）
//   3. package.json 的 license 字段（元数据兜底）
//   4. 仓库元数据的 license（最弱——实测对 MCP 仓返回 NOASSERTION/Other，不可单独采信）
//
// 顺序即可信度顺序：原文 > 包清单 > 仓库元数据。全部取不到 → 返回空证据集，
// 许可门据此判 not-declared 并拒绝（fail-closed）。

import { outboundFetch, githubListDir, parseGitTreeUrl } from "../external-sources.js";

const MAX_EVIDENCE_CHARS = 200_000; // bound the text we hand to the scanner
const LICENSE_FILE_RE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

function clip(text) {
  const s = typeof text === "string" ? text : "";
  return s.length > MAX_EVIDENCE_CHARS ? s.slice(0, MAX_EVIDENCE_CHARS) : s;
}

// 从已解析的包里取许可证据：包内 LICENSE 文件优先，其次 frontmatter.license。
//
// tier 语义（见 lib/license-gate.js 的分层裁决）：
//   package:<path> 里的 LICENSE/COPYING 文件 → primary（授权凭证）
//   package:frontmatter 的 license 字段      → declared（作者自述，不覆盖凭证）
export function licenseEvidenceFromPackage(pack) {
  const out = [];
  const files = pack && typeof pack === "object" && pack.files && typeof pack.files === "object" ? pack.files : {};
  for (const [path, content] of Object.entries(files)) {
    const base = path.split("/").pop() || path;
    if (LICENSE_FILE_RE.test(base) && typeof content === "string" && content.trim()) {
      out.push({ source: `package:${path}`, text: clip(content), tier: "primary" });
    }
  }
  const fm = pack?.frontmatter;
  if (fm && typeof fm.license === "string" && fm.license.trim()) {
    out.push({ source: "package:frontmatter", text: clip(fm.license), tier: "declared" });
  }
  return out;
}

// 取仓库根目录的 LICENSE 文件原文（可跨一层子目录，因为有些仓把技能放在子目录
// 且许可在本仓根）。`subPath` 来自 parseGitTreeUrl（技能所在目录），因此先在技能
// 目录里找，再回落到仓库根。
async function fetchRepoLicenseTexts(owner, repo, ref, subPath, { fetchImpl = outboundFetch } = {}) {
  const out = [];
  const dirs = subPath ? [subPath, ""] : [""];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await githubListDir(owner, repo, ref, dir, { fetchImpl });
    } catch {
      continue; // 目录不存在/不可达 → 换下一个候选，不中断
    }
    const hit = entries.find((e) => e.type === "file" && LICENSE_FILE_RE.test(e.name));
    if (!hit) continue;
    try {
      const res = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(hit.path)}?ref=${encodeURIComponent(ref)}`,
        { headers: { Accept: "application/vnd.github.raw" } },
      );
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.trim()) out.push({ source: `repo:${hit.path}`, text: clip(text), tier: "primary" });
    } catch {
      // 单次下载失败不致命：证据集可以少一条，许可门会按缺失处理
    }
    break; // 该目录已命中，不再回落到上一层
  }
  return out;
}

// 取 package.json 的 license 字段（元数据兜底）。
async function fetchPackageJsonLicense(owner, repo, ref, subPath, { fetchImpl = outboundFetch } = {}) {
  const paths = subPath ? [`${subPath}/package.json`, "package.json"] : ["package.json"];
  for (const p of paths) {
    try {
      const res = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(p)}?ref=${encodeURIComponent(ref)}`,
        { headers: { Accept: "application/vnd.github.raw" } },
      );
      if (!res.ok) continue;
      const doc = JSON.parse(await res.text());
      const lic = doc?.license;
      if (typeof lic === "string" && lic.trim()) return [{ source: `package.json:${p}`, text: clip(lic), tier: "declared" }];
      if (Array.isArray(doc?.licenses)) {
        const joined = doc.licenses.map((l) => (typeof l === "string" ? l : l?.type)).filter(Boolean).join(" OR ");
        if (joined) return [{ source: `package.json:${p}`, text: clip(joined), tier: "declared" }];
      }
      return [];
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * 采集一个货架条目的上游许可证据。
 *
 * @param {{source: string, slug: string, entry?: object, pack?: object}} args
 *   entry 为货架归一化条目（originUrl 决定仓库位置）；pack 为已取回的包（可选）。
 * @returns {Promise<Array<{source: string, text: string}>>}
 *
 * 永不抛：任何一步失败都只是少一条证据。空数组 = 无法判定 = 许可门拒绝。
 */
export async function collectUpstreamLicenseEvidence({ entry, pack } = {}, { fetchImpl = outboundFetch } = {}) {
  const evidence = [];

  // 1. 包内（零额外请求，最直接）
  if (pack) evidence.push(...licenseEvidenceFromPackage(pack));

  // 2/3. 仓库级证据 —— 需要 originUrl 能解析成 github tree/blob
  const originUrl = entry?.originUrl ?? null;
  const parsed = originUrl ? parseGitTreeUrl(originUrl) : null;
  if (parsed) {
    const { owner, repo, ref, subPath } = parsed;
    evidence.push(...(await fetchRepoLicenseTexts(owner, repo, ref, subPath, { fetchImpl })));
    if (!evidence.some((e) => e.source.startsWith("repo:"))) {
      evidence.push(...(await fetchPackageJsonLicense(owner, repo, ref, subPath, { fetchImpl })));
    }
  }

  return evidence;
}
