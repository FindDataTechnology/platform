// ── Chart data source (openspec: add-chart-data-binding) ─────────────────────
//
// The deterministic data path behind a bound chart: call the MCP read tool the
// binding names, then turn its response into `(period, value)` points. No model
// is involved at any step — a refresh is a tool call plus arithmetic.
//
// Three concerns live here, in the order data flows through them:
//
//   1. The replay client (`callTool`): a minimal streamable-http JSON-RPC
//      client (initialize → notifications/initialized → tools/call). Endpoint
//      and credential resolve exactly the way the dsh child resolves them for
//      that server (installed extension config + the same per-user registry
//      token), so a refresh can never reach somewhere the agent could not.
//   2. The mapping contract (`evaluateMap`): a five-field declarative map with
//      no expressions — rows/period/value/source/series — that says where the
//      points live in the response.
//   3. Frequency-aware normalization (`normalizePeriod`): the canonical period
//      key the store and the renderer agree on.
//
// Fail-safe posture throughout: a response that does not satisfy the mapping
// contract is refused WHOLE (never partially absorbed). A shape change upstream
// costs a map update, not a silently wrong chart.

import * as extensionStore from "./extension-store.js";
import * as registryCredentials from "./registry-credentials.js";

const DEFAULT_TIMEOUT_MS =
  Number(process.env.CHART_SOURCE_TIMEOUT_MS) > 0 ? Number(process.env.CHART_SOURCE_TIMEOUT_MS) : 30_000;
const CLIENT_INFO = { name: "paas-chart-refresh", version: "1.0.0" };
// The protocol revision the repo's other live MCP clients negotiate; servers
// answering with their own supported revision are accepted either way.
const PROTOCOL_VERSION = "2024-11-05";

// v1 normalizes exactly these two; anything else is refused at attach (the
// cadence decides how a period label becomes a key, so guessing would corrupt).
export const SUPPORTED_FREQUENCIES = new Set(["monthly", "yearly"]);

export class ChartSourceError extends Error {
  // code: credential | unreachable | tool_error — the binding's stale_reason set.
  constructor(code, message) {
    super(message);
    this.name = "ChartSourceError";
    this.code = code;
  }
}

// ── The mapping contract ─────────────────────────────────────────────────────

const MAP_FIELDS = ["rows", "period", "value", "source", "series"];

// The map a probed read tool's response implies. `read_series` wraps its rows
// in a `points` array; `read` returns the bare array. Both carry per-row
// {date, value, unit, source_used}. Only these two tools are bindable in v1.
export function defaultMapForTool(tool) {
  if (tool === "read_series") {
    return { rows: "points[]", period: "date", value: "value", source: "source_used", series: null };
  }
  if (tool === "read") {
    return { rows: "@root", period: "date", value: "value", source: "source_used", series: null };
  }
  return null;
}

// Deterministic JSON for identity (lineage keys) and storage: key order must
// not change the identity of a call the way an object literal's order would.
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

// Structural validation of a declared map (shape only — whether the fields
// resolve is a per-response question, answered by evaluateMap).
export function validateMap(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { ok: false, reason: "map must be an object" };
  }
  for (const key of Object.keys(map)) {
    if (!MAP_FIELDS.includes(key)) return { ok: false, reason: `unknown map field "${key}"` };
  }
  if (typeof map.rows !== "string" || !map.rows.trim()) {
    return { ok: false, reason: "map.rows is required" };
  }
  if (map.rows !== "@root" && !/^[A-Za-z0-9_.[\]-]+$/.test(map.rows)) {
    return { ok: false, reason: "map.rows must be \"@root\" or a property path" };
  }
  for (const field of ["period", "value", "source"]) {
    if (typeof map[field] !== "string" || !map[field].trim()) {
      return { ok: false, reason: `map.${field} is required` };
    }
  }
  if (map.series != null && (typeof map.series !== "string" || !map.series.trim())) {
    return { ok: false, reason: "map.series must be null or a field name" };
  }
  return { ok: true };
}

