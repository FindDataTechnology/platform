// Bound-chart affordances for the resources page (spec: resource-library-ui,
// openspec: add-chart-data-binding).
//
// Three small surfaces, composed by the card:
//
//   ChartBindingBar   — one row per bound series: the source line
//                       (server · tool · as-of age), refresh, the stale badge
//                       with its localized reason, and unbind. An unbound chart
//                       renders none of this.
//   ChartBindPicker   — the confirmation path: this turn's calls, offered as
//                       candidates, with the map each would bind.
//   ChartTimeline     — the refresh log with an observation-time filter and the
//                       as-of view (reconstructed server-side, rendered through
//                       the same EChart), with one action back to the present.
//
// Version skew is a first-class case: a cell older than this capability sends
// no `bindings` field and 404s the new routes, so every affordance here is
// behind "does this cell know about bindings" and a 404 hides it silently
// instead of surfacing an error.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  asOfMoment,
  detachBinding,
  listBindingCandidates,
  listObservations,
  refreshBinding,
  staleReasonKey,
  type BindingCandidate,
  type ChartBindingView,
  type RefreshObservation,
  type Resource,
} from "@platform/core";
import { showToast } from "@/components/Toast";

type SeriesBinding = ChartBindingView & { seriesIndex: number };

// ── shared bits ─────────────────────────────────────────────────────────────

