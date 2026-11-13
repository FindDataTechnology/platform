// 内容运营板 — the facet curation board (add-facet-content-management), the
// admin surface that makes 谦面's content manageable in its own domain.
//
// Shape (overhaul-facet-shell-ia-and-space D6): master–detail. The board used
// to be one flat column of full-width rows, each carrying five inline
// controls — which meant an admin scrolled a kilometre of chrome to reach the
// fourth pack, and the list was capped at `pageSize: 100`, so pack 101 simply
// did not exist on the management face. Now:
//
//   left  — searchable, narrowable list of every pack (unlisted included via
//           the admin-only widening), each row naming its own state;
//   right — the selected pack's editor: category (vocabulary), domains
//           (vocabulary, ≤3), featured, coverage gaps, usage;
//   one Save commits a row's three edits in ONE request — the endpoint has
//           always accepted them together, the three clicks were the UI's
//           invention.
//
// Presentation-level only: curation never changes visibility, content, or
// installability. Usage and coverage degrade honestly; neither gates curation.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackSummary } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";

type UsageRow = { packId: string | null; turns: number; activeUsers: number; lastUsedAt: number };

/** One pack's pending edit set — the unit the board commits. */
type Draft = { category: string; domains: string[]; featured: boolean };

const PAGE_SIZE = 100;

