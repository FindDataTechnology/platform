// TeamDirectoryPage.tsx — the cross-user team directory (openspec:
// add-agent-team-directory, tasks 4.1–4.2).
//
// This is a READ door and nothing else: no composer, no "call this team"
// button, no queue. The spec draws that line on purpose (发现与调用是两个独立
// 的门) — an entry point here would silently promise a call path that does not
// exist yet, and the honest surface is a directory that says so.
//
// Honesty rules the page carries, each visible rather than inferred:
//   • 「空」 vs 「没采到」 — the sampling line names how many cells answered,
//     so an empty directory never reads as a broken one;
//   • a cell that did not answer is listed as degraded, not hidden;
//   • a stale cache says it is stale;
//   • `private` cards never reach this page (the gateway filters them), and a
//     deep read of one answers exactly like an unknown handle.
//
// The card body is the shared AgentSpecSheet in compact form — the same three-
// bucket vocabulary the market and the picker use. Nothing new is drawn.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { AgentSpecSheet } from "@/components/packs/AgentSpecSheet";
import { TeamCallDialog, type TeamCallTarget } from "@/components/fleet/TeamCallDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageShell } from "@/components/ui/page-shell";
import { StatusPill } from "@/components/ui/status-pill";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/states-kit";
import type { StatusKind } from "@/lib/statusTokens";

interface CardSkill {
  id: string;
  name: string;
}

interface CardPost {
  id: string;
  title: string;
}

interface TeamCard {
  name: string;
  description: string;
  version: number;
  capabilities: string[];
  skills: CardSkill[];
  posts: CardPost[];
  pricing: { callsPerDay: number; tokensPerDay: number; usdPerDay: number; currency: string; billedTo: string };
  availability: { state: string; accepting: boolean };
  trust: { publishedAt: number; cellId: string };
}

interface DirectoryEntry {
  handle: string;
  visibility: "listed" | "open";
  target: { kind: string; id: string };
  cellId: string;
  sampledAt: number;
  card: TeamCard;
  postsTruncated?: boolean;
}

interface DirectoryPayload {
  v: number;
  sampledAt: number;
  cells: { sampled: number; degraded: number };
  degradedCells: string[];
  cards: DirectoryEntry[];
  truncated: boolean;
  stale: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error((data as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
  return data as T;
}

/** Availability → the four-word vocabulary; the label always rides along. */
function availabilityStatus(card: TeamCard): StatusKind {
  if (card.availability.accepting) return "running";
  return card.availability.state === "paused" ? "paused" : "failed";
}

export function TeamDirectoryPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<DirectoryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  const [detail, setDetail] = useState<DirectoryEntry | null>(null);
  const [callTarget, setCallTarget] = useState<TeamCallTarget | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await getJson<DirectoryPayload>("/api/teams/directory");
      setData(body);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cards = useMemo(() => {
    const all = data?.cards ?? [];
    const needle = query.trim().toLowerCase();
    return all.filter((entry) => {
      if (openOnly && entry.visibility !== "open") return false;
      if (!needle) return true;
      return (
        entry.card.name.toLowerCase().includes(needle) ||
        entry.card.description.toLowerCase().includes(needle) ||
        entry.handle.toLowerCase().includes(needle) ||
        entry.card.posts.some((p) => p.title.toLowerCase().includes(needle))
      );
    });
  }, [data, query, openOnly]);

  const sampledLine = useMemo(() => {
    if (!data) return null;
    const at = new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(
      new Date(data.sampledAt),
    );
    return t("teamDirectory.sampled", { at, cells: data.cells.sampled, degraded: data.cells.degraded });
  }, [data, i18n.language, t]);

  const filters = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-[220px] flex-1">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("teamDirectory.searchPlaceholder")}
          aria-label={t("teamDirectory.searchPlaceholder")}
          data-testid="directory-search"
          className="h-9"
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="directory-open-only">
        <Switch checked={openOnly} onCheckedChange={setOpenOnly} />
        <span>{t("teamDirectory.openOnly")}</span>
      </label>
    </div>
  );

  return (
    <PageShell
      data-testid="team-directory-page"
      title={t("teamDirectory.title")}
      titleTestId="team-directory-title"
      subtitle={sampledLine}
      actions={
        <>
          {/* The third view of the teams nav, so the switch is symmetric: the
              hub links here, this page links back. One control, no second nav. */}
          <Button variant="ghost" size="sm" onClick={() => navigate("/fleets")} data-testid="directory-back-to-hub">
            {t("teamDirectory.backToTeams")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} data-testid="directory-refresh">
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t("teamDirectory.refresh")}
          </Button>
        </>
      }
      filters={filters}
    >
      <div className="space-y-4 pb-4">
        {/* Degradation and staleness are FACTS about the read, not errors: they
            sit above the list and never replace it. */}
        {data && data.stale && (
          <p className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground" data-testid="directory-stale">
            {t("teamDirectory.stale")}
          </p>
        )}
        {data && data.degradedCells.length > 0 && (
          <p className="rounded-md border border-border bg-card px-3 py-2 text-xs text-status-waiting" data-testid="directory-degraded">
            {t("teamDirectory.degraded", { n: data.degradedCells.length })}
          </p>
        )}
        {data?.truncated && (
          <p className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground" data-testid="directory-truncated">
            {t("teamDirectory.truncated")}
          </p>
        )}

