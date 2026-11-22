// ── 市场来源的唯一判据（align-yizuo-market-origin-judgment 1.1）───────────────
//
// 「这条目是不是来自市场」在服务端与前端必须得到同一个答案。市场由两个通道
// 供货：旧的 registry feed（origin "registry"）与谦面目录投影（"facet-catalog"）。
//
// 两处手写比较就是漂移的机制——2026-11-22 实测：服务端已双认，而六处前端 +
// 一处服务端过滤仍只认 "registry"。后果不是「少个徽标」：作者的工具选择器漏
// 条目，安装表单让用户填服务端必定丢弃的密钥。
//
// 判据放在 core，因为它是服务端与前端唯一共同依赖的层；放在任何一侧，另一侧
// 就只能手写。本文件不 import 任何东西——它是纯数据 + 纯函数，node 可直接测。
export const MARKET_ORIGINS = ["registry", "facet-catalog"] as const;
export type MarketOrigin = (typeof MARKET_ORIGINS)[number];

/**
 * 该 origin 是不是市场来源。
 *
 * `bundled`（应用自带的起步件）**不是**：它确实可被作者引用，但那需要
 * 「市场来源 ∪ bundled」显式叠加，不能把 bundled 塞进市场判据——否则安装
 * 表单会把自带工具当成市场条目，去要一个它并不需要的凭据。
 *
 * 未知值与缺失一律答 false：判据只回答「来自市场吗」，不猜。
 */
export function isMarketOrigin(origin: string | null | undefined): boolean {
  return typeof origin === "string" && (MARKET_ORIGINS as readonly string[]).includes(origin);
}
