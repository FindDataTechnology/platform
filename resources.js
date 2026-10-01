// ── Resource library (chat-produced artifacts: charts, saved files) ──────────
//
// openspec: add-resource-library. Two capture paths, one store:
//
//   - Charts are captured WITHOUT user action from every assistant turn, at
//     chat-history's mirror point — the single funnel every client and every
//     scheduled-task run passes through. The recognized form is the rendering
//     contract: a fenced ```echarts block whose body parses as a JSON object
//     (the same rule the web and mini-program renderers apply; a fence that
//     fails to parse is not a chart and falls back to a code block there and
//     is skipped here).
//   - Files are captured ONLY by explicit user action, and only then are bytes
//     copied into the store. The workspace is mutable and switchable, so a
//     reference would rot; the copy is what makes the resource durable.
//
// Identity is content (see db.insertResource): a repeat capture refreshes
// last_seen_at and keeps the first provenance, which is what makes regeneration
// — an honest re-send, since the runtime has no replace-turn operation —
// idempotent.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename as renameFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as bindings from "./chart-bindings.js";
import * as db from "./db.js";
import { storeDir } from "./paths.js";

// Module-specific store override, the paths.js contract (cf. CRON_STORAGE_PATH).
const STORAGE_PATH = process.env.RESOURCES_STORAGE_PATH || "";

// Per-file ceiling for a saved resource. Server-authoritative: the mini
// program's download/preview limits may be stricter, but this is what protects
// the cell's disk. Env-overridable so a tighter platform limit can be matched
// without a code change.
const MAX_FILE_BYTES =
  Number(process.env.RESOURCE_MAX_FILE_BYTES) > 0
    ? Number(process.env.RESOURCE_MAX_FILE_BYTES)
    : 20 * 1024 * 1024;

// Preference marker for the one-time history seeding pass. Its presence means
// "seeding already ran automatically" — a restart must never resurrect a
// resource the user deleted.
const SEED_MARKER = "resources.seeded_at";

let broadcast = () => {};

// The store root. NOTE: distinct from the repo-root `resources/` directory,
// which is the bundled Node runtime for packaging and is never imported.
export function storeRoot() {
  return storeDir("resources-store", STORAGE_PATH);
}

// The subtree `GET /api/files?root=resources` serves. Only saveFile and remove
// write here; the route stays strictly read-only.
export function filesRoot() {
  return path.join(storeRoot(), "files");
}

export function maxFileBytes() {
  return MAX_FILE_BYTES;
}

// Errors the route translates into HTTP responses. `code` is the stable
// machine-readable half; `message` is for the user.
export class ResourceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ResourceError";
    this.status = status;
    this.code = code;
  }
}

// The WS shape is the message object itself (ctx.broadcast takes one object):
// `type` is the discriminator, so the RESOURCE's type rides `resourceType` —
// a second `type` key would shadow the discriminator in the same JSON object.
function broadcastChange(action, resource) {
  broadcast({
    type: "resources_changed",
    action,
    id: resource.id,
    resourceType: resource.type,
  });
}

// ── Chart extraction ────────────────────────────────────────────────────────

const CHART_FENCE = /```echarts[ \t]*\r?\n([\s\S]*?)```/g;

