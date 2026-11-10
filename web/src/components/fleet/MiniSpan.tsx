// Node-embedded mini span (fleet-ops-canvas): when a post node is hovered or
// selected, embed a collapsed waterfall of the turn's tool calls — name,
// outcome, duration, error kind — right inside the post card, no inspector
// needed. Rendered ONLY while a turn is in flight or the newest real turn
// failed; a tool-less turn renders nothing at all (无工具调用不渲染空占位).
//
// Data: two existing endpoints, no new query path — the member's newest turn
// page (skip entries excluded) gives the trace id, /api/trace/turns/:id gives
// the events; tool/call ↔ tool/result pairs join on callId. A 30s module LRU
// keeps hover-off/hover-on from re-fetching.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

interface ToolEntry {
  callId: string;
  name: string;
  status: "pending" | "ok" | "failed";
  durationMs: number | null;
}

type SpanState =
  | { kind: "loading" }
  | {
      kind: "ready";
      traceTurnId: string;
      tools: ToolEntry[];
      /** The SAME turn's recorded failure kind (from its row, not the
          ephemeral WS store — a stale store entry attributed an older
          failure to the in-flight turn in the 2026-10-27 walkthrough). */
      errorKind: string | null;
    };

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; state: SpanState }>();

function cacheKey(fleetId: string, memberId: string, traceTurnId: string) {
  return `${fleetId}:${memberId}:${traceTurnId}`;
}

interface TraceEvent {
  event_type: string;
  /** The trace API already JSON.parses payloads (object in production); the
      e2e/replay fixtures carry the raw string. Accept both. */
  payload: string | { event?: { type?: string; time?: number; data?: Record<string, unknown> } };
}

function deriveTools(events: TraceEvent[]): ToolEntry[] {
  const calls = new Map<string, ToolEntry & { startedAt: number }>();
  for (const row of events) {
    let parsed: { event?: { type?: string; time?: number; data?: Record<string, unknown> } } | null = null;
    if (typeof row.payload === "string") {
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        continue;
      }
    } else if (row.payload && typeof row.payload === "object") {
      parsed = row.payload;
    }
    const ev = parsed?.event;
    if (!ev || typeof ev.type !== "string") continue;
    const t = Number(ev.time);
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === "tool/call") {
      const callId = String(d.callId ?? "");
      if (!callId) continue;
      calls.set(callId, {
        callId,
        name: String(d.name ?? "?"),
        status: "pending",
        durationMs: null,
        startedAt: Number.isFinite(t) ? t : 0,
      });
    } else if (ev.type === "tool/result") {
      const msg = (d.message ?? {}) as Record<string, unknown>;
      const callId = String(d.callId ?? msg.toolCallId ?? "");
      const entry = calls.get(callId);
      if (!entry) continue;
      entry.status = msg.isError === true ? "failed" : "ok";
      if (Number.isFinite(t) && entry.startedAt > 0) entry.durationMs = Math.max(0, t - entry.startedAt);
    }
  }
  return [...calls.values()].map(({ startedAt: _s, ...rest }) => rest);
}

export function MiniSpan({
  fleetId,
  memberId,
  liveTraceTurnId,
  /** Newest turn's ledger status from the cockpit aggregate. */
  lastTurnFailed,
  lastTurnSkipped,
}: {
  fleetId: string;
  memberId: string;
  liveTraceTurnId: string | null;
  lastTurnFailed: boolean;
  lastTurnSkipped: boolean;
}) {
  const { t } = useTranslation();
  // Spec visibility: in-flight OR latest real turn failed. A skipped-only
  // newest round is neither.
  const eligible = liveTraceTurnId != null || (lastTurnFailed && !lastTurnSkipped);
  const [state, setState] = useState<SpanState | null>(null);

  useEffect(() => {
    if (!eligible) return;
    let alive = true;
    (async () => {
      try {
        let traceTurnId = liveTraceTurnId;
        let rowErrorKind: string | null = null;
        if (!traceTurnId) {
          const r = await fetch(`/api/fleets/${encodeURIComponent(fleetId)}/members/${encodeURIComponent(memberId)}/turns?limit=5`);
          if (!r.ok) return;
          const body = (await r.json()) as { turns?: { traceTurnId: string | null; status: string; errorKind?: string | null }[] };
          const row = (body.turns ?? []).find((x) => x.status !== "skipped" && x.traceTurnId);
          traceTurnId = row?.traceTurnId ?? null;
          rowErrorKind = row?.errorKind ?? null;
        }
        if (!traceTurnId) return;
        const key = cacheKey(fleetId, memberId, traceTurnId);
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS && hit.state.kind === "ready" && hit.state.errorKind != null) {
          if (alive) setState(hit.state);
          return;
        }
        const r2 = await fetch(`/api/trace/turns/${encodeURIComponent(traceTurnId)}`);
        if (!r2.ok) return;
        const body2 = (await r2.json()) as { events?: TraceEvent[] };
        const tools = deriveTools(body2.events ?? []);
        const next: SpanState = { kind: "ready", traceTurnId, tools, errorKind: rowErrorKind };
        cache.set(key, { at: Date.now(), state: next });
        if (alive) setState(next);
      } catch {
        /* hover evidence is footnote material — a failed lookup renders nothing */
      }
    })();
    return () => {
      alive = false;
    };
  }, [eligible, fleetId, memberId, liveTraceTurnId]);

  const visible = useMemo(() => {
    if (!eligible) return null;
    if (!state || state.kind !== "ready") return null;
    if (state.tools.length === 0 && !state.errorKind) return null;
    return state;
  }, [eligible, state]);

  if (!visible) return null;

  return (
    <div className="mt-1 border-t border-border/60 pt-1" data-testid="mini-span">
      <div className="flex flex-col gap-0.5">
        {visible.tools.slice(0, 5).map((tool) => (
          <div key={tool.callId} className="flex items-center gap-1 text-[10px]" data-testid="mini-span-tool">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                tool.status === "failed" ? "bg-destructive" : tool.status === "pending" ? "bg-amber-500 animate-pulse" : "bg-success"
              }`}
            />
            <span className="min-w-0 truncate font-mono text-muted-foreground" title={tool.name}>
              {tool.name.replace(/^mcp__[^_]+__/, "")}
            </span>
            {tool.durationMs != null ? (
              <span className="ml-auto shrink-0 text-muted-foreground">{tool.durationMs < 1000 ? `${tool.durationMs}ms` : `${(tool.durationMs / 1000).toFixed(1)}s`}</span>
            ) : null}
            {tool.status === "failed" ? <span className="shrink-0 rounded bg-destructive/15 px-1 text-destructive">{t("fleets.miniSpan.failed")}</span> : null}
          </div>
        ))}
        {visible.tools.length > 5 ? <div className="text-[10px] text-muted-foreground">+{visible.tools.length - 5} …</div> : null}
        {visible.errorKind ? (
          <div className="truncate text-[10px] text-destructive" title={visible.errorKind} data-testid="mini-span-error">
            {t("fleets.miniSpan.errorKind", { kind: visible.errorKind })}
          </div>
        ) : null}
        {visible.traceTurnId ? (
          <a
            className="mt-0.5 inline-block text-[10px] text-primary underline-offset-2 hover:underline"
            href={`/trace/${encodeURIComponent(visible.traceTurnId)}`}
            onClick={(e) => e.stopPropagation()}
            data-testid="mini-span-source"
          >
            {t("fleets.miniSpan.source")}
          </a>
        ) : null}
      </div>
    </div>
  );
}
