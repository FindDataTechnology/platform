// PackMarketView — browse, search, inspect, subscribe (add-pack-marketplace).
// All parts of a pack are inspectable BEFORE subscribing: the detail dialog
// shows every skill's full body, MCP references with required groups, and
// agent personas (spec: pack-marketplace, browse-and-inspect).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import * as api from "@/lib/packs-api";
import { packRelation, installedVersionMap } from "@/lib/packRelation";
import type { PackSummary, PackReport } from "@/lib/packs-api";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states-kit";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/packs/Badge";
import { PackDetailDialog } from "./PackDetailDialog";
import { PackCard } from "./PackCard";
import { publishPackInspection } from "@/lib/copilot-pack-context";
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
 *  state contract): title+version line, two description lines, tag row. */
function MarketSkeleton() {
  return (
    <div className="grid gap-3" data-testid="pack-market-skeleton">
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
  onOpenChat,
  onRequireLogin,
  onGotoMine,
  studioOrigin,
  onUsePrompt,
  installSurface = true,
  initialDetailId,
}: {
  onSubscribed?: () => void;
  // The report footer's open-chat hook. Hosts without a conversation view
  // (the facet shell) pass null to drop the footer entirely; the default
  // navigates 壹座's chat route. See NextStepsFooter for why the routing
  // call lives there and not here.
  onOpenChat?: (() => void) | null;
  // Signed-out signal forwarded to the detail dialog (polish-facet-
  // interactions): hosts with anonymous viewers wire it, 壹座 omits it.
  onRequireLogin?: () => void;
  // Fork deep-link origin (add-agent-fork-lineage) — forwarded to the dialog.
  studioOrigin?: string;
  // Deep-link prefill: the pack id the dialog opens on (deployCastPack).
  initialDetailId?: string;
  // Host-selected "go to my packs" affordance (polish-facet-interactions
  // follow-up): forwarded to the dialog, which routes it through the login
  // guidance when the host also wired onRequireLogin and the viewer is
  // signed out.
  onGotoMine?: () => void;
  // Example prompts are actionable (overhaul-market-catalog-presentation P2
  // 3.5): the 壹座 host parks the prompt in the chat store's composer-draft
  // channel and navigates to /chat (DocumentsPage "start conversation"
  // precedent); the facet shell omits it and the dialog copies to clipboard.
  onUsePrompt?: (prompt: string) => void;
  // Whether this host can install/deploy packs into a cell (overhaul-market-
  // catalog-presentation P0). The facet shell cannot — the dialog skips its
  // deployments/billing probes there instead of firing requests that can
  // never carry data on that host. Defaults to true (壹座 mounts unchanged).
  installSurface?: boolean;
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
  const [detailId, setDetailId] = useState<string | null>(
    typeof initialDetailId === "string" && initialDetailId ? initialDetailId : null,
  );
  // Publish the inspected pack for the copilot dock (add-facet-copilot D2):
  // opening/switching publishes the pack, closing publishes null. The packs
  // array is the name/version source of truth (the id is all the dialog owns).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dock context keys on the inspected pack's id — a name/version refresh mid-inspection must not re-fire it, so only the id (via detailId) is the trigger
  useEffect(() => {
    const pack = detailId ? packs.find((p) => p.id === detailId) ?? null : null;
    publishPackInspection(pack && { id: pack.id, name: pack.name, version: pack.version });
  }, [detailId]);
  useEffect(() => () => publishPackInspection(null), []);

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: `language` is the TRIGGER, not an input — getPackFacets stamps the current i18n.language itself
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

  const [report, setReport] = useState<PackReport | null>(null);
  const [reportPack, setReportPack] = useState<string>("");
  const [reportPackId, setReportPackId] = useState<string>("");
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

  // Deep-link target (simplify-chat-and-agents-ia): a pack with a
  // successfully installed role goes straight into a conversation with it
  // (`?preset=`); a multi-role pack additionally carries its cluster id so the
  // chat binds the whole group and switches to the roster's lead. A pack
  // without roles (skill/tool-only) keeps the plain navigation — the
  // conversation needs no switch.
  const installedAgents = (report?.agents ?? []).filter(
    (a) => a.status === "installed" || a.status === "reused" || a.status === "replaced",
  );
  const chatTarget =
    report && installedAgents.length > 0
      ? installedAgents.length >= 2 && reportPackId
        ? `/chat?preset=${encodeURIComponent(installedAgents[0]!.id)}&cluster=${encodeURIComponent(reportPackId)}`
        : `/chat?preset=${encodeURIComponent(installedAgents[0]!.id)}`
      : "/chat";
  const chatClusterMode = installedAgents.length >= 2;

  return (
    <section data-testid="pack-market-section">
      {guideUnfocused && (
        <p
          data-testid="pack-market-guide-hint"
          className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          {t("packs.market.assistantHint")}
        </p>
      )}
      <div className="flex items-center gap-2 mb-4">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void refresh(search)}
          placeholder={t("packs.market.searchPlaceholder")}
          className="max-w-sm"
          data-testid="pack-search-input"
        />
        <Button variant="outline" size="sm" onClick={() => void refresh(search)}>
          {t("packs.market.search")}
        </Button>
        <select
          value={sizeKey}
          onChange={(e) => setSizeKey(e.target.value)}
          aria-label={t("packs.market.agentSize")}
          data-testid="pack-agent-size-filter"
          className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
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

      {(facets || hasOfficialRows) && (
        <div className="space-y-1.5 mb-3" data-testid="pack-facets">
          {/* Axis 1 · lines — always the full declared set, declared order, with
              counts. A zero-count line stays put and greys out: the strip is
              spatial memory, not a live projection of the current rows. */}
          <div className="flex flex-wrap gap-1.5" data-testid="pack-category-chips">
            {hasOfficialRows && (
              <button
                onClick={() => setOfficialFilter(!officialOnly)}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
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
              className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
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
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
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
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
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
            <div className="grid gap-3">
              {visiblePacks
                .filter((p) => p.featured)
                .map((p, i) => (
                  <PackCard key={p.id} pack={p} index={i} audienceLabels={domainLabels} tone="gallery" relation={relationFor(p)} testId={`pack-featured-card-${p.id}`} onOpen={() => setDetailId(p.id)} />
                ))}
            </div>
          </div>
        )}
      {loading && <MarketSkeleton />}
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

      <div className="grid gap-3">
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
              onOpen={() => setDetailId(pack.id)}
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
            <PackCard key={pack.id} pack={pack} index={i} audienceLabels={domainLabels} relation={relationFor(pack)} testId={`pack-card-${pack.id}`} onOpen={() => setDetailId(pack.id)} />
          )
        )}
      </div>

      <PackDetailDialog
        studioOrigin={studioOrigin}
        packId={detailId}
        installSurface={installSurface}
        onOpenChange={(open) => !open && setDetailId(null)}
        onSubscribed={(r, name, packId) => {
          setReport(r);
          setReportPack(name);
          setReportPackId(packId);
          void refresh(search);
          // The viewer just gained a snapshot: the card must say 已装 now.
          void loadInstalled();
        }}
        onGotoMine={onGotoMine}
        onRequireLogin={onRequireLogin}
        onUsePrompt={onUsePrompt}
      />

      {/* Post-subscribe per-part report (spec: pack-installation). */}
      {report && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          data-testid="pack-install-report"
          onClick={() => setReport(null)}
        >
          <div
            className="bg-background border border-border rounded-lg max-w-lg w-full max-h-[80vh] overflow-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-semibold text-foreground mb-1">{t("packs.report.title", { name: reportPack })}</h3>
            <p className="text-xs text-muted-foreground mb-3">{t("packs.report.hint")}</p>
            <div className="space-y-1 text-sm">
              {report.skills.map((s) => (
                <div key={s.name} className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.skill")}</span>
                  <span className="text-foreground">{s.name}</span>
                  <span className="ml-auto">{statusLabel(t, s.status)}</span>
                  {s.reason && <span className="text-xs text-destructive w-full">{s.reason}</span>}
                  {/* Disclosure (add-packaged-skills 5.2): tree skills state
                      their file count and name their script files. */}
                  {s.fileCount != null && (
                    <span className="text-xs text-muted-foreground w-full" data-testid={`pack-report-files-${s.name}`}>
                      {s.scriptFiles?.length
                        ? t("packs.report.filesWithScripts", {
                            count: s.fileCount,
                            scripts: s.scriptFiles.join("、"),
                          })
                        : t("packs.report.files", { count: s.fileCount })}
                    </span>
                  )}
                </div>
              ))}
              {report.mcpServers.map((m) => (
                <div key={m.name} className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.mcp")}</span>
                  <span className="text-foreground">{m.name}</span>
                  <span className="ml-auto">{statusLabel(t, m.status)}</span>
                  {m.reason && <span className="text-xs text-destructive w-full">{m.reason}</span>}
                </div>
              ))}
              {report.agents.map((a) => (
                <div key={a.id} className="flex gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.agent")}</span>
                  <span className="text-foreground">{a.name}</span>
                  <span className="ml-auto">{statusLabel(t, a.status)}</span>
                  {a.reason && <span className="text-xs text-destructive w-full">{a.reason}</span>}
                </div>
              ))}
              {/* Bot units (pack-bot-units): mirror the agents rows; an
                  awaiting-credential bot is information, not an error — the
                  operator's channel setup is the explicit next step. */}
              {(report.bots ?? []).map((b) => (
                <div key={b.id} className="flex gap-2" data-testid={`pack-report-bot-${b.id}`}>
                  <span className="text-muted-foreground w-20 shrink-0">{t("packs.report.bot")}</span>
                  <span className="text-foreground">{b.name}</span>
                  <span className="ml-auto">{statusLabel(t, b.status)}</span>
                  {b.reason && (
                    <span className="text-xs text-muted-foreground w-full">{b.reason}</span>
                  )}
                </div>
              ))}
            </div>
            <div className="flex justify-end mt-4">
              <Button size="sm" onClick={() => setReport(null)}>
                {t("common.close")}
              </Button>
            </div>
            {/* Next-steps wizard footer (add-pack-tutorials-and-wizard +
                simplify-chat-and-agents-ia): the report ends by taking the
                user straight into a conversation with what they just
                installed — the CTA carries the installed role (and, for a
                multi-role pack, the cluster bind intent), so no manual
                re-selection step remains. The report itself is unchanged. */}
            <NextStepsFooter
              target={chatTarget}
              clusterMode={chatClusterMode}
              onOpenChat={onOpenChat}
              onDismiss={() => setReport(null)}
            />
          </div>
        </div>
      )}
    </section>
  );
}

// The report's next-steps footer — the only routing-dependent piece of this
// view, and therefore its own component: useNavigate runs only when the
// footer actually renders. Hosts that pass onOpenChat={null} never mount it,
// so this view stays borrowable by router-less shells (facet-platform: the
// facet shell adds no router dependency — a top-level useNavigate here is
// exactly what blanked #/packs in production).
function NextStepsFooter({
  target,
  clusterMode,
  onOpenChat,
  onDismiss,
}: {
  target: string;
  clusterMode: boolean;
  onOpenChat?: (() => void) | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  if (onOpenChat === null) return null;
  return (
    <div
      className="mt-3 flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2"
      data-testid="pack-install-next"
    >
      <span className="text-xs text-muted-foreground">
        {t(clusterMode ? "packs.report.nextHintCluster" : "packs.report.nextHint")}
      </span>
      <button
        className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        onClick={() => {
          onDismiss();
          onOpenChat ? onOpenChat() : navigate(target);
        }}
        data-testid="pack-install-open-chat"
      >
        {t(clusterMode ? "packs.report.openChatCluster" : "packs.report.openChat")}
      </button>
    </div>
  );
}

function statusLabel(t: (k: string) => string, status: string) {
  const key = `packs.report.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}
