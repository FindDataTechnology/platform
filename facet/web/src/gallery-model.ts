// ── 素材画廊的领域逻辑（merge-plaza-into-facet-entry 2.x）─────────────────────
//
// 从 MaterialGallery.tsx 拆出来的**纯函数**。拆的理由不是整洁，是**可测**：
// .tsx 在 node 下不能直接 import，而这三条语义（快照为基底 / live 就地更新 /
// 降级不空）恰恰是最该被钉住的东西。组件只负责把它们接上 React。

export type Material = {
  id: string;
  slug: string;
  category: string;
  tags?: string[];
  canonical?: { brief?: string };
  human?: Record<string, { name?: string; summary?: string }>;
  badges?: { official?: boolean; facade?: boolean };
};

export type CatalogSnapshot = { generatedAt?: string; materials?: Material[] };
export type LiveState = "pending" | "live" | "snapshot";

/** 快照为基底；live 只按 id 就地更新，绝不逐出其他物种。 */
export function mergeMaterials(snapshot: Material[] = [], live: Material[] | null, liveState: LiveState) {
  if (liveState !== "live" || !live) return snapshot;
  const byId = new Map(snapshot.map((m) => [m.id, { ...m }]));
  for (const item of live) {
    const prev = byId.get(item.id);
    byId.set(item.id, {
      ...prev,
      ...item,
      human: { ...(prev?.human ?? {}), ...(item.human ?? {}) },
    } as Material);
  }
  return [...byId.values()];
}

/** 页签 → 物种集合。agents 是「人看的那三类」的合称，与现有实现一致。 */
export function speciesOf(tab: string): (c: string) => boolean {
  if (tab === "all") return () => true;
  if (tab === "agents") return (c) => ["pack", "facade", "official-data"].includes(c);
  if (tab === "skills") return (c) => c === "skill";
  return (c) => c === "mcp";
}

export function filterMaterials(
  materials: Material[],
  { tab, category, query, locale }: { tab: string; category: string; query: string; locale: string },
) {
  const inTab = speciesOf(tab);
  const q = query.trim().toLowerCase();
  return materials.filter((m) => {
    if (!inTab(m.category)) return false;
    if (category && m.category !== category) return false;
    if (!q) return true;
    const hay = [
      m.human?.[locale]?.name,
      m.human?.en?.name,
      m.human?.["zh-CN"]?.name,
      m.canonical?.brief,
      ...(m.tags ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}
