// TeamsOverviewBoard — cross-team aggregate read face (agent-teams-overview).
//
// Answers "how are ALL my teams doing right now", composed from the
// existing read endpoints — /api/fleets (roster + inline-edit fields),
// /api/fleets/overview (six-state distribution + top decisions),
// /api/fleets/owner/board (spend + last activity), and
// /api/fleets/owner/cross-line-spend (add-owner-cross-line-view: per-line
// cost groups) — each fetched independently and degraded independently: one
// failing source greys out only its own blocks with a retry, never the whole
// board (D2: no second state machine). Pure read face: cards navigate to the
// cockpit, nothing here writes.
//
// Abnormal teams (missing/vacant/failing posts) sort first, then by open
// decisions, then by last activity (spec: 异常上浮与排序沉睡).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { MiniFleetFormation } from "@/components/FleetGraph";
import { fetchCrossLineSpend, type CrossLineSpend } from "@/lib/fleet-owner-api";

interface RosterFleet {
  id: string;
  name: string;
  state: string;
  memberCount?: number;
  statusCounts?: Record<string, number>;
  openDecisions?: number;
  defaultModel?: string | null;
  spend?: { windows: Record<string, { runs: number; turns: number }> } | null;
}

interface OverviewFleet {
  id: string;
  counts: { onDuty: number; paused: number; missing: number; vacant: number; passive: number; failing: number; total: number };
  openDecisions: { count: number; top: { question: string; severity: string; memberTitle: string | null }[] };
  // Formation summary (add-teams-hub-formation-board): compact nodes + edges
  // from the same read the cockpit draws. Absent on older servers — the
  // formation view then says so instead of rendering an empty grid.
  formation?: {
    members: { id: string; title: string; targetKind?: string | null; status?: string | null }[];
    edges: { kind: string; from?: string | null; to?: string | null; implicit?: boolean }[];
    truncated: boolean;
  } | null;
}

interface BoardFleet {
  id: string;
  lastActivityAt: number | null;
  failing: number;
  openDecisions: number;
}

interface Source<T> {
  data: T | null;
  error: string | null;
}

const ABNORMAL_KEYS = ["missing", "vacant", "failing"] as const;

function isAbnormal(o?: OverviewFleet, b?: BoardFleet): boolean {
  const counts = o?.counts;
  if (counts && ABNORMAL_KEYS.some((k) => (counts[k] ?? 0) > 0)) return true;
  if ((b?.failing ?? 0) > 0) return true;
  return false;
}

function SourceError({ testId, onRetry }: { testId: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" data-testid={testId}>
      {t("agentTeams.overview.sourceUnavailable")}
      <Button variant="ghost" size="sm" className="h-5 px-2 text-xs" onClick={onRetry}>
        {t("agentTeams.overview.retry")}
      </Button>
    </span>
  );
}

// 跨线花费区 (add-owner-cross-line-view 2.2)：六格按线分组。任一线 degraded
// 只降级该格（错误说明+整路重试），unconnected 线渲染未连接+去连接入口；
// MUST NOT 渲染跨线总额（schema 无槽，前端也不加总）。深链=/boards/<line>。
const XLINES: { id: string; board: string | null; connect?: string }[] = [
  { id: "fleet", board: null },
  { id: "market", board: "facet" },
  { id: "wanxing", board: "wanxing" },
  { id: "lex", board: "lex", connect: "/settings/connections?panel=line-lex" },
  { id: "wire", board: "wire", connect: "/settings/connections?panel=line-wire-customer" },
  { id: "balance", board: null },
];

function metricText(line: string, metrics: Record<string, unknown> | null | undefined): string | null {
  if (!metrics || typeof metrics !== "object") return null;
  if (line === "fleet") {
    const runs = metrics.runs;
    return typeof runs === "number" ? `${runs} runs` : null;
  }
  if (line === "market") {
    const settled = metrics.settled;
    return typeof settled === "number" ? `${settled} settled` : null;
  }
  if (line === "wanxing") {
    if (metrics.available === false) return null;
    const usd = metrics.usd;
    return typeof usd === "number" ? `$${usd}` : null;
  }
  if (line === "lex") {
    const calls = metrics.usage_calls;
    return typeof calls === "number" ? `${calls} calls` : null;
  }
  if (line === "wire") {
    const ds = metrics.datasets;
    return typeof ds === "number" ? `${ds} datasets` : null;
  }
  if (line === "balance") {
    const usd = metrics.balance_usd;
    return typeof usd === "number" ? `$${usd}` : null;
  }
  return null;
}

