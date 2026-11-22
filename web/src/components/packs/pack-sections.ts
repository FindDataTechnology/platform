// ── 详情页的章节模型（pack-detail-as-page 2.1）────────────────────────────────
//
// 从 PackDetailPage.tsx 抽出的**纯函数**。理由与 gallery-model/catalog-model 相同：
// .tsx 在 node 下不能直接 import，而「章节由包实际声明的东西决定」这条恰恰最该被测。

// 只用到形状，不引入运行时依赖
import type { PackDetail } from "@/lib/packs-api";

export type DetailSection = { id: string; labelKey: string };

/**
 * 章节由**包里实际声明的东西**决定，不是一张固定的九项清单——一个不声明记忆的
 * 包不该出现空的「记忆」章节。返回顺序即阅读顺序。
 *
 * `host` 决定宿主专属的两段：部署面板只在能装进 cell 的宿主（壹座）出现，
 * facet 匿名壳没有安装面，列出来等于给一个永远打不开的锚点。
 */
export function sectionsFor(
  pack: PackDetail | null,
  opts: { installSurface?: boolean } = {},
): DetailSection[] {
  // 没有包就没有章节：空壳的「概览 / 版本历史」会让加载态与「这个包什么都没有」
  // 长得一样。
  if (!pack) return [];
  const out: DetailSection[] = [{ id: "overview", labelKey: "packPage.sections.overview" }];
  // 显式标注：`pack?.manifest ?? {}` 会被推断成 `{}`，随后每个字段访问都报错。
  const m: Partial<PackDetail["manifest"]> = pack?.manifest ?? {};
  if ((m.agents ?? []).length > 0) out.push({ id: "roles", labelKey: "packPage.sections.roles" });
  if ((m.skills ?? []).length > 0) out.push({ id: "skills", labelKey: "packPage.sections.skills" });
  if ((m.mcpServers ?? []).length > 0) out.push({ id: "mcp", labelKey: "packPage.sections.mcp" });
  // 记忆与看板是 **manifest 顶层字段**（pillar-surfaces / agent-memory-declaration），
  // 不是 agent 上的字段——2026-11-22 实撞：我按 `agent.memory` 判断，而那个字段
  // 在类型里根本不存在，TypeScript 一句话没说，因为类型一直在漂。
  if (m.memory != null) out.push({ id: "memory", labelKey: "packPage.sections.memory" });
  if (m.console != null) out.push({ id: "board", labelKey: "packPage.sections.board" });
  // cluster 成员（agent-cluster-platform）与 facade 归属（add-principal-facade）
  // 是两段独立内容：一个包可以声明 cluster 而不是 facade，反之亦然。
  if (m.cluster != null) out.push({ id: "cluster", labelKey: "packPage.sections.cluster" });
  if (m.facade != null) out.push({ id: "facade", labelKey: "packPage.sections.facade" });
  // 部署面板：只有能装进 cell 的宿主才有意义（facet 匿名壳没有安装面）。
  if (opts.installSurface && (m.agents ?? []).some((a) => a.serving != null)) {
    out.push({ id: "deploy", labelKey: "packPage.sections.deploy" });
  }
  // 边界与覆盖度：任一有内容就成段，两者都没有则整段不出现。
  if ((m.notes ?? "").trim() !== "" || pack.coverage) {
    out.push({ id: "boundary", labelKey: "packPage.sections.boundary" });
  }
  out.push({ id: "versions", labelKey: "packPage.sections.versions" });
  return out;
}