/** "3 分钟前" from an ISO moment — the source line's age, never a raw stamp. */
function useAgeLabel() {
  const { t } = useTranslation();
  return useCallback(
    (iso: string | null): string | null => {
      if (!iso) return null;
      const ms = Date.now() - Date.parse(iso);
      if (!Number.isFinite(ms)) return null;
      const minutes = Math.max(0, Math.round(ms / 60000));
      if (minutes < 1) return t("resources.binding.ageNow");
      if (minutes < 60) return t("resources.binding.ageMinutes", { count: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t("resources.binding.ageHours", { count: hours });
      const days = Math.round(hours / 24);
      return t("resources.binding.ageDays", { count: days });
    },
    [t],
  );
}

/** A localized short moment for timeline rows. */
function useMoment() {
  const { i18n } = useTranslation();
  return useCallback(
    (iso: string | null): string => {
      if (!iso) return "";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "";
      return date.toLocaleString(i18n.language, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    },
    [i18n.language],
  );
}

/** Refusals the UI shows inline: a refresh outcome with a reason, not an error. */
function refreshMessageKey(reason: string | null | undefined): string | null {
  const specific = staleReasonKey(reason);
  if (specific) return `resources.binding.reason.${specific}`;
  if (reason === "ttl") return "resources.binding.reason.fresh";
  return null;
}

// ── the binding bar ─────────────────────────────────────────────────────────

export function ChartBindingBar({
  resource,
  binding,
  seriesCount,
  window: periodWindow,
  shown,
  onWindow,
  onChanged,
  onTimeline,
  timelineOpen,
}: {
  resource: Resource;
  binding: SeriesBinding;
  seriesCount: number;
  window: string;
  /** Periods currently rendered — the window's effect, worth showing. */
  shown: number;
  onWindow: (next: "6m" | "1y" | "all") => void;
  onChanged: () => void;
  onTimeline: () => void;
  timelineOpen: boolean;
}) {
  const { t } = useTranslation();
  const age = useAgeLabel();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const asOf = age(asOfMoment(binding));
  const sourceLine = [binding.server, binding.tool].filter(Boolean).join(" · ");
  const reasonKey = binding.stale ? refreshMessageKey(binding.staleReason) : null;

  const doRefresh = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await refreshBinding(resource.id, binding.id, { trigger: "manual" });
      if (result.ok) {
        const counts = result.counts;
        setNotice(
          counts && counts.appended + counts.revised + counts.resourced > 0
            ? t("resources.binding.refreshed", {
                added: counts.appended,
                revised: counts.revised + counts.resourced,
              })
            : t("resources.binding.refreshUnchanged"),
        );
      } else {
        const key = refreshMessageKey(result.reason);
        setNotice(key ? t(key) : (result.error ?? t("resources.binding.refreshFailed")));
      }
      onChanged();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doUnbind = async () => {
    if (!window.confirm(t("resources.binding.unbindConfirm"))) return;
    setBusy(true);
    try {
      await detachBinding(resource.id, binding.id);
      onChanged();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mt-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs"
      data-testid="binding-bar"
      data-binding-id={binding.id}
      data-binding-series={binding.seriesIndex}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground" data-testid="binding-source">
          {seriesCount > 1 ? `${t("resources.binding.series", { index: binding.seriesIndex + 1 })} ` : ""}
          {sourceLine}
          {asOf ? ` · ${t("resources.binding.asOf", { age: asOf })}` : ""}
        </span>
        {binding.stale ? (
          <span
            className="rounded-full bg-destructive/15 px-2 py-0.5 text-destructive"
            data-testid="binding-stale"
            title={reasonKey ? t(reasonKey) : (binding.staleReason ?? "")}
          >
            {t("resources.binding.stale")}
            {reasonKey ? ` · ${t(reasonKey)}` : ""}
          </span>
        ) : null}
        {!binding.refreshable ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground" data-testid="binding-not-refreshable">
            {t("resources.binding.notRefreshable")}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {binding.refreshable ? (
            <button
              type="button"
              className="rounded-md border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
              onClick={() => void doRefresh()}
              disabled={busy}
              data-testid="binding-refresh"
            >
              {busy ? t("resources.binding.refreshing") : t("resources.binding.refresh")}
            </button>
          ) : null}
          <button
            type="button"
            className={`rounded-md border border-border px-2 py-0.5 hover:bg-muted ${timelineOpen ? "bg-primary/15" : ""}`}
            onClick={onTimeline}
            data-testid="binding-timeline-toggle"
          >
            {t("resources.binding.timeline")}
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            onClick={() => void doUnbind()}
            disabled={busy}
            data-testid="binding-unbind"
          >
            {t("resources.binding.unbind")}
          </button>
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground">{t("resources.binding.periodLabel")}</span>
        {(["6m", "1y", "all"] as const).map((key) => (
          <button
            key={key}
            type="button"
            className={`rounded-md px-2 py-0.5 ${
              periodWindow === key ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"
            }`}
            onClick={() => onWindow(key)}
            data-testid={`binding-period-${key}`}
          >
            {t(`resources.binding.period.${key}`)}
          </button>
        ))}
        <span className="ml-auto text-muted-foreground" data-testid="binding-periods">
          {t("resources.binding.periodCount", { count: binding.periods })}
        </span>
        <span className="text-muted-foreground" data-testid="binding-periods-shown" data-shown={shown}>
          {t("resources.binding.periodShown", { count: shown })}
        </span>
      </div>
      {notice ? (
        <div className="mt-1 text-muted-foreground" data-testid="binding-notice">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

// ── the confirmation path ───────────────────────────────────────────────────

export function ChartBindPicker({ resource, onChanged }: { resource: Resource; onChanged: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<BindingCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setCandidates(await listBindingCandidates(resource.id));
    } catch {
      // An older cell 404s this route: the affordance hides, nothing is shown.
      setCandidates([]);
    }
  }, [resource.id]);

  useEffect(() => {
    if (open && candidates === null) void load();
  }, [open, candidates, load]);

  if (!open) {
    return (
      <button
        type="button"
        className="mt-2 self-start rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
        onClick={() => setOpen(true)}
        data-testid="binding-bind-open"
      >
        {t("resources.binding.bindAction")}
      </button>
    );
  }

  const attach = async (index: number) => {
    setBusy(true);
    try {
      const { attachBinding } = await import("@platform/core");
      await attachBinding(resource.id, { candidateIndex: index });
      setOpen(false);
      setCandidates(null);
      onChanged();
    } catch (err) {
      showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs" data-testid="binding-picker">
      <div className="flex items-center gap-2">
        <span className="font-medium">{t("resources.binding.pickTitle")}</span>
        <button
          type="button"
          className="ml-auto rounded-md border border-border px-2 py-0.5 hover:bg-muted"
          onClick={() => setOpen(false)}
          data-testid="binding-pick-cancel"
        >
          {t("resources.binding.cancel")}
        </button>
      </div>
      {candidates === null ? (
        <div className="mt-1 text-muted-foreground">{t("resources.loading")}</div>
      ) : candidates.length === 0 ? (
        <div className="mt-1 text-muted-foreground" data-testid="binding-pick-empty">
          {t("resources.binding.pickEmpty")}
        </div>
      ) : (
        <ul className="mt-1 space-y-1">
          {candidates.map((candidate, index) => (
            <li key={`${candidate.name}:${JSON.stringify(candidate.args)}`} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                {candidate.tool}
                <span className="text-muted-foreground"> {JSON.stringify(candidate.args)}</span>
              </span>
              {candidate.points != null ? (
                <span className="shrink-0 text-muted-foreground">
                  {t("resources.binding.pickPoints", { count: candidate.points })}
                </span>
              ) : null}
              <button
                type="button"
                className="shrink-0 rounded-md border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
                onClick={() => void attach(index)}
                disabled={busy || !candidate.allowlisted}
                title={candidate.allowlisted ? undefined : t("resources.binding.notRefreshable")}
                data-testid={`binding-pick-attach-${index}`}
              >
                {t("resources.binding.attach")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── the observation timeline ────────────────────────────────────────────────

const TIMELINE_FILTERS = [
  { key: "24h", hours: 24 },
  { key: "7d", hours: 24 * 7 },
  { key: "30d", hours: 24 * 30 },
  { key: "all", hours: 0 },
] as const;

type TimelineFilter = (typeof TIMELINE_FILTERS)[number]["key"];

function outcomeKey(observation: RefreshObservation): string {
  const known = ["ok", "unchanged", "skipped_fresh", "error"];
  return known.includes(observation.outcome) ? observation.outcome : "error";
}

export function ChartTimeline({
  resource,
  onView,
}: {
  resource: Resource;
  onView: (at: string | null) => void;
}) {
  const { t } = useTranslation();
  const moment = useMoment();
  const [filter, setFilter] = useState<TimelineFilter>("7d");
  const [rows, setRows] = useState<RefreshObservation[] | null>(null);
  const [activeAt, setActiveAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    const spec = TIMELINE_FILTERS.find((f) => f.key === filter);
    const since =
      spec && spec.hours > 0 ? new Date(Date.now() - spec.hours * 3600 * 1000).toISOString() : undefined;
    try {
      const page = await listObservations(resource.id, { since, limit: 50 });
      setRows(page.items);
    } catch {
      setRows([]);
    }
  }, [resource.id, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mt-2 rounded-md border border-border bg-background px-2 py-2 text-xs" data-testid="binding-timeline">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("resources.binding.timelineTitle")}</span>
        {TIMELINE_FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className={`rounded-md px-2 py-0.5 ${
              filter === entry.key ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted"
            }`}
            onClick={() => setFilter(entry.key)}
            data-testid={`timeline-filter-${entry.key}`}
          >
            {t(`resources.binding.window.${entry.key}`)}
          </button>
        ))}
        {activeAt ? (
          <button
            type="button"
            className="ml-auto rounded-md bg-primary/15 px-2 py-0.5 text-primary"
            onClick={() => {
              setActiveAt(null);
              onView(null);
            }}
            data-testid="timeline-back-to-current"
          >
            {t("resources.binding.backToCurrent")}
          </button>
        ) : null}
      </div>

      {activeAt ? (
        <div className="mt-1 text-primary" data-testid="timeline-asof-banner">
          {t("resources.binding.viewingAsOf", { moment: moment(activeAt) })}
        </div>
      ) : null}

      {rows === null ? (
        <div className="mt-1 text-muted-foreground">{t("resources.loading")}</div>
      ) : rows.length === 0 ? (
        <div className="mt-1 text-muted-foreground" data-testid="timeline-empty">
          {t("resources.binding.timelineEmpty")}
        </div>
      ) : (
        <ul className="mt-1 space-y-1">
          {rows.map((row) => {
            const counts = [
              ["added", row.added],
              ["revised", row.revised],
              ["resourced", row.resourced],
              ["unchanged", row.unchanged],
              ["missing", row.missing],
              ["anomalies", row.anomalies],
            ].filter(([, value]) => Number(value) > 0) as [string, number][];
            const changed = row.added + row.revised + row.resourced > 0;
            const stale = row.outcome === "error";
            return (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border/60 pt-1 first:border-0 first:pt-0"
                data-testid="timeline-row"
                data-outcome={row.outcome}
              >
                <span className="text-muted-foreground">{moment(row.fetchedAt)}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-muted-foreground">
                  {t(`resources.binding.trigger.${row.trigger === "on-open" ? "onOpen" : row.trigger}`, {
                    defaultValue: row.trigger,
                  })}
                </span>
                <span className={stale ? "text-destructive" : ""}>
                  {t(`resources.binding.outcome.${outcomeKey(row)}`)}
                </span>
                {counts.length ? (
                  <span className="text-muted-foreground">
                    {counts
                      .map(([key, value]) => t(`resources.binding.count.${key}`, { count: value }))
                      .join(" · ")}
                  </span>
                ) : null}
                {stale && row.error ? <span className="text-destructive">{row.error}</span> : null}
                {changed ? (
                  <button
                    type="button"
                    className="ml-auto rounded-md border border-border px-2 py-0.5 hover:bg-muted"
                    onClick={() => {
                      setActiveAt(row.fetchedAt);
                      onView(row.fetchedAt);
                    }}
                    data-testid="timeline-view-asof"
                  >
                    {t("resources.binding.viewAsOf")}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}