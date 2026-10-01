// Resource library REST clients (openspec: add-resource-library 6.2).
//
// List / save / rename / delete over the shared transport. Chart payloads ride
// the list response (they are small, and a second request per card would make
// the page chatty), so `chartOption` is a pure parse helper, not a fetch.
//
// Bound charts (openspec: add-chart-data-binding 2.5/4.1) add the data-source
// surface: a chart carries binding views (identity, stale state, refreshability)
// and the routes that mutate them. Every mutation answers with the updated
// resource, so a client reconciles from the response it already has.

import { fileRefPath, type FileRef } from "../lib/file-ref";
import { http } from "./http";

/** Why a binding is stale, as a code — the client localizes, never the server. */
export type StaleReason =
  | "credential"
  | "unreachable"
  | "tool_error"
  | "unit_mismatch"
  | "map_violation"
  | "allowlist";

/** A per-binding refresh schedule. `ttlSec` is checked when a chart is opened;
 *  `cron`/`tz` schedules a background refresh. */
export interface RefreshRule {
  cron?: string;
  tz?: string;
  ttlSec?: number;
}

/** One rendered series → one data source. */
export interface ResourceBindingRef {
  seriesIndex: number;
  bindingId: string;
}

export interface ChartBindingView {
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  map: Record<string, unknown> | null;
  concept: string | null;
  frequency: string | null;
  unit: string | null;
  /** declared > confirmed > inferred. */
  origin: "declared" | "confirmed" | "inferred" | string;
  stale: boolean;
  staleReason: StaleReason | string | null;
  staleSince: string | null;
  lastOkAt: string | null;
  consecutiveFailures: number;
  refreshRule: RefreshRule | null;
  /** False when the deployment's replay allowlist excludes this tool. */
  refreshable: boolean;
  refreshableReason: string | null;
  /** Stored periods in the latest view (the data-period filter's input). */
  periods: number;
  /** The moment of the newest observed value — the source line's as-of. */
  lastObservedAt: string | null;
}

export interface Resource {
  id: string;
  /** "chart" | "file" today; the store is typed and extensible. */
  type: string;
  title: string;
  source: "auto" | "manual";
  /** Soft provenance — the session may be gone; sessionTitle is the snapshot. */
  sessionId: string | null;
  sessionTitle: string | null;
  messageId: number | null;
  /** chart: the normalized ECharts option JSON, as a string. */
  payload: string | null;
  /** file: path relative to the resources root the serving route resolves. */
  filePath: string | null;
  fileSize: number | null;
  fileMime: string | null;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  /** 1 when the row came from the one-time history seeding pass. */
  seeded: number;
  /** Which series render from which binding (empty for unbound charts). */
  bindingRefs?: ResourceBindingRef[];
  /** The binding views, one per referenced series (empty for unbound charts). */
  bindings?: (ChartBindingView & { seriesIndex: number })[];
}

/** A same-turn MCP call the chart was drawn from, offered for confirmation. */
export interface BindingCandidate {
  name: string;
  args: Record<string, unknown>;
  server: string;
  tool: string;
  map: Record<string, unknown>;
  frequency: string | null;
  allowlisted: boolean;
  points: number | null;
  unit: string | null;
  matchedSeries: number | null;
}

export interface RefreshObservation {
  id: string;
  bindingId: string;
  seriesIndex: number;
  fetchedAt: string;
  trigger: "manual" | "scheduled" | "on-open" | string;
  outcome: "ok" | "unchanged" | "skipped_fresh" | "error" | string;
  added: number;
  revised: number;
  resourced: number;
  unchanged: number;
  missing: number;
  anomalies: number;
  anomaliesDetail: { series: string; period: string; values: { value: number; source: string | null }[] }[] | null;
  gate: string | null;
  error: string | null;
  durationMs: number | null;
}

export interface RefreshResult {
  ok: boolean;
  outcome: string;
  /** Present on a refusal: a stale reason code (or "ttl" for an on-open skip). */
  reason?: string;
  counts?: { appended: number; revised: number; resourced: number; unchanged: number; missing: number };
  anomalies?: { period: string; values: { value: number }[] }[];
  unit?: string | null;
  observedAt?: string;
  error?: string;
  resource?: Resource;
}

export interface ResourceList {
  items: Resource[];
  total: number;
  limit: number;
  offset: number;
}

export interface ResourceListQuery {
  type?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

// A refused library call. `status` is the HTTP status — the mini program uses
// 404 to mean "this cell predates the library" and hides the entry instead of
// showing an error (openspec: resource-library-ui, version skew).
export class ResourceApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ResourceApiError";
    this.status = status;
  }
}

// A refused save. `code` is the stable machine-readable reason
// (invalid_path / file_not_found / file_too_large / db_unavailable /
// store_failed); clients map it to a LOCALIZED message and fall back to
// `message` (the server's own text) for codes they do not know.
export class ResourceSaveError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ResourceSaveError";
    this.code = code;
  }
}

