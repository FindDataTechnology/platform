// Run timeline (agent-fleet-cockpit v2 face 2) — langfuse-shaped replay.
//
// Left: the paged run list (filter by status / root source; v1-era turns
// carry no run and never appear). Selected run: a swimlane waterfall — one
// lane per member, turns as duration bars, chain hops (dispatch/handoff/
// fanout) as lane-to-lane connectors, tool calls as nested spans under their
// turn (joined from the trace store via traceTurnId; an absent trace is
// labeled, never faked). The slider scrubs the replay cursor: while held,
// the canvas above replays node/edge state at that instant (store.replayAt);
// releasing returns to live.
//
// Self-drawn CSS grid + SVG (D7): no second graph lib.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  cancelRun,
  getRun,
  getTurnTrace,
  listRuns,
  toolSpansOf,
  type RunDetail,
  type RunListEntry,
  type ToolSpan,
} from "@/api/fleets-api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusPill } from "@/components/ui/status-pill";
import { useFleetStore } from "@/store/fleet-store";

const PAGE = 20;
const LANE_H = 34;
const BAR_H = 14;
const SPAN_H = 6;

const STATUS_BAR: Record<string, string> = {
  ok: "bg-success/70",
  failed: "bg-destructive/80",
  interrupted: "bg-amber-500/70",
};

