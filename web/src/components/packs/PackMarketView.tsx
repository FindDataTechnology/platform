// PackMarketView — browse, search, inspect, subscribe (add-pack-marketplace).
// All parts of a pack are inspectable BEFORE subscribing: the detail dialog
// shows every skill's full body, MCP references with required groups, and
// agent personas (spec: pack-marketplace, browse-and-inspect).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import { packRelation, installedVersionMap } from "@/lib/packRelation";
import type { PackSummary } from "@/lib/packs-api";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states-kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/packs/Badge";
import { PackCard } from "./PackCard";
import { STARTER_TEAMS } from "@/lib/packGuides";
import { AgentSpecSheet } from "@/components/packs/AgentSpecSheet";

// Agent-count buckets (agent-cluster-platform marketplace views): the spec's
// "cluster size" filter, expressed over the count every pack carries — a
// multi-agent pack is cluster material whether or not it declares cluster
// metadata yet. State lives in the `agents` URL param (stateful per spec).
const AGENT_SIZE_FILTERS = [
  { key: "", min: 0, max: Number.POSITIVE_INFINITY },
  { key: "1", min: 1, max: 1 },
  { key: "2-3", min: 2, max: 3 },
  { key: "4+", min: 4, max: Number.POSITIVE_INFINITY },
] as const;

/** Card-grid skeleton matching the loaded market rows (polish-facet-usability
 *  state contract): title+version line, two description lines, tag row. The
 *  column count follows the host's layout so the skeleton does not reflow into
 *  a different shape when the data lands. */
