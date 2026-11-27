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
 * `host` 决定宿主专属的段：部署面板只在能装进 cell 的宿主（壹座）出现，
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

  // 判据必须是**派生结果**而不是原始字段（overhaul-pack-detail-presentation D6）：
  // `derivePillars()` 在只有角色级 `memory` 时也返回 `present`，而按包级
  // `manifest.memory` 判断会漏掉这一项——实测两个在架包内容渲染了、导航没有该项，
  // 内容侧也没有锚点（导航与渲染用了两套判据）。`pillars` / `team` 缺失是「这次响应
  // 没带」，此时回落到原始字段，让老响应的行为保持不变。
  const pillars = pack.pillars ?? null;
  const team = pack.team ?? null;

  // 记忆：派生结果优先；没有派生结果时才看包级字段。
  const hasMemory = pillars?.memory ? pillars.memory.state === "present" : m.memory != null;
  if (hasMemory) out.push({ id: "memory", labelKey: "packPage.sections.memory" });

  // 工具面收窄：只有「有岗位且真的收窄了」时才成段——包级工具面已由 mcp 段说完。
  const narrowedRoles = pillars?.toolkit?.roles ?? [];
  if (pillars?.toolkit?.state === "present" && narrowedRoles.some((r) => r.narrowed)) {
    out.push({ id: "toolkit", labelKey: "packPage.sections.toolkit" });
  }

  // 看板：同理走派生结果。
  const hasBoard = pillars?.dashboard ? pillars.dashboard.state === "present" : m.console != null;
  if (hasBoard) out.push({ id: "board", labelKey: "packPage.sections.board" });

  // cluster 成员（agent-cluster-platform）与 facade 归属（add-principal-facade）
  // 是两段独立内容：一个包可以声明 cluster 而不是 facade，反之亦然。
  // 判据就是 `manifest.cluster`——详情页里 `data-section="cluster"` 的段落只在它存在时
  // 渲染。团队编制（`fleet`）由规格书的岗位表呈现（不是独立章节、不带锚点），
  // 所以不能凭 `team.state` 列这一项，否则导航有项、内容没有锚点。
  if (m.cluster != null) out.push({ id: "cluster", labelKey: "packPage.sections.cluster" });

  // 验收断言：toolkit/roster 之外的另一组读者事实。
  if (team?.acceptance && team.acceptance.length > 0) {
    out.push({ id: "acceptance", labelKey: "packPage.sections.acceptance" });
  }

  // 监控。
  if (m.monitoring != null) out.push({ id: "monitoring", labelKey: "packPage.sections.monitoring" });

  // 产物卡（`board[]` 是**产出什么**，与上面的 console「看板」是两个概念）。
  if ((m.board ?? []).length > 0) out.push({ id: "output", labelKey: "packPage.sections.output" });

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