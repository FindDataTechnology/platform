// ── Chart bindings: identity, priority, and the replay gate ──────────────────
// (openspec: add-chart-data-binding)
//
// A binding is a data SOURCE. Its identity is content-derived — the lineage key
// folds server, tool, arguments and mapping into one hash — so two charts over
// the same call share one row and one observation history, and re-attaching the
// same source is idempotent.
//
// The replay gate is data, not code: `chart-replay-allowlist.json` names, per
// server, the exact read tools a refresh may call. The write surface upstream
// is broader than naming conventions suggest — `policy_delete`,
// `platform_trigger` and `fetch` all mutate state and none of them matches a
// create/update/add prefix — so "looks like a read" is not a safety argument.
// Default deny, exact names only, configurable without a code change.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as db from "./db.js";
import {
  canonicalJson,
  defaultMapForTool,
  evaluateMap,
  inferFrequencyFromLabels,
  normalizePeriod,
  SUPPORTED_FREQUENCIES,
  validateMap,
} from "./chart-source.js";

const ALLOWLIST_PATH = process.env.CHART_REPLAY_ALLOWLIST_PATH
  ? path.resolve(process.env.CHART_REPLAY_ALLOWLIST_PATH)
  : path.resolve("chart-replay-allowlist.json");

// The documented default when no file is present: the cache-only read tool of
// the one probed server. A missing file is NOT "allow everything" — it is this
// list, and any other server/tool is refused.
const ALLOWLIST_FALLBACK = { servers: { "fd-open-data-mcp": ["read_series"] } };

let broadcast = () => {};

export function setBroadcast(fn) {
  if (fn) broadcast = fn;
}

// Refusals the REST layer translates: `status` is HTTP, `code` is the stable
// machine-readable half, and the UI localizes from the code.
export class BindingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "BindingError";
    this.status = status;
    this.code = code;
  }
}

// ── The replay allowlist ─────────────────────────────────────────────────────

// Read per call, not cached at boot: the file is the operator's control and a
// restart should not be needed to add a tool. Tiny file, rare callers.
export function loadAllowlist() {
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[chart-bindings] allowlist unreadable (${err.message}); using the built-in default`);
    }
    doc = ALLOWLIST_FALLBACK;
  }
  const servers = doc?.servers;
  if (!servers || typeof servers !== "object") return { ...ALLOWLIST_FALLBACK.servers };
  const clean = {};
  for (const [server, tools] of Object.entries(servers)) {
    if (!Array.isArray(tools)) continue;
    clean[server] = tools.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim());
  }
  return clean;
}

export function allowlistPath() {
  return ALLOWLIST_PATH;
}

// Exact names only — `read_series` is allowed, `read*` is not a member, and a
// server with no entry has no replayable tools at all.
export function isReplayable(server, tool, allowlist = loadAllowlist()) {
  const tools = allowlist?.[server];
  return Array.isArray(tools) && tools.includes(tool);
}

// Decide a tool's bindability from its projected name (`mcp__<server>__<tool>`)
// — the shape the declared channel receives from the model and the shape the
// turn's candidates carry.
export function parseMcpToolName(name) {
  const match = /^mcp__([^_].*?)__(.+)$/.exec(String(name || ""));
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}

export function assertReplayable(server, tool, allowlist = loadAllowlist()) {
  if (isReplayable(server, tool, allowlist)) return;
  const known = Array.isArray(allowlist?.[server]) ? allowlist[server] : [];
  throw new BindingError(
    403,
    "tool_not_allowlisted",
    known.length
      ? `tool "${tool}" is not on the replay allowlist for ${server} (allowed: ${known.join(", ")})`
      : `${server} has no replayable read tools on this deployment's allowlist`
  );
}

// ── Lineage identity ─────────────────────────────────────────────────────────

// sha256(server|tool|canonical(args)|canonical(map)). Canonical JSON on both
// sides: a binding is the same binding regardless of the key order a caller
// happened to use, and a map change is a DIFFERENT binding (the extraction is
// part of what the data source is).
export function lineageKey({ server, tool, args, map }) {
  const payload = [server, tool, canonicalJson(args ?? {}), canonicalJson(map ?? {})].join("|");
  return createHash("sha256").update(payload).digest("hex");
}