function MarketSkeleton({ tiled = false }: { tiled?: boolean }) {
  return (
    <div
      className={tiled ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "grid gap-3"}
      data-testid="pack-market-skeleton"
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="h-4 w-36 animate-pulse rounded bg-muted" />
            <div className="h-4 w-10 animate-pulse rounded bg-muted" />
          </div>
          <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="mt-1.5 h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="mt-2 flex gap-1.5">
            <div className="h-5 w-14 animate-pulse rounded-full bg-muted" />
            <div className="h-5 w-14 animate-pulse rounded-full bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PackMarketView({
  studioOrigin,
  initialDetailId,
  onOpenDetail,
  layout = "row",
  filters = "top",
}: {
  // Fork deep-link origin (add-agent-fork-lineage): the gallery card's fork
  // link stays on THIS view; the fork button itself moved to the detail page.
  studioOrigin?: string;
  // Deep-link handoff (deployCastPack): the pack the host should open on
  // arrival. The detail is a page now, so this view simply forwards it to
  // `onOpenDetail` instead of mounting a dialog.
  initialDetailId?: string;
  /** Where "open this pack" leads. The host owns the address: 壹座 uses
   *  react-router (`/agents/<id>`), facet uses `#/packs/<id>`. A hardcoded
   *  hash here would blank 壹座's BrowserRouter route.
   *  Trading state (login gate, fork, deploy, install report) lives on the
   *  detail page — this view lists, filters and searches only. */
  onOpenDetail?: (id: string) => void;
  /** Card shape (overhaul-facet-shell-ia-and-space D2). `row` is the original
   *  horizontal card and the default; `tile` stacks it for a multi-column
   *  grid, which is how the facet shell spends a wide viewport. */
  layout?: "row" | "tile";
  /** Where the filter block lives (same change, D5). `top` keeps the search
   *  row and the chip axes above the list (壹座); `rail` moves them into a
   *  sticky left column and lets the cards tile — the facet shell's shape.
   *  Both keep the same testids and the same URL-lived filter state. */
  filters?: "top" | "rail";
}) {
  const { t, i18n } = useTranslation();
  const [packs, setPacks] = useState<PackSummary[]>([]);
  // Installed snapshots, for the per-card relation state
  // (polish-material-market-tabs 1.2). A host that cannot read them (the facet
  // shell is anonymous) leaves this empty — and empty means "say nothing",
  // never "not installed".
  const [installedVersions, setInstalledVersions] = useState<Record<string, number>>({});
  const loadInstalled = useCallback(async () => {
    try {
      const r = await api.listInstalledPacks();
      setInstalledVersions(installedVersionMap(r.packs));
    } catch {
      setInstalledVersions({});
    }
  }, []);
  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);
  const relationFor = (pack: PackSummary) => packRelation(pack.version, installedVersions[pack.id]);
  const [search, setSearch] = useState("");
  // Curation (add-facet-content-management): a category filter chips row
  // (from the distinct live categories) and a featured rail. Both render
  // only when curation data exists — an uncatalogued market looks exactly
  // as before.
  const [category, setCategory] = useState("");
  // Facets (overhaul-market-catalog-presentation P1 2.5): the chip set is the
  // server's DECLARED taxonomy + counts, never the set of strings a page of
  // rows happened to carry. Two orthogonal rows: lines (always the full
  // declared set, zero-count included → the tab strip never reshapes as
  // content moves) and domains (non-zero values only, declared order).
  const [facets, setFacets] = useState<api.PackFacets | null>(null);
  // Domain-axis selection (a vocabulary slug, not a label).
  const [domain, setDomain] = useState("");
  // Non-blocking stale-locale hint (P0 1.4): a failed silent refetch keeps
  // the old rows and says so, instead of swallowing the error.
  const [localeStale, setLocaleStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // deployCastPack handoff (add-supply-studio-migration 2.2): the supply
  // Studio's cross-domain deploy link opens the dialog straight on the cast
  // pack (install surface → from-template wizard → team page).
  // 卡片打开详情（pack-detail-as-page 5.1）：导航到详情页地址，不再开弹窗。
  // 不带来源参数——交易可见性由登录态决定，不由来源决定。
  // 宿主给了地址就交给宿主（壹座 是 BrowserRouter，写死 hash 会把路由打空）。
  const openDetail = (id: string) => {
    if (onOpenDetail) onOpenDetail(id);
    else window.location.hash = `#/packs/${encodeURIComponent(id)}`;
  };
  // deployCastPack handoff: the supply Studio links here with the pack to open.
  // The detail is a page now, so the handoff is one navigation, not a dialog
  // state. Fired once per id; the list may still be loading, and the id is all
  // the target address needs.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (typeof initialDetailId !== "string" || !initialDetailId) return;
    seededRef.current = true;
    openDetail(initialDetailId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDetailId]);

  // Agent-count filter state rides the URL (?agents=2-3) so a refresh keeps
  // it (spec: filter state persists across page refreshes). Deliberately NOT
  // react-router's useSearchParams: the facet shell mounts this view with no
  // Router ancestor, and a top-level router hook blanks its #/packs (the
  // shell sentinel's exact regression class, regressed 2026-10-21) — plain
  // window.location keeps the same URL-lived contract router-free.
  const [sizeKey, setSizeKeyState] = useState(
    () => new URLSearchParams(window.location.search).get("agents") || "",
  );
  const setSizeKey = useCallback((key: string) => {
    const url = new URL(window.location.href);
    if (key) url.searchParams.set("agents", key);
    else url.searchParams.delete("agents");
    window.history.replaceState({}, "", url.toString());
    setSizeKeyState(key);
  }, []);
  const sizeFilter = AGENT_SIZE_FILTERS.find((f) => f.key === sizeKey) ?? AGENT_SIZE_FILTERS[0];
  // Official filter (add-official-pack-showcase): URL-persisted like the size
  // filter. Rows without the flag (pre-upgrade server) pass through
  // unfiltered rather than vanishing; the chip renders only when the server
  // actually derives official rows (a rosterless deployment has none).
  const [officialOnly, setOfficialOnly] = useState(
    () => new URLSearchParams(window.location.search).get("official") === "1",
  );
  const setOfficialFilter = useCallback((on: boolean) => {
    const url = new URL(window.location.href);
    if (on) url.searchParams.set("official", "1");
    else url.searchParams.delete("official");
    window.history.replaceState({}, "", url.toString());
    setOfficialOnly(on);
  }, []);
  const hasOfficialRows = packs.some((p) => p.official === true);
  // Slug→label view of the domain vocabulary (locale-projected by the server,
  // P1 facets): the audience slot resolves declared slugs through this map.
  const domainLabels: Record<string, string> = Object.fromEntries((facets?.domains ?? []).map((d) => [d.slug, d.label]));
  // Countless summaries (a pre-upgrade server) pass through unfiltered
  // rather than vanishing.
  const visiblePacks = packs.filter(
    (p) =>
      (p.agentCount === undefined ||
        (p.agentCount >= sizeFilter.min && p.agentCount <= sizeFilter.max)) &&
      (!officialOnly || p.official === true),
  );

  const refresh = useCallback(
    async (q: string, cat = category, dom = domain, opts: { silent?: boolean } = {}) => {
      // Silent mode (overhaul-market-catalog-presentation P0): a locale-change
      // refetch keeps the already-rendered cards visible until the new data
      // lands — no skeleton flash — and a failure keeps the old rows with a
      // non-blocking hint instead of the destructive error box.
      if (!opts.silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const r = await api.listPacks({
          ...(q ? { search: q } : {}),
          ...(cat ? { category: cat } : {}),
          ...(dom ? { domain: dom } : {}),
        });
        setPacks(r.packs);
        setLocaleStale(false);
      } catch (err) {
        if (opts.silent) setLocaleStale(true);
        else setError((err as Error).message);
      } finally {
        if (!opts.silent) setLoading(false);
      }
    },
    [category, domain],
  );

  useEffect(() => {
    void refresh("");
  }, [refresh]);

  // Locale-change refetch (P0 1.1): the server owns locale resolution and the
  // zh fallback; the client only re-states its UI language. The list keeps its
  // filters (search/category) and refreshes silently. Refs carry the latest
  // refresh/search so the listener never fires a stale closure (refresh's own
  // identity changes with `category`; this effect deliberately does not).
  const language = i18n.language;
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  }, [search]);
  const prevLanguage = useRef(language);
  useEffect(() => {
    if (prevLanguage.current === language) return;
    prevLanguage.current = language;
    void refreshRef.current(searchRef.current, undefined, undefined, { silent: true });
  }, [language]);

  // Facets from the declared taxonomy (P1 2.5). Re-runs on language change so
  // the labels follow the request; the SET and its order never move.
  // `language` is the TRIGGER, not an input — getPackFacets stamps the current
  // i18n.language itself.
  useEffect(() => {
    let live = true;
    api
      .getPackFacets()
      .then((f) => {
        if (live) setFacets(f);
      })
      .catch(() => {
        // Facets are a browse aid: an unreachable endpoint leaves the chip
        // rows empty rather than breaking the market itself.
        if (live) setFacets(null);
      });
    return () => {
      live = false;
    };
  }, [language]);

  // Honest guide hint (add-facet-copilot): ask the existing focused-preset
  // endpoint whether the facet assistant is installed. Only the "resolves to
  // null" answer shows the hint; a failed/absent probe shows nothing (the
  // dock's own degradation already narrates there).
  const [guideUnfocused, setGuideUnfocused] = useState(false);
  useEffect(() => {
    fetch("/api/boards/facet/copilot")
      .then((r) => (r.ok ? r.json() : { error: true }))
      .then((b) => setGuideUnfocused(!b.error && b.copilot == null))
      .catch(() => setGuideUnfocused(false));
  }, []);

  const tiled = layout === "tile";
  const rail = filters === "rail";
  const listGrid = tiled ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "grid gap-3";

  return (
    <section
      data-testid="pack-market-section"
      className={rail ? "grid items-start gap-x-6 lg:grid-cols-[16rem_minmax(0,1fr)]" : undefined}
    >
      {guideUnfocused && (
        <p
          data-testid="pack-market-guide-hint"
          className={`mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning ${
            rail ? "lg:col-span-2" : ""
          }`}
        >
          {t("packs.market.assistantHint")}
        </p>
      )}
      <div
        data-testid="pack-filters"
        className={rail ? "space-y-3 lg:sticky lg:top-0 lg:col-start-1 lg:row-start-2" : ""}
      >
      <div className={rail ? "flex flex-col gap-2 mb-4" : "flex items-center gap-2 mb-4"}>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void refresh(search)}
          placeholder={t("packs.market.searchPlaceholder")}
          className={rail ? "w-full" : "max-w-sm"}
          data-testid="pack-search-input"
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void refresh(search)}>
            {t("packs.market.search")}
          </Button>
          <select
            value={sizeKey}
            onChange={(e) => setSizeKey(e.target.value)}
            aria-label={t("packs.market.agentSize")}
            data-testid="pack-agent-size-filter"
            className={`h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground ${rail ? "flex-1" : ""}`}
          >
            {AGENT_SIZE_FILTERS.map((f) => (
              <option key={f.key || "all"} value={f.key}>
                {f.key
                  ? t("packs.market.agentSizeValue", { value: f.key })
                  : t("packs.market.agentSizeAny")}
              </option>
            ))}
          </select>
        </div>
      </div>

      {(facets || hasOfficialRows) && (
        <div className={rail ? "space-y-3" : "space-y-1.5 mb-3"} data-testid="pack-facets">
          {/* Axis 1 · lines — always the full declared set, declared order, with
              counts. A zero-count line stays put and greys out: the strip is
              spatial memory, not a live projection of the current rows. */}
          <div className="flex flex-wrap gap-1.5" data-testid="pack-category-chips">
            {hasOfficialRows && (
              <button
                onClick={() => setOfficialFilter(!officialOnly)}
                className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors ${
                  officialOnly ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                }`}
                data-testid="pack-official-chip"
              >
                {t("packs.market.official")}
              </button>
            )}
            <button
              onClick={() => {
                setCategory("");
                setDomain("");
                void refresh(search, "", "");
              }}
              className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors ${
                category === "" && domain === "" ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {t("packs.market.allCategories")}
            </button>
            {(facets?.lines ?? []).map((line) => {
              const empty = line.count === 0;
              const active = category === line.word;
              return (
                <button
                  key={line.slug}
                  onClick={() => {
                    setCategory(line.word);
                    setDomain("");
                    void refresh(search, line.word, "");
                  }}
                  data-line-count={line.count}
                  className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors ${
                    active
                      ? "border-primary text-primary"
                      : empty
                        ? "border-border/60 text-muted-foreground/50 hover:text-muted-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {line.label}
                  <span className="ml-1 font-mono text-[10px] opacity-60">{line.count}</span>
                </button>
              );
            })}
          </div>
          {/* Axis 2 · domains — non-zero values only, declared order. Rendered
              only when the vocabulary has at least one listed value. */}
          {(facets?.domains?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="pack-domain-chips">
              <span className="text-xs text-muted-foreground">{t("packs.market.domains")}</span>
              {(facets?.domains ?? []).map((d) => (
                <button
                  key={d.slug}
                  onClick={() => {
                    const next = domain === d.slug ? "" : d.slug;
                    setDomain(next);
                    void refresh(search, category, next);
                  }}
                  className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors ${
                    domain === d.slug ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {d.label}
                  <span className="ml-1 font-mono text-[10px] opacity-60">{d.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      <div className={rail ? "min-w-0 lg:col-start-2 lg:row-start-2" : ""}>
      {localeStale && (
        <p
          data-testid="pack-market-locale-stale"
          className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          {t("packs.market.staleLocale")}
        </p>
      )}
      {!category && !search &&
        visiblePacks.filter((p) => p.featured).length > 0 && (
          <div className="mb-4" data-testid="pack-featured-rail">
            <p className="text-xs font-medium text-muted-foreground mb-1.5">{t("packs.market.featured")}</p>
            <div className={listGrid}>
              {visiblePacks
                .filter((p) => p.featured)
                .map((p, i) => (
                  <PackCard key={p.id} pack={p} index={i} layout={layout} audienceLabels={domainLabels} tone="gallery" relation={relationFor(p)} testId={`pack-featured-card-${p.id}`} onOpen={() => openDetail(p.id)} />
                ))}
            </div>
          </div>
        )}
      {loading && <MarketSkeleton tiled={tiled} />}
      {error && (
        // StatesKit (polish-material-market-tabs 3.1): the failure names the
        // problem and offers the way forward, in the same shape the rest of the
        // product uses. The rows above stay on screen — a failed refetch never
        // blanks a working catalog (3.2).
        <div data-testid="pack-market-error" className="mb-4">
          <ErrorState message={error} onRetry={() => void refresh(search)} retryLabel={t("common.retry")} />
        </div>
      )}
      {!loading && !error && visiblePacks.length === 0 && (
        <div data-testid="pack-market-empty">
          {/* A selected line with nothing listed says so in its own words — the
              generic "market is empty" would misdescribe a healthy catalog. */}
          <EmptyState
            title={category && !search ? t("packs.market.lineEmpty") : t("packs.market.empty")}
            hint={t("packs.market.emptyHint")}
            action={
              category || search ? (
                <Button variant="outline" size="sm" onClick={() => void refresh("", "", "")} data-testid="pack-market-clear-filters">
                  {t("packs.market.clearFilters")}
                </Button>
              ) : null
            }
          />
        </div>
      )}

      <div className={listGrid}>
        {officialOnly && visiblePacks.length > 0 && (
          <p className="text-xs font-medium text-muted-foreground" data-testid="pack-gallery-title">
            {t("packs.market.galleryTitle")}
          </p>
        )}
        {visiblePacks.map((pack, i) =>
          officialOnly ? (
            /* 官方 gallery (add-official-agent-gallery) 的呈现层升级在 PackCard 里
               合并（overhaul-market-catalog-presentation P2）：同一列表数据（零端点、
               零 fetch），compact 共享规格书与 starter 标记作为 children；克隆深链走
               extra 兄弟行——卡片主体保持单一可点区（五槽位契约），fork 有自己的
               键盘停靠点，不再是可点区内的嵌套目标。 */
            <PackCard
              key={pack.id}
              pack={pack}
              index={i}
              audienceLabels={domainLabels}
              relation={relationFor(pack)}
              tone="gallery"
              testId={`pack-gallery-card-${pack.id}`}
              onOpen={() => openDetail(pack.id)}
            >
              {(() => {
                const starter = STARTER_TEAMS.find((st) => st.packId === pack.id);
                return (
                  <>
                    {starter && (
                      <Badge data-testid={`pack-gallery-starter-${pack.id}`}>
                        {t(`help.start.starterRole.${starter.role}`)}
                      </Badge>
                    )}
                    <AgentSpecSheet
                      variant="compact"
                      testIdPrefix={`gallery-${pack.id}`}
                      badge={pack.badge ?? null}
                      official={pack.official === true}
                      adopted={pack.adopted === true}
                      personaPresent={(pack.agentCount ?? 0) > 0}
                    />
                  </>
                );
              })()}
              extra={
                <a
                  href={`${studioOrigin ?? ""}/studio?fork=${encodeURIComponent(pack.id)}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-primary hover:underline"
                  data-testid={`pack-gallery-fork-${pack.id}`}
                >
                  {t("packs.detail.fork")}
                </a>
              }
            </PackCard>
          ) : (
            <PackCard key={pack.id} pack={pack} index={i} layout={layout} audienceLabels={domainLabels} relation={relationFor(pack)} testId={`pack-card-${pack.id}`} onOpen={() => openDetail(pack.id)} />
          )
        )}
      </div>
      </div>

    </section>
  );
}
