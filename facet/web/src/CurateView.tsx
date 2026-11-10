// 策展板 — the facet curation board (add-facet-content-management), the
// admin surface that finally makes 谦面's content manageable in its own
// domain: every pack (unlisted and private included, via the admin viewer),
// inline category/featured writes, and per-pack usage from the platform
// gateway's aggregate (weekly actives / turns — the M1 exit metric). Usage
// degrades honestly; curation never depends on it. Presentation-level only:
// curation never changes visibility, content, or installability.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackSummary } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";

type UsageRow = { packId: string | null; turns: number; activeUsers: number; lastUsedAt: number };

export function CurateView() {
  const { t } = useTranslation();
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Domain axis (overhaul-market-catalog-presentation P1 2.7): the picker's
  // source is the DECLARED vocabulary from the facets endpoint (zero-count
  // values included) — never free text. Per-row drafts hold a slug set.
  const [vocabulary, setVocabulary] = useState<{ slug: string; label: string }[]>([]);
  const [domainDrafts, setDomainDrafts] = useState<Record<string, string[]>>({});
  // Unclassified to-do (P1 2.6): packs with no domain declaration are the
  // curation backlog; the board can be narrowed to just those.
  const [onlyUnclassified, setOnlyUnclassified] = useState(false);
  // 覆盖度看板 (overhaul-market-catalog-presentation 5.4): the operations patrol
  // face — per-pack en coverage of the org surface from the server's one
  // denominator. Non-blocking: a failed read hides the badges, curation itself
  // never depends on it (same posture as the usage aggregate).
  const [coverage, setCoverage] = useState<Record<string, api.PackCoverageRow> | null>(null);
  const [onlyGaps, setOnlyGaps] = useState(false);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const r = await api.listPacks({ pageSize: 100 });
      setPacks(r.packs);
    } catch (err) {
      setPacks([]);
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api
      .getPackUsageBoard()
      .then((r) => setUsage(r.rows))
      .catch((e: Error) => setUsageError(e.message));
    api
      .getPackFacets()
      .then((f) => setVocabulary(f.vocabulary ?? []))
      .catch(() => setVocabulary([])); // picker degrades to unavailable, never to free text
    api
      .getPackCoverageBoard()
      .then((r) => setCoverage(Object.fromEntries(r.packs.map((row) => [row.id, row]))))
      .catch(() => setCoverage(null)); // patrol face degrades silently; never blocks curation
  }, [refresh]);

  const save = async (pack: PackSummary, body: { category?: string; featured?: boolean; domains?: string[] }) => {
    try {
      await api.setPackCuration(pack.id, body);
      setNotice(t("facetCurate.saved", { name: pack.name }));
      await refresh();
    } catch (err) {
      setNotice(t("facetCurate.saveFailed", { name: pack.name, message: (err as Error).message }));
    }
  };

  const usageOf = (id: string) => usage?.find((r) => r.packId === id) ?? null;

  const domainsOf = (p: PackSummary) => domainDrafts[p.id] ?? p.domains ?? [];
  const toggleDomain = (p: PackSummary, slug: string) => {
    const current = domainsOf(p);
    // Cap at the contract's 3 (mirrors the server's DOMAIN_MAX); picking an
    // active chip removes it.
    const next = current.includes(slug)
      ? current.filter((d) => d !== slug)
      : current.length >= 3
        ? current
        : [...current, slug];
    setDomainDrafts((d) => ({ ...d, [p.id]: next }));
  };
  const unclassified = (p: PackSummary) => (p.domains ?? []).length === 0;
  const hasGap = (p: PackSummary) => (coverage?.[p.id]?.missing.length ?? 0) > 0;
  // Two independent narrowing axes (unclassified backlog / en-coverage gaps).
  // The gap axis is a no-op when coverage failed to load (degrades silent).
  let visible = packs;
  if (visible && onlyUnclassified) visible = visible.filter(unclassified);
  if (visible && onlyGaps && coverage) visible = visible.filter(hasGap);

  if (!packs) return <BoardSkeleton />;
  if (loadError)
    return (
      <div className="text-sm text-destructive space-y-2" data-testid="facet-curate-error">
        <p>{t("facetCurate.errorLoad", { message: loadError })}</p>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          {t("common.retry")}
        </Button>
      </div>
    );

  return (
    <section data-testid="facet-curate-view" className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold">{t("facetCurate.title")}</h2>
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

      {packs.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="facet-curate-empty">
          {t("facetCurate.empty")}
        </p>
      )}

      {packs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="facet-curate-filters">
          <button
            onClick={() => setOnlyUnclassified(false)}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              !onlyUnclassified ? "border-primary text-primary" : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("facetCurate.allPacks")}
          </button>
          <button
            onClick={() => setOnlyUnclassified(true)}
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
          <span className="text-xs text-muted-foreground">
            {t("facetCurate.unclassifiedCount", { count: packs.filter(unclassified).length, total: packs.length })}
          </span>
        </div>
      )}

      <div className="grid gap-3">
        {(visible ?? []).map((p) => {
          const u = usageOf(p.id);
          return (
            <div key={p.id} data-testid={`facet-curate-row-${p.id}`} className="border border-border rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-medium text-foreground flex items-center gap-1.5">
                  {p.name}
                  {unclassified(p) && (
                    <span
                      className="rounded-full border border-amber-600/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
                      data-testid={`facet-curate-unclassified-${p.id}`}
                    >
                      {t("facetCurate.unclassified")}
                    </span>
                  )}
                  {coverage?.[p.id] && (
                    <span
                      className={
                        coverage[p.id].missing.length > 0
                          ? "rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 font-mono text-[10px] text-warning"
                          : "rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                      }
                      data-testid={`facet-curate-coverage-${p.id}`}
                    >
                      {t("facetCurate.coverageBadge", { covered: coverage[p.id].covered, total: coverage[p.id].total })}
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  v{p.version} · {p.authorEmail}
                  {p.unlisted ? ` · ${t("facetCurate.unlisted")}` : ""}
                  {p.visibility === "private" ? ` · ${t("facetCurate.private")}` : ""}
                  {u ? ` · ${t("facetCurate.usage", { users: u.activeUsers, turns: u.turns })}` : ""}
                </span>
              </div>
              {/* 缺项清单 (5.4): field paths, precise to the entry the workbench
                  would jump to — the patrol face names what to fix, not a bar. */}
              {coverage?.[p.id] && coverage[p.id].missing.length > 0 && (
                <div className="flex flex-wrap gap-1.5" data-testid={`facet-curate-gaps-${p.id}`}>
                  {coverage[p.id].missing.slice(0, 8).map((fpath) => (
                    <span key={fpath} className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {fpath}
                    </span>
                  ))}
                  {coverage[p.id].missing.length > 8 && (
                    <span className="text-[10px] text-muted-foreground">+{coverage[p.id].missing.length - 8}</span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={drafts[p.id] ?? p.category ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                  placeholder={t("facetCurate.categoryPlaceholder")}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs w-56"
                  data-testid={`facet-curate-category-${p.id}`}
                />
                <Button variant="outline" size="sm" onClick={() => void save(p, { category: (drafts[p.id] ?? p.category ?? "").trim() })}>
                  {t("facetCurate.setCategory")}
                </Button>
                {/* The resolved line (read-only): what the browse strip will
                    actually group this slug under. */}
                {p.line ? (
                  <span className="text-xs text-muted-foreground" data-testid={`facet-curate-line-${p.id}`}>
                    {t("facetCurate.lineResolved", { line: p.lineLabel ?? p.line })}
                  </span>
                ) : null}
                <Button
                  variant={p.featured ? "default" : "outline"}
                  size="sm"
                  onClick={() => void save(p, { featured: !p.featured })}
                  data-testid={`facet-curate-featured-${p.id}`}
                >
                  {p.featured ? t("facetCurate.unfeature") : t("facetCurate.feature")}
                </Button>
              </div>
              {/* Domain picker (P1 2.7): vocabulary only — no free-text slug
                  input exists on this board. */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{t("facetCurate.domainsLabel")}</span>
                {vocabulary.length === 0 && (
                  <span className="text-xs text-amber-600" data-testid={`facet-curate-vocab-missing-${p.id}`}>
                    {t("facetCurate.vocabUnavailable")}
                  </span>
                )}
                {vocabulary.map((v) => {
                  const active = domainsOf(p).includes(v.slug);
                  return (
                    <button
                      key={v.slug}
                      onClick={() => toggleDomain(p, v.slug)}
                      data-testid={`facet-curate-domain-${p.id}-${v.slug}`}
                      className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                        active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {v.label}
                    </button>
                  );
                })}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={vocabulary.length === 0 || (domainDrafts[p.id] === undefined)}
                  onClick={() => void save(p, { domains: domainsOf(p) })}
                  data-testid={`facet-curate-save-domains-${p.id}`}
                >
                  {t("facetCurate.saveDomains")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Structural skeleton matching a loaded row: title line + meta line + control line. */
function BoardSkeleton() {
  return (
    <section className="space-y-4" data-testid="facet-curate-skeleton">
      <div className="h-6 w-40 animate-pulse rounded bg-muted" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-border rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-4 w-48 animate-pulse rounded bg-muted" />
          </div>
          <div className="flex gap-2">
            <div className="h-7 w-56 animate-pulse rounded-md bg-muted" />
            <div className="h-7 w-24 animate-pulse rounded-md bg-muted" />
            <div className="h-7 w-24 animate-pulse rounded-md bg-muted" />
          </div>
        </div>
      ))}
    </section>
  );
}