        {loading && !data ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
            {["a", "b", "c", "d", "e", "f"].map((id) => (
              <div key={id} className="rounded-md border border-border bg-card p-4">
                <Skeleton className="mb-3 h-4 w-2/5" />
                <Skeleton className="mb-2 h-3 w-4/5" />
                <Skeleton className="h-3 w-3/5" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="py-10">
            <ErrorState
              message={t("teamDirectory.unavailable", { error })}
              onRetry={() => void load()}
              retryLabel={t("common.retry")}
            />
          </div>
        ) : cards.length === 0 ? (
          <div className="py-10">
            <EmptyState
              icon={<RefreshCw className="h-5 w-5" aria-hidden="true" />}
              title={data && data.cards.length > 0 ? t("teamDirectory.noMatch") : t("teamDirectory.empty")}
              hint={data && data.cards.length > 0 ? undefined : t("teamDirectory.emptyHint")}
              action={
                data && data.cards.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQuery("");
                      setOpenOnly(false);
                    }}
                  >
                    {t("teamDirectory.clearFilters")}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => navigate("/fleets")}>
                    {t("teamDirectory.emptyAction")}
                  </Button>
                )
              }
            />
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="directory-list">
            {cards.map((entry) => (
              <li key={`${entry.cellId}:${entry.handle}`}>
                <button
                  type="button"
                  onClick={() => setDetail(entry)}
                  data-testid={`directory-card-${entry.handle}`}
                  className="flex h-full w-full flex-col gap-3 rounded-md border border-border bg-card p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-semibold text-foreground">{entry.card.name}</span>
                    <StatusPill
                      className="shrink-0"
                      status={availabilityStatus(entry.card)}
                      label={t(`teamDirectory.availability.${entry.card.availability.state}`)}
                    />
                  </div>
                  {entry.card.description && (
                    <span className="line-clamp-2 text-xs leading-5 text-muted-foreground">{entry.card.description}</span>
                  )}
                  <AgentSpecSheet
                    variant="compact"
                    testIdPrefix={`directory-sheet-${entry.handle}`}
                    roles={entry.card.posts.map((p) => ({ id: p.id, name: p.title }))}
                    skillCount={entry.card.skills.length}
                  />
                  <span className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
                    <span className="truncate font-mono">{entry.handle}</span>
                    <span className="shrink-0 font-mono">
                      {t("teamDirectory.pricing.compact", {
                        calls: entry.card.pricing.callsPerDay,
                        usd: entry.card.pricing.usdPerDay,
                      })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-w-xl" data-testid="directory-detail">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span className="min-w-0 truncate">{detail.card.name}</span>
                  <StatusPill
                    className="shrink-0"
                    status={availabilityStatus(detail.card)}
                    label={t(`teamDirectory.availability.${detail.card.availability.state}`)}
                  />
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                {detail.card.description && <p className="text-sm leading-6 text-foreground">{detail.card.description}</p>}

                {/* Pricing is on the card for a reason (D5): a caller must be
                    able to see the boundary BEFORE deciding to call. */}
                <div className="rounded-md border border-border" data-testid="directory-detail-pricing">
                  <div className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">
                    {t("teamDirectory.pricing.title")}
                  </div>
                  <dl className="divide-y divide-border text-xs">
                    {(
                      [
                        ["calls", detail.card.pricing.callsPerDay],
                        ["tokens", detail.card.pricing.tokensPerDay],
                        ["usd", detail.card.pricing.usdPerDay],
                      ] as const
                    ).map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between px-3 py-2">
                        <dt className="text-muted-foreground">{t(`teamDirectory.pricing.${key}`)}</dt>
                        <dd className="font-mono text-foreground">{value.toLocaleString(i18n.language)}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                    {t("teamDirectory.pricing.billedTo")}
                  </p>
                </div>

                <div data-testid="directory-detail-posts">
                  <div className="mb-1.5 text-xs font-medium text-foreground">{t("teamDirectory.posts.title")}</div>
                  {detail.card.posts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("teamDirectory.posts.empty")}</p>
                  ) : (
                    <ul className="space-y-1">
                      {detail.card.posts.map((p) => (
                        <li key={p.id} className="flex items-baseline justify-between gap-3 text-xs">
                          <span className="text-foreground">{p.title}</span>
                          <span className="font-mono text-muted-foreground">{p.id}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.postsTruncated && (
                    <p className="mt-1 text-[11px] text-muted-foreground">{t("teamDirectory.posts.truncated")}</p>
                  )}
                </div>

                <p className="text-[11px] text-muted-foreground" data-testid="directory-detail-trust">
                  {t("teamDirectory.trust", {
                    cell: detail.cellId,
                    at: new Date(detail.card.trust.publishedAt).toLocaleString(i18n.language),
                  })}
                </p>
                <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">
                    {detail.visibility === "open" ? t("teamDirectory.callOpenHint") : t("teamDirectory.callListedHint")}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    data-testid="directory-call-open"
                    onClick={() =>
                      setCallTarget({ cellId: detail.cellId, handle: detail.handle, name: detail.card.name, visibility: detail.visibility })
                    }
                  >
                    {t("teamCall.open")}
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <TeamCallDialog
        open={callTarget !== null}
        onOpenChange={(open) => !open && setCallTarget(null)}
        target={callTarget}
      />
    </PageShell>
  );
}
