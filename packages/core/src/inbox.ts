// ── Owner inbox read model (openspec: owner-inbox) ──────────────────────────
//
// Three clients (web, Expo app, WeChat mini program) consume the SAME shapes and
// the SAME actions from here. Nothing in this file knows how to approve a fleet
// decision — the server answers each item with the endpoint that lane already
// exposes, and `runAction` is a plain http() call to it. That is the whole
// reason the aggregation could be added without touching any lane's state
// machine: dispatch is data, not code.
//
// Degradation is explicit: a lane that could not be read comes back with
// `status: "error"` and an empty item array. A client MUST render that as "we
// could not read this lane", never as "nothing here" — which is why the counts
// live on the envelope (server-computed) and not on a client-side sum over
// whatever happened to load.

import { http } from "./api/http";

export type InboxBucket = "waiting" | "inflight" | "context";

export interface InboxAction {
  op: string;
  label: string;
  endpoint: string;
  method: string;
  /** Payload keys the endpoint accepts. Informational for form rendering. */
  bodyShape: Record<string, string>;
  /** True when the action cannot change a decided outcome (e.g. re-run). */
  safe: boolean;
}

export interface InboxEvaluation {
  status: "passed" | "failed" | "unevaluated";
  reason: string | null;
}

export interface InboxItem {
  laneId: string;
  itemRef: string;
  subjectKind: string;
  originLabel: string;
  originRefs: Record<string, string | null>;
  title: string;
  severity: "low" | "normal" | "high" | string;
  itemType: string;
  state: string;
  bucket: InboxBucket;
  submittedAt: number | null;
  /** Server-derived "what approving this does". Never client-inferred. */
  consequence: string;
  evidence: Record<string, unknown> | null;
  evaluation?: InboxEvaluation;
  options?: { value: string; label: string }[];
  recommendation?: string | null;
  actions: InboxAction[];
}

export interface InboxLane {
  id: string;
  label: string;
  status: "ok" | "error";
  error?: string;
  items: InboxItem[];
}

export interface InboxPayload {
  v: number;
  sampledAt: number;
  lanes: InboxLane[];
  counts: { waiting: number; inflight: number };
}

export const INBOX_ROUTE = "/api/inbox";

/** Read the whole inbox. `lanes` narrows the server-side fan-out. */
export async function fetchInbox(opts: { lanes?: string[] } = {}): Promise<InboxPayload> {
  const qs = opts.lanes?.length ? `?lanes=${encodeURIComponent(opts.lanes.join(","))}` : "";
  const r = await http(`${INBOX_ROUTE}${qs}`);
  if (!r.ok) throw new Error(`inbox ${r.status}`);
  return (await r.json()) as InboxPayload;
}

/**
 * Lane ids that go to the TOP of the list, whatever order the server sent.
 *
 * Why this is not just "server order": found live 2026-11-24 during acceptance —
 * one lane can legitimately hold hundreds of items (fleet-decision had 522 open
 * decisions), and a broadcast notice appended after them was unreachable: the
 * API returned it and the page rendered it at position 35 of 37. Nothing is
 * hidden — the rest still follows in server order.
 */
const INBOX_LANE_PRIORITY: readonly string[] = ["notification"];

/** Items of one bucket: priority lanes first, then the server's own order. */
export function itemsInBucket(payload: InboxPayload | null, bucket: InboxBucket): InboxItem[] {
  if (!payload) return [];
  const rank = (laneId: string) => {
    const i = INBOX_LANE_PRIORITY.indexOf(laneId);
    return i < 0 ? INBOX_LANE_PRIORITY.length : i;
  };
  return [...payload.lanes].sort((a, b) => rank(a.id) - rank(b.id)).flatMap((l) => l.items.filter((i) => i.bucket === bucket));
}

/** True when at least one lane failed — the surface must say so out loud. */
export function failedLanes(payload: InboxPayload | null): InboxLane[] {
  return (payload?.lanes ?? []).filter((l) => l.status === "error");
}

/**
 * Dispatch one action against the endpoint the SERVER named.
 *
 * The guard is load-bearing: a client must not be able to turn this into a
 * generic "POST anywhere" primitive. We accept only same-origin `/api/...`
 * paths that came back in the inbox envelope.
 */
export async function runAction(
  action: InboxAction,
  body: Record<string, unknown> = {},
  knownActions?: InboxAction[],
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!action || typeof action.endpoint !== "string" || !action.endpoint.startsWith("/api/")) {
    throw new Error("inbox action endpoint must be a same-origin /api path");
  }
  if (knownActions && !knownActions.some((a) => a.op === action.op && a.endpoint === action.endpoint)) {
    throw new Error("inbox action was not offered by the server response");
  }
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method: action.method || "POST",
    headers: {},
  };
  if (init.method !== "GET" && init.method !== "HEAD") {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  const r = await http(action.endpoint, init);
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
}

export interface BatchReceipt {
  itemRef: string;
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Fire the same action across many items, one independent ruling each.
 *
 * Sequential on purpose: these are owner rulings against the same SQLite file,
 * and the interesting failure mode is a first-writer-wins conflict on one row —
 * running them serially makes the receipt order match the list order, which is
 * what the UI shows. One failure never aborts the rest (the fleet batch
 * endpoint's own contract, per-item receipts and 200).
 */
export async function runBatch(
  jobs: { itemRef: string; action: InboxAction; body?: Record<string, unknown> }[],
): Promise<BatchReceipt[]> {
  const out: BatchReceipt[] = [];
  for (const job of jobs) {
    try {
      const res = await runAction(job.action, job.body ?? {});
      out.push({
        itemRef: job.itemRef,
        ok: res.ok,
        status: res.status,
        error: res.ok ? undefined : errorText(res.data, res.status),
      });
    } catch (err) {
      out.push({ itemRef: job.itemRef, ok: false, error: String((err as Error)?.message ?? err) });
    }
  }
  return out;
}

function errorText(data: unknown, status: number): string {
  const body = data as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error ? body.error : `HTTP ${status}`;
}