// Resolve a dotted property path against a value. `"a.b"` walks two levels;
// `"a.b[]"` additionally strips the trailing array marker (the marker is
// documented, not magic — it is how a path says "this is the row list").
function resolvePath(value, path) {
  let current = value;
  for (const seg of String(path).split(".")) {
    const key = seg.endsWith("[]") ? seg.slice(0, -2) : seg;
    if (!key) return undefined;
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function resolveRows(result, rowsPath) {
  if (rowsPath === "@root") return Array.isArray(result) ? result : null;
  const rows = resolvePath(result, rowsPath);
  return Array.isArray(rows) ? rows : null;
}

// ── Period normalization ─────────────────────────────────────────────────────

const YEAR_MONTH = /^(\d{4})-(\d{2})(?:-\d{2})?/;
const YEAR_ONLY = /^(\d{4})$/;

// Canonical key by frequency: monthly → `YYYY-MM`, yearly → `YYYY`. Both
// observed label forms are accepted (monthly labels period-start, yearly labels
// period-end — so a yearly series' `2019-12-31` and a bare `2019` are the same
// period). Unparseable input returns null and the caller refuses the response.
export function normalizePeriod(raw, frequency) {
  const s = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
  if (!s) return null;
  const ym = YEAR_MONTH.exec(s);
  const year = YEAR_ONLY.exec(s);
  if (frequency === "yearly") {
    if (year) return year[1];
    if (ym) return ym[1];
    return null;
  }
  if (frequency === "monthly") {
    if (!ym) return null;
    const month = Number(ym[2]);
    if (month < 1 || month > 12) return null;
    return `${ym[1]}-${ym[2]}`;
  }
  return null;
}

// The frequency a chart's own axis labels imply — the inference path has no
// concept metadata to read, and the labels the model drew ARE the claim about
// cadence being witnessed.
export function inferFrequencyFromLabels(labels) {
  const clean = (labels ?? []).filter((l) => typeof l === "string" && l.trim());
  if (!clean.length) return null;
  if (clean.every((l) => YEAR_ONLY.test(l.trim()))) return "yearly";
  if (clean.every((l) => YEAR_MONTH.test(l.trim()))) return "monthly";
  return null;
}

// ── Row evaluation ───────────────────────────────────────────────────────────

function valueAt(row, field) {
  if (row == null || typeof row !== "object") return undefined;
  if (!field.includes(".")) return row[field];
  return resolvePath(row, field);
}

// Every distinct unit the response carries for the mapped rows. The unit is a
// convention (per-row `unit`), not a map field: it is part of the data contract
// the binding records, not a per-chart extraction choice.
export function unitsFromResult(result, map) {
  const rows = resolveRows(result, map.rows) ?? [];
  const units = new Set();
  for (const row of rows) {
    const unit = valueAt(row, "unit");
    if (typeof unit === "string" && unit.trim()) units.add(unit.trim());
  }
  return units;
}

// The 30-month-vs-window concern: enumerate the frequency calendar inside the
// observed range, so "a period the response omitted" is decidable. Bounded by
// MAX_CALENDAR_SPAN — a corrupt label must not spin the enumerator.
const MAX_CALENDAR_SPAN = 2400; // 200 years monthly / 2400 years yearly

export function calendarBetween(minPeriod, maxPeriod, frequency) {
  const out = [];
  if (frequency === "yearly") {
    const from = Number(minPeriod);
    const to = Number(maxPeriod);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return out;
    for (let y = from; y <= to && out.length < MAX_CALENDAR_SPAN; y += 1) out.push(String(y));
    return out;
  }
  const [fy, fm] = String(minPeriod).split("-").map(Number);
  const [ty, tm] = String(maxPeriod).split("-").map(Number);
  if (![fy, fm, ty, tm].every(Number.isFinite)) return out;
  let y = fy;
  let m = fm;
  while ((y < ty || (y === ty && m <= tm)) && out.length < MAX_CALENDAR_SPAN) {
    out.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

// Map a tool result onto points. Returns one of:
//   { ok: true, points, anomalies, units }
//   { ok: false, reason }
//
// Strictness is deliberate: every named field must resolve, every period must
// parse under the frequency, every value must be numeric. One bad row refuses
// the WHOLE response (the refresh records map_violation and keeps the old data)
// rather than quietly dropping data the user would then read as complete.
export function evaluateMap(result, map, frequency) {
  const shape = validateMap(map);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  if (!SUPPORTED_FREQUENCIES.has(frequency)) {
    return { ok: false, reason: `unsupported frequency "${frequency}"` };
  }
  const rows = resolveRows(result, map.rows);
  if (!rows) {
    return { ok: false, reason: `no row list at "${map.rows}" in the response` };
  }

  const collected = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
      return { ok: false, reason: `row ${index} is not an object` };
    }
    const rawPeriod = valueAt(row, map.period);
    if (rawPeriod == null || rawPeriod === "") {
      return { ok: false, reason: `row ${index} has no "${map.period}"` };
    }
    const period = normalizePeriod(rawPeriod, frequency);
    if (!period) {
      return { ok: false, reason: `row ${index} period "${rawPeriod}" does not parse as ${frequency}` };
    }
    const rawValue = valueAt(row, map.value);
    const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (rawValue == null || rawValue === "" || !Number.isFinite(value)) {
      return { ok: false, reason: `row ${index} value is not numeric` };
    }
    const source = valueAt(row, map.source);
    let series = "";
    if (map.series) {
      const rawSeries = valueAt(row, map.series);
      if (rawSeries == null || rawSeries === "") {
        return { ok: false, reason: `row ${index} has no "${map.series}"` };
      }
      series = String(rawSeries);
    }
    collected.push({ series, period, value, source: source == null ? null : String(source) });
  }

  // One map covers one series: a response that resolves the series field to
  // several values is refused rather than half-bound (v1 has no per-series
  // filtering, so silently picking one would bind the wrong data).
  const seriesKeys = new Set(collected.map((p) => p.series));
  if (seriesKeys.size > 1) {
    return {
      ok: false,
      reason: `map.series resolves to ${seriesKeys.size} series in one response (one map covers one series)`,
    };
  }

  // Same-period dedupe, BEFORE anything is compared or stored: the probed
  // yearly defect puts both `2023` and `2023-12-31` in one response. Equal
  // values collapse into one point; different values are an anomaly with both
  // sides recorded and neither written.
  const byKey = new Map();
  const anomalies = [];
  for (const point of collected) {
    const key = `${point.series}\u0000${point.period}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...point, variants: [{ value: point.value, source: point.source }] });
      continue;
    }
    if (existing.value === point.value) {
      existing.variants.push({ value: point.value, source: point.source });
      continue;
    }
    if (!existing.conflict) {
      existing.conflict = true;
      anomalies.push({
        series: point.series,
        period: point.period,
        values: [...existing.variants, { value: point.value, source: point.source }],
      });
      byKey.delete(key);
    } else {
      const anomaly = anomalies.find((a) => a.series === point.series && a.period === point.period);
      anomaly?.values.push({ value: point.value, source: point.source });
    }
  }

  const points = [...byKey.values()]
    .map(({ variants, conflict, ...point }) => point)
    .sort((a, b) => (a.series === b.series ? a.period.localeCompare(b.period) : a.series.localeCompare(b.series)));

  return { ok: true, points, anomalies, units: unitsFromResult(result, map) };
}

// ── The replay client ────────────────────────────────────────────────────────

// Same resolution the dsh child's profile writer performs (dsh-profile.js
// writeMcpPatch): the installed config's own headers, with the per-user
// registry token substituted at call time for a registry-origin server. A
// non-registry server keeps whatever static header its config carries.
export function resolveMcpTarget(server, ownerEmail) {
  const row = extensionStore.getMcpServer(server);
  if (!row) throw new ChartSourceError("unreachable", `MCP server "${server}" is not installed`);
  if (row.enabled === false) throw new ChartSourceError("unreachable", `MCP server "${server}" is disabled`);
  const config = row.config ?? {};
  const url = typeof config.url === "string" ? config.url.trim() : "";
  if (!url) {
    throw new ChartSourceError("unreachable", `MCP server "${server}" has no HTTP endpoint (stdio servers are not replayable)`);
  }
  const headers = { ...(config.headers || {}) };
  if (registryCredentials.isRegistryRef(config)) {
    const token = registryCredentials.liveToken(ownerEmail);
    if (!token) {
      throw new ChartSourceError("credential", `no live registry credential for ${server}`);
    }
    headers.Authorization = `Bearer ${token}`;
  }
  return { url, headers };
}

// One JSON-RPC request over streamable HTTP. Returns { result, sessionId }.
// SSE bodies are scanned for the response carrying OUR id (an SSE stream can
// interleave notifications); a plain JSON body is read as-is.
async function rpc({ url, headers, method, params, id, sessionId, timeoutMs, fetchImpl }) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new ChartSourceError(
      res.status === 401 || res.status === 403 ? "credential" : "unreachable",
      `MCP ${method} returned ${res.status}: ${text.slice(0, 200)}`
    );
    err.status = res.status;
    throw err;
  }
  let payload = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const messages = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    payload = messages.find((m) => m.id === id) ?? messages[messages.length - 1] ?? null;
  } else {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ChartSourceError("tool_error", `MCP ${method} returned unparseable body`);
    }
  }
  if (!payload) throw new ChartSourceError("tool_error", `MCP ${method} returned no message`);
  if (payload.error) {
    throw new ChartSourceError("tool_error", `MCP ${method} error: ${payload.error.message || JSON.stringify(payload.error)}`);
  }
  return { result: payload.result, sessionId: res.headers.get("mcp-session-id") };
}

function isTransportError(err) {
  return (
    err instanceof ChartSourceError
      ? err.code === "unreachable"
      : err?.name === "TimeoutError" || err?.name === "AbortError" || err?.name === "TypeError"
  );
}

// initialize → notifications/initialized → tools/call, one session per call
// (no pooled connection to keep alive — a refresh is minutes-to-days apart),
// with ONE transport retry. A JSON-RPC error is an answer, not a transport
// failure, and is never retried.
export async function callTool({ server, tool, args, ownerEmail = null, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const attempt = async () => {
    const target = resolveMcpTarget(server, ownerEmail);
    const init = await rpc({
      ...target,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      id: 1,
      sessionId: null,
      timeoutMs,
      fetchImpl,
    });
    const sessionId = init.sessionId;
    // The initialized notification is a notification (no id) — fire and forget,
    // but let its transport failure fail the attempt so the retry covers it.
    await fetchImpl(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...target.headers,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err) => {
      throw new ChartSourceError("unreachable", `MCP initialized notification failed: ${err.message}`);
    });
    const call = await rpc({
      ...target,
      method: "tools/call",
      params: { name: tool, arguments: args ?? {} },
      id: 2,
      sessionId,
      timeoutMs,
      fetchImpl,
    });
    return unwrapToolResult(call.result);
  };
  try {
    return await attempt();
  } catch (err) {
    if (!isTransportError(err)) throw err;
    return attempt();
  }
}

// A tools/call result is either structured content or a text block carrying
// JSON. An isError result is the tool's own refusal (an answer, not a
// transport fault) and surfaces as tool_error with its text.
export function unwrapToolResult(result) {
  if (!result || typeof result !== "object") {
    throw new ChartSourceError("tool_error", "MCP tools/call returned no result");
  }
  const textBlock = Array.isArray(result.content)
    ? result.content.find((b) => b?.type === "text" && typeof b.text === "string")
    : null;
  if (result.isError) {
    throw new ChartSourceError("tool_error", `tool returned an error: ${textBlock?.text?.slice(0, 300) || "unknown"}`);
  }
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  if (textBlock) {
    try {
      return JSON.parse(textBlock.text);
    } catch {
      throw new ChartSourceError("tool_error", `tool result was not JSON: ${textBlock.text.slice(0, 200)}`);
    }
  }
  throw new ChartSourceError("tool_error", "tool result carried no content");
}

// ── The freshness gate ───────────────────────────────────────────────────────

// The cheap signal a scheduled/on-open tick consults first: `data_stats` for
// the bound concept. Its fingerprint is what "nothing moved upstream" means.
// Tolerant by design — an unrecognised shape yields null, and the caller then
// READS (a cache read is cheap; skipping on a misread fingerprint would be a
// lie about freshness, which is worse).
export async function freshnessFingerprint({ server, concept, ownerEmail = null, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!concept) return null;
  let result;
  try {
    result = await callTool({
      server,
      tool: "data_stats",
      args: { concept_id: concept },
      ownerEmail,
      fetchImpl,
      timeoutMs,
    });
  } catch {
    // A gate we cannot read is not an error state: it means "unknown", and the
    // caller reads the series (cheap, cache-only) instead of skipping.
    return null;
  }
  const stats = findStats(result, concept);
  if (!stats) return null;
  const parts = [stats.last_fetch ?? stats.lastFetch ?? "", stats.latest_date ?? stats.latestDate ?? "", stats.rows ?? ""];
  if (!parts.some((p) => p !== "" && p != null)) return null;
  return parts.map((p) => String(p ?? "")).join("|");
}

// The stats object for a concept can arrive flat, inside an array, or under a
// concept-keyed object — all three are searched for the fields that make the
// signal, in that order.
function findStats(node, concept, depth = 0) {
  if (!node || typeof node !== "object" || depth > 4) return null;
  if (Array.isArray(node)) {
    const exact = node.find((n) => n?.concept_id === concept || n?.concept === concept);
    if (exact) return exact;
    for (const item of node) {
      const hit = findStats(item, concept, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (hasStatsFields(node)) return node;
  const keyed = node[concept];
  if (keyed && typeof keyed === "object") {
    const hit = findStats(keyed, concept, depth + 1);
    if (hit) return hit;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      const hit = findStats(value, concept, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function hasStatsFields(node) {
  return ["last_fetch", "lastFetch", "latest_date", "latestDate"].some((k) => k in node);
}