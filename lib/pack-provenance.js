// lib/pack-provenance.js — 三轴来源投影（add-official-adopted-agents D1 / task 1.2）
//
// 三条轴各自有唯一真源，本模块**只合成、不重新推导**：
//   类型徽章   badge     ← lib/pack-badge.js deriveBadge(manifest)（结构轴）
//   官方性     official  ← 调用方传入的 roster 判定（gateway/packs.js，作者不可自报）
//   来源       source    ← manifest.provenance（来源轴，本 change 新增）
//
// 为什么必须单点合成：三轴分别落在三个文件，若平台面与 facet 面各自拼装
// 「官方精选·已审校」文案，必然漂移。spec 要求三态可辨且 adopted 不自带官方
// 身份——这条纪律只在合成处能守住。

import { deriveBadge } from "./pack-badge.js";

// 来源三态。ecosystem 只出现在外部货架（不是 pack），见 describeShelfProvenance。
export const PROVENANCE_SOURCE = {
  OFFICIAL_ORIGINAL: "official-original",
  OFFICIAL_ADOPTED: "official-adopted",
  COMMUNITY: "community",
  ECOSYSTEM_UNREVIEWED: "ecosystem-unreviewed",
};

/**
 * 合成一个 pack 的三轴来源描述。
 *
 * @param {object} manifest  pack manifest（可能带 provenance 块）
 * @param {{official?: boolean}} ctx  official 来自调用方的 roster 判定
 * @returns {{badge: string, official: boolean, source: string, adopted: object|null}}
 *
 * 关键不变式：adopted 只有在 **roster 已给 official** 且 **manifest 声明
 * provenance.kind==="official-adopted"** 时才成立。manifest 自报永远不能把
 * 一个非 roster 包顶成 official-adopted（spec 场景「adopted provenance 不给
 * 官方身份」）。类型徽章与来源轴完全独立。
 */
export function describeProvenance(manifest, ctx = {}) {
  const m = manifest && typeof manifest === "object" ? manifest : {};
  const official = ctx.official === true;
  const badge = deriveBadge(m);
  const p = m.provenance && typeof m.provenance === "object" ? m.provenance : null;
  const adopted = p && p.kind === "official-adopted" ? p : null;

  let source;
  if (adopted && official) {
    source = PROVENANCE_SOURCE.OFFICIAL_ADOPTED;
  } else if (official) {
    source = PROVENANCE_SOURCE.OFFICIAL_ORIGINAL;
  } else {
    // An adopted-provenance block on a non-roster pack is NOT official-adopted:
    // it reads as community material that happens to carry a provenance record.
    source = PROVENANCE_SOURCE.COMMUNITY;
  }

  return {
    badge,
    official,
    source,
    adopted: source === PROVENANCE_SOURCE.OFFICIAL_ADOPTED ? adopted : null,
  };
}

/**
 * 外部货架条目的来源描述（第四态，与 pack 三态并列但不经 manifest）。
 * 货架按定义是「未经本平台审校」，与 adopted 永不同源。
 */
export function describeShelfProvenance(entry) {
  const e = entry && typeof entry === "object" ? entry : {};
  return {
    source: PROVENANCE_SOURCE.ECOSYSTEM_UNREVIEWED,
    upstreamUrl: e.originUrl ?? null,
    upstreamName: e.displayName ?? e.name ?? null,
    licenseState: e.licenseState ?? "unknown",
    downloads: e.downloads ?? null,
    stars: e.stars ?? null,
  };
}