// The fence body must parse as a JSON *object*: arrays and scalars are not
// chart options, and the renderers draw the same line (they fall back to a
// code block), so capture and rendering never disagree about what is a chart.
export function extractChartSpecs(text) {
  if (typeof text !== "string" || !text.includes("```echarts")) return [];
  const specs = [];
  // matchAll over a fresh iterator per call: no lastIndex state to leak between
  // messages (the regex is module-level and shared).
  for (const match of text.matchAll(CHART_FENCE)) {
    const body = match[1].trim();
    if (!body) continue;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    specs.push(parsed);
  }
  return specs;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// The option's own title wins; otherwise the label is session-derived so a list
// of charts from one conversation still reads like that conversation. `Chart`
// is English on purpose — the DB is shared by five locales, and the project's
// other generated title ("New chat") set that precedent.
function chartTitle(option, sessionTitle, ordinal) {
  const own = option?.title?.text;
  if (typeof own === "string" && own.trim()) return own.trim();
  const base =
    typeof sessionTitle === "string" && sessionTitle.trim() ? sessionTitle.trim() : "Chart";
  return `${base} · Chart ${ordinal}`;
}

// A candidate's recorded result is the turn's evidence, kept so the user can
// confirm a binding later. It is text from a tool call, and a single call can
// return a lot of it — capped here (per candidate, per chart) because the
// column lives on the resource row that list responses read.
const MAX_CANDIDATE_RESULT_BYTES =
  Number(process.env.RESOURCE_MAX_CANDIDATE_BYTES) > 0
    ? Number(process.env.RESOURCE_MAX_CANDIDATE_BYTES)
    : 200 * 1024;

// Same-turn MCP calls, in the shape binding-candidates are retained as. Only
// MCP projections qualify (`mcp__<server>__<tool>`): a shell command or a web
// fetch is not a data source for a chart, and offering it would be noise.
export function bindingCandidatesFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const candidates = [];
  for (const block of blocks) {
    if (!block || block.kind !== "tool") continue;
    const name = typeof block.name === "string" ? block.name : "";
    if (!name.startsWith("mcp__")) continue;
    if (block.result == null) continue;
    const result = typeof block.result === "string" ? block.result : JSON.stringify(block.result);
    candidates.push({
      name,
      args: block.args ?? {},
      result: result.length > MAX_CANDIDATE_RESULT_BYTES ? result.slice(0, MAX_CANDIDATE_RESULT_BYTES) : result,
    });
  }
  return candidates;
}

// ── Capture ─────────────────────────────────────────────────────────────────

// Record every chart spec in one assistant turn. Returns the resources that
// were CREATED (a repeat spec returns nothing — only its last_seen_at moves).
// Called from chat-history.recordMessage; never throws into the mirror path.
//
// `blocks` is the turn's evidence trail (assistant tool calls with their
// results), passed through from the mirror funnel. Two things ride it:
// binding candidates are retained on each captured chart, and a chart whose
// data a single same-turn call demonstrably produced gets an inferred binding.
export function captureFromMessage({ sessionId, messageId, sessionTitle, text, blocks = null, createdAt } = {}) {
  if (!db.isDbReady()) return [];
  const specs = extractChartSpecs(text);
  if (!specs.length) return [];
  const now = createdAt || new Date().toISOString();
  const candidates = bindingCandidatesFromBlocks(blocks);
  const created = [];
  specs.forEach((option, index) => {
    const payload = JSON.stringify(option);
    const { inserted, resource } = db.insertResource({
      id: randomUUID(),
      type: "chart",
      title: chartTitle(option, sessionTitle, index + 1),
      source: "auto",
      sessionId: sessionId || null,
      sessionTitle: sessionTitle || null,
      messageId: Number.isInteger(messageId) ? messageId : null,
      payload,
      contentHash: sha256(payload),
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    });
    if (!resource) return;
    const target = resource;
    if (candidates.length) {
      // Merged, not replaced: a regenerated chart brings the newest results for
      // the calls it made, while candidates from an earlier turn stay offered.
      const merged = bindings.mergeCandidates(db.getResourceCandidates(target.id), candidates);
      db.setResourceCandidates(target.id, merged);
      try {
        bindings.inferBindings({ resourceId: target.id, option, candidates: merged });
      } catch (err) {
        console.warn(`[resources] inference failed for ${target.id}: ${err.message}`);
      }
    }
    if (inserted) created.push(target);
    else db.touchResourceSeen(target.id, now);
  });
  for (const resource of created) {
    broadcastChange("created", resource);
  }
  return created;
}

// ── File save ───────────────────────────────────────────────────────────────

// A stored name must not become a dotfile (the serving route denies those, so
// the reference would 403 forever) and must never collapse to "." or "..".
// Otherwise the original name is preserved — CJK, spaces and dots included,
// since the serving route URL-encodes it — with control characters and path
// separators stripped and an over-long name trimmed from the front so the
// extension survives.
function safeStoredName(filename) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters IS the sanitizer
  const CONTROL_CHARS = /[\u0000-\u001f\u007f/\\]/g;
  const base = path.basename(String(filename || "file")).replace(CONTROL_CHARS, "");
  const trimmed = base.replace(/^\.+/, "");
  const chars = Array.from(trimmed);
  const capped = chars.length > 100 ? chars.slice(-100).join("") : trimmed;
  return capped && capped !== "." && capped !== ".." ? capped : "file";
}

const MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

function mimeFor(name) {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] || "application/octet-stream";
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