async function jsonOrThrow<T>(resPromise: ReturnType<typeof http>): Promise<T> {
  const res = await resPromise;
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string } | null;
      if (j?.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ResourceApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export async function listResources(query: ResourceListQuery = {}): Promise<ResourceList> {
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.q) params.set("q", query.q);
  if (query.limit != null) params.set("limit", String(query.limit));
  if (query.offset != null) params.set("offset", String(query.offset));
  const qs = params.toString();
  return jsonOrThrow<ResourceList>(http(`/api/resources${qs ? `?${qs}` : ""}`));
}

// Save a workspace file. `inserted: false` is a success that means "the same
// content is already in the library" — the caller says so rather than showing
// an error. Failures throw a ResourceSaveError carrying the server's `code`.
export async function saveResource(input: {
  path: string;
  sessionId?: string | null;
  messageId?: number | null;
}): Promise<{ inserted: boolean; resource: Resource }> {
  const res = await http("/api/resources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: input.path,
      sessionId: input.sessionId ?? null,
      messageId: input.messageId ?? null,
    }),
  });
  if (!res.ok) {
    let code = "save_failed";
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; code?: string } | null;
      if (j?.code) code = j.code;
      if (j?.error) message = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ResourceSaveError(code, message);
  }
  return (await res.json()) as { inserted: boolean; resource: Resource };
}

export async function renameResource(id: string, title: string): Promise<Resource> {
  const j = await jsonOrThrow<{ resource: Resource }>(
    http(`/api/resources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
  return j.resource;
}

export async function deleteResource(id: string): Promise<void> {
  const res = await http(`/api/resources/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Bound charts ────────────────────────────────────────────────────────────

/** The same-turn calls a chart was drawn from, with the map each would bind. */
export async function listBindingCandidates(id: string): Promise<BindingCandidate[]> {
  const j = await jsonOrThrow<{ candidates: BindingCandidate[] }>(
    http(`/api/resources/${encodeURIComponent(id)}/candidates`),
  );
  return j.candidates ?? [];
}

/** Confirm a candidate as the chart's data source (origin `confirmed`). */
export async function attachBinding(
  id: string,
  input: { candidateIndex: number; seriesIndex?: number; map?: Record<string, unknown> },
): Promise<{ binding: ChartBindingView; resource: Resource }> {
  return jsonOrThrow<{ binding: ChartBindingView; resource: Resource }>(
    http(`/api/resources/${encodeURIComponent(id)}/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateIndex: input.candidateIndex,
        seriesIndex: input.seriesIndex ?? 0,
        map: input.map ?? null,
      }),
    }),
  );
}

export async function detachBinding(id: string, bindingId: string): Promise<{ resource: Resource }> {
  return jsonOrThrow<{ resource: Resource }>(
    http(`/api/resources/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}`, {
      method: "DELETE",
    }),
  );
}

export async function setBindingRefreshRule(
  id: string,
  bindingId: string,
  rule: RefreshRule | null,
): Promise<{ binding: ChartBindingView; resource: Resource }> {
  return jsonOrThrow<{ binding: ChartBindingView; resource: Resource }>(
    http(`/api/resources/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}/refresh-rule`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshRule: rule }),
    }),
  );
}

/**
 * Refresh a binding. `trigger: "on-open"` is the TTL path — the cell answers
 * "nothing to do" when the data is still fresh, so a client may call it freely
 * every time a bound chart is opened. A failed refresh is a 200 with
 * `ok: false` and a reason: the chart keeps rendering its last good data, and
 * that is an outcome to show, not an exception to catch.
 */
export async function refreshBinding(
  id: string,
  bindingId: string,
  input: { trigger?: "manual" | "on-open" } = {},
): Promise<RefreshResult> {
  return jsonOrThrow<RefreshResult>(
    http(`/api/resources/${encodeURIComponent(id)}/bindings/${encodeURIComponent(bindingId)}/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trigger: input.trigger ?? "manual" }),
    }),
  );
}

export async function listObservations(
  id: string,
  query: { bindingId?: string; since?: string; until?: string; limit?: number; offset?: number } = {},
): Promise<{ items: RefreshObservation[]; total: number; limit: number; offset: number }> {
  const params = new URLSearchParams();
  if (query.bindingId) params.set("bindingId", query.bindingId);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.limit != null) params.set("limit", String(query.limit));
  if (query.offset != null) params.set("offset", String(query.offset));
  const qs = params.toString();
  return jsonOrThrow(
    http(`/api/resources/${encodeURIComponent(id)}/observations${qs ? `?${qs}` : ""}`),
  );
}

/** The chart as it stood at `at` — reconstructed from the point log. */
export async function asOfResource(
  id: string,
  at: string,
): Promise<{ at: string; option: Record<string, unknown>; periods: number }> {
  return jsonOrThrow(
    http(`/api/resources/${encodeURIComponent(id)}/as-of?at=${encodeURIComponent(at)}`),
  );
}

/** i18n key suffix for a stale reason, or null when the code is unknown. */
export function staleReasonKey(reason: string | null | undefined): string | null {
  const known = ["credential", "unreachable", "tool_error", "unit_mismatch", "map_violation", "allowlist"];
  return reason && known.includes(reason) ? reason : null;
}

/** The binding behind a series index, or undefined when that series is static. */
export function bindingForSeries(
  resource: Resource,
  seriesIndex: number,
): (ChartBindingView & { seriesIndex: number }) | undefined {
  return resource.bindings?.find((b) => b.seriesIndex === seriesIndex);
}

/** The moment a bound chart's data is "as of": the newest observation. */
export function asOfMoment(binding: ChartBindingView | undefined): string | null {
  return binding ? (binding.lastObservedAt ?? binding.lastOkAt) : null;
}

// ── The data-period filter ──────────────────────────────────────────────────

/** The chart windows offered over a stored series. */
export type PeriodWindow = "6m" | "1y" | "all";

/** Windows in months; `all` keeps everything. */
const WINDOW_MONTHS: Record<Exclude<PeriodWindow, "all">, number> = { "6m": 6, "1y": 12 };

/**
 * The default window for a stored series. A monthly series grows past any
 * single fetch window, so the recent slice is what a reader wants first; a
 * yearly series has few periods and no "recent 6 months" to speak of, so it
 * shows everything.
 */
export function defaultPeriodWindow(periods: string[]): PeriodWindow {
  return periods.length && periods.every((p) => /^\d{4}$/.test(p)) ? "all" : "1y";
}

/** A period's first day: `2026-08` → Aug 1, `2026` → Jan 1. */
function periodStart(period: string): Date {
  const yearOnly = /^(\d{4})$/.exec(period);
  if (yearOnly) return new Date(Date.UTC(Number(yearOnly[1]), 0, 1));
  return new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1));
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

/**
 * Slice a stored period list to a window. The window is measured back from the
 * NEWEST STORED period, not from today: a series that lags upstream still opens
 * on a readable slice of its own data instead of an empty chart, and the result
 * does not depend on the reader's clock.
 */
export function filterPeriods(periods: string[], window: PeriodWindow): string[] {
  if (window === "all" || !periods.length) return [...periods];
  const sorted = [...periods].sort();
  const newest = sorted[sorted.length - 1];
  if (newest === undefined) return [...periods];
  const cutoff = addMonths(periodStart(newest), -(WINDOW_MONTHS[window] - 1));
  return sorted.filter((period) => periodStart(period).getTime() >= cutoff.getTime());
}

/**
 * Slice a chart option to a period window: the axis labels whose periods fall
 * inside it, and every series' data realigned to them. A chart with no
 * category axis or a non-aligning series is returned unchanged — the filter
 * never invents data.
 */
export function filterChartOption(
  option: Record<string, unknown> | null,
  window: PeriodWindow,
): Record<string, unknown> | null {
  if (!option || window === "all") return option;
  const axis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
  const labels = (axis as { data?: unknown[] } | undefined)?.data;
  if (!Array.isArray(labels) || !labels.length) return option;
  const keys = labels.map((l) => String(l));
  const kept = new Set(filterPeriods(keys, window));
  if (kept.size === keys.length) return option;
  if (!kept.size) return option;
  const positions = keys.map((k, i) => (kept.has(k) ? i : -1)).filter((i) => i >= 0);
  const next = JSON.parse(JSON.stringify(option)) as Record<string, unknown>;
  const nextAxis = (Array.isArray(next.xAxis) ? next.xAxis[0] : next.xAxis) as { data: unknown[] };
  nextAxis.data = positions.map((i) => labels[i]);
  const series = Array.isArray(next.series) ? next.series : [];
  for (const entry of series) {
    const values = (entry as { data?: unknown[] })?.data;
    if (Array.isArray(values)) (entry as { data: unknown[] }).data = positions.map((i) => values[i] ?? null);
  }
  return next;
}

/** i18n key suffix for a refused save, or null when the code is unknown. */
export function saveErrorKey(err: unknown): string | null {
  if (!(err instanceof ResourceSaveError)) return null;
  const known = ["invalid_path", "file_not_found", "file_too_large", "db_unavailable", "store_failed"];
  return known.includes(err.code) ? err.code : null;
}

/** The preview/serving reference of a file resource, or null for other types. */
export function resourceFileRef(resource: Resource): FileRef | null {
  if (!resource.filePath) return null;
  return { root: "resources", rel: resource.filePath };
}

/** The route path serving a file resource (`/api/files?...`), or null. */
export function resourceFileUrl(resource: Resource): string | null {
  const ref = resourceFileRef(resource);
  return ref ? fileRefPath(ref) : null;
}

/** The chart option of a chart resource, or null when malformed. */
export function chartOption(resource: Resource): Record<string, unknown> | null {
  if (!resource.payload) return null;
  try {
    const parsed = JSON.parse(resource.payload);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The category axis of a chart option as string periods. The axis IS the
 * series' period list for a bound chart (it is regenerated from the store), so
 * this is what the data-period filter slices.
 */
export function chartPeriods(option: Record<string, unknown> | null): string[] {
  const axis = Array.isArray(option?.xAxis) ? option.xAxis[0] : option?.xAxis;
  const data = (axis as { data?: unknown[] } | undefined)?.data;
  return Array.isArray(data) ? data.map((value) => String(value)) : [];
}

/** Human-readable size for file cards. */
export function formatFileSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}