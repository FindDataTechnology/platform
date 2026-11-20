// Fleet REST wrappers (agent-fleet-runs read face + the trace join it keys).
//
// The pages otherwise use bare fetch; the run timeline is the first fleet
// surface with multi-endpoint orchestration (list → detail → per-turn trace),
// so the shapes live here once.

export interface RunListEntry {
  runId: string;
  rootSource: string;
  rootMemberId: string;
  rootMemberTitle: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: "open" | "ok" | "failed" | "partial";
  turns: number;
  okCount: number;
  failedCount: number;
  usage: { input: number | null; output: number | null } | null;
  // add-fleet-run-budget: `status` stays the derived outcome; these two carry
  // WHY it stopped (owner cancel or a budget ceiling). Absent/null = not stopped.
  stoppedAt?: number | null;
  stopReason?: string | null;
  cost?: { usd: number | null; pricedTurns: number } | null;
}

export interface RunTurn {
  id: number;
  memberId: string;
  source: string;
  status: "ok" | "failed" | "interrupted";
  errorKind: string | null;
  error: string | null;
  model: string | null;
  startedAt: number;
  endedAt: number;
  sessionId: string | null;
  turnId: string | null;
  runId: string | null;
  parentTurnId: string | null;
  edgeKind: string | null;
  usage: { input: number | null; output: number | null } | null;
  traceTurnId: string | null;
}

export interface RunDetail {
  run: RunListEntry;
  turns: RunTurn[];
}

export interface TraceEvent {
  seq: number;
  ts: number;
  method: string;
  eventType: string | null;
  payload: unknown;
}

export interface ToolSpan {
  callId: string;
  name: string;
  start: number;
  end: number | null;
}

export interface RunListQuery {
  status?: string;
  source?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export async function listRuns(fleetId: string, { status, source, since, until, limit, offset }: RunListQuery = {}): Promise<{ total: number; runs: RunListEntry[] }> {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (source) q.set("source", source);
  if (Number.isFinite(since)) q.set("since", String(since));
  if (Number.isFinite(until)) q.set("until", String(until));
  if (limit) q.set("limit", String(limit));
  if (offset) q.set("offset", String(offset));
  const r = await fetch(`/api/fleets/${encodeURIComponent(fleetId)}/runs?${q.toString()}`);
  if (!r.ok) throw new Error(`runs ${r.status}`);
  return await r.json();
}

export async function getRun(fleetId: string, runId: string): Promise<RunDetail> {
  const r = await fetch(`/api/fleets/${encodeURIComponent(fleetId)}/runs/${encodeURIComponent(runId)}`);
  if (!r.ok) throw new Error(`run ${r.status}`);
  return await r.json();
}

// Cancel a run (explore P2-6): the backend has always been able to stop one
// (fleet-runs.stopRun → POST …/runs/:runId/cancel, aborting in-flight turns);
// the cockpit had no entry point, so a runaway wave could only be stopped by
// SQL. The response says whether it was already stopped, so the UI can stay
// honest instead of pretending it just did something.
export async function cancelRun(
  fleetId: string,
  runId: string,
  reason?: string,
): Promise<{ cancelled: boolean; alreadyStopped: boolean; abortedTurns: number; run: RunListEntry }> {
  const r = await fetch(`/api/fleets/${encodeURIComponent(fleetId)}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!r.ok) {
    let detail = "";
    try {
      detail = (await r.json())?.error ?? "";
    } catch { /* non-JSON error body */ }
    throw new Error(detail || `cancel ${r.status}`);
  }
  return await r.json();
}

export async function getTurnTrace(traceTurnId: string): Promise<TraceEvent[] | null> {
  const r = await fetch(`/api/trace/turns/${encodeURIComponent(traceTurnId)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`trace ${r.status}`);
  const body = await r.json();
  return body.events ?? [];
}

// Pair tool/call → tool/result into spans; an unanswered call stays open
// (end=null renders as a tick to the turn's end).
export function toolSpansOf(events: TraceEvent[] | null): ToolSpan[] {
  if (!events) return [];
  const calls = new Map();
  const order: string[] = [];
  for (const ev of events) {
    const data = (ev.payload as { event?: { data?: Record<string, unknown> } })?.event?.data;
    if (ev.eventType === "tool/call" && data?.callId) {
      if (!calls.has(data.callId)) order.push(String(data.callId));
      calls.set(String(data.callId), { callId: String(data.callId), name: String(data.name ?? "?"), start: ev.ts, end: null });
    } else if (ev.eventType === "tool/result" && data?.callId) {
      const hit = calls.get(String(data.callId));
      if (hit) hit.end = ev.ts;
    }
  }
  return order.map((id) => calls.get(id)!).filter(Boolean);
}
