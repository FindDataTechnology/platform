// TracePage.tsx — per-turn trace viewer. Lists captured turns; the detail view
// renders the turn's full dsh event timeline with expandable raw payloads.
// Read-after-the-fact via REST (no WS involvement by design).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { listTraceTurns, getTraceTurn, type TraceTurnSummary, type TraceEvent } from "@platform/core";

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function TurnList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [turns, setTurns] = useState<TraceTurnSummary[]>([]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const PAGE = 50;

  const load = useCallback(async (off: number) => {
    setLoading(true);
    setError(null);
    try {
      const all = await listTraceTurns({ limit: PAGE, offset: off });
      setTurns(all);
      setOffset(off);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(0);
  }, [load]);

  const filtered = errorsOnly ? turns.filter((t) => t.hasError) : turns;

  return (
    <div className="flex flex-col h-full bg-background" data-testid="trace-page">
      <div className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t("trace.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("trace.description")}</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
          {t("trace.errorsOnly")}
        </label>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        {loading && <p className="text-sm text-muted-foreground">{t("trace.loading")}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!loading && !error && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("trace.empty")}</p>
        )}
        {filtered.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="py-2 pr-4 font-medium">{t("trace.col.time")}</th>
                <th className="py-2 pr-4 font-medium">{t("trace.col.model")}</th>
                <th className="py-2 pr-4 font-medium">{t("trace.col.duration")}</th>
                <th className="py-2 pr-4 font-medium">{t("trace.col.events")}</th>
                <th className="py-2 pr-4 font-medium">{t("trace.col.session")}</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((turn) => (
                <tr
                  key={turn.turnId}
                  className="border-b border-border/50 cursor-pointer hover:bg-muted/40"
                  onClick={() => navigate(`/trace/${encodeURIComponent(turn.turnId)}`)}
                  data-testid="trace-turn-row"
                >
                  <td className="py-2 pr-4 whitespace-nowrap">{fmtTime(turn.started)}</td>
                  <td className="py-2 pr-4">{turn.model || "—"}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{fmtDuration(turn.durationMs)}</td>
                  <td className="py-2 pr-4">{turn.eventCount}</td>
                  <td className="py-2 pr-4 max-w-[160px] truncate text-muted-foreground" title={turn.sessionId}>
                    {turn.sessionId}
                  </td>
                  <td className="py-2">
                    {turn.hasError && (
                      <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-xs text-destructive">
                        {t("trace.errorBadge")}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {offset > 0 && (
          <button className="mt-3 mr-3 text-sm underline text-muted-foreground" onClick={() => load(Math.max(offset - PAGE, 0))}>
            {t("trace.prev")}
          </button>
        )}
        {turns.length === PAGE && (
          <button className="mt-3 text-sm underline text-muted-foreground" onClick={() => load(offset + PAGE)}>
            {t("trace.next")}
          </button>
        )}
      </div>
    </div>
  );
}

function TraceEventRow({ ev }: { ev: TraceEvent }) {
  const [open, setOpen] = useState(false);
  const isError = /error|retry/i.test(ev.eventType ?? "");
  return (
    <div className="border-b border-border/50" data-testid="trace-event-row">
      <button
        className="w-full flex items-baseline gap-3 py-1.5 text-left hover:bg-muted/40"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="w-[72px] shrink-0 text-xs text-muted-foreground tabular-nums">{fmtTime(ev.ts)}</span>
        <span className="w-[170px] shrink-0 text-xs font-mono text-muted-foreground truncate">{ev.eventType ?? ev.method}</span>
        <span className={`flex-1 text-sm truncate ${isError ? "text-destructive" : ""}`}>{ev.summary}</span>
      </button>
      {open && (
        <pre className="mx-[88px] mb-2 max-h-72 overflow-auto rounded border border-border bg-muted/40 p-2 text-xs">
          {JSON.stringify(ev.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

function TurnDetail() {
  const { turnId = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getTraceTurn(decodeURIComponent(turnId))
      .then((evs) => setEvents(evs))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [turnId]);

  // Derived aggregates over the raw stream (counts only — no replay).
  const toolCalls = events.filter((e) => e.eventType === "tool/call").length;
  const retries = events.filter((e) => e.eventType === "llm/retry").length;
  const textChars = events
    .filter((e) => e.eventType === "assistant/chunk")
    .reduce((n, e) => {
      const c = (e.payload as { event?: { data?: { chunk?: { type?: string; text?: string } } } })?.event?.data?.chunk;
      return n + (c?.type === "text-delta" ? (c.text ?? "").length : 0);
    }, 0);

  return (
    <div className="flex flex-col h-full bg-background" data-testid="trace-detail-page">
      <div className="border-b border-border px-6 py-4">
        <button className="text-sm text-muted-foreground underline" onClick={() => navigate("/trace")}>
          ← {t("trace.back")}
        </button>
        <h1 className="text-lg font-semibold text-foreground mt-2 font-mono break-all">{decodeURIComponent(turnId)}</h1>
        {events.length > 0 && (
          <p className="text-sm text-muted-foreground mt-1">
            {events.length} {t("trace.col.events")}
            {toolCalls > 0 && ` · ${toolCalls} ${t("trace.toolCalls")}`}
            {retries > 0 && ` · ${retries} ${t("trace.retries")}`}
            {textChars > 0 && ` · ${textChars} ${t("trace.textChars")}`}
          </p>
        )}
      </div>
      <div className="flex-1 overflow-auto px-6 py-2">
        {loading && <p className="text-sm text-muted-foreground">{t("trace.loading")}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {events.map((ev) => (
          <TraceEventRow key={ev.seq} ev={ev} />
        ))}
      </div>
    </div>
  );
}

export function TracePage() {
  return <TurnList />;
}
export function TraceDetailPage() {
  return <TurnDetail />;
}