function CrossLineSpendSection({
  xline,
  onRetry,
}: {
  xline: Source<CrossLineSpend>;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3" data-testid="teams-xline-spend">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium" data-testid="teams-xline-title">
          {t("agentTeams.overview.xlineTitle")}
        </span>
        {xline.error ? <SourceError testId="teams-xline-error" onRetry={onRetry} /> : null}
      </div>
      {xline.data ? (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {xline.data.lines.map((l) => {
            const unconnected = (l.metrics as { unconnected?: string } | null)?.unconnected;
            const text = unconnected ? null : metricText(l.line, l.metrics);
            const meta = XLINES.find((x) => x.id === l.line);
            return (
              <div
                key={l.line}
                data-testid={`teams-xline-${l.line}`}
                className={`rounded-md border p-2 text-xs ${l.status === "degraded" ? "border-destructive/40" : "border-border"}`}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium">{t(`agentTeams.overview.xline.${l.line}`)}</span>
                  <span className="text-muted-foreground">{t(`agentTeams.overview.xlineCalibre.${l.line}`)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-1">
                  {l.status === "degraded" ? (
                    <span className="text-destructive" data-testid={`teams-xline-${l.line}-error`}>
                      {l.error ? l.error.slice(0, 80) : t("agentTeams.overview.sourceUnavailable")}
                    </span>
                  ) : unconnected ? (
                    <span className="text-muted-foreground" data-testid={`teams-xline-${l.line}-unconnected`}>
                      {t("agentTeams.overview.xlineUnconnected", {
                        reason: t(`agentTeams.overview.xlineReason.${unconnected === "expired" ? "expired" : "not_connected"}`),
                      })}
                    </span>
                  ) : text ? (
                    <span data-testid={`teams-xline-${l.line}-value`}>{text}</span>
                  ) : (
                    <span className="text-muted-foreground" data-testid={`teams-xline-${l.line}-absent`}>
                      {t("agentTeams.overview.xlineNoData")}
                    </span>
                  )}
                  {unconnected && meta?.connect ? (
                    <a className="shrink-0 underline text-primary" href={meta.connect}>
                      {t("agentTeams.overview.xlineConnect")}
                    </a>
                  ) : meta?.board ? (
                    <a className="shrink-0 underline text-muted-foreground" href={`/boards/${meta.board}`}>
                      {t("agentTeams.overview.xlineBoard")}
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : !xline.error ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("agentTeams.overview.loading")}</p>
      ) : null}
    </div>
  );
}

export function TeamsOverviewBoard({
  roster,
  rosterError,
  onRetryRoster,
  onSelect,
  onOpenManage,
  onOpenOwner,
}: {
  roster: RosterFleet[];
  rosterError: string | null;
  onRetryRoster: () => void;
  onSelect: (fleetId: string) => void;
  onOpenManage: () => void;
  onOpenOwner: () => void;
}) {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<Source<OverviewFleet[]>>({ data: null, error: null });
  const [board, setBoard] = useState<Source<BoardFleet[]>>({ data: null, error: null });
  // 跨线花费第四路 (add-owner-cross-line-view 2.2)：与既有三路并列独立降级。
  const [xline, setXline] = useState<Source<CrossLineSpend>>({ data: null, error: null });
  // View mode (add-teams-hub-formation-board 2.2): card list ↔ formation grid.
  // Persisted per user; "cards" stays the default so the pre-change face is
  // byte-identical on first visit.
  const [view, setView] = useState<"cards" | "formation">(() => {
    try {
      const v = localStorage.getItem("teams.overview.view");
      return v === "formation" ? "formation" : "cards";
    } catch {
      return "cards";
    }
  });
  const setViewPersisted = (v: "cards" | "formation") => {
    setView(v);
    try {
      localStorage.setItem("teams.overview.view", v);
    } catch {
      /* storage blocked — the toggle just stops persisting */
    }
  };

  const loadOverview = useCallback(async () => {
    setOverview({ data: null, error: null });
    try {
      const r = await fetch("/api/fleets/overview");
      if (!r.ok) throw new Error(`overview ${r.status}`);
      const body = await r.json();
      setOverview({ data: body.fleets ?? [], error: null });
    } catch (e) {
      setOverview({ data: null, error: String((e as Error).message ?? e) });
    }
  }, []);

  const loadBoard = useCallback(async () => {
    setBoard({ data: null, error: null });
    try {
      const r = await fetch("/api/fleets/owner/board");
      if (!r.ok) throw new Error(`board ${r.status}`);
      const body = await r.json();
      setBoard({ data: body.fleets ?? [], error: null });
    } catch (e) {
      setBoard({ data: null, error: String((e as Error).message ?? e) });
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    void loadBoard();
  }, [loadOverview, loadBoard]);

  const loadXline = useCallback(async () => {
    setXline({ data: null, error: null });
    try {
      const body = await fetchCrossLineSpend();
      setXline({ data: body, error: null });
    } catch (e) {
      setXline({ data: null, error: String((e as Error).message ?? e) });
    }
  }, []);

  useEffect(() => {
    void loadXline();
  }, [loadXline]);

  const byId = useMemo(() => {
    const map = new Map<string, { o?: OverviewFleet; b?: BoardFleet }>();
    for (const o of overview.data ?? []) map.set(o.id, { ...map.get(o.id), o });
    for (const b of board.data ?? []) map.set(b.id, { ...map.get(b.id), b });
    return map;
  }, [overview.data, board.data]);

  const cards = useMemo(() => {
    return roster
      .map((f) => ({ f, o: byId.get(f.id)?.o, b: byId.get(f.id)?.b }))
      .sort((x, y) => {
        const ax = isAbnormal(x.o, x.b) ? 0 : 1;
        const ay = isAbnormal(y.o, y.b) ? 0 : 1;
        if (ax !== ay) return ax - ay;
        const dx = (x.b?.openDecisions ?? x.f.openDecisions ?? 0);
        const dy = (y.b?.openDecisions ?? y.f.openDecisions ?? 0);
        if (dx !== dy) return dy - dx;
        return (y.b?.lastActivityAt ?? 0) - (x.b?.lastActivityAt ?? 0);
      });
  }, [roster, byId]);

  // Summary strip renders from whichever sources succeeded — a failed source
  // contributes its block as unavailable, never a confident zero (spec: no
  // fake "0 异常" from a dead source).
  const totals = useMemo(() => {
    const decisions = roster.reduce((n, f) => n + (f.openDecisions ?? 0), 0);
    const abnormal = cards.filter((c) => isAbnormal(c.o, c.b)).length;
    const running = roster.filter((f) => f.state === "active").length;
    const runs24h = roster.reduce((n, f) => n + (f.spend?.windows?.["24h"]?.runs ?? 0), 0);
    const overviewKnown = overview.data !== null;
    return { decisions, abnormal, running, runs24h, overviewKnown, total: roster.length };
  }, [roster, cards, overview.data]);

  if (roster.length === 0 && !rosterError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16" data-testid="teams-overview-empty">
        <p className="text-sm text-muted-foreground">{t("agentTeams.overview.empty")}</p>
        <Button size="sm" onClick={onOpenManage} data-testid="teams-overview-empty-create">
          {t("fleets.create")}
        </Button>
        <p className="max-w-md text-center text-xs text-muted-foreground" data-testid="teams-overview-empty-builders">
          {t("agentTeams.overview.builderPointer")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="teams-overview">
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/30 px-4 py-3" data-testid="teams-summary-strip">
        <span className="text-sm font-medium">{t("agentTeams.overview.summaryTitle")}</span>
        <span className="text-sm" data-testid="teams-summary-total">
          {t("agentTeams.overview.total", { count: totals.total })}
        </span>
        <span className="text-sm" data-testid="teams-summary-running">
          {t("agentTeams.overview.running", { count: totals.running })}
        </span>
        <span className="text-sm" data-testid="teams-summary-abnormal">
          {totals.overviewKnown
            ? t("agentTeams.overview.abnormal", { count: totals.abnormal })
            : t("agentTeams.overview.abnormalUnknown")}
        </span>
        <span className="text-sm" data-testid="teams-summary-decisions">
          {t("agentTeams.overview.decisions", { count: totals.decisions })}
        </span>
        <span className="text-sm" data-testid="teams-summary-runs">
          {t("agentTeams.overview.runs24h", { count: totals.runs24h })}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {/* View switch (2.2): cards ↔ formation; the choice persists. */}
          <span className="flex overflow-hidden rounded-md border border-border" data-testid="teams-view-mode">
            {(["cards", "formation"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setViewPersisted(m)}
                data-testid={`teams-view-mode-${m}`}
                className={`px-2 py-0.5 text-xs ${view === m ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:bg-muted"}`}
              >
                {t(`agentTeams.overview.viewMode.${m}`)}
              </button>
            ))}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onOpenManage} data-testid="teams-goto-manage">
            {t("agentTeams.views.manage")}
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onOpenOwner} data-testid="teams-goto-owner">
            {t("agentTeams.views.owner")}
          </Button>
        </span>
      </div>

      {rosterError ? (
        <div className="flex items-center justify-between rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="teams-roster-error">
          <span>{rosterError}</span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onRetryRoster}>
            {t("agentTeams.overview.retry")}
          </Button>
        </div>
      ) : null}

      {/* 跨线花费第四路（独立降级）：失败只标注本区，不影响团队卡。 */}
      <CrossLineSpendSection xline={xline} onRetry={loadXline} />

      {view === "formation" ? (
        /* Formation grid (2.2): one mini formation per team from the SAME
           overview payload (single round-trip). Broken/absent posts show as
           ring colours on the dots (missing/vacant/failing = red/amber), so
           the breakage is visible without opening the cockpit (spec: 断线上板
           可见). Click = deep link into that cockpit (一点进驾驶舱). Degraded
           overview read marks THIS view unavailable with a retry (2.3); the
           card list keeps working — three-source independent degradation. */
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="teams-formation-grid">
          {overview.error ? (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <SourceError testId="teams-formation-error" onRetry={loadOverview} />
            </div>
          ) : null}
          {cards.map(({ f, o }) => {
            const abnormal = isAbnormal(o, undefined);
            const fm = o?.formation;
            return (
              <button
                key={f.id}
                type="button"
                data-testid={`teams-formation-${f.id}`}
                onClick={() => onSelect(f.id)}
                className={`rounded-md border p-3 text-left transition-colors hover:bg-muted/50 ${
                  abnormal ? "border-destructive/50" : "border-border"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{f.name}</span>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">{f.state}</span>
                </div>
                <div className="mt-2 flex min-h-16 items-center justify-center rounded-md bg-muted/20 p-2">
                  {overview.data === null && !overview.error ? (
                    <span className="text-xs text-muted-foreground">{t("agentTeams.overview.loading")}</span>
                  ) : fm ? (
                    fm.truncated || fm.members.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {fm.members.length === 0
                          ? t("agentTeams.overview.formationEmpty")
                          : t("agentTeams.overview.formationTruncated", { count: fm.members.length })}
                      </span>
                    ) : (
                      <MiniFleetFormation members={fm.members} edges={fm.edges} />
                    )
                  ) : (
                    <span className="text-xs text-muted-foreground">{t("agentTeams.overview.formationUnavailable")}</span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{t("agentTeams.overview.members", { count: f.memberCount ?? 0 })}</span>
                  <span data-testid={`teams-formation-decisions-${f.id}`}>
                    {t("agentTeams.overview.decisions", { count: f.openDecisions ?? 0 })}
                  </span>
                  {o && ABNORMAL_KEYS.filter((k) => (o.counts[k] ?? 0) > 0).map((k) => (
                    <span key={k} className="rounded-full bg-destructive/15 px-2 py-0.5 text-destructive">
                      {t(`agentTeams.overview.state.${k}`, { count: o.counts[k] })}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="teams-cards">
        {cards.map(({ f, o, b }) => {
          const abnormal = isAbnormal(o, b);
          return (
            <button
              key={f.id}
              type="button"
              data-testid={`teams-card-${f.id}`}
              onClick={() => onSelect(f.id)}
              className={`rounded-md border p-3 text-left transition-colors hover:bg-muted/50 ${
                abnormal ? "border-destructive/50" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{f.name}</span>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs">{f.state}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{t("agentTeams.overview.members", { count: f.memberCount ?? 0 })}</span>
                <span data-testid={`teams-card-decisions-${f.id}`}>
                  {t("agentTeams.overview.decisions", { count: f.openDecisions ?? 0 })}
                </span>
                {b?.lastActivityAt ? (
                  <span>{t("agentTeams.overview.lastActivity", { time: new Date(b.lastActivityAt).toLocaleString() })}</span>
                ) : null}
                {f.spend?.windows?.["24h"] ? (
                  <span>{t("agentTeams.overview.runs24h", { count: f.spend.windows["24h"].runs })}</span>
                ) : null}
              </div>
              <div className="mt-2">
                {o ? (
                  <div className="flex flex-wrap gap-1 text-xs" data-testid={`teams-card-states-${f.id}`}>
                    {ABNORMAL_KEYS.filter((k) => (o.counts[k] ?? 0) > 0).map((k) => (
                      <span key={k} className="rounded-full bg-destructive/15 px-2 py-0.5 text-destructive">
                        {t(`agentTeams.overview.state.${k}`, { count: o.counts[k] })}
                      </span>
                    ))}
                    <span className="rounded-full bg-muted px-2 py-0.5">
                      {t("agentTeams.overview.onDuty", { count: o.counts.onDuty ?? 0 })}
                    </span>
                  </div>
                ) : overview.error ? (
                  <SourceError testId={`teams-card-states-error-${f.id}`} onRetry={loadOverview} />
                ) : (
                  <span className="text-xs text-muted-foreground">{t("agentTeams.overview.loading")}</span>
                )}
              </div>
              {(o?.openDecisions.top?.length ?? 0) > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground" data-testid={`teams-card-top-decisions-${f.id}`}>
                  {o!.openDecisions.top.slice(0, 2).map((d) => (
                    <li key={d.question} className="truncate">
                      • {d.question}
                    </li>
                  ))}
                </ul>
              ) : null}
            </button>
          );
        })}
      </div>
      )}
    </div>
  );
}
