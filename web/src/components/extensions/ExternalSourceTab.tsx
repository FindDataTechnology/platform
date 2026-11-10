// ExternalSourceTab.tsx — the external-market zone of the skills market shelf
// (add-external-skill-sources 刀一, install flow 刀二; a zone of the 商店 tab
// since settings-connect-center). One search box fans out server-side; results
// render grouped by source with per-source health captions. Installing is
// per-entry and consent-gated (刀二): every card carries the source badge, the
// license three-state chip, and the "not reviewed by this platform" mark.

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchExternalEntry,
  searchExternalSkills,
  type ExternalSkillEntry,
  type ExternalSourceGroup,
} from "@platform/core";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ExternalInstallDialog } from "@/components/extensions/ExternalInstallDialog";
import { Icon } from "@/components/ui/icon";

const LicenseChip = ({ state, licenseText }: { state: ExternalSkillEntry["licenseState"]; licenseText: string | null }) => {
  const { t } = useTranslation();
  const cls =
    state === "declared"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : state === "not-declared"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
        : "bg-muted text-muted-foreground";
  const label = t(`extensions.external.license.${state}`);
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs ${cls}`} title={licenseText ?? undefined}>
      {label}
    </span>
  );
};

const NotReviewedMark = () => {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
      {t("extensions.external.notReviewed")}
    </span>
  );
};

export function ExternalSourceTab() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [groups, setGroups] = useState<ExternalSourceGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<ExternalSkillEntry | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 刀二: the install consent flow's target (null = dialog closed).
  const [installTarget, setInstallTarget] = useState<{ source: string; slug: string } | null>(null);
  // Bumped on every open/close so a fetch that resolves after the dialog was
  // dismissed cannot re-open it with a late setDetail (live-probe regression:
  // Escape while "Loading…" → dialog popped back open ~1s later).
  const detailSeq = useRef(0);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setError("");
    try {
      const doc = await searchExternalSkills(q.trim());
      setGroups(doc.groups);
      setSearched(q.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    detailSeq.current += 1;
    setDetail(null);
    setDetailLoading(false);
  }, []);

  const openDetail = useCallback(async (entry: ExternalSkillEntry) => {
    const seq = ++detailSeq.current;
    setDetail(entry); // optimistic: card data renders immediately
    setDetailLoading(true);
    try {
      const out = await fetchExternalEntry(entry.source, entry.id);
      if (seq === detailSeq.current && out.entry) setDetail(out.entry);
    } catch {
      // Card data already on screen; the detail fetch failing must not blank it.
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, []);

  const fmtTime = (ts: number | null) =>
    ts ? new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "";

  return (
    <div className="space-y-4" data-testid="external-source-shelf">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">{t("extensions.external.title")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("extensions.external.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runSearch(query);
            }}
            placeholder={t("extensions.external.searchPlaceholder")}
            className="h-8 w-64 rounded-md border border-input bg-background px-3 text-sm"
            data-testid="external-source-search"
          />
          <button
            onClick={() => void runSearch(query)}
            disabled={loading || !query.trim()}
            className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50"
          >
            {loading ? t("common.loading") : t("extensions.external.searchButton")}
          </button>
        </div>
      </div>

      {error && <div className="rounded-md bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}

      {searched && !loading && groups.length === 0 && (
        <div className="text-sm text-muted-foreground">{t("extensions.external.empty")}</div>
      )}

      {groups.map((group) => (
        <div key={group.source} className="space-y-2" data-testid={`external-group-${group.source}`}>
          <div className="flex items-center gap-2 border-b border-border pb-1">
            <span className="text-sm font-medium">{group.sourceDisplayName}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {t("extensions.external.sourceBadge")}
            </span>
            {group.entries.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {t("extensions.external.resultCount", { count: group.entries.length })}
              </span>
            )}
            {group.stale && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                {t("extensions.external.stale", { time: fmtTime(group.snapshotAt) })}
              </span>
            )}
            {group.failed && <span className="text-xs text-destructive">{t("extensions.external.sourceFailed")}</span>}
          </div>
          {group.entries.map((entry) => (
            <button
              key={`${entry.source}:${entry.id}`}
              onClick={() => void openDetail(entry)}
              className="flex w-full flex-col items-start gap-1 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent/50"
              data-testid={`external-entry-${entry.source}-${entry.id}`}
            >
              <div className="flex w-full flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{entry.displayName}</span>
                <LicenseChip state={entry.licenseState} licenseText={entry.licenseText} />
                <NotReviewedMark />
                {entry.version && <span className="text-xs text-muted-foreground">v{entry.version}</span>}
              </div>
              {entry.description && (
                <p className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
              )}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {entry.downloads != null && (
                  <span className="inline-flex items-center gap-1">
                    <Icon name="download" className="h-3 w-3" />
                    {entry.downloads}
                  </span>
                )}
                {entry.stars != null && (
                  <span className="inline-flex items-center gap-1">
                    <Icon name="star" className="h-3 w-3" />
                    {entry.stars}
                  </span>
                )}
                {entry.tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="rounded bg-muted px-1.5 py-0.5">
                    {tag}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      ))}

      <Dialog open={detail !== null} onOpenChange={(open) => !open && closeDetail()}>
        <DialogContent className="max-w-lg" data-testid="external-entry-detail">
          <DialogHeader>
            <DialogTitle>{detail?.displayName}</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <LicenseChip state={detail.licenseState} licenseText={detail.licenseText} />
                <NotReviewedMark />
                {detail.version && (
                  <span className="text-xs text-muted-foreground">
                    {t("extensions.external.version", { version: detail.version })}
                    {detail.versionLayer ? ` · ${detail.versionLayer}` : ""}
                  </span>
                )}
              </div>
              {detail.description && <p className="whitespace-pre-wrap text-muted-foreground">{detail.description}</p>}
              {detail.originUrl && (
                <p className="text-xs">
                  <a
                    href={detail.originUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    {t("extensions.external.openUpstream")}
                  </a>
                </p>
              )}
              {detail.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {detail.tags.map((tag) => (
                    <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {detailLoading && <p className="text-xs text-muted-foreground">{t("common.loading")}</p>}
              {/* Install (刀二): the entry detail is the entry point; the flow
                  always passes through the consent panel (never installs from
                  here directly) and the server refuses an unconfirmed call
                  regardless of what the UI would have shown. */}
              <button
                onClick={() => setInstallTarget({ source: detail.source, slug: detail.id })}
                className="h-9 w-full rounded-md bg-primary text-sm text-primary-foreground"
                data-testid="external-install-button"
              >
                {t("extensions.external.install.button")}
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {installTarget && (
        <ExternalInstallDialog
          source={installTarget.source}
          slug={installTarget.slug}
          onOpenChange={(open) => !open && setInstallTarget(null)}
        />
      )}
    </div>
  );
}
