// ── MaterialGallery — 素材目录（merge-plaza-into-facet-entry 2.x）─────────────
//
// 素材广场画廊的 React 重写。原实现是 site-plaza/script.js 里 271 行 DOM 直操，
// 语义三条，一条都不能丢：
//
//   1. **快照是基底，live 只就地更新**。live 刷新只覆盖 pack 物种；若把 live
//      结果整个替换掉快照，技能与 MCP 两个页签会在市场可达时变成空的
//      （script.js 里为此专门写了注释——踩过）。
//   2. **降级诚实**：live 成功显示「实时」，失败显示「快照 · <as-of>」。
//   3. **永不渲染空**：只要快照能读出来，就不显示空列表。
//
// 取数与渲染分离：`mergeMaterials` 与 `filterMaterials` 是纯函数，能在没有
// 浏览器的情况下断言上面三条。组件只负责把它们接上 React。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { mergeMaterials, filterMaterials, type Material, type CatalogSnapshot, type LiveState } from "./gallery-model";

const TABS = ["all", "agents", "skills", "mcp"] as const;

export function MaterialGallery({
  base = "",
  initialSpecies = "all",
  fetchImpl = fetch,
}: {
  /** 站点根（空串 = 同源）。机器面由导出器供给，路径不变。 */
  base?: string;
  /** `?species=skill|mcp` 之类的预选。 */
  initialSpecies?: string;
  fetchImpl?: typeof fetch;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language || "zh-CN";

  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null);
  const [live, setLive] = useState<Material[] | null>(null);
  const [liveState, setLiveState] = useState<LiveState>("pending");
  // 物种预选：显式传入优先，其次读 `?species=`（兼容门的跳转会带它）。
  // 映射与旧静态页一致：skill→skills、mcp→mcp、agent/pack→agents。
  const [tab, setTab] = useState<string>(() => {
    if (initialSpecies && initialSpecies !== "all") return initialSpecies;
    const raw = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("species") : null;
    const v = String(raw ?? "").toLowerCase();
    if (v === "skill" || v === "skills") return "skills";
    if (v === "mcp") return "mcp";
    if (v === "agent" || v === "agents" || v === "pack") return "agents";
    return "all";
  });
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");

  // 快照先读（它是基底，也是降级时的唯一来源）。
  useEffect(() => {
    let alive = true;
    fetchImpl(`${base}/generated/catalog.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setCatalog(d))
      .catch(() => alive && setCatalog(null));
    return () => {
      alive = false;
    };
  }, [base, fetchImpl]);

  // live 后读；失败就是失败，不改 catalog。
  useEffect(() => {
    let alive = true;
    fetchImpl(`${base}/api/marketplace/marketplace.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!alive) return;
        const items: Material[] = (d?.plugins ?? []).map((p: Record<string, unknown>) => ({
          id: String(p.id ?? p.name ?? ""),
          slug: String(p.id ?? ""),
          category: "pack",
          tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
          canonical: { brief: typeof p.description === "string" ? p.description : "" },
          human: {},
        }));
        setLive(items);
        setLiveState("live");
      })
      .catch(() => alive && setLiveState("snapshot"));
    return () => {
      alive = false;
    };
  }, [base, fetchImpl]);

  const materials = useMemo(
    () => mergeMaterials(catalog?.materials ?? [], live, liveState),
    [catalog, live, liveState],
  );
  const shown = useMemo(
    () => filterMaterials(materials, { tab, category, query, locale }),
    [materials, tab, category, query, locale],
  );

  const status =
    liveState === "live"
      ? t("entryGallery.live")
      : catalog
        ? `${t("entryGallery.snapshot")} · ${catalog.generatedAt ?? ""}`
        : "";

  const categories = useMemo(() => {
    const seen = new Map<string, number>();
    for (const m of materials) seen.set(m.category, (seen.get(m.category) ?? 0) + 1);
    return [...seen.entries()];
  }, [materials]);

  return (
    <section className="chapter wide" id="inventory" data-testid="material-gallery">
      <h2 className="sec-title">{t("entryGallery.title")}</h2>
      <p className="sec-lead">{t("entryGallery.lead")}</p>

      <p className="inv-status mono" data-testid="gallery-status" aria-live="polite">
        {status}
      </p>

      <div className="inv-tabs mono" role="tablist">
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`inv-tab ${tab === id ? "active" : ""}`}
            onClick={() => setTab(id)}
          >
            {t(`entryGallery.tabs.${id}`)}
          </button>
        ))}
      </div>

      <div className="inv-controls">
        <input
          type="search"
          className="inv-search"
          placeholder={t("entryGallery.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="inv-select" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{t("entryGallery.allCategories")}</option>
          {categories.map(([c, n]) => (
            <option key={c} value={c}>
              {t(`entryGallery.categoryNames.${c}`, c)} ({n})
            </option>
          ))}
        </select>
      </div>

      {shown.length === 0 ? (
        <p className="sec-ink" data-testid="gallery-empty">
          {t("entryGallery.empty")}
        </p>
      ) : (
        <div className="inv-grid" data-testid="gallery-grid">
          {shown.map((m) => {
            const name = m.human?.[locale]?.name ?? m.human?.en?.name ?? m.id;
            const desc = m.human?.[locale]?.summary ?? m.canonical?.brief ?? "";
            return (
              <article className="inv-card" key={m.id}>
                <h4>{name}</h4>
                <div className="badges">
                  {m.badges?.official && <span className="badge official">{t("entryGallery.official")}</span>}
                  {m.badges?.facade && <span className="badge facade">{t("entryGallery.facade")}</span>}
                  <span className="badge">{t(`entryGallery.categoryNames.${m.category}`, m.category)}</span>
                </div>
                <p className="desc">{desc}</p>
                <div className="links">
                  <a href={`${base}/generated/materials/${encodeURIComponent(m.slug)}.md`}>
                    {t("entryGallery.page")} →
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default MaterialGallery;