// ── Origin priority ──────────────────────────────────────────────────────────

export const ORIGIN_RANK = { inferred: 1, confirmed: 2, declared: 3 };

// No downgrade: an explicit user confirmation outranks an inference, a later
// declaration outranks a confirmation, and nothing outranks a declaration.
export function originRank(origin) {
  return ORIGIN_RANK[origin] ?? 0;
}

export function canReplace(currentOrigin, nextOrigin) {
  return originRank(nextOrigin) >= originRank(currentOrigin);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// A candidate is the same-turn call the captured chart was drawn from: its
// exact name, arguments and result. Held on the resource, never a binding by
// itself — attaching always goes through one of the three sources.
export function candidateIdentity(candidate) {
  return `${candidate?.name ?? ""}\u0000${canonicalJson(candidate?.args ?? {})}`;
}

// Merge newly captured candidates into the ones already retained for a chart:
// identity is (name, args), and the newest result wins (a regenerated chart
// re-ran the call). Results are capped upstream, at the capture funnel.
export function mergeCandidates(existing, incoming) {
  const byIdentity = new Map();
  for (const candidate of [...(existing ?? []), ...(incoming ?? [])]) {
    if (!candidate || typeof candidate.name !== "string") continue;
    byIdentity.set(candidateIdentity(candidate), candidate);
  }
  return [...byIdentity.values()];
}

// The server/tool pair a candidate names, resolved through the same rules the
// declared channel uses: the name must be an MCP projection of a time-series
// read tool on a server this deployment knows how to replay.
function candidateSource(candidate, allowlist = loadAllowlist()) {
  const parsed = parseMcpToolName(candidate?.name);
  if (!parsed) return null;
  const map = defaultMapForTool(parsed.tool);
  if (!map) return null;
  if (!Array.isArray(allowlist?.[parsed.server])) return null;
  return { ...parsed, map, allowlisted: isReplayable(parsed.server, parsed.tool, allowlist) };
}

// The parseable body of a recorded tool result. Recorded results are text (the
// dsh turn blocks carry the rendered text); a caller may also hand over an
// already-parsed object.
export function candidateResultValue(candidate) {
  const result = candidate?.result;
  if (result == null) return null;
  if (typeof result === "object") return result;
  try {
    return JSON.parse(String(result));
  } catch {
    return null;
  }
}

let schedulerHook = () => {};

// The route layer wires this to the scheduler's resync, so attach/detach change
// which timers exist without the scheduler being imported here (chart-refresh
// already imports this module — a second import would be a cycle).
export function setSchedulerHook(fn) {
  if (typeof fn === "function") schedulerHook = fn;
}

// Called by the library service after anything that could change which
// bindings are referenced or how they refresh (detach, delete, rule change).
export function notifyScheduleDirty() {
  schedulerHook();
}

// Attach a binding to one series of one resource.
//
// Priority is enforced HERE, on write: a source may replace the binding of a
// series only when its origin outranks (or equals) the incumbent's, so an
// inference can never demote a user's confirmation, and a confirmation never
// overrides a declaration. Re-attaching an identity that already exists reuses
// the row — that is what makes two charts over one call share one history.
export function attachBinding({
  resourceId,
  seriesIndex = 0,
  server,
  tool,
  args = {},
  map = null,
  origin,
  concept = null,
  frequency = null,
  unit = null,
}) {
  if (!db.isDbReady()) throw new BindingError(503, "db_unavailable", "绑定暂不可用");
  const row = db.getResource(resourceId);
  if (!row) throw new BindingError(404, "resource_not_found", "资源不存在");
  if (row.type !== "chart") throw new BindingError(400, "not_a_chart", "只有图表资源可以绑定数据源");
  if (!originRank(origin)) throw new BindingError(400, "invalid_origin", "绑定来源无效");
  const resolvedMap = map ?? defaultMapForTool(tool);
  if (!defaultMapForTool(tool)) {
    throw new BindingError(400, "unsupported_tool", `${server}/${tool} is not a bindable time-series read tool`);
  }
  // The allowlist bounds what is bindable, not just what is replayable: a
  // server this deployment does not list has no bindable tools at all.
  if (!Array.isArray(loadAllowlist()?.[server])) {
    throw new BindingError(400, "unsupported_server", `${server} 不在可绑定的数据源列表中`);
  }
  const shape = validateMap(resolvedMap);
  if (!shape.ok) throw new BindingError(400, "invalid_map", shape.reason);
  // Normalization is impossible without a cadence, and a wrong guess corrupts
  // every stored period — refuse rather than assume.
  if (!SUPPORTED_FREQUENCIES.has(frequency)) {
    throw new BindingError(400, "unsupported_frequency", `周期无法规范化：frequency 为 "${frequency ?? "未知"}"`);
  }
  if (!Number.isInteger(seriesIndex) || seriesIndex < 0) {
    throw new BindingError(400, "invalid_series", "seriesIndex 无效");
  }

  const refs = refsOf(row);
  const incumbent = refs.find((r) => r.seriesIndex === seriesIndex);
  if (incumbent) {
    const current = db.getChartBinding(incumbent.bindingId);
    if (current && !canReplace(current.origin, origin)) {
      throw new BindingError(
        409,
        "origin_downgrade",
        `已有 ${current.origin} 绑定，${origin} 不能覆盖它`
      );
    }
  }

  const key = lineageKey({ server, tool, args, map: resolvedMap });
  const now = new Date().toISOString();
  let binding = db.getChartBindingByLineage(key);
  const created = !binding;
  if (!binding) {
    binding = db.insertChartBinding({
      id: randomUUID(),
      lineageKey: key,
      server,
      tool,
      args,
      map: resolvedMap,
      concept,
      frequency,
      unit,
      origin,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    const patch = {};
    if (originRank(origin) > originRank(binding.origin)) patch.origin = origin;
    // A recorded unit/identity snapshot fills gaps; it never overwrites what
    // the incumbent binding already established.
    if (!binding.unit && unit) patch.unit = unit;
    if (!binding.concept && concept) patch.concept = concept;
    if (Object.keys(patch).length) binding = db.updateChartBinding(binding.id, patch, now);
  }

  const nextRefs = [...refs.filter((r) => r.seriesIndex !== seriesIndex), { seriesIndex, bindingId: binding.id }].sort(
    (a, b) => a.seriesIndex - b.seriesIndex
  );
  const updated = db.setResourceBindingRefs(resourceId, nextRefs, now);
  broadcast({ type: "resources_changed", action: "bound", id: resourceId, resourceType: row.type });
  schedulerHook();
  return { binding, resource: updated ?? row, created, replaced: incumbent?.bindingId ?? null };
}

export function refsOf(row) {
  const raw = row?.bindingRefs;
  let refs = [];
  if (Array.isArray(raw)) refs = raw;
  else if (typeof raw === "string" && raw) {
    try {
      refs = JSON.parse(raw);
    } catch {
      refs = [];
    }
  }
  return (Array.isArray(refs) ? refs : []).filter((r) => r && r.bindingId && Number.isInteger(r.seriesIndex));
}

// Detach one series' binding. The binding row itself survives until the
// retention sweep — it may still be referenced by another chart, and an
// unreferenced one is removed with its history by the sweep.
export function detachBinding(resourceId, bindingId) {
  const row = db.getResource(resourceId);
  if (!row) throw new BindingError(404, "resource_not_found", "资源不存在");
  const refs = refsOf(row);
  if (!refs.some((r) => r.bindingId === bindingId)) {
    throw new BindingError(404, "binding_not_attached", "该资源未引用此绑定");
  }
  const now = new Date().toISOString();
  const updated = db.setResourceBindingRefs(
    resourceId,
    refs.filter((r) => r.bindingId !== bindingId),
    now
  );
  broadcast({ type: "resources_changed", action: "unbound", id: resourceId, resourceType: row.type });
  schedulerHook();
  return { resource: updated ?? row, bindingId };
}

// ── Witness-based inference ──────────────────────────────────────────────────

// The option's own axis + series arrays: labels in axis order, and each
// series' values. Only series with a data array are witnesses.
export function optionWitnesses(option) {
  const axis = Array.isArray(option?.xAxis) ? option.xAxis[0] : option?.xAxis;
  const labels = Array.isArray(axis?.data) ? axis.data.map((l) => String(l)) : [];
  if (!labels.length) return { labels, series: [] };
  const series = (Array.isArray(option?.series) ? option.series : [])
    .map((entry, index) => ({ index, values: Array.isArray(entry?.data) ? entry.data : null }))
    .filter((w) => w.values && w.values.length);
  return { labels, series };
}

const WITNESS_TOLERANCE = 1e-6;

function valuesAgree(a, b) {
  const left = typeof a === "number" ? a : Number(a);
  const right = typeof b === "number" ? b : Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) <= scale * WITNESS_TOLERANCE;
}

// Does this response reproduce exactly one of the chart's series? Compared on
// normalized period keys (so a chart labelled `2026-08-01` witnesses a response
// about `2026-08`) and on values within tolerance.
export function witnessSeries({ points, labels, frequency, series }) {
  const normalized = new Map();
  labels.forEach((label, position) => {
    const key = normalizePeriod(label, frequency);
    if (key && !normalized.has(key)) normalized.set(key, position);
  });
  if (normalized.size !== points.length) return null;
  const matches = [];
  for (const witness of series) {
    let ok = true;
    for (const point of points) {
      const position = normalized.get(point.period);
      if (position === undefined || !valuesAgree(witness.values[position], point.value)) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(witness.index);
  }
  return matches.length === 1 ? matches[0] : null;
}

// Inference: witness every candidate against the captured option and bind only
// where the evidence is unambiguous. Zero matches and multiple matches both
// mean "no inference" — the chart stays eligible for user confirmation.
export function inferBindings({ resourceId, option, candidates = [], allowlist = loadAllowlist() }) {
  const { labels, series } = optionWitnesses(option);
  if (!labels.length || !series.length) return { attached: [], ambiguous: 0, considered: 0 };
  const frequency = inferFrequencyFromLabels(labels);
  if (!frequency) return { attached: [], ambiguous: 0, considered: 0 };

  const matches = new Map(); // seriesIndex -> [{ candidate, source, points, unit }]
  let considered = 0;
  for (const candidate of candidates) {
    const source = candidateSource(candidate, allowlist);
    if (!source) continue;
    const result = candidateResultValue(candidate);
    if (result == null) continue;
    const evaluated = evaluateMap(result, source.map, frequency);
    if (!evaluated.ok) continue;
    considered += 1;
    const seriesIndex = witnessSeries({ points: evaluated.points, labels, frequency, series });
    if (seriesIndex === null) continue;
    if (!matches.has(seriesIndex)) matches.set(seriesIndex, []);
    matches.get(seriesIndex).push({
      candidate,
      source,
      frequency,
      points: evaluated.points,
      unit: [...evaluated.units][0] ?? null,
    });
  }

  const attached = [];
  let ambiguous = 0;
  for (const [seriesIndex, hits] of matches) {
    if (hits.length !== 1) {
      ambiguous += 1;
      continue;
    }
    const [hit] = hits;
    try {
      const result = attachBinding({
        resourceId,
        seriesIndex,
        server: hit.source.server,
        tool: hit.source.tool,
        args: hit.candidate.args ?? {},
        map: hit.source.map,
        origin: "inferred",
        concept: hit.candidate.args?.concept_id ?? null,
        frequency: hit.frequency,
        unit: hit.unit,
      });
      attached.push(result);
    } catch {
      // A refused inference (a declared/confirmed binding already owns the
      // series) is the priority rule working, not an error.
    }
  }
  return { attached, ambiguous, considered };
}

// ── Candidate presentation ──────────────────────────────────────────────────

// What the confirmation UI is offered: the same-turn calls with their exact
// names and arguments, plus the map and cadence an attachment would use. Only
// candidates that could actually be bound appear — a shell command or a
// non-time-series tool is not a candidate, it is noise.
export function candidatesForResource(row, allowlist = loadAllowlist()) {
  const option = safeParse(row?.payload);
  const labels = optionWitnesses(option).labels;
  const frequency = labels.length ? inferFrequencyFromLabels(labels) : null;
  const out = [];
  for (const candidate of db.getResourceCandidates(row?.id)) {
    const source = candidateSource(candidate, allowlist);
    if (!source) continue;
    const result = candidateResultValue(candidate);
    const evaluated = result == null || !frequency ? null : evaluateMap(result, source.map, frequency);
    out.push({
      name: candidate.name,
      args: candidate.args ?? {},
      server: source.server,
      tool: source.tool,
      map: source.map,
      frequency,
      allowlisted: source.allowlisted,
      // A candidate that already maps is offered with its witnessed shape; one
      // that does not is still offered (the user is confirming the CALL, and a
      // declared map can be supplied with it).
      points: evaluated?.ok ? evaluated.points.length : null,
      unit: evaluated?.ok ? ([...evaluated.units][0] ?? null) : null,
      matchedSeries: evaluated?.ok ? witnessSeries({ points: evaluated.points, labels, frequency, series: optionWitnesses(option).series }) : null,
    });
  }
  return out;
}

function safeParse(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

// ── The declared channel ────────────────────────────────────────────────────

// Record a declaration from the agent's `chart_bind` tool. The call is
// validated against the same rules as everything else (a bindable time-series
// read tool of a listed server, a well-formed map), and the cadence is taken
// from the chart's OWN axis labels: the declaration names the source, the
// captured chart says how its periods are shaped, and the first read confirms
// both. Nothing is executed here — the first fetch happens on the first
// refresh.
export function attachDeclared({ resourceId, tool, args = {}, map = null, note = null }) {
  const row = db.getResource(resourceId);
  if (!row) throw new BindingError(404, "resource_not_found", "本轮没有可绑定的图表");
  const parsed = parseMcpToolName(tool);
  if (!parsed) {
    throw new BindingError(400, "invalid_tool", `"${tool}" 不是 MCP 工具名（应为 mcp__<server>__<tool>）`);
  }
  const defaultMap = defaultMapForTool(parsed.tool);
  if (!defaultMap) {
    throw new BindingError(400, "unsupported_tool", `${parsed.server}/${parsed.tool} 不是可绑定的时序读取工具`);
  }
  const option = safeParse(row.payload);
  const frequency = inferFrequencyFromLabels(optionWitnesses(option).labels);
  if (!frequency) {
    throw new BindingError(
      400,
      "unsupported_frequency",
      "无法从图表的周期标签判断频率（需要 YYYY 或 YYYY-MM 形式的类目轴），因此没有绑定"
    );
  }
  // The unit, when the declaring turn's own result is still retained: the first
  // observation records the contract, and the declaration can seed it.
  const candidates = db.getResourceCandidates(resourceId);
  const declaring = candidates.find((candidate) => {
    const source = parseMcpToolName(candidate?.name);
    if (!source || source.server !== parsed.server || source.tool !== parsed.tool) return false;
    return canonicalJson(candidate.args ?? {}) === canonicalJson(args ?? {});
  });
  let unit = null;
  if (declaring) {
    const value = candidateResultValue(declaring);
    const evaluated = value == null ? null : evaluateMap(value, map ?? defaultMap, frequency);
    if (evaluated?.ok && evaluated.units.size === 1) unit = [...evaluated.units][0];
  }
  const result = attachBinding({
    resourceId,
    seriesIndex: 0,
    server: parsed.server,
    tool: parsed.tool,
    args,
    map: map ?? defaultMap,
    origin: "declared",
    concept: args?.concept_id != null ? String(args.concept_id) : null,
    frequency,
    unit,
  });
  return { ...result, note: note ?? null };
}