function fmtDur(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtTok(u: { input: number | null; output: number | null } | null): string {
  if (!u || (u.input == null && u.output == null)) return "—";
  return `${u.input ?? 0}+${u.output ?? 0}`;
}

export function RunTimeline({ fleetId, memberTitles }: { fleetId: string; memberTitles: Map<string, string> }) {
  const { t } = useTranslation();
  const runsVersion = useFleetStore((s) => s.runsVersion);
  const replayAt = useFleetStore((s) => s.replayAt);
  const setReplayAt = useFleetStore((s) => s.setReplayAt);
  const setReplayTurns = useFleetStore((s) => s.setReplayTurns);

  const [runs, setRuns] = useState<RunListEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [memberFilter, setMemberFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [spans, setSpans] = useState<Record<string, ToolSpan[]>>({});
  const [error, setError] = useState<string | null>(null);
  // Stop-a-run (explore P2-6): confirmation FIRST — this interrupts live turns,
  // and an irreversible-feeling action must not be one stray click away.
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);

  // Auto-select the newest run on the FIRST successful list load only
  // (add-cockpit-ux-polish): the waterfall is immediately visible without an
  // extra click; later runs arriving (runsVersion bumps) never jump the
  // user's current selection. The gate resets when the fleet changes.
  const didAutoSelect = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fleetId is the reset trigger — a fleet switch must clear the gate and the selection even though the effect body reads neither
  useEffect(() => {
    didAutoSelect.current = false;
    setSelected(null);
  }, [fleetId]);

  const title = useCallback((id: string) => memberTitles.get(id) ?? id, [memberTitles]);

  // List refresh: on mount, on filter/page change, and whenever a run header
  // opens or closes (fleet_run_updated bumps runsVersion).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runsVersion is the intentional external refresh trigger (fleet_run_updated), not a value this effect reads
  useEffect(() => {
    let alive = true;
    listRuns(fleetId, { status: status || undefined, source: source || undefined, limit: PAGE, offset })
        .then((body) => {
          if (!alive) return;
          setRuns(body.runs);
          setTotal(body.total);
          setError(null);
          if (!didAutoSelect.current && body.runs.length > 0) {
            didAutoSelect.current = true;
            const newest = body.runs[0];
            if (newest) setSelected((cur) => cur ?? newest.runId);
          }
        })
        .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [fleetId, status, source, offset, runsVersion]);

  // Detail + trace join for the selected run (per-turn trace fetches in
  // parallel; a missing trace is an honest absence, not an error).
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setSpans({});
      return;
    }
    let alive = true;
    getRun(fleetId, selected)
      .then(async (body) => {
        if (!alive) return;
        setDetail(body);
        const traceable = body.turns.filter((tu) => tu.traceTurnId).slice(0, 60);
        const entries = await Promise.all(
          traceable.map(async (tu) => [tu.traceTurnId!, await getTurnTrace(tu.traceTurnId!).catch(() => null)] as const),
        );
        if (!alive) return;
        const map: Record<string, ToolSpan[]> = {};
        for (const [id, events] of entries) map[id] = toolSpansOf(events);
        setSpans(map);
      })
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [fleetId, selected]);

  // Stop the selected run. Async by nature (the abort reaches the running
  // child), so the dialog closes on success and the notice states what actually
  // happened — including "it had already stopped", which is not a failure but
  // must not read as "we just did something".
  const stopSelectedRun = useCallback(async () => {
    if (!detail) return;
    const runId = detail.run.runId;
    setStopping(true);
    setStopNotice(null);
    try {
      const res = await cancelRun(fleetId, runId, t("fleets.runs.stopReasonDefault"));
      setStopNotice(
        res.alreadyStopped
          ? t("fleets.runs.stopAlready", { run: runId })
          : t("fleets.runs.stopDone", { run: runId, turns: res.abortedTurns }),
      );
      const fresh = await getRun(fleetId, runId).catch(() => null);
      if (fresh) setDetail(fresh);
      const list = await listRuns(fleetId, { status: status || undefined, source: source || undefined, limit: PAGE, offset }).catch(() => null);
      if (list) {
        setRuns(list.runs);
        setTotal(list.total);
      }
    } catch (e) {
      setStopNotice(t("fleets.runs.stopFailed", { error: String((e as Error)?.message ?? e) }));
    } finally {
      setStopping(false);
      setConfirmStop(false);
    }
  }, [detail, fleetId, status, source, offset, t]);

  // Leaving the timeline (or the fleet) must never strand a replay cursor.
  useEffect(
    () => () => {
      setReplayAt(null);
      setReplayTurns([]);
    },
    [setReplayAt, setReplayTurns],
  );

  // Scrub: while the slider is held, the cursor instant replays on the canvas
  // above — the turns open AT the cursor become the canvas's in-flight set
  // (same shape the live events produce); releasing clears back to live.
  const scrub = useCallback(
    (clock: number) => {
      setReplayAt(clock);
      if (!detail) return setReplayTurns([]);
      const open = detail.turns.filter((tu) => tu.startedAt <= clock && (tu.endedAt == null || tu.endedAt > clock));
      setReplayTurns(
        open.map((tu) => ({
          turnId: tu.turnId ?? String(tu.id),
          runId: tu.runId ?? detail.run.runId,
          fleetId,
          memberId: tu.memberId,
          parentTurnId: tu.parentTurnId,
          parentMemberId: tu.parentTurnId
            ? (detail.turns.find((p) => p.turnId === tu.parentTurnId)?.memberId ?? null)
            : null,
          edgeKind: tu.edgeKind,
          source: tu.source,
          startedAt: tu.startedAt,
        })),
      );
    },
    [detail, fleetId, setReplayAt, setReplayTurns],
  );

  const release = useCallback(() => {
    setReplayAt(null);
    setReplayTurns([]);
  }, [setReplayAt, setReplayTurns]);

  const lanes = useMemo(() => {
    if (!detail) return [];
    const order: string[] = [];
    for (const tu of detail.turns) if (!order.includes(tu.memberId)) order.push(tu.memberId);
    return order;
  }, [detail]);

  const window = useMemo(() => {
    if (!detail || !detail.turns.length) return null;
    const start = detail.run.startedAt;
    const end = Math.max(...detail.turns.map((tu) => tu.endedAt ?? tu.startedAt));
    return { start, end: end > start ? end : start + 1 };
  }, [detail]);

  const pct = useCallback(
    (ts: number) => (window ? Math.max(0, Math.min(100, ((ts - window.start) / (window.end - window.start)) * 100)) : 0),
    [window],
  );

  const cursorPct = replayAt != null && window ? pct(replayAt) : null;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const visibleRuns = useMemo(
    () => (memberFilter ? runs.filter((r) => r.rootMemberId === memberFilter) : runs),
    [runs, memberFilter],
  );

  return (
    <details className="mt-4" open data-testid="fleet-runs">
      <summary className="cursor-pointer select-none text-sm font-medium text-muted-foreground">
        {t("fleets.runs.title")}
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            aria-label={t("fleets.runs.filterStatus")}
            className="rounded-md border border-border bg-card px-2 py-1"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
            data-testid="runs-status-filter"
          >
            <option value="">{t("fleets.runs.allStatuses")}</option>
            {["open", "ok", "failed", "partial"].map((s) => (
              <option key={s} value={s}>
                {t(`fleets.runs.status.${s}`)}
              </option>
            ))}
          </select>
          <select
            aria-label={t("fleets.runs.filterSource")}
            className="rounded-md border border-border bg-card px-2 py-1"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setOffset(0);
            }}
            data-testid="runs-source-filter"
          >
            <option value="">{t("fleets.runs.allSources")}</option>
            {["cron", "manual", "delegation", "event"].map((s) => (
              <option key={s} value={s}>
                {t(`fleets.runs.source.${s}`)}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground" data-testid="runs-total">
            {total}
          </span>
          {/* Post filter (client-side over the loaded page): the operator's
              most common question is "what did THIS post run?", and scans a
              page of mixed-post runs badly. */}
          <select
            aria-label={t("fleets.runs.filterMember")}
            className="rounded-md border border-border bg-card px-2 py-1"
            value={memberFilter}
            onChange={(e) => setMemberFilter(e.target.value)}
            data-testid="runs-member-filter"
          >
            <option value="">{t("fleets.runs.allMembers")}</option>
            {[...memberTitles.entries()].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          {pages > 1 ? (
            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                className="rounded-md border border-border px-2 py-0.5 disabled:opacity-40"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
                data-testid="runs-prev"
              >
                ‹
              </button>
              <span className="text-muted-foreground">
                {Math.floor(offset / PAGE) + 1}/{pages}
              </span>
              <button
                type="button"
                className="rounded-md border border-border px-2 py-0.5 disabled:opacity-40"
                disabled={offset + PAGE >= total}
                onClick={() => setOffset(offset + PAGE)}
                data-testid="runs-next"
              >
                ›
              </button>
            </span>
          ) : null}
        </div>

        {visibleRuns.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="runs-empty">
            {runs.length === 0 ? t("fleets.runs.empty") : t("fleets.runs.noMatch")}
          </p>
        ) : (
          <div className="flex flex-col gap-1" data-testid="runs-list">
            {visibleRuns.map((r) => (
              <button
                type="button"
                key={r.runId}
                onClick={() => setSelected(r.runId === selected ? null : r.runId)}
                data-testid={`run-row-${r.runId}`}
                className={`flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs ${
                  r.runId === selected ? "border-blue-500/50 bg-blue-500/5" : "border-border bg-card hover:bg-muted/40"
                }`}
              >
                <span
                  className={`rounded-full px-2 py-0.5 ${
                    r.status === "ok"
                      ? "bg-success/15 text-success"
                      : r.status === "failed"
                        ? "bg-destructive/15 text-destructive"
                        : r.status === "open"
                          ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                          : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  }`}
                >
                  {t(`fleets.runs.status.${r.status}`)}
                </span>
                <span className="text-muted-foreground">{t(`fleets.runs.source.${r.rootSource}`)}</span>
                <span className="font-medium">{r.rootMemberTitle ?? title(r.rootMemberId)}</span>
                <span className="ml-auto text-muted-foreground">{fmtDur(r.durationMs)}</span>
                <span className="text-muted-foreground" data-testid={`run-turns-${r.runId}`}>
                  {r.turns}
                </span>
                <span className="text-muted-foreground">{fmtTok(r.usage)} tok</span>
              </button>
            ))}
          </div>
        )}

        {detail && window ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3" data-testid={`run-detail-${detail.run.runId}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">{t("fleets.runs.waterfall")}</span>
              <span className="text-muted-foreground">
                {new Date(window.start).toLocaleTimeString()} → {new Date(window.end).toLocaleTimeString()}
              </span>
              {replayAt != null ? (
                <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-blue-600 dark:text-blue-400" data-testid="runs-replaying">
                  {t("fleets.runs.replaying")}
                </span>
              ) : null}
              {/* The owner's stop (explore P2-6): the backend could always stop a
                  run — without this control the only way was SQL. Offered only
                  while the run is still open; once stopped, the header says who
                  stopped it and why instead of looking like a finished run. */}
              {detail.run.stoppedAt != null ? (
                <StatusPill
                  status="paused"
                  label={detail.run.stopReason
                    ? t("fleets.runs.stoppedWithReason", { reason: detail.run.stopReason })
                    : t("fleets.runs.stopped")}
                  data-testid="run-stopped"
                />
              ) : detail.run.status === "open" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto h-7 px-2 text-xs"
                  onClick={() => { setStopNotice(null); setConfirmStop(true); }}
                  data-testid="run-stop"
                >
                  {t("fleets.runs.stopRun")}
                </Button>
              ) : null}
            </div>
            {stopNotice ? (
              <p className="text-xs text-muted-foreground" data-testid="run-stop-notice">
                {stopNotice}
              </p>
            ) : null}

            {/* The waterfall: lanes grid + absolute-positioned turn bars and
                an SVG overlay for chain connectors and the replay cursor. */}
            <div className="relative" style={{ height: lanes.length * LANE_H + 18 }} data-testid="run-waterfall">
              <div className="absolute inset-y-0 left-0 w-28 shrink-0">
                {lanes.map((m) => (
                  <div key={m} className="flex items-center truncate pr-2 text-[11px] text-muted-foreground" style={{ height: LANE_H }} data-testid={`run-lane-${m}`}>
                    {title(m)}
                  </div>
                ))}
              </div>
              <div className="absolute inset-y-0 left-28 right-0" style={{ position: "relative" }}>
                <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
                  {detail.turns
                    .filter((tu) => tu.parentTurnId && tu.edgeKind)
                    .map((tu) => {
                      const parent = detail.turns.find((p) => p.turnId === tu.parentTurnId);
                      if (!parent) return null;
                      const y1 = lanes.indexOf(parent.memberId) * LANE_H + LANE_H / 2;
                      const y2 = lanes.indexOf(tu.memberId) * LANE_H + LANE_H / 2;
                      const x1 = `${pct(parent.endedAt ?? parent.startedAt)}%`;
                      const x2 = `${pct(tu.startedAt)}%`;
                      return (
                        <line
                          key={`hop-${tu.turnId}`}
                          x1={x1}
                          y1={y1}
                          x2={x2}
                          y2={y2}
                          stroke="#94a3b8"
                          strokeWidth="1"
                          strokeDasharray="3 2"
                          data-testid={`run-hop-${tu.turnId}`}
                        >
                          <title>{`${parent.memberId} → ${tu.memberId} · ${tu.edgeKind}`}</title>
                        </line>
                      );
                    })}
                  {cursorPct != null ? (
                    <line x1={`${cursorPct}%`} y1="0" x2={`${cursorPct}%`} y2="100%" stroke="#3b82f6" strokeWidth="1.5" data-testid="run-cursor" />
                  ) : null}
                </svg>
                {lanes.map((m, i) => (
                  <div key={m} className="absolute left-0 right-0 border-t border-border/40" style={{ top: i * LANE_H, height: LANE_H }}>
                    {detail.turns
                      .filter((tu) => tu.memberId === m)
                      .map((tu) => {
                        const left = pct(tu.startedAt);
                        const width = Math.max(0.5, pct(tu.endedAt ?? tu.startedAt) - left);
                        const turnSpans = tu.traceTurnId ? spans[tu.traceTurnId] ?? null : null;
                        const barTitle = `${title(m)} · ${tu.status}${tu.errorKind ? ` (${tu.errorKind})` : ""} · ${fmtDur(tu.endedAt - tu.startedAt)} · ${fmtTok(tu.usage)} tok${tu.traceTurnId ? "" : ` · ${t("fleets.runs.noTrace")}`}`;
                        return (
                          <div key={tu.turnId ?? tu.id} className="absolute" style={{ left: `${left}%`, width: `${width}%`, top: (LANE_H - BAR_H - SPAN_H - 4) / 2 }}>
                            <div
                              className={`rounded-sm ${STATUS_BAR[tu.status] ?? "bg-muted"} ${tu.traceTurnId == null ? "opacity-50" : ""}`}
                              style={{ height: BAR_H }}
                              title={barTitle}
                              data-testid={`run-bar-${tu.turnId ?? tu.id}`}
                            />
                            {turnSpans?.length ? (
                              <div className="relative" style={{ height: SPAN_H + 2 }}>
                                {turnSpans.map((sp) => {
                                  const spLeft = pct(sp.start);
                                  const spWidth = Math.max(0.4, pct(sp.end ?? tu.endedAt ?? sp.start) - spLeft);
                                  return (
                                    <div
                                      key={sp.callId}
                                      className="absolute rounded-sm bg-slate-500/70"
                                      style={{ left: `${((spLeft - left) / Math.max(width, 0.001)) * 100}%`, width: `${(spWidth / Math.max(width, 0.001)) * 100}%`, height: SPAN_H, top: 0 }}
                                      title={`${sp.name} · ${sp.end ? fmtDur(sp.end - sp.start) : "?"}`}
                                      data-testid={`run-span-${sp.callId}`}
                                    />
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">{t("fleets.runs.replay")}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={0.1}
                defaultValue={0}
                aria-label={t("fleets.runs.replay")}
                className="flex-1"
                onInput={(e) => scrub(window.start + ((window.end - window.start) * Number((e.target as HTMLInputElement).value)) / 100)}
                onPointerUp={release}
                onKeyUp={release}
                data-testid="runs-replay-slider"
              />
              <span className="whitespace-nowrap text-muted-foreground" data-testid="runs-replay-at">
                {replayAt != null ? new Date(replayAt).toLocaleTimeString() : t("fleets.runs.live")}
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmStop}
        onOpenChange={(open) => { if (!stopping) setConfirmStop(open); }}
        title={t("fleets.runs.stopTitle")}
        description={t("fleets.runs.stopBody")}
        confirmLabel={stopping ? t("fleets.runs.stopping") : t("fleets.runs.stopConfirm")}
        cancelLabel={t("fleets.runs.stopCancel")}
        variant="danger"
        closeOnConfirm={false}
        onConfirm={() => { void stopSelectedRun(); }}
      />
    </details>
  );
}

export default RunTimeline;
