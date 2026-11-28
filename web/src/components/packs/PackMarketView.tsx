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
      className={tiled ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "grid gap-3"}
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
  // 筛选状态写进地址（polish-facet-read-surfaces 真机走查补齐）：线 / 领域 /
  // 未归类 / 搜索词此前只活在组件 state 里，刷新或从详情页返回就丢 —— 而
  // pack-marketplace 的既有要求是「筛选项的状态要经得起一次往返」。商品的
  // 分面选择是读者花了点击换来的上下文，丢了就得重新选一遍。
  // 不引入 router（facet 壳没有 Router 祖先，见下方 sizeKey 的注释）：
  // 直接改 window.location.search。
  const writeFilters = useCallback(
    (next: { category?: string; domain?: string; unlined?: boolean; search?: string }) => {
      const url = new URL(window.location.href);
      const set = (k: string, v: string) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
      if (next.category !== undefined) set("line", next.category);
      if (next.domain !== undefined) set("domain", next.domain);
      if (next.unlined !== undefined) set("unlined", next.unlined ? "1" : "");
      if (next.search !== undefined) set("q", next.search);
      window.history.replaceState({}, "", url.toString());
    },
    [],
  );
  const fromUrl = (k: string) => new URLSearchParams(window.location.search).get(k) ?? "";
  const [search, setSearch] = useState(() => fromUrl("q"));
  // Curation (add-facet-content-management): a category filter chips row
  // (from the distinct live categories) and a featured rail. Both render
  // only when curation data exists — an uncatalogued market looks exactly
  // as before.
  const [category, setCategory] = useState(() => fromUrl("line"));
  // Facets (overhaul-market-catalog-presentation P1 2.5): the chip set is the
  // server's DECLARED taxonomy + counts, never the set of strings a page of
  // rows happened to carry. Two orthogonal rows: lines (always the full
  // declared set, zero-count included → the tab strip never reshapes as
  // content moves) and domains (non-zero values only, declared order).
  const [facets, setFacets] = useState<api.PackFacets | null>(null);
  // Domain-axis selection (a vocabulary slug, not a label).
  const [domain, setDomain] = useState(() => fromUrl("domain"));
  // Non-blocking stale-locale hint (P0 1.4): a failed silent refetch keeps
  // the old rows and says so, instead of swallowing the error.
  const [localeStale, setLocaleStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 完整可达（polish-facet-read-surfaces D4）：服务端声明 total，客户端此前
  // 直接丢掉它 —— 142 条只渲染 50 条而页面不作声。现在两者都留着。
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  // 未归类筛选：不属于任何已声明线的包，今天没有任何 chip 能筛到。
  const [unlined, setUnlined] = useState(() => fromUrl("unlined") === "1");
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per id (`seededRef` guard); openDetail is re-created each render and must not re-trigger it.
  useEffect(() => {
    if (seededRef.current) return;
    if (typeof initialDetailId !== "string" || !initialDetailId) return;
    seededRef.current = true;
    openDetail(initialDetailId);
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
  // 未归类计数：facets.lines 是声明全集的计数（与当前筛选无关），因此
  // 「无筛选时的 total − Σ(lines)」就是未归类条数。它只在无筛选的那次取数里
  // 可算准，所以记在 state 里 —— 选中未归类后 chip 仍要在，否则没法再点掉。
  const [unlinedCount, setUnlinedCount] = useState(0);
  useEffect(() => {
    if (total === null || !facets) return;
    if (category || search || domain) return;
    if (unlined) {
      // 选中时 total 就是未归类自己的条数，别再减一次。
      setUnlinedCount(total);
      return;
    }
    // `facets.lines` may be absent on a partial facets payload (an older
    // server, or an e2e mock that only declares the axes it asserts). Reading
    // it unguarded threw inside this effect and blanked the whole market view —
    // every card anchor disappeared (team-roster-isomorphic's mock returns
    // {categories,domains,tags} with no `lines`, and all three of its cases
    // went red with "pack-card-team-probe-0001 not visible").
    const linesSum = (facets.lines ?? []).reduce((a, l) => a + l.count, 0);
    setUnlinedCount(Math.max(0, total - linesSum));
  }, [total, facets, category, search, domain, unlined]);
  // Slug→label view of the domain vocabulary (locale-projected by the server,
  // P1 facets): the audience slot resolves declared slugs through this map.
  const domainLabels: Record<string, string> = Object.fromEntries((facets?.domains ?? []).map((d) => [d.slug, d.label]));
  // 保留 slug 不在词表里，服务端不给 label —— 补一个本地化标签，
  // 否则卡片上的 audience slot 会渲染出 `__unclassified__` 这种裸 slug。
  if (facets?.unclassified?.slug) domainLabels[facets.unclassified.slug] = t("packs.market.unclassifiedDomain");
  // Countless summaries (a pre-upgrade server) pass through unfiltered
  // rather than vanishing.
  const visiblePacks = packs.filter(
    (p) =>
      (p.agentCount === undefined ||
        (p.agentCount >= sizeFilter.min && p.agentCount <= sizeFilter.max)) &&
      (!officialOnly || p.official === true),
  );

  // 未归类 flag 走 ref：refresh 的 identity 变化会重跑首屏 effect，
  // 而筛选状态本来就已经在 URL 里 —— 与 search/category 同一套做法。
  const unlinedRef = useRef(unlined);
  // 最新 refresh 请求号（见 refresh 内「最新请求胜出」注释）。
  const refreshSeq = useRef(0);
  useEffect(() => {
    unlinedRef.current = unlined;
  }, [unlined]);

  const refresh = useCallback(
    async (
      q: string,
      cat = category,
      dom = domain,
      opts: { silent?: boolean; unlinedFlag?: boolean } = {},
    ) => {
      // Silent mode (overhaul-market-catalog-presentation P0): a locale-change
      // refetch keeps the already-rendered cards visible until the new data
      // lands — no skeleton flash — and a failure keeps the old rows with a
      // non-blocking hint instead of the destructive error box.
      if (!opts.silent) {
        setLoading(true);
        setError(null);
      }
      const unl = opts.unlinedFlag ?? unlinedRef.current;
      // 最新请求胜出（2026-11-25）：筛选变化会连发多次 refresh，慢网/慢 runner 下
      // 先发的「全量」响应可能晚于「筛选后」响应到达，把筛选结果覆盖回全量——
      // 用户点了「识律」却又看到 3 条。给每次请求编号，只有最新那次能落 setPacks。
      const reqId = ++refreshSeq.current;
      try {
        const r = await api.listPacks({
          ...(q ? { search: q } : {}),
          ...(cat ? { category: cat } : {}),
          ...(dom ? { domain: dom } : {}),
          ...(unl ? { unlined: true } : {}),
          page: 1,
          // 首屏取满一页：不传 pageSize 时服务端默认 50，线 chip 报 52 却只画 50
          // ——「连 chip 自己报的数都够不着」（polish-facet-read-surfaces）。
          // 服务端上限 100，这里取上限。
          pageSize: 100,
        });
        if (reqId !== refreshSeq.current) return; // a newer refresh superseded this one
        setPacks(r.packs);
        setTotal(r.total);
        setPage(1);
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

  /** 继续加载（polish-facet-read-surfaces D4）：追加下一页，保留当前筛选。
   *  与目录页的 catalog.loadMore 同一种交互。 */
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.listPacks({
        ...(search ? { search } : {}),
        ...(category ? { category } : {}),
        ...(domain ? { domain } : {}),
        ...(unlinedRef.current ? { unlined: true } : {}),
        page: page + 1,
        // 与首屏同页宽；否则第二页只回 50，120 条的列表要翻三次才到底。
        pageSize: 100,
      });
      // 去重：服务端分页按 published_at 排序，翻页期间若有新发布可能重复一条。
      setPacks((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...r.packs.filter((p) => !seen.has(p.id))];
      });
      setTotal(r.total);
      setPage((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, search, category, domain, page]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only bootstrap — refresh's identity changes with the filters; following it would double every filter change into two requests.
  useEffect(() => {
    // 首屏取数带上地址里的筛选（polish-facet-read-surfaces 真机复验抓到的）：
    // 这里原本写死 refresh("")，于是 ?q= 会被忽略 —— 输入框能从地址回填，列表
    // 却回到全量，看起来像「搜索没生效」。search/category/domain 的初始值本身
    // 就来自地址，所以直接把 state 交回去即可；只在挂载时跑一次。
    void refresh(search, category, domain);
  }, []);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: `language` is the trigger; the request stamps i18n.language itself.
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
  const listGrid = tiled ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "grid gap-3";

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
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            writeFilters({ search });
            void refresh(search);
          }}
          placeholder={t("packs.market.searchPlaceholder")}
          className={rail ? "w-full" : "max-w-sm"}
          data-testid="pack-search-input"
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { writeFilters({ search }); void refresh(search); }}>
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
                setUnlined(false);
                writeFilters({ category: "", domain: "", unlined: false });
                void refresh(search, "", "", { unlinedFlag: false });
              }}
              className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors ${
                category === "" && domain === "" && !unlined
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
              data-testid="pack-category-chip-all"
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
                    setUnlined(false);
                    writeFilters({ category: line.word, domain: "", unlined: false });
                    void refresh(search, line.word, "", { unlinedFlag: false });
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
          {/* 未归类 chip（polish-facet-read-surfaces D4）：不属于任何已声明线的
              包今天没有任何入口。计数 = total − Σ(line.count)，与筛选读取同一张
              表，所以两者不会漂移。零计数时不渲染 —— 「没有未归类」不是信息。 */}
          {unlinedCount > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="pack-unlined-row">
              <button
                onClick={() => {
                  const next = !unlined;
                  setUnlined(next);
                  setCategory("");
                  setDomain("");
                  writeFilters({ category: "", domain: "", unlined: next });
                  void refresh(search, "", "", { unlinedFlag: next });
                }}
                className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors ${
                  unlined ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
                }`}
                data-testid="pack-unlined-chip"
              >
                {t("packs.market.unlined")}
                <span className="ml-1 font-mono text-[10px] opacity-60">{unlinedCount}</span>
              </button>
            </div>
          )}
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
                    setUnlined(false);
                    writeFilters({ domain: next, unlined: false });
                    void refresh(search, category, next, { unlinedFlag: false });
                  }}
                  className={`inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors ${
                    domain === d.slug ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {d.label}
                  <span className="ml-1 font-mono text-[10px] opacity-60">{d.count}</span>
                </button>
              ))}
              {/* 领域轴的未归类档（pack-domain-taxonomy §3）。计数来自服务端的
                  `facets.unclassified`——不在前端用 total 减，因为领域是多值轴，
                  条目的多个 domain 会让求和重复计数。保留 slug 不在词表里，
                  标签走本地化 key（它不是词表项，服务端不给 label）。 */}
              {(facets?.unclassified?.count ?? 0) > 0 && (
                <button
                  onClick={() => {
                    const next = domain === facets!.unclassified!.slug ? "" : facets!.unclassified!.slug;
                    setDomain(next);
                    setUnlined(false);
                    writeFilters({ domain: next, unlined: false });
                    void refresh(search, category, next, { unlinedFlag: false });
                  }}
                  className={`inline-flex h-7 items-center rounded-full border border-dashed px-2.5 text-xs transition-colors ${
                    domain === facets?.unclassified?.slug ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid="pack-domain-unclassified-chip"
                >
                  {t("packs.market.unclassifiedDomain")}
                  <span className="ml-1 font-mono text-[10px] opacity-60">{facets?.unclassified?.count}</span>
                </button>
              )}
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

      {/* 完整可达（polish-facet-read-surfaces D4）：服务端声明 total、客户端
          此前直接丢弃 —— 142 条只渲染 50 条而页面不作声。总数写出来，并给
          一个继续加载的出口；两段都只在「确实还有」时出现。 */}
      {total !== null && total > 0 && (
        <p className="mb-2 text-xs text-muted-foreground" data-testid="pack-market-count">
          {t("packs.market.showingOf", { shown: packs.length, total })}
        </p>
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
      {total !== null && packs.length < total && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            data-testid="pack-market-more"
          >
            {t("packs.market.loadMore", { shown: packs.length, total })}
          </Button>
        </div>
      )}
      </div>

    </section>
  );
}
