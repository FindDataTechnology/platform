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
    <section className="rounded-lg border border-border p-6" id="inventory" data-testid="material-gallery">
      <h2 className="text-lg font-semibold">{t("entryGallery.title")}</h2>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {t("entryGallery.lead")}
      </p>

      <p className="mt-3 text-xs text-muted-foreground" data-testid="gallery-status" aria-live="polite">
        {status}
      </p>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist">
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === id
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {t(`entryGallery.tabs.${id}`)}
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <input
          type="search"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm min-w-[14rem]"
          placeholder={t("entryGallery.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">{t("entryGallery.allCategories")}</option>
          {categories.map(([c, n]) => (
            <option key={c} value={c}>
              {t(`entryGallery.categoryNames.${c}`, c)} ({n})
            </option>
          ))}
        </select>
      </div>

      {shown.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground" data-testid="gallery-empty">
          {t("entryGallery.empty")}
        </p>
      ) : (
        <div
          className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
          data-testid="gallery-grid"
        >
          {shown.map((m) => {
            const name = m.human?.[locale]?.name ?? m.human?.en?.name ?? m.id;
            const desc = m.human?.[locale]?.summary ?? m.canonical?.brief ?? "";
            return (
              <article
                key={m.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-4"
              >
                <h4 className="text-sm font-medium leading-snug">{name}</h4>
                <div className="flex flex-wrap gap-1.5">
                  {m.badges?.official && (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {t("entryGallery.official")}
                    </span>
                  )}
                  {m.badges?.facade && (
                    <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium">
                      {t("entryGallery.facade")}
                    </span>
                  )}
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t(`entryGallery.categoryNames.${m.category}`, m.category)}
                  </span>
                </div>
                <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{desc}</p>
                <a
                  className="mt-auto text-xs text-primary underline-offset-2 hover:underline"
                  href={`${base}/generated/materials/${encodeURIComponent(m.slug)}.md`}
                >
                  {t("entryGallery.page")} →
                </a>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default MaterialGallery;