export function CurateView() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PackSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  // The picker's source is the DECLARED vocabulary from the facets endpoint
  // (zero-count values included) — never free text. Domains and the category
  // axis now read the same source instead of one being a text input.
  const [vocabulary, setVocabulary] = useState<{ slug: string; label: string }[]>([]);
  const [lines, setLines] = useState<{ slug: string; label: string; count: number }[]>([]);
  const [onlyUnclassified, setOnlyUnclassified] = useState(false);
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<Record<string, api.PackCoverageRow> | null>(null);

  const load = useCallback(async (search: string) => {
    setLoadError(null);
    try {
      const r = await api.listPacks({ pageSize: PAGE_SIZE, search, includeUnlisted: true });
      setRows(r.packs);
      setTotal(r.total ?? r.packs.length);
    } catch (err) {
      setRows([]);
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load("");
    api
      .getPackUsageBoard()
      .then((r) => setUsage(r.rows))
      .catch((e: Error) => setUsageError(e.message));
    api
      .getPackFacets()
      .then((f) => {
        setVocabulary(f.vocabulary ?? []);
        setLines((f.lines ?? []).map((l) => ({ slug: l.slug, label: l.label, count: l.count })));
      })
      .catch(() => {
        // Both pickers degrade to unavailable, never to free text.
        setVocabulary([]);
        setLines([]);
      });
    api
      .getPackCoverageBoard()
      .then((r) => setCoverage(Object.fromEntries(r.packs.map((row) => [row.id, row]))))
      .catch(() => setCoverage(null)); // patrol face degrades silently; never blocks curation
  }, [load]);

  // "Load more" walks the catalogue in server pages: every pack has to be
  // reachable, which the old fixed 100-row fetch silently denied.
  const loadMore = async () => {
    if (!rows || rows.length >= total) return;
    setLoadingMore(true);
    try {
      const nextPage = Math.floor(rows.length / PAGE_SIZE) + 1;
      const r = await api.listPacks({ page: nextPage, pageSize: PAGE_SIZE, search: applied, includeUnlisted: true });
      setRows([...rows, ...r.packs]);
      setTotal(r.total ?? total);
    } catch (err) {
      setNotice(t("facetCurate.loadMoreFailed", { message: (err as Error).message }));
    } finally {
      setLoadingMore(false);
    }
  };

  const runSearch = () => {
    setSelectedId(null);
    setApplied(query.trim());
    void load(query.trim());
  };

  const draftOf = (p: PackSummary): Draft =>
    drafts[p.id] ?? { category: p.category ?? "", domains: p.domains ?? [], featured: p.featured === true };
  const patchDraft = (p: PackSummary, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [p.id]: { ...(d[p.id] ?? draftOf(p)), ...patch } }));
  const isDirty = (p: PackSummary) => {
    const d = drafts[p.id];
    if (!d) return false;
    const base = draftOfBase(p);
    return (
      d.category !== base.category ||
      d.featured !== base.featured ||
      [...d.domains].sort().join(",") !== [...base.domains].sort().join(",")
    );
  };
  const draftOfBase = (p: PackSummary): Draft => ({
    category: p.category ?? "",
    domains: p.domains ?? [],
    featured: p.featured === true,
  });

  const save = async (pack: PackSummary) => {
    const d = draftOf(pack);
    const base = draftOfBase(pack);
    setSavingId(pack.id);
    try {
      // One request carries every edit the admin made — but ONLY the fields
      // that actually moved. Sending all three unconditionally made an author
      // without the admin group fail on `featured` (the route rejects the
      // whole body), so a plain domain retarget would 403 for exactly the
      // people allowed to do it.
      const body: { category?: string; domains?: string[]; featured?: boolean } = {};
      if (d.category !== base.category) body.category = d.category;
      if (d.featured !== base.featured) body.featured = d.featured;
      if ([...d.domains].sort().join(",") !== [...base.domains].sort().join(",")) body.domains = d.domains;
      if (Object.keys(body).length > 0) await api.setPackCuration(pack.id, body);
      setNotice(t("facetCurate.saved", { name: pack.name }));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[pack.id];
        return next;
      });
      await load(applied);
    } catch (err) {
      setNotice(t("facetCurate.saveFailed", { name: pack.name, message: (err as Error).message }));
    } finally {
      setSavingId(null);
    }
  };

  const unclassified = (p: PackSummary) => (p.domains ?? []).length === 0;
  const usageOf = (id: string) => usage?.find((r) => r.packId === id) ?? null;

  // Two independent narrowing axes (unclassified backlog / en-coverage gaps).
  // The gap axis is a no-op when coverage failed to load (degrades silent).
  // The predicates are inlined rather than referenced as closures: they are
  // rebuilt on every render, so listing them as dependencies would re-filter on
  // every keystroke that touches unrelated state and defeat the memo.
  const visible = useMemo(() => {
    let list = rows ?? [];
    if (onlyUnclassified) list = list.filter((p) => (p.domains ?? []).length === 0);
    if (onlyGaps && coverage) list = list.filter((p) => (coverage[p.id]?.missing.length ?? 0) > 0);
    return list;
  }, [rows, onlyUnclassified, onlyGaps, coverage]);

  const unclassifiedTotal = (rows ?? []).filter(unclassified).length;
  const selected = (rows ?? []).find((p) => p.id === selectedId) ?? null;

  if (!rows) return <BoardSkeleton />;
  if (loadError)
    return (
      <div className="text-sm text-destructive space-y-2" data-testid="facet-curate-error">
        <p>{t("facetCurate.errorLoad", { message: loadError })}</p>
        <Button variant="outline" size="sm" onClick={() => void load(applied)}>
          {t("common.retry")}
        </Button>
      </div>
    );

  return (
    <section data-testid="facet-curate-view" className="space-y-4">
      <header>
        {/* Page title is the h1 (one per view); the master–detail panes and the
            pack name inside the detail nest under it. */}
        <h1 className="text-2xl font-semibold tracking-tight">{t("facetCurate.title")}</h1>
        <p className="text-xs text-muted-foreground mt-1">{t("facetCurate.subtitle")}</p>
      </header>

      {notice && (
        <p data-testid="facet-curate-notice" className="text-xs text-muted-foreground border border-border rounded-md px-3 py-2">
          {notice}
        </p>
      )}

      {usageError && (
        <p data-testid="facet-curate-usage-degraded" className="text-xs text-amber-600 border border-amber-600/30 bg-amber-500/5 rounded-md px-3 py-2">
          {t("facetCurate.usageDegraded", { message: usageError })}
        </p>
      )}

      {rows.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="facet-curate-empty">
          {t("facetCurate.empty")}
        </p>
      )}

      {rows.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
          {/* ── Master: the catalogue, searchable and narrowable ── */}
          <div className="border border-border rounded-lg">
            <div className="space-y-2 border-b border-border p-3">
              <div className="flex items-center gap-2">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runSearch()}
                  placeholder={t("facetCurate.searchPlaceholder")}
                  data-testid="facet-curate-search"
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                />
                <Button variant="outline" size="sm" onClick={runSearch}>
                  {t("common.search")}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2" data-testid="facet-curate-filters">
                <button
                  onClick={() => setOnlyUnclassified(false)}
                  aria-pressed={!onlyUnclassified}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    !onlyUnclassified ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t("facetCurate.allPacks")}
                </button>
                <button
                  onClick={() => setOnlyUnclassified(true)}
                  aria-pressed={onlyUnclassified}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    onlyUnclassified ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid="facet-curate-only-unclassified"
                >
                  {t("facetCurate.onlyUnclassified")}
                </button>
                <button
                  onClick={() => setOnlyGaps((v) => !v)}
                  aria-pressed={onlyGaps}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    onlyGaps ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                  data-testid="facet-curate-only-gaps"
                >
                  {t("facetCurate.onlyGaps")}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("facetCurate.unclassifiedCount", { count: unclassifiedTotal, total: rows.length })}
                {rows.length < total ? ` · ${t("facetCurate.loadedOf", { loaded: rows.length, total })}` : ""}
              </p>
            </div>

            <ul className="max-h-[calc(100vh-16rem)] divide-y divide-border overflow-auto" data-testid="facet-curate-list">
              {visible.map((p) => {
                const active = p.id === selectedId;
                const dirty = isDirty(p);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(p.id)}
                      data-testid={`facet-curate-row-${p.id}`}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-start justify-between gap-2 px-3 py-2 text-left transition-colors ${
                        active ? "bg-muted" : "hover:bg-muted/50"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                          <span className="truncate">{p.name}</span>
                          {dirty && (
                            <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-label={t("facetCurate.dirty")} data-testid={`facet-curate-dirty-${p.id}`} />
                          )}
                          {unclassified(p) && (
                            <span
                              className="rounded-full border border-amber-600/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                              data-testid={`facet-curate-unclassified-${p.id}`}
                            >
                              {t("facetCurate.unclassified")}
                            </span>
                          )}
                          {coverage?.[p.id] && (
                            <span
                              className={
                                coverage[p.id].missing.length > 0
                                  ? "rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning"
                                  : "rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                              }
                              data-testid={`facet-curate-coverage-${p.id}`}
                            >
                              {t("facetCurate.coverageBadge", { covered: coverage[p.id].covered, total: coverage[p.id].total })}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          v{p.version} · {p.authorEmail}
                          {p.unlisted ? ` · ${t("facetCurate.unlisted")}` : ""}
                          {p.visibility === "private" ? ` · ${t("facetCurate.private")}` : ""}
                        </span>
                      </span>
                      {coverage?.[p.id] && coverage[p.id].missing.length > 0 && (
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                          {t("facetCurate.gapCount", { count: coverage[p.id].missing.length })}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {rows.length < total && (
              <div className="border-t border-border p-2">
                <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()} data-testid="facet-curate-load-more">
                  {loadingMore
                    ? t("facetCurate.loading")
                    : t("facetCurate.loadMore", { remaining: total - rows.length })}
                </Button>
              </div>
            )}
          </div>

          {/* ── Detail: one pack, every axis, one Save ── */}
          <div className="min-w-0 border border-border rounded-lg p-4" data-testid="facet-curate-detail">
            {!selected ? (
              <p className="text-sm text-muted-foreground" data-testid="facet-curate-select-hint">
                {t("facetCurate.selectHint")}
              </p>
            ) : (
              <PackEditor
                key={selected.id}
                pack={selected}
                draft={draftOf(selected)}
                lines={lines}
                vocabulary={vocabulary}
                coverage={coverage?.[selected.id] ?? null}
                usage={usageOf(selected.id)}
                dirty={isDirty(selected)}
                saving={savingId === selected.id}
                onPatch={(patch) => patchDraft(selected, patch)}
                onSave={() => void save(selected)}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** One pack's editor: vocabulary-driven category, domain chips (≤3), the
 *  featured switch, the coverage gap list, and the usage line. Everything it
 *  shows is a fact the server returned; nothing is derived here. */
function PackEditor({
  pack,
  draft,
  lines,
  vocabulary,
  coverage,
  usage,
  dirty,
  saving,
  onPatch,
  onSave,
}: {
  pack: PackSummary;
  draft: Draft;
  lines: { slug: string; label: string; count: number }[];
  vocabulary: { slug: string; label: string }[];
  coverage: api.PackCoverageRow | null;
  usage: UsageRow | null;
  dirty: boolean;
  saving: boolean;
  onPatch: (patch: Partial<Draft>) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const stored = pack.category ?? "";
  const known = lines.some((l) => l.slug === stored);
  const toggleDomain = (slug: string) => {
    const current = draft.domains;
    // Cap at the contract's 3 (mirrors the server's DOMAIN_MAX); picking an
    // active chip removes it.
    const next = current.includes(slug)
      ? current.filter((d) => d !== slug)
      : current.length >= 3
        ? current
        : [...current, slug];
    onPatch({ domains: next });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">{pack.name}</h3>
        <span className="text-xs text-muted-foreground">
          v{pack.version} · {pack.authorEmail}
          {pack.unlisted ? ` · ${t("facetCurate.unlisted")}` : ""}
          {pack.visibility === "private" ? ` · ${t("facetCurate.private")}` : ""}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("facetCurate.categoryLabel")}</span>
          <select
            value={draft.category}
            onChange={(e) => onPatch({ category: e.target.value })}
            data-testid={`facet-curate-category-${pack.id}`}
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <option value="">{t("facetCurate.categoryNone")}</option>
            {lines.map((l) => (
              <option key={l.slug} value={l.slug}>
                {l.label}
              </option>
            ))}
            {/* A stored value outside the declared lines is shown as-is —
                presentation never silently retargets an unmapped category. */}
            {stored !== "" && !known && (
              <option value={stored}>{t("facetCurate.categoryLegacy", { value: stored })}</option>
            )}
          </select>
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">{t("facetCurate.featuredLabel")}</span>
          <button
            type="button"
            onClick={() => onPatch({ featured: !draft.featured })}
            aria-pressed={draft.featured}
            data-testid={`facet-curate-featured-${pack.id}`}
            className={`w-full rounded-md border px-2 py-1 text-xs transition-colors ${
              draft.featured ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"
            }`}
          >
            {draft.featured ? t("facetCurate.unfeature") : t("facetCurate.feature")}
          </button>
        </label>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">{t("facetCurate.domainsLabel")}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {vocabulary.length === 0 && (
            <span className="text-xs text-amber-600" data-testid={`facet-curate-vocab-missing-${pack.id}`}>
              {t("facetCurate.vocabUnavailable")}
            </span>
          )}
          {vocabulary.map((v) => {
            const active = draft.domains.includes(v.slug);
            return (
              <button
                key={v.slug}
                onClick={() => toggleDomain(v.slug)}
                aria-pressed={active}
                data-testid={`facet-curate-domain-${pack.id}-${v.slug}`}
                className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                  active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {v.label}
              </button>
            );
          })}
        </div>
      </div>

      {pack.line && (
        <p className="text-xs text-muted-foreground" data-testid={`facet-curate-line-${pack.id}`}>
          {t("facetCurate.lineResolved", { line: pack.lineLabel ?? pack.line })}
        </p>
      )}

      {coverage && (
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">{t("facetCurate.coverageLabel")}</span>
          {coverage.missing.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid={`facet-curate-coverage-full-${pack.id}`}>
              {t("facetCurate.coverageFull")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5" data-testid={`facet-curate-gaps-${pack.id}`}>
              {coverage.missing.slice(0, 12).map((fpath) => (
                <span key={fpath} className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {fpath}
                </span>
              ))}
              {coverage.missing.length > 12 && (
                <span className="text-xs text-muted-foreground">+{coverage.missing.length - 12}</span>
              )}
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground" data-testid={`facet-curate-usage-${pack.id}`}>
        {usage ? t("facetCurate.usage", { users: usage.activeUsers, turns: usage.turns }) : t("facetCurate.usageNone")}
      </p>

      <div className="flex items-center gap-3 border-t border-border pt-3">
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={onSave}
          data-testid={`facet-curate-save-${pack.id}`}
        >
          {saving ? t("facetCurate.saving") : t("facetCurate.save")}
        </Button>
        {dirty && <span className="text-xs text-warning">{t("facetCurate.dirty")}</span>}
      </div>
    </div>
  );
}

/** Structural skeleton matching a loaded board: a header line, a list column,
 *  and a detail panel. */
function BoardSkeleton() {
  return (
    <section className="space-y-4" data-testid="facet-curate-skeleton">
      <div className="h-6 w-40 animate-pulse rounded bg-muted" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="h-7 w-full animate-pulse rounded bg-muted" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-10 w-full animate-pulse rounded bg-muted" />
          ))}
        </div>
        <div className="space-y-3 rounded-lg border border-border p-4">
          <div className="h-5 w-48 animate-pulse rounded bg-muted" />
          <div className="h-7 w-full animate-pulse rounded bg-muted" />
          <div className="h-7 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
    </section>
  );
}