// Resolve an incoming path against the workspace root. Relative paths resolve
// from the root; absolute paths are accepted only when they land inside it (a
// client that knows the absolute path may send it verbatim). Rejections are the
// same class the serving route enforces: NUL, an empty path, or anything whose
// lexical resolution leaves the root.
function resolveUnderRoot(workspaceRoot, input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw || raw.includes("\0")) return null;
  const lexicalRoot = path.resolve(workspaceRoot);
  const lexical = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(lexicalRoot, raw);
  if (lexical === lexicalRoot || !lexical.startsWith(lexicalRoot + path.sep)) return null;
  return { lexicalRoot, lexical };
}

// Copy a workspace file into the store. The source must be a regular file
// inside the workspace root, proven by realpath — a symlink pointing out of
// the root is refused even though its lexical path looked contained.
export async function saveFile({ sessionId = null, messageId = null, path: inputPath, workspaceRoot }) {
  if (!db.isDbReady()) {
    throw new ResourceError(503, "db_unavailable", "资源库暂不可用");
  }
  const resolved = resolveUnderRoot(workspaceRoot, inputPath);
  if (!resolved) {
    throw new ResourceError(403, "invalid_path", "文件路径无效或不在工作区内");
  }
  let realRoot;
  let real;
  try {
    realRoot = await realpath(resolved.lexicalRoot);
    real = await realpath(resolved.lexical);
  } catch {
    throw new ResourceError(404, "file_not_found", "文件不存在或已被移除");
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new ResourceError(403, "invalid_path", "文件路径无效或不在工作区内");
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) {
    throw new ResourceError(404, "file_not_found", "文件不存在或已被移除");
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new ResourceError(
      413,
      "file_too_large",
      `文件超过 ${formatBytes(MAX_FILE_BYTES)} 上限，无法存入资源`
    );
  }

  const bytes = await readFile(real);
  const hash = sha256(bytes);
  const existing = db.findResourceByHash(hash);
  if (existing) return { inserted: false, resource: existing };

  const id = randomUUID();
  const originalName = path.basename(real).slice(0, 200) || "file";
  const name = safeStoredName(originalName);
  const relDir = id;
  const dir = path.join(filesRoot(), relDir);
  const finalPath = path.join(dir, name);
  // Write-then-rename: a crash mid-write leaves only a dotfile temp (which the
  // serving route refuses), never a truncated file served as the real one.
  const tmpPath = path.join(dir, `.${name}.tmp`);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(tmpPath, bytes);
    await renameFile(tmpPath, finalPath);
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new ResourceError(500, "store_failed", `保存失败：${err.message}`);
  }

  const session = sessionId ? db.getSessionMeta(sessionId) : null;
  const now = new Date().toISOString();
  const { inserted, resource } = db.insertResource({
    id,
    type: "file",
    title: originalName,
    source: "manual",
    sessionId: sessionId || null,
    sessionTitle: session?.title || null,
    messageId: Number.isInteger(messageId) ? messageId : null,
    filePath: `${relDir}/${name}`,
    fileSize: bytes.length,
    fileMime: mimeFor(name),
    contentHash: hash,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  if (!inserted) {
    // Lost a race against an identical save: the row already existed after all.
    await rm(dir, { recursive: true, force: true });
    return { inserted: false, resource };
  }
  broadcastChange("created", resource);
  return { inserted: true, resource };
}

// ── Management ──────────────────────────────────────────────────────────────

// A binding as a CLIENT reads it: the identity fields a source line needs, the
// stale state with its reason CODE (localized client-side — server text is not
// translatable), and whether a refresh would even be attempted. `refreshable`
// is computed from the deployment's allowlist rather than stored: the file is
// the operator's control, so flipping it must not require a data migration.
export function bindingView(binding, stats = null) {
  const allowlisted = bindings.isReplayable(binding.server, binding.tool);
  return {
    id: binding.id,
    server: binding.server,
    tool: binding.tool,
    args: binding.args,
    map: binding.map,
    concept: binding.concept,
    frequency: binding.frequency,
    unit: binding.unit,
    origin: binding.origin,
    stale: binding.stale,
    staleReason: binding.stale ? binding.staleReason : null,
    staleSince: binding.stale ? binding.staleSince : null,
    lastOkAt: binding.lastOkAt,
    consecutiveFailures: binding.consecutiveFailures,
    refreshRule: binding.refreshRule,
    refreshable: allowlisted,
    refreshableReason: allowlisted ? null : "allowlist",
    periods: stats?.periods ?? 0,
    lastObservedAt: stats?.lastObservedAt ?? null,
  };
}

// Attach the binding views + the parsed series→binding refs a client needs.
// One batch read for the whole page (list responses are the hot path).
function decorate(rows) {
  const items = Array.isArray(rows) ? rows : [rows];
  const ids = new Set();
  for (const row of items) {
    for (const ref of bindings.refsOf(row)) ids.add(ref.bindingId);
  }
  const bindingRows = db.getChartBindings([...ids]);
  const stats = db.seriesPointStats([...ids]);
  const views = new Map(bindingRows.map((b) => [b.id, bindingView(b, stats.get(b.id))]));
  const decorateOne = (row) => {
    if (!row) return row;
    const refs = bindings.refsOf(row);
    return {
      ...row,
      bindingRefs: refs,
      bindings: refs.map((ref) => ({ seriesIndex: ref.seriesIndex, ...(views.get(ref.bindingId) ?? { id: ref.bindingId }) })),
    };
  };
  return Array.isArray(rows) ? items.map(decorateOne) : decorateOne(items[0]);
}

export function list(params = {}) {
  const page = db.listResources(params);
  return { ...page, items: decorate(page.items) };
}

export function get(id) {
  return decorate(db.getResource(id));
}

// ── Binding mutations (openspec: add-chart-data-binding) ────────────────────
//
// The confirmation path: the user picks one of the chart's retained same-turn
// candidates. The candidate supplies the exact call — name, arguments and the
// map proposed from its recorded result — so nothing is reconstructed here.

export function attachFromCandidate(id, { candidateIndex = 0, seriesIndex = 0, map = null } = {}) {
  const row = db.getResource(id);
  if (!row) throw new ResourceError(404, "resource_not_found", "资源不存在");
  const candidates = bindings.candidatesForResource(row);
  const candidate = candidates[candidateIndex];
  if (!candidate) throw new ResourceError(404, "candidate_not_found", "候选数据调用不存在");
  const result = bindings.attachBinding({
    resourceId: id,
    seriesIndex: Number.isInteger(seriesIndex) ? seriesIndex : 0,
    server: candidate.server,
    tool: candidate.tool,
    args: candidate.args,
    map: map ?? candidate.map,
    origin: "confirmed",
    concept: candidate.args?.concept_id ?? null,
    frequency: candidate.frequency,
    unit: candidate.unit,
  });
  return { ...result, resource: get(result.resource.id) };
}

export function detach(id, bindingId) {
  const result = bindings.detachBinding(id, bindingId);
  return { ...result, resource: get(result.resource.id) };
}

// The refresh rule is validated for shape here; an unparseable cron is caught
// by the scheduler, which warns and skips rather than scheduling garbage.
export function setRefreshRule(id, bindingId, rule) {
  const row = db.getResource(id);
  if (!row) throw new ResourceError(404, "resource_not_found", "资源不存在");
  if (!bindings.refsOf(row).some((r) => r.bindingId === bindingId)) {
    throw new ResourceError(404, "binding_not_attached", "该资源未引用此绑定");
  }
  const cleaned = normalizeRefreshRule(rule);
  const updated = db.updateChartBinding(bindingId, { refreshRule: cleaned }, new Date().toISOString());
  bindings.notifyScheduleDirty();
  broadcastChange("bound", row);
  return { binding: bindingView(updated), resource: get(id) };
}

const CRON_SHAPE = /^\s*\S+(\s+\S+){4,5}\s*$/;

function normalizeRefreshRule(rule) {
  if (rule == null) return null;
  if (typeof rule !== "object" || Array.isArray(rule)) {
    throw new ResourceError(400, "invalid_rule", "刷新规则无效");
  }
  const out = {};
  if (rule.cron != null) {
    const cron = String(rule.cron).trim();
    if (!CRON_SHAPE.test(cron)) throw new ResourceError(400, "invalid_rule", "cron 表达式需要 5–6 个字段");
    out.cron = cron;
    if (rule.tz != null) {
      const tz = String(rule.tz).trim();
      if (!tz) throw new ResourceError(400, "invalid_rule", "时区无效");
      out.tz = tz;
    }
    return out;
  }
  if (rule.ttlSec != null) {
    const ttl = Number(rule.ttlSec);
    if (!Number.isFinite(ttl) || ttl <= 0) throw new ResourceError(400, "invalid_rule", "TTL 需要为正秒数");
    out.ttlSec = Math.floor(ttl);
    return out;
  }
  throw new ResourceError(400, "invalid_rule", "刷新规则需要 cron 或 ttlSec");
}

// The observation timeline of one binding, newest first — the refresh log as
// the UI reads it. Time-filterable server-side so a long-lived binding does not
// ship its whole history to render a week of it.
export function observationsFor(bindingId, { since = null, until = null, limit = 100, offset = 0 } = {}) {
  return db.listChartRefreshes(bindingId, { since, until, limit, offset });
}

export function rename(id, title) {
  const clean = typeof title === "string" ? title.trim().slice(0, 200) : "";
  if (!clean) throw new ResourceError(400, "invalid_title", "标题不能为空");
  const resource = db.renameResource(id, clean, new Date().toISOString());
  if (resource) {
    broadcastChange("renamed", resource);
  }
  return resource;
}

export async function remove(id) {
  const resource = db.deleteResource(id);
  if (!resource) return null;
  if (resource.type === "file" && /^[A-Za-z0-9_-]{1,64}$/.test(resource.id)) {
    await rm(path.join(filesRoot(), resource.id), { recursive: true, force: true });
  }
  // The row carried its binding references away with it; the scheduler and the
  // sweeper reconcile from what is left.
  if (bindings.refsOf(resource).length) bindings.notifyScheduleDirty();
  broadcastChange("deleted", resource);
  return resource;
}

// ── Seeding (existing history) ──────────────────────────────────────────────

// One-time pass over previously recorded assistant messages so charts produced
// before the library existed are not lost. The preference marker makes the
// automatic path run at most once per cell — a restart must not resurrect a
// resource the user deleted. `force` is the operator re-run
// (scripts/seed-resources.mjs); that one MAY re-create deleted entries, which
// is the documented consequence of asking for it explicitly. `dryRun` reports
// what a run would add without writing anything (and without setting the
// marker).
export function seedFromHistory({ force = false, dryRun = false } = {}) {
  if (!db.isDbReady()) {
    return { seeded: 0, scanned: 0, skipped: true, reason: "db-unavailable" };
  }
  if (!force && db.getPreference(SEED_MARKER)) {
    return { seeded: 0, scanned: 0, skipped: true, reason: "already-seeded" };
  }
  const rows = db.listMessagesWithChartFences();
  if (dryRun) {
    const seen = new Set();
    let wouldSeed = 0;
    for (const row of rows) {
      for (const option of extractChartSpecs(row.content)) {
        const hash = sha256(JSON.stringify(option));
        if (seen.has(hash)) continue;
        seen.add(hash);
        if (!db.findResourceByHash(hash)) wouldSeed += 1;
      }
    }
    return { seeded: 0, wouldSeed, scanned: rows.length, skipped: false, dryRun: true };
  }
  let seeded = 0;
  db.runInTransaction(() => {
    for (const row of rows) {
      const specs = extractChartSpecs(row.content);
      specs.forEach((option, index) => {
        const payload = JSON.stringify(option);
        const at = row.createdAt || new Date().toISOString();
        const { inserted } = db.insertResource({
          id: randomUUID(),
          type: "chart",
          title: chartTitle(option, row.sessionTitle, index + 1),
          source: "auto",
          sessionId: row.sessionId || null,
          sessionTitle: row.sessionTitle || null,
          messageId: Number.isInteger(row.messageId) ? row.messageId : null,
          payload,
          contentHash: sha256(payload),
          createdAt: at,
          updatedAt: at,
          lastSeenAt: at,
          seeded: true,
        });
        if (inserted) seeded += 1;
      });
    }
    db.setPreference(SEED_MARKER, new Date().toISOString());
  });
  return { seeded, scanned: rows.length, skipped: false };
}

// Startup init: inject the WS broadcast and run the guarded seeding pass.
// Seeding deliberately does NOT broadcast — it runs before clients connect
// (and on the operator path there is no server at all).
export async function initStore({ broadcast: broadcastFn } = {}) {
  if (broadcastFn) broadcast = broadcastFn;
  // The binding module broadcasts its own mutations (bind/unbind) on the same
  // event: one injection point for the library's whole surface.
  bindings.setBroadcast(broadcast);
  await mkdir(filesRoot(), { recursive: true });
  const result = seedFromHistory();
  if (result.seeded > 0) {
    console.log(
      `[resources] seeded ${result.seeded} chart resource(s) from ${result.scanned} message(s)`
    );
  }
  return result;
}