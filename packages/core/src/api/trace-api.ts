import { http, type HttpResponse } from "./http";

// Client wrappers for the /api/trace endpoints (turn-tracing capability).

export interface TraceTurnSummary {
  turnId: string;
  sessionId: string;
  started: number;
  durationMs: number;
  eventCount: number;
  hasError: boolean;
  model: string | null;
  provider: string | null;
}

export interface TraceEvent {
  seq: number;
  ts: number;
  method: string;
  eventType: string | null;
  summary: string;
  payload: unknown;
}

async function jsonOrThrow<T>(res: HttpResponse): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export async function listTraceTurns(opts: { limit?: number; offset?: number; sessionId?: string } = {}): Promise<TraceTurnSummary[]> {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.offset) q.set("offset", String(opts.offset));
  if (opts.sessionId) q.set("sessionId", opts.sessionId);
  const r = await http(`/api/trace/turns?${q}`);
  const j = await jsonOrThrow<{ turns: TraceTurnSummary[] }>(r);
  return j.turns ?? [];
}

export async function getTraceTurn(turnId: string): Promise<TraceEvent[]> {
  const r = await http(`/api/trace/turns/${encodeURIComponent(turnId)}`);
  const j = await jsonOrThrow<{ events: TraceEvent[] }>(r);
  return j.events ?? [];
}
