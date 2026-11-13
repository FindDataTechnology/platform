// Fleet management routes (agent-fleet-core).
//
// Fleet = organization, Member = stable post (ADR-0031). Every write path
// ends in a synchronous reconcile (server/fleet-reconcile.js) so the
// materialized task-engine jobs always match the fleet's declared state —
// there is no background syncer to race. Auth/identity semantics mirror
// clusters.js: auth-on reads the forward-auth user, auth-off the machine
// owner; writes are owner-scoped by fleet.ownerEmail.

import { Router } from "express";
import { fetchLexUsageFor, fetchWireUsageFor } from "../../lib/board-adapters.js";
import * as cron from "../../cron.js";
import * as catalog from "../../catalog.js";
import * as chatHistory from "../../chat-history.js";
import { rosterPresetId, readFleetPluginRows } from "../../dsh-profile.js";
import { materializeFleetPlugins, declaredPluginsForFleet, composeFleetPluginView } from "../fleet-plugins.js";
import { resolveDispatchTarget } from "../../server/fleet-chat-context.js";
import { getClusterDatabase } from "./clusters-db.js";
import {
  getFleetDatabase,
  FLEET_STATES,
  MEMBER_TARGET_KINDS,
  isPersonaBackedTargetKind,
} from "./fleets-db.js";
import { reconcileFleet, deriveMemberStatus, cronPeriodMs, staleWindowMs } from "../fleet-reconcile.js";
import { validateOrchestration, expandedEdges, dispatchAllowed, constraintsOf, CARRIERS } from "../fleet-orchestration.js";
import { validateFleetDraft, applyFleetDraft } from "../fleet-architect.js";
import { buildConsoleViewModel } from "../console-blocks/index.js";
import { splitToolTarget } from "../tool-turn.js";
import { resolveServerEndpoint, resolveStdioServerConfig } from "../../lib/action-executor.js";
import { classifyProvenance } from "../../lib/precedent-grade.js";
import { auditorAllowedFor, validateAuditorToolFace, AUDITOR_VERDICTS, isVerdict } from "../../lib/auditor-tool-face.js";
import { domainFor } from "../../lib/personal-domain-map.js";
import { validateRule } from "../../lib/precedent-candidate.js";
import { agentMayHandle } from "../../lib/personal-mandate.js";

// Team plugin landing (add-fleet-plugin-declaration 2.1). Called after a team is
// born from a template and after a state change: the row set is RECOMPUTED from
// every live team's declaration, so both add and remove land in one write. A
// failure here is logged and never fails the fleet action — the team exists
// either way, and the next landing reconciles the patch.
// 一个团队的生效插件视图（3.1）：唯一事实是补丁层 + 台账，二者都每次读现算；
// 声明来自来源模板的已装包，规则在 server/fleet-plugins.js（可注入、可测）。
export function fleetPluginsForView(fleet, ctx, dirs) {
  try {
    const effective = readFleetPluginRows(dirs);
    const declared = declaredPluginsForFleet({ fleet, getInstalledPack: dbModule.getInstalledPack });
    return composeFleetPluginView({
      fleetId: fleet?.id,
      declaredPlugins: declared.plugins,
      effective,
      roster: Array.isArray(ctx?.pluginBundles) ? ctx.pluginBundles : [],
    });
  } catch (err) {
    console.warn(`[fleets] plugin read face failed: ${err?.message || err}`);
    return [];
  }
}

function syncFleetPlugins(db, log = console) {
  try {
    const fleets = typeof db?.listFleets === "function" ? db.listFleets() : [];
    return materializeFleetPlugins({ fleets, getInstalledPack: dbModule.getInstalledPack, log });
  } catch (err) {
    log.warn(`[fleets] plugin landing failed: ${err?.message || err}`);
    return null;
  }
}
import { assessPersonalAgent } from "../../lib/personal-agent-readiness.js";
import { fleetModelChoiceError, resolveModelChain, validateConfigDims, effortUnionFrom } from "../fleet-model.js";
import { fetchWithTimeout } from "../../lib/fetch-with-timeout.js";
import {
  validateReportPayload,
  resolveAttribution,
  floodWindowMs,
  checkFlood,
  buildLatestView,
  reportTimelineEntry,
} from "../fleet-reports.js";
import {
  validateEscalatePayload,
  validateResolution,
  renderDecisionSegment,
  buildExecuteNowPrompt,
  OPEN_QUEUE_LIMIT,
} from "../fleet-decisions.js";
import {
  normalizeDelegationPolicy,
  normalizeQuestion,
  routeForItem,
  SEVERITY_RANK,
} from "./fleets-db.js";
import { normalizeKnowledgeProfile, effectiveProfile } from "../knowledge-profile.js";
import { memoryRefClientFor, memoryRefSlug } from "../memory-refs.js";
import * as engine from "../../task-engine.js";
import { exportFleetToTemplate } from "../fleet-template.js";
import { createConfigChangeProposal, runIterationCast, retryIterationCast } from "../fleet-iteration.js";
import { provisionFleetFromTemplate } from "../fleet-provisioner.js";
import { fleetBindingHealth } from "../../lib/fleet-binding-health.js";
import * as dbModule from "../../db.js";
import { facetRequest } from "../../gateway/facet-proxy.js";

const DENSE_CADENCE_MS = 10 * 60 * 1000; // design D7: <10min cadence needs confirmation
const KPI_SLOT_LIMIT = 8;
function resolveUserFactory(ctx) {
  return (req) =>
    req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });
}

function fleetId(_id) {
  return `fleet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// 常务岗职责（DEPUTY_PROMPT）：加岗时就写进 cadence.promptTemplate——职责是
// 岗位声明的一部分，不是一个隐藏开关。措辞点明「越权会被服务端拒绝，然后
// 转主人」，因为闸在服务端，这段只影响模型行为、不构成授权。
//
// 2026-10-29 真机实证后的两处收紧：
//   ① 队列每项**已经带着**主人的同类判例（`precedents` 字段，服务端连人带
//      理由一起给）——旧措辞「按主人过往判例裁决」让一个岗把整轮时间花在
//      工作区和记忆里翻判例，8 分钟跑完一条都没裁。现在明写「就地用，
//      不要为此另做检索」。
//   ② 「找不到判例」不是不裁的理由。凭空要求判例会让代理把「无先例」当成
//      阻塞项而停摆；正确行为是照事实与策略自己裁，并在 evidence 里**如实
//      说明没有同类判例、理由是什么**（这一点真机里它其实做到了，值得固化）。
const DEPUTY_PROMPT =
  "你是本舰队的常务岗（决策代理）。每一轮：1) 用 decision_queue 读取待裁项——" +
  "每项已附来源岗位近期报数与主人同类判例（precedents），**就地使用，不要为此另做检索**；" +
  "2) 逐项裁决（decision_resolve，必须附 evidence；approve 必须选一个选项 value）：" +
  "有判例就引用它，没有就按事实与策略自己裁并在 evidence 里写明「无同类判例，理由如下」——" +
  "缺判例不是不裁的理由；3) 真正判不了的（超出授权、事实不足、需主人偏好）用 " +
  "decision_escalate_to_owner 附分析上报，不要硬裁；4) 问题单做归并与跟踪，不重复上报；" +
  "5) 裁决与进度写记忆，让主人可查证。一轮之内把队列处理完（每条要么裁、要么上报），" +
  "不要留到最后不了了之。绝不越出策略授权——被服务端拒绝就转主人，不要重试。";

function memberId(_id) {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Target resolution ────────────────────────────────────────────────────────
//
// The single authority for "does this targetRef point at a live object".
// Creation-time validation and read-time vacancy derivation share it, so a
// post can never be BUILT dangling — 待补岗 only ever comes from the target
// being deleted afterwards (design: 对象模型).

// `view` is a request-scoped catalog snapshot (catalog.mergedView): a roster
// read resolves one target per member, and resolving against the LIVE catalog
// re-merges it per member — 60 merges × ~30ms of blocked event loop on one
// request, which delayed every other request in the cell including the chat
// WebSocket handshake. One view per request keeps every member of that
// request on the same snapshot AND costs one merge.
function resolveTarget(member, view = null) {
  // 审计官是受约束的 persona：解析链与 persona 相同。少了这一支，它会落到下面的
  // a2a 兜底并要求 entry.mode==="a2a"——一个健康的审计官（目标是一个对话 preset）
  // 会被判 alive=false，在坞面上永远显示「待补岗」。
  if (isPersonaBackedTargetKind(member.targetKind)) {
    const entries = view ? view.chatAgentEntries : catalog.getChatAgentEntries();
    const entry = entries.find((e) => e.id === member.targetId) || null;
    // Empty targetId = provisioner conflict sentinel — no label, the vacant
    // badge and its reason carry the story.
    return { alive: !!entry, label: entry?.name ?? (member.targetId || null), clusterName: null };
  }
  if (member.targetKind === "cluster") {
    const cluster = getClusterDatabase().get(member.targetId);
    const alive = !!cluster && cluster.status !== "terminated";
    return { alive, label: cluster?.name ?? (member.targetId || null), clusterName: cluster?.name ?? null };
  }
  if (member.targetKind === "tool") {
    // Tool posts (add-tool-posts): alive = the server is routable at all
    // (operator stdio config or a registry entry); the tool name itself is
    // judged at run time, honestly, because MCP tool surfaces drift.
    const split = splitToolTarget(member.targetId);
    const alive = !!split && (resolveStdioServerConfig(split.server) != null || resolveServerEndpoint(split.server) != null);
    return { alive, label: member.targetId, clusterName: null };
  }
  if (member.targetKind === "bot") {
    // Bot posts (add-mixed-fleet-packs D4): the target is a bot id in the
    // bots store — pack bots and incumbent bots are indistinguishable here.
    // Existence is the only gate; enabled/connection state is the operator's
    // runtime story, read honestly like every other target.
    const bot = dbModule.getBot(member.targetId);
    return { alive: !!bot, label: bot?.name ?? (member.targetId || null), clusterName: null };
  }
  // 兜底分支只归 a2a（2026-11-10）。此前任何**未知**类型都会掉进这里当 a2a 解析，
  // 于是「加第六种类型」会重演审计官那串静默降级：岗位看着在、判活却按错的路走。
  // 现在未知类型直接判 dead——坏得很响，而不是悄悄按 a2a 处理。
  if (member.targetKind !== "a2a") {
    return { alive: false, label: member.targetId || null, clusterName: null, servingPath: null };
  }
  const entry = view ? view.agentEntry(member.targetId) : catalog.getAgentEntry(member.targetId);
  const alive = !!entry && entry.mode === "a2a";
  return {
    alive,
    label: entry?.name ?? (member.targetId || null),
    clusterName: null,
    // Serving face (fix-zhiyu-summon-serving-face 1.1): the registry agent
    // path a pack deployment joins on, parsed from the a2a entry's url. Only
    // pack deployments are room-summonable; an agents.json external a2a url
    // (or a malformed one) yields null — honestly excluded from summon plans.
    servingPath: alive ? servingPathFromEntryUrl(entry.url) : null,
  };
}

// Serving-path extraction (fix-zhiyu-summon-serving-face 1.1): catalog a2a
// entries carry the deployment join key inside their url
// (`${REGISTRY_URL}/agent<path>/`, registry-bridge mapAgent) — the same path a
// deployment minted at `/packs/<packId>/<agentId><suffix>` (lib/agent-serving).
// Anything not of that shape yields null, never a guess.
function servingPathFromEntryUrl(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/agent/")) return null;
    return parsed.pathname.slice("/agent".length).replace(/\/+$/, "") || null;
  } catch {
    return null;
  }
}
// Shared for tests (same pattern as resolveFleetTarget).
export { servingPathFromEntryUrl };

// Shared with the server.js catalog-change hook (reconcileAllFleets) so the
// "vacant post stops firing" pass resolves targets exactly like the routes.
export const resolveFleetTarget = resolveTarget;

function invalidTargetMessage(kind, id) {
  if (!MEMBER_TARGET_KINDS.includes(kind)) {
    return `targetKind must be one of ${MEMBER_TARGET_KINDS.join(", ")}`;
  }
  if (kind === "persona") return `persona '${id}' is not in the catalog chat roster`; // persona-only: 专用文案，auditor 有自己的
  if (kind === "cluster") return `cluster '${id}' does not exist`;
  if (kind === "tool") {
    return splitToolTarget(id)
      ? `tool server '${splitToolTarget(id).server}' is not routable (no registry entry, no stdio config)`
      : `tool target '${id}' must be 'server::tool'`;
  }
  // 审计官是受约束的 persona：解析链与 persona 相同，差别在工具面。
  if (kind === "auditor") return `auditor persona '${id}' is not in the catalog chat roster`;
  if (kind === "bot") return `bot '${id}' has no instance in this cell's bots store`;
  return `market agent '${id}' is not an online a2a entry`;
}

// ── Cadence & KPI validation ────────────────────────────────────────────────

function normalizeCadence(cadence, { confirmed } = {}) {
  if (cadence === undefined || cadence === null) return { ok: true, cadence: null };
  if (typeof cadence !== "object" || Array.isArray(cadence)) {
    return { ok: false, error: "cadence must be an object or null" };
  }
  const { cron: expr, tz, promptTemplate, enabled, turnTimeoutMs } = cadence;
  if (!expr || typeof expr !== "string") {
    return { ok: false, error: "cadence.cron is required" };
  }
  const invalid = cron.validateCron(expr, tz || null);
  if (invalid) return { ok: false, error: invalid };
  if (!promptTemplate || typeof promptTemplate !== "string") {
    return { ok: false, error: "cadence.promptTemplate is required when a cadence is set" };
  }
  if (tz !== undefined && tz !== null && typeof tz !== "string") {
    return { ok: false, error: "cadence.tz must be an IANA timezone string or null" };
  }
  // Per-post turn budget (fix-fleet-chain-operability D3): type-checked here,
  // clamped at read time (cron-runner resolveTurnBudgetMs) — the write face
  // must not silently drop the field (normalizeCadence used to rebuild the
  // object with only the known keys) nor judge the range twice.
  let outTurnTimeoutMs;
  if (turnTimeoutMs !== undefined) {
    if (turnTimeoutMs === null) {
      outTurnTimeoutMs = null;
    } else {
      const n = Number(turnTimeoutMs);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, error: "cadence.turnTimeoutMs must be a positive number of milliseconds or null" };
      }
      outTurnTimeoutMs = Math.round(n);
    }
  }
  // Dense-cadence guard (design D7): interval under 10 minutes requires an
  // explicit confirmation flag — the UI shows the cost warning first.
  const period = cronPeriodMs(expr, tz || null);
  if (period != null && period < DENSE_CADENCE_MS && confirmed !== true) {
    return { ok: false, error: "cadence fires more often than every 10 minutes — confirm the cost to proceed", code: "cadence_confirmation_required", periodMs: period };
  }
  const out = { cron: expr, tz: tz || null, promptTemplate, enabled: enabled !== false };
  if (outTurnTimeoutMs !== undefined) out.turnTimeoutMs = outTurnTimeoutMs;
  return { ok: true, cadence: out };
}

// Tool posts (add-tool-posts): the cadence prompt IS the tool's arguments —
// a JSON object, deterministically. Checked wherever a tool post's cadence is
// written (create/update/swap), after normalizeCadence's shape checks.
function toolCadenceError(targetKind, cadence) {
  if (targetKind !== "tool" || !cadence) return null;
  try {
    const parsed = JSON.parse(cadence.promptTemplate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  } catch {
    return "a tool post's cadence.promptTemplate must be a JSON object — it is the tool's arguments";
  }
  return null;
}

function normalizeKpiSlots(slots) {
  if (slots === undefined || slots === null) return { ok: true, kpiSlots: [] };
  if (!Array.isArray(slots)) return { ok: false, error: "kpiSlots must be an array" };
  if (slots.length > KPI_SLOT_LIMIT) {
    return { ok: false, error: `kpiSlots is capped at ${KPI_SLOT_LIMIT}` };
  }
  for (const s of slots) {
    if (!s || typeof s !== "object" || typeof s.key !== "string" || !s.key.trim() || typeof s.label !== "string" || !s.label.trim()) {
      return { ok: false, error: "each kpiSlot needs a key and a label" };
    }
  }
  return { ok: true, kpiSlots: slots };
}

// Cycle guard: reject a parent edge that would loop (A under its descendant).
function wouldCycle(db, member, newParentId) {
  if (!newParentId) return false;
  let cursor = newParentId;
  const seen = new Set();
  while (cursor) {
    if (cursor === member.id) return true;
    if (seen.has(cursor)) return true; // defensive: existing corruption must not spin
    seen.add(cursor);
    const node = db.getMember(cursor);
    cursor = node?.parentId ?? null;
  }
  return false;
}

// ── Derived read faces ───────────────────────────────────────────────────────

// `jobs` is the already-listed cron job set: a roster read lists the jobs
// once and indexes them per fleet, instead of re-listing every job for every
// fleet (21 fleets × the whole job table).
function taskIndexFor(fleetId, jobs = cron.listJobs()) {
  const map = new Map();
  for (const job of jobs) {
    if (job?.sourceTag?.fleetId === fleetId) map.set(job.sourceTag.memberId, job);
  }
  return map;
}

function memberView(db, fleet, member, tasks, { now = Date.now(), resolver = resolveTarget, model = null } = {}) {
  const target = resolver(member);
  const task = tasks.get(member.id) ?? null;
  // Report lane: latest with system trends (dual-window missing reads its
  // timestamp too); timeline preview is the first page — the drawer pages.
  const latest = db.latestReportFor(member.id);
  const previous = latest ? db.previousReport(member.id, latest.createdAt) : null;
  // Failure streak feeds the status derivation (fix-fleet-failure-visibility
  // D3): one pass gives the count, when it started and what the newest
  // failure was. Read BEFORE the derivation because it is an input to it.
  const streak = db.failureStreak(member.id);
  // Presence reads REAL rounds only (fix-fleet-turn-veracity D3): once the
  // turn stream holds any events, the plain latest row settles whether the
  // stream exists, and the newest REAL turn (skips excluded) is what may
  // advance presence — a skip-only history reads as never ran. The in-window
  // skip count doubles as the card badge's "第 k 次" below.
  const lastTurn = db.latestTurnFor(member.id);
  const skipWindowMs = member.cadence ? staleWindowMs(member.cadence.cron, member.cadence.tz) : null;
  const skippedRounds = db.skippedCount(member.id, skipWindowMs ? { sinceMs: now - skipWindowMs } : {});
  // Newest REAL turn (fleet-ops-canvas): skips never carry usage, so the
  // context-budget histogram reads this row, not the plain latest.
  const latestRealTurn = lastTurn ? db.latestRealTurnFor(member.id) : null;
  const derived = deriveMemberStatus({
    member,
    fleet,
    task,
    targetAlive: target.alive,
    latestReport: latest,
    now,
    failureStreak: streak.streak,
    failureSince: streak.since,
    lastFailureKind: streak.lastErrorKind,
    effectiveLastRunAt: lastTurn ? (latestRealTurn?.endedAt ?? null) : undefined,
    skippedRounds,
  });
  // Post model (add-fleet-post-model F1/F3): declared values verbatim plus the
  // advisory effective model — what this post's NEXT turn would run on, given
  // the chain and the roster as of this read. Advisory because the roster at
  // turn time may have drifted again.
  const resolution = resolveModelChain({
    model: member.model ?? null,
    fallbackModel: member.fallbackModel ?? null,
    fleetDefault: fleet?.defaultModel ?? null,
    cellDefault: model?.cellDefault ?? null,
    roster: model?.roster ?? null,
  });
  return {
    id: member.id,
    fleetId: member.fleetId,
    title: member.title,
    parentId: member.parentId,
    target: { kind: member.targetKind, id: member.targetId, label: target.label, servingPath: target.servingPath ?? null },
    kpiSlots: member.kpiSlots,
    cadence: member.cadence,
    model: member.model ?? null,
    fallbackModel: member.fallbackModel ?? null,
    // Config dimensions (add-agent-config-dims): declared values verbatim.
    // `effort` here is the DECLARED level; the effective level is resolved at
    // turn time (against the landed model) and recorded on the turn event.
    effort: member.effort ?? null,
    contextBudget: member.contextBudget ?? null,
    // Turn carrier (add-fleet-carrier): the CONFIGURED placement (null = auto)
    // — the actual body lands on the turn events' carrier column.
    carrier: member.carrier ?? null,
      packId: member.packId ?? null,
    // Latest real turn's usage (fleet-ops-canvas): the config bar's context
    // budget histogram buckets by this over the declared budget. null = the
    // newest real round reported none (用量字段缺失 ≠ 未超预算).
    latestTurnUsage: latestRealTurn?.usage ?? null,
    effectiveModel: resolution.effective,
    modelNotice: resolution.notices.length ? resolution.notices.join("; ") : null,
    sortKey: member.sortKey,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
    taskId: task?.id ?? null,
    status: derived.status,
    statusReason: derived.reason,
    evidence: derived.evidence,
    // Downtime loss, top-level for the post card (P2, 2026-10-26): `missed -->
    // 0` means a platform restart covered one or more of this post's triggers.
    // `catchUpPending` says a make-up round is in flight right now, so a
    // returning owner reads "already being made up", not "still broken".
    missedRounds: derived.evidence.missedRounds ?? 0,
    lastMissedAt: derived.evidence.lastMissedAt ?? null,
    catchUpPending: derived.evidence.catchUpPending === true,
    // Failure attribution, top-level for the card (fix-fleet-failure-visibility):
    // the streak is what downgraded the status — the card says so in the same
    // breath as the colour, never a bare red dot.
    failureStreak: derived.evidence.failureStreak ?? 0,
    failingSince: derived.evidence.failingSince ?? null,
    lastErrorKind: derived.evidence.lastErrorKind ?? null,
    // In-window skip count (fix-fleet-turn-veracity): the post card's
    // 「本轮未执行（第 k 次）」 badge reads this; sustained skips show up in
    // `status` (missing with the count named), not here.
    skippedRounds: derived.evidence.skippedRounds ?? 0,
    // Bot sidecar (fleet-ops-canvas, agent-fleet-core): target kind `bot`
    // posts carry the channel's runtime story as a read-only object —
    // enabled from the bot row, inbound/outbound/error as best-effort
    // timestamps (columns absent → null, never fabricated).
    ...(member.targetKind === "bot"
      ? {
          bot: (() => {
            const bot = dbModule.getBot(member.targetId);
            const activity = dbModule.botActivitySummary(member.targetId) ?? {};
            return {
              type: bot?.type ?? member.targetId,
              enabled: bot ? !!bot.enabled : false,
              lastInboundAt: activity?.lastInboundAt ?? null,
              lastOutboundAt: activity?.lastOutboundAt ?? null,
              lastError: activity?.lastError ?? null,
            };
          })(),
        }
      : {}),
    latestReport: buildLatestView({ report: latest, previous, kpiSlots: member.kpiSlots }),
    reportTimeline: db.listReports(member.id, { limit: 5 }).map(reportTimelineEntry),
    lastTurn: lastTurn
      ? {
          status: lastTurn.status,
          errorKind: lastTurn.errorKind,
          error: lastTurn.error,
          endedAt: lastTurn.endedAt,
          sessionId: lastTurn.sessionId,
          // Timeout/degrade attribution (fix-fleet-turn-attribution): the
          // card renders stalled-vs-budget and the degraded hop verbatim.
          detail: lastTurn.detail ?? null,
        }
      : null,
    consecutiveFailures: lastTurn ? db.consecutiveFailures(member.id) : 0,
  };
}

// The template-newer notice (D7): notice only — never a migration, never a
// mutation of the live fleet.
function templateNotice(fleet) {
  if (!fleet.sourceTemplate?.packId) return null;
  const installed = dbModule.getInstalledPack(fleet.sourceTemplate.packId);
  if (!installed?.version) return null;
  const newer = installed.version !== fleet.sourceTemplate.version;
  return {
    packId: fleet.sourceTemplate.packId,
    instantiatedVersion: fleet.sourceTemplate.version ?? null,
    latestVersion: installed.version,
    updateAvailable: newer,
  };
}

// add-agent-builder-workspace 7.2 (D7 回链): the source blueprint id, read from
// the casting provenance of the pack the fleet was instantiated from. Read-only
// projection — absent (null) when the fleet has no template origin or the pack
// carries no _casting. Both the cockpit read face (what the page fetches) and
// the bare detail route expose it; keeping ONE helper means neither can drift.
function sourceBlueprintId(fleet) {
  const packId = fleet?.sourceTemplate?.packId;
  if (!packId) return null;
  try {
    const installed = dbModule.getInstalledPack(packId);
    const cast = installed?.manifest?._casting;
    return typeof cast?.blueprintId === "string" ? cast.blueprintId : null;
  } catch {
    return null;
  }
}

// One timeline row (drawer): value snapshot, blockers, the source-session
// jump link, and the self/derived provenance badge.
// ── Console publication (add-pack-console D5) ───────────────────────────────
// A share link has to be a readable address, and it must never be a name the
// owner chose: user-chosen slugs invite squatting and impersonation of another
// team. So the server derives one from the team name and disambiguates against
// the unique index; the owner can publish or unpublish, not pick.
const CONSOLE_SLUG_MAX = 40;

function consoleSlugBase(name) {
  // Unicode letters/digits stay: this is a Chinese-first product and 电商团队
  // must be able to read its own link. NFKD folds Latin accents, the URL layer
  // percent-encodes the rest, and the unique index handles collisions.
  return Array.from(
    String(name ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
  )
    .slice(0, CONSOLE_SLUG_MAX)
    .join("");
}

// Deterministic candidate ladder: "<base>", "<base>-<id tail>", ... — the tail
// comes from the fleet id, so two teams with the same name never fight over one
// address and the result is stable across retries.
function deriveConsoleSlug(db, fleet) {
  const base = consoleSlugBase(fleet.name) || "team";
  const tail = String(fleet.id).replace(/[^a-z0-9]/gi, "").slice(-4).toLowerCase() || "team";
  const candidates = [base, `${base}-${tail}`];
  for (let i = 2; i <= 5; i++) candidates.push(`${base}-${tail}-${i}`);
  for (const candidate of candidates) {
    const owner = typeof db.getFleetByConsoleSlug === "function" ? db.getFleetByConsoleSlug(candidate) : null;
    if (!owner || owner.id === fleet.id) return candidate;
  }
  return `${base}-${tail}-${Date.now().toString(36)}`;
}

// ── Route registration ───────────────────────────────────────────────────────

export function createFleetRoutes(app, ctx = null) {
  const resolveUser = resolveUserFactory(ctx);
  // Tests inject a fake universe through ctx; production always resolves
  // against the live catalog/clusters store.
  const targetResolver = ctx?.fleetTargetResolver ?? resolveTarget;
  const router = Router();

  // Fleet access log (add-fleet-row-update-audit): one line for every
  // non-read /api/fleets request — during the 2026-10-24 reset window the
  // verdict "zero PATCHes" rested on inference precisely because nothing
  // recorded method lines. Read methods stay silent (log volume).
  router.use((req, _res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      console.log(`[fleet-access] ${req.method} ${req.baseUrl}${req.path} ${resolveUser(req)?.email ?? "anon"}`);
    }
    next();
  });

  // Audit attribution (add-fleet-row-update-audit): every fleet-row write
  // from this router stamps who and through which route.
  const auditMeta = (req, via) => ({ actor: resolveUser(req)?.email ?? null, via });

  // ── Post-model helpers (add-fleet-post-model) ─────────────────────────────
  //
  // Roster source for both faces is ctx.dshModels — the same in-memory list
  // getAvailableModels() serves (deduped for display; membership tests don't
  // care). Null (tests without a runtime) degrades every roster gate open.
  const modelRoster = () => (Array.isArray(ctx?.dshModels) ? ctx.dshModels.map((m) => m.id) : null);
  const modelCtx = () => ({ roster: modelRoster(), cellDefault: ctx?.bootModel?.id ?? null });

  // In-flight fleet turns (fix-parked-preset-attribution D1): the run ledger's
  // open turns name the post each turn executes, whatever its target kind. This
  // is the signal that survives persona parking — a parked round mounts its
  // persona on the SESSION and deliberately leaves the runtime's deployment
  // default alone, so attribution MUST NOT read `ctx.currentPreset` for it.
  // Absent ledger (tests, desktop without fleet runs) → empty, and attribution
  // falls back to the running-task scan exactly as before.
  const openTurns = () => {
    try {
      return ctx?.fleetTurnLedger?.openTurns?.() ?? [];
    } catch {
      return []; // degrade open: attribution must never fail on a ledger hiccup
    }
  };

  // A per-request target resolver: a roster read resolves one target per
  // member across every fleet, and the default resolver re-merges the catalog
  // each time (~30ms × 60 members ≈ 1.8s of blocked event loop — long enough
  // to delay the chat WebSocket handshake in the same cell, measured at
  // 1.2s→3.9s). One view per request means one merge. A test-injected
  // resolver ignores the second argument, so it passes straight through.
  const rosterResolver = () => {
    const view = targetResolver === resolveTarget ? catalog.mergedView() : null;
    return (m) => targetResolver(m, view);
  };

  // Write gate, evaluated against the RESULTING row (not the patch alone):
  // the fallback⇒primary constraint and the persona-only rule must hold after
  // the write, so a patch that only clears `model` while a fallback hangs on
  // is caught here, not by a later turn.
  const memberModelWriteError = ({ existing = null, targetKind, body }) => {
    const model = body?.model !== undefined ? body.model : (existing?.model ?? null);
    const fallbackModel = body?.fallbackModel !== undefined ? body.fallbackModel : (existing?.fallbackModel ?? null);
    for (const v of [model, fallbackModel]) {
      if (v != null && typeof v !== "string") return "model fields must be a model id string or null";
    }
    // 审计官能声明自己的模型：设计上它必须可与专家用不同模型，否则两者同向走偏，
    // 复核退化成复述（反例注入只解决「看什么」，解决不了「同一个脑子」）。
    if (!isPersonaBackedTargetKind(targetKind) && (model != null || fallbackModel != null)) {
      return "only persona posts declare a model — a2a posts take theirs from the service deployment config, cluster posts from their member posts, tool posts run no LLM at all";
    }
    if (fallbackModel != null && model == null) {
      return "fallbackModel requires model — clear the fallback before clearing (or omitting) the primary";
    }
    const roster = modelRoster();
    for (const [label, value] of [["model", model], ["fallbackModel", fallbackModel]]) {
      if (value == null) continue;
      const err = fleetModelChoiceError({ model: value, roster });
      if (err) return `${label}: ${err}`;
    }
    return null;
  };

  const requireOwnedFleet = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    const fleet = getFleetDatabase().getFleet(req.params.id);
    if (!fleet) {
      res.status(404).json({ error: "Fleet not found" });
      return null;
    }
    if (fleet.ownerEmail !== user.email) {
      res.status(403).json({ error: "Not your fleet" });
      return null;
    }
    return { user, fleet };
  };

  const runReconcile = async (fleetId) => {
    try {
      return await reconcileFleet({
        fleetId,
        db: getFleetDatabase(),
        cronApi: cron,
        resolveTarget: targetResolver,
        rosterPresetId,
      });
    } catch (err) {
      console.error(`[fleets] reconcile failed for ${fleetId}:`, err.message);
      return { error: err.message };
    }
  };

  // 迭代回调的默认运输（fleet-owner-iteration）：附体身份=当下决策 req 的
  // cookie 转交。安装/预检 = 同源 /api/packs*/validate；发布 = /api/packs 以
  // 操作者凭据上场 — 两门与人工 UI 上提交逐字节同缝；测试经 ctx 注入替身。
  const defaultInstallFn = () => ctx?.iterationsInstallFn ?? ((packId) => dbModule.getInstalledPack(packId));
  const defaultPublishFn = (req) =>
    ctx?.iterationsPublisher ??
    (async ({ packId, manifest }) => {
      const base = `${req.protocol || "http"}://${req.get("host") ?? "127.0.0.1"}`;
      // Outbound call discipline: loopback self-call rides the shared deadline
      // wrapper (default env bound) — a wedged packs route fails the
      // fire-and-forget publish instead of hanging the reconcile lane.
      const r = await fetchWithTimeout(`${base}/api/packs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        },
        body: JSON.stringify({ packId, manifest }),
      });
      const body = await r.json().catch(() => ({}));
      return r.ok ? body : { error: body?.error ?? `HTTP ${r.status}` };
    });
  const defaultValidateFn = (req) =>
    ctx?.iterationsValidator ??
    (async ({ packId, manifest }) => {
      const base = `${req.protocol || "http"}://${req.get("host") ?? "127.0.0.1"}`;
      // Outbound call discipline: shared deadline wrapper (default env bound).
      const r = await fetchWithTimeout(`${base}/api/packs/validate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        },
        body: JSON.stringify({ packId, manifest }),
      });
      const body = await r.json().catch(() => ({}));
      return r.ok ? body : { valid: false, errors: [body?.error ?? `HTTP ${r.status}`] };
    });

  // ── Report lane (agent-fleet-report-lane) ─────────────────────────────────
  //
  // The report_status bridge. Attribution is SERVER-side (D3): the caller
  // never names a post — a running fleet cluster task attributes to its own
  // post (the fan-out rotates presets, which would otherwise misattribute),
  // else the live preset resolves the unique persona post holding it. The
  // in-cell fleet MCP child reaches this over loopback; a non-loopback caller
  // still passes the full auth gate and gets the same server-side attribution.
  router.post("/report", async (req, res) => {
    try {
      const db = getFleetDatabase();
      const payload = validateReportPayload(req.body);
      if (!payload.ok) return res.status(400).json({ error: payload.error });

      const personaMembers = [];
      for (const f of db.listFleets()) {
        // Ghost-post guard (0030e1e8 family): a dissolved fleet's posts exit
        // attribution — a persona swapped into a walkthrough fleet's post must
        // not collide with its live post and wedge report/escalate with 409s.
        if (f.state === "archived") continue;
        for (const m of db.listMembers(f.id)) {
          if (isPersonaBackedTargetKind(m.targetKind)) personaMembers.push(m);
        }
      }
      const attribution = resolveAttribution({
        currentPreset: ctx?.currentPreset ?? null,
        runningTasks: cron.listJobs(),
        openTurns: openTurns(),
        personaMembers,
        rosterPresetId,
      });
      if (attribution.kind === "none" || attribution.kind === "ambiguous") {
      // A refused report is a fact about this turn, exactly like a flood-gate
      // refusal (fix-fleet-report-delivery 1.1/1.2). Without this the round
      // reads as "the post never reported" while the truth is "the server
      // refused to attribute it". Live 2026-11-10: the bet post called
      // report_status three times and got `this agent is not a member of any
      // fleet` every time; its turn detail came out null, so the ledger showed
      // nothing and the bet-line work only existed in a workspace file.
      // No memberId exists at this point, so key the stash by the live preset.
      try {
        ctx?.recordReportRejection?.(ctx?.currentPreset ?? null, {
          reason: attribution.kind === "ambiguous" ? "attribution_ambiguous" : "attribution_none",
          message: attribution.error,
          slots: Object.keys(payload.report.metrics ?? {}),
        });
      } catch { /* observation never fails the response */ }
        return res.status(409).json({ error: attribution.error });
      }
      const member = db.getMember(attribution.memberId);
      if (!member) return res.status(409).json({ error: "the attributed post no longer exists" });
      // Attribution fact (fix-parked-preset-attribution D3): the turn's event
      // row lands at the turn's END, so stash HOW this call was attributed and
      // let the recorder write it as detail.attribution. Observability only —
      // a stash failure never affects the report.
      try {
        ctx?.recordFleetAttribution?.(member.id, { source: attribution.kind, fleetId: member.fleetId, memberId: member.id });
      } catch { /* observation never fails the report */ }

      // Flood control (design D7): window = half the cadence period with a
      // 10-minute floor; at most 3 self reports per window. Derived (a2a)
      // rows never pass through this door, so they never count.
      //
      // The source session is resolved BEFORE the check because a round's FIRST
      // report is exempt (checkFlood's `roundReports === 0`). Without that, a
      // report filed from some other session (a stray probe, a platform chat)
      // can fill the window and reject this round's only honest report
      // wholesale — live 2026-11-09 the proposal post lost its three-slot
      // disclosure that way, and the ledger kept an empty `metrics:{}` row.
      const sessionId =
        attribution.task?.sessionId ?? chatHistory.currentSessionId?.() ?? null;
      const windowMs = floodWindowMs(member.cadence, cronPeriodMs);
      const now = Date.now();
      const since = now - windowMs;
      const recent = db.listReports(member.id, { limit: 3 });
      const inWindow = recent.filter((r) => r.createdAt > since && r.source === "self");
      const roundReports = sessionId
        ? inWindow.filter((r) => r.sessionId === sessionId).length
        : 0;
      const flood = checkFlood({
        countSince: inWindow.length,
        roundReports,
        windowMs,
        now,
        oldestInWindowAt: inWindow.length ? inWindow[inWindow.length - 1].createdAt : null,
      });
      if (!flood.ok) {
        // The refusal is a fact about this turn (fix-fleet-report-delivery 1.1):
        // stash it so the turn row can say "the server refused the report"
        // instead of leaving an unexplained empty round.
        try {
          ctx?.recordReportRejection?.(member.id, {
            reason: "flood",
            windowResetsAt: flood.windowResetsAt,
            slots: Object.keys(payload.report.metrics ?? {}),
          });
        } catch { /* observation never fails the response */ }
        return res.status(429).json({ error: flood.error, windowResetsAt: flood.windowResetsAt });
      }

      const declared = new Set(member.kpiSlots.map((s) => s.key));
      const submitted = Object.keys(payload.report.metrics);
      // Selection-time model fallbacks (add-fleet-post-model D7): the turn
      // recorded them under this member; a report filed in that same turn
      // carries them as blockers so the owner sees WHY the post ran degraded.
      // One-shot — a report is the only consumer; no report leaves them in the
      // log only.
      const modelNotices =
        typeof ctx?.takeFleetModelNotices === "function" ? ctx.takeFleetModelNotices(member.id) : [];
      const report = db.appendReport({
        id: `r_${now}_${Math.random().toString(36).slice(2, 8)}`,
        fleetId: member.fleetId,
        memberId: member.id,
        sessionId,
        metrics: payload.report.metrics,
        resources: payload.report.resources,
        blockers: [...modelNotices.map(String), ...payload.report.blockers].slice(0, 20),
        summary: payload.report.summary,
        source: "self",
        createdAt: now,
      });
      res.status(201).json({
        ok: true,
        memberTitle: member.title,
        fleetName: db.getFleet(member.fleetId)?.name ?? member.fleetId,
        reportId: report.id,
        // fix-fleet-chain-operability D2: the declared keys, echoed so the
        // UNRECOGNIZED hint can point at the actual key face instead of
        // telling the post to "re-check" a declaration nothing exposes.
        declaredSlots: [...declared],
        slotsAccepted: submitted.filter((k) => declared.has(k)),
        slotsUnrecognized: submitted.filter((k) => !declared.has(k)),
        windowResetsAt: now + windowMs,
      });
    } catch (err) {
      console.error("[fleets] report error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Report timeline page for the detail drawer (owner-gated like the fleet).
  router.get("/:id/members/:mid/reports", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== owned.fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      const beforeMs = req.query.before ? Number(req.query.before) : null;
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const rows = db.listReports(member.id, {
        ...(Number.isFinite(beforeMs) ? { beforeMs } : {}),
        limit: limit + 1,
      });
      const page = rows.slice(0, limit).map(reportTimelineEntry);
      res.json({
        reports: page,
        nextBefore: rows.length > limit ? page[page.length - 1].at : null,
      });
    } catch (err) {
      console.error("[fleets] reports timeline error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Turn result events (add-fleet-turn-events D6) ─────────────────────────

  // One timeline row: system facts only — no credentials, no session bodies.
  function turnTimelineEntry(event) {
    return {
      id: event.id,
      memberId: event.memberId,
      source: event.source,
      status: event.status,
      errorKind: event.errorKind,
      error: event.error,
      model: event.model,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      sessionId: event.sessionId,
      // Timeout/degrade/lane attribution (fix-fleet-turn-attribution): the
      // timeline carries the summary verbatim; legacy rows read null.
      detail: event.detail ?? null,
      // fleet-ops-canvas mini span: the client joins this to the trace store
      // for the tool waterfall — without it every non-live span lookup fell
      // through (live-found in production walkthrough 2026-10-27).
      traceTurnId: event.traceTurnId ?? null,
      // Estimated USD for this turn (add-fleet-cost-read-face): null when the
      // turn was never priced — the timeline must not draw a $0 it cannot prove.
      cost: event.cost ?? null,
    };
  }

  // Member turn timeline for the detail drawer — same cursor shape as the
  // report timeline (nextBefore = last row's id).
  router.get("/:id/members/:mid/turns", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== owned.fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      const beforeId = req.query.before ? Number(req.query.before) : null;
      const limit = Math.min(Number(req.query.limit) || 20, 50);
      const rows = db.listTurnEvents(member.id, {
        ...(Number.isFinite(beforeId) ? { beforeId } : {}),
        limit: limit + 1,
      });
      const page = rows.slice(0, limit);
      res.json({
        turns: page.map(turnTimelineEntry),
        nextBefore: rows.length > limit ? page[page.length - 1].id : null,
      });
    } catch (err) {
      console.error("[fleets] turn timeline error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Fleet-wide filter (status/source) — the data source the architect pack's
  // read verbs and O3's both-sides dispatch events will consume.
  router.get("/:id/turns", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const status = req.query.status ?? null;
      const source = req.query.source ?? null;
      if (status && !["ok", "failed", "interrupted", "skipped"].includes(status)) {
        return res.status(400).json({ error: "status must be one of ok|failed|interrupted|skipped" });
      }
      if (source && !["cron", "manual", "delegation", "event"].includes(source)) {
        return res.status(400).json({ error: "source must be one of cron|manual|delegation" });
      }
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const db = getFleetDatabase();
      res.json({ turns: db.listFleetTurnEvents(owned.fleet.id, { status, source, limit }).map(turnTimelineEntry) });
    } catch (err) {
      console.error("[fleets] fleet turns error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Run read face (agent-fleet-runs, add-fleet-cockpit-v2) ─────────────────
  //
  // The execution instance behind the timeline: paged run list (filters:
  // status / root source / started-at window) and one run's ordered turn
  // detail — the chain (parentTurnId × edgeKind) reconstructs from the rows.
  // System facts only: ids, outcome, timing, usage; no credentials, no
  // session bodies. Owner scope identical to every other fleet read.

  const RUN_STATUSES = ["open", "ok", "failed", "partial"];
  const TURN_SOURCES = ["cron", "manual", "delegation", "event"];

  function runListEntry(run, memberTitles, costEntry = null) {
    return {
      runId: run.runId,
      rootSource: run.rootSource,
      rootMemberId: run.rootMemberId,
      rootMemberTitle: memberTitles.get(run.rootMemberId) ?? null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.endedAt != null ? run.endedAt - run.startedAt : null,
      status: run.status,
      turns: run.turns,
      okCount: run.okCount,
      failedCount: run.failedCount,
      usage: run.usage,
      // add-fleet-run-budget: a stopped run (owner cancel or budget ceiling)
      // says so — `status` stays the derived outcome, these two carry the WHY.
      stoppedAt: run.stoppedAt ?? null,
      stopReason: run.stopReason ?? null,
      // add-fleet-cost-read-face: estimated USD, summed from this run's own turn
      // rows at the price each turn ran under. `pricedTurns` is the sample size;
      // `usd` is null when nothing in the run was priced (never a fake 0).
      cost: costEntry,
    };
  }

  function runTurnEntry(event) {
    return {
      ...turnTimelineEntry(event),
      // Per-turn estimate as it was computed at turn time (add-fleet-cost-read-face).
      cost: event.cost ?? null,
      turnId: event.turnId,
      runId: event.runId,
      parentTurnId: event.parentTurnId,
      edgeKind: event.edgeKind,
      usage: event.usage,
      traceTurnId: event.traceTurnId,
    };
  }

  router.get("/:id/runs", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const status = req.query.status ?? null;
      const source = req.query.source ?? null;
      if (status && !RUN_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of ${RUN_STATUSES.join("|")}` });
      }
      if (source && !TURN_SOURCES.includes(source)) {
        return res.status(400).json({ error: `source must be one of ${TURN_SOURCES.join("|")}` });
      }
      const parseMs = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : null;
      };
      const since = parseMs(req.query.since);
      const until = parseMs(req.query.until);
      if ((req.query.since != null && since == null) || (req.query.until != null && until == null)) {
        return res.status(400).json({ error: "since/until must be epoch milliseconds" });
      }
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const db = getFleetDatabase();
      const { total, runs } = db.listRuns(owned.fleet.id, { status, source, since, until, limit, offset });
      const memberTitles = new Map(db.listMembers(owned.fleet.id).map((m) => [m.id, m.title]));
      // One grouped query for the whole page — never one per run.
      const costs = db.runCosts(owned.fleet.id, { sinceMs: Number.isFinite(since) ? since : 0 });
      res.json({ total, runs: runs.map((r) => runListEntry(r, memberTitles, costs.get(r.runId) ?? null)) });
    } catch (err) {
      console.error("[fleets] runs list error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.get("/:id/runs/:runId", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const run = db.getRun(req.params.runId);
      if (!run || run.fleetId !== owned.fleet.id) {
        return res.status(404).json({ error: "Run not found" });
      }
      const memberTitles = new Map(db.listMembers(owned.fleet.id).map((m) => [m.id, m.title]));
      res.json({
        run: runListEntry(run, memberTitles, db.runCost(run.runId)),
        turns: db.listRunTurns(run.runId).map(runTurnEntry),
      });
    } catch (err) {
      console.error("[fleets] run detail error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Cancel a run (add-fleet-run-budget D3): the owner's stop switch. Stamps the
  // header, refuses all further ignition for this run (the ignition gate reads
  // the same header) and aborts the run's in-flight turns through the existing
  // abort registry, so they land as `interrupted` rather than running to
  // completion on work nobody wants any more. Idempotent: a second call
  // answers with the stored reason instead of rewinding the first one.
  router.post("/:id/runs/:runId/cancel", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const run = db.getRun(req.params.runId);
      if (!run || run.fleetId !== owned.fleet.id) {
        return res.status(404).json({ error: "Run not found" });
      }
      if (run.stoppedAt != null) {
        return res.json({ cancelled: true, alreadyStopped: true, run: runListEntry(run, new Map(), db.runCost(run.runId)), abortedTurns: 0 });
      }
      const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
        ? req.body.reason.trim().slice(0, 200)
        : "cancelled by owner";
      const stopped = ctx?.fleetTurnLedger?.stopRun?.(run.runId, {
        reason,
        abortTurn: (sessionId, why) => {
          const abort = ctx?.taskTurnRegistry?.get?.(sessionId);
          if (typeof abort !== "function") return false;
          abort(why);
          return true;
        },
      }) ?? null;
      // Degrade open: without a ledger mount the header stamp still lands.
      const finalRun = stopped?.run ?? db.stopRun(run.runId, { reason });
      res.json({
        cancelled: true,
        alreadyStopped: false,
        run: runListEntry(finalRun ?? run, new Map(), db.runCost(run.runId)),
        abortedTurns: stopped?.abortedTurns ?? 0,
      });
    } catch (err) {
      console.error("[fleets] run cancel error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Design-mode draft lane (agent-fleet-architect v2, add-fleet-cockpit-v2) ─
  //
  // The cockpit's design mode rides the SAME validate/diff/estimate/apply
  // functions the architect tool bridge calls — two doors, one judgment. This
  // door is owner-gated per the fleet face (401 anonymous / 404 unknown /
  // 403 foreign, identical to every other fleet route) and scoped to the
  // design-mode subset: the orchestration section plus per-member cadence /
  // model / fallbackModel edits. Structural moves (add/remove posts, renames,
  // targets, fleet policy) stay on the architect lane — the subset guard
  // rejects them by name so the UI never offers what this door refuses.
  function cockpitDraftSubsetError(draft) {
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) return "draft must be an object";
    const allowedFleet = new Set(["orchestration"]);
    for (const k of Object.keys(draft.fleet ?? {})) {
      if (!allowedFleet.has(k)) return `fleet.${k} is outside the design-mode subset — the architect lane owns it`;
    }
    const allowedMember = new Set(["ref", "op", "cadence", "model", "fallbackModel"]);
    const members = Array.isArray(draft.members) ? draft.members : [];
    for (const [i, op] of members.entries()) {
      if (op?.op !== "update") {
        return `members[${i}].op '${op?.op ?? "?"}' is outside the design-mode subset — add/pause/resume/remove go through the architect lane`;
      }
      if (typeof op.ref !== "string" || !op.ref) return `members[${i}].ref is required`;
      for (const k of Object.keys(op)) {
        if (!allowedMember.has(k)) return `members[${i}].${k} is outside the design-mode subset`;
      }
    }
    return null;
  }

  const toCockpitDraft = (body, fleetId) => ({ ...(body ?? {}), mode: "edit", fleetId, fleet: { ...(body?.fleet ?? {}) } });

  router.post("/:id/orchestration/draft", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const subset = cockpitDraftSubsetError(req.body);
      if (subset) return res.status(400).json({ error: subset });
      res.json(validateFleetDraft(getFleetDatabase(), toCockpitDraft(req.body, owned.fleet.id), { resolver: rosterResolver() }));
    } catch (err) {
      console.error("[fleets] orchestration draft error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/:id/orchestration/apply", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const subset = cockpitDraftSubsetError(req.body);
      if (subset) return res.status(400).json({ error: subset });
      // Revalidation happens inside (drift fails honestly, same as the bridge).
      const out = await applyFleetDraft(getFleetDatabase(), toCockpitDraft(req.body, owned.fleet.id), {
        ownerEmail: owned.fleet.ownerEmail,
        resolver: rosterResolver(),
      });
      if (!out.ok) return res.status(409).json(out);
      res.json(out);
    } catch (err) {
      console.error("[fleets] orchestration apply error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Dispatch bridge (agent-fleet-orchestration O3) ────────────────────────
  //
  // A member turn's dispatch_post lands here: the running post (server-side
  // attribution, same seam as report/escalate) dispatches work to another
  // post of the SAME fleet. The task rides the existing delegation lane —
  // engine manual task with origin.fleet evidence (depth 1) and the
  // dispatcher's session as initiator, so the aggregator returns the summary
  // into the dispatcher's NEXT turn. Async by construction: never a wait.
  const dispatchBudgets = new Map(); // `${fleetId}:${memberId}` / fleetId → timestamps[]
  function dispatchCap(kind, fallback) {
    const n = Number(process.env[`FLEET_DISPATCH_${kind}_CAP`]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
  function budgetTake(key, windowMs, cap) {
    const now = Date.now();
    const stamps = (dispatchBudgets.get(key) ?? []).filter((t) => now - t < windowMs);
    if (stamps.length >= cap) {
      dispatchBudgets.set(key, stamps);
      return false;
    }
    stamps.push(now);
    dispatchBudgets.set(key, stamps);
    return true;
  }

  router.post("/dispatch", async (req, res) => {
    try {
      const db = getFleetDatabase();
      const toRef = req.body?.to;
      const brief = req.body?.brief;
      if (typeof toRef !== "string" || !toRef) {
        return res.status(400).json({ error: "to (target post ref) is required" });
      }
      if (typeof brief !== "string" || !brief.trim()) {
        return res.status(400).json({ error: "brief is required" });
      }

      const personaMembers = [];
      for (const f of db.listFleets()) {
        if (f.state === "archived") continue;
        for (const m of db.listMembers(f.id)) {
          if (isPersonaBackedTargetKind(m.targetKind)) personaMembers.push(m);
        }
      }
      const attribution = resolveAttribution({
        currentPreset: ctx?.currentPreset ?? null,
        runningTasks: cron.listJobs(),
        openTurns: openTurns(),
        personaMembers,
        rosterPresetId,
      });
      if (attribution.kind === "none" || attribution.kind === "ambiguous") {
        return res.status(409).json({ error: attribution.error });
      }
      const from = db.getMember(attribution.memberId);
      if (!from) return res.status(409).json({ error: "the attributed post no longer exists" });
      const fleet = db.getFleet(from.fleetId);
      if (!fleet) return res.status(409).json({ error: "the dispatcher's fleet no longer exists" });

      // Guard 1: same fleet. Guard 2: no self-dispatch (attribution already
      // implies it, but the ref could be the caller's own post).
      // Addressing (fix-external-team-chat-lane B1): the caller is a persona
      // that reads a ROSTER — it types a title or a member id, not a database
      // id it cannot see. A title resolves within THIS fleet only; an
      // ambiguous title refuses and lists the candidates (never a guess).
      const resolved = resolveDispatchTarget(db, fleet.id, toRef);
      if (!resolved.ok) {
        return res.status(400).json({ error: resolved.error });
      }
      const target = resolved.member;
      if (target.id === from.id) {
        return res.status(400).json({ error: "a post cannot dispatch to itself" });
      }
      // Guard 3: the edge/mode permission.
      const allowed = dispatchAllowed({ members: db.listMembers(fleet.id), orchestration: fleet.orchestration }, from.id, target.id);
      if (!allowed.ok) return res.status(403).json({ error: allowed.error });
      // Guard 4: cluster posts have no manual lane (delegation targets
      // personas, a2a agents, and tool posts). Tool posts take their args as
      // the brief — it must BE the JSON arguments, deterministically.
      if (target.targetKind === "cluster") {
        return res.status(400).json({ error: `post '${target.title}' runs a cluster — the manual dispatch lane targets persona/a2a/tool posts` });
      }
      let dispatchPrompt = null;
      if (target.targetKind === "tool") {
        try {
          const parsed = JSON.parse(brief);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          dispatchPrompt = brief.trim();
        } catch {
          return res.status(400).json({ error: `post '${target.title}' is a tool post — the brief must be its JSON arguments (e.g. {"query":"…"})` });
        }
      } else {
        dispatchPrompt =
          `【集群派发】来自同集群岗位「${from.title}」的派发(回执将自动送回其下一回合):\n${brief.trim().slice(0, 4000)}` +
          // add-fleet-edge-context D1: the fleet view rides the assignment. The
          // template lives here, its rendering at the engine's one injection
          // seam — the brief leads, the background follows.
          // persona-only: 边目标才注入舰队视图；审计官不进工作图
          (target.targetKind === "persona" ? "\n\n{{fleetEdgeContext}}" : "");
      }
      // Guard 5: rate caps — per member per turn-proxy window, per fleet per hour.
      if (!budgetTake(`m:${from.id}`, 15 * 60_000, dispatchCap("PER_TURN", 3))) {
        return res.status(429).json({ error: "dispatch cap reached for this post (3 per ~15min) — batch the work into fewer briefs" });
      }
      if (!budgetTake(`f:${fleet.id}`, 60 * 60_000, dispatchCap("HOURLY", 30))) {
        return res.status(429).json({ error: "fleet dispatch cap reached for this hour (30) — tighten the edges" });
      }

      // Dispatch rides the delegation lane: initiator = the dispatcher's
      // session (the aggregator delivers the summary back there), origin.fleet
      // carries the target post + depth 1 for the turn contract. The chain
      // position (agent-fleet-runs) comes from the dispatcher's in-flight turn
      // — looked up by POST, since attribution above is post-level; a dispatch
      // from a non-fleet conversation finds none and the target starts a root
      // run, honestly.
      const prompt = dispatchPrompt;
      const upstream = ctx?.fleetTurnLedger?.lookupByMember?.(from.id) ?? null;
      const chain = ctx?.fleetTurnLedger?.chainFor?.(upstream, "dispatch") ?? null;
      // Who owns the receipt (fix-dispatch-delivery D1). `chatHistory.currentSessionId()`
      // is the runtime's ONE global session pointer — during a scheduled post turn
      // it happens to name the bound session while that turn runs, but nothing
      // guarantees it (a web turn can be the live one), and the aggregator would
      // deliver the dispatch receipt into the wrong conversation. Attribution
      // already knows where the call came from, so read the session off it: the
      // in-flight turn's mirror session, else the running task's, else the web
      // session (that branch is unchanged — a chat-lane caller IS the pointer).
      const initiator =
        (attribution.kind === "turn" ? attribution.turn?.sessionId : null) ??
        (attribution.kind === "job-sourceTag" || attribution.kind === "cluster-task" ? attribution.task?.sessionId : null) ??
        chatHistory.currentSessionId();
      // The same discipline fix-fanout-aggregation applied to fan-out: the
      // summary must be spoken by the DISPATCHING post. A scheduled dispatcher's
      // persona is its roster preset; a chat-lane caller is the live preset.
      const initiatorPreset =
        attribution.kind === "preset" ? (ctx?.currentPreset ?? null) : rosterPresetId(from.targetId);
      const task = engine.createManualTask({
        prompt,
        ...(target.targetKind === "a2a"
          ? { agent: target.targetId }
          : target.targetKind === "tool"
            ? { tool: target.targetId }
            : { persona: rosterPresetId(target.targetId) }),
        sessionTitle: `派发 · ${target.title}`,
        initiator,
        initiatorPreset,
        // One dispatch is one aggregation group (fix-fanout-aggregation D2):
        // without a key, a scheduled post's dispatches would merge with every
        // other dispatch the same session ever fired.
        initiatorGroup: `dispatch:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
        origin: { fleet: { fleetId: fleet.id, memberId: target.id, depth: 1, ...(chain ? { chain } : {}) } },
      });
      res.status(201).json({
        dispatched: true,
        taskId: task.id,
        to: { memberId: target.id, title: target.title, kind: target.targetKind },
        note: "async — the summary arrives in the dispatching post's next turn",
      });
    } catch (err) {
      console.error("[fleets] dispatch error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Cockpit aggregate + template lifecycle (agent-fleet-templates) ────────

  // Compact per-cell projection of every fleet the caller owns
  // (agent-fleet-cockpit-projection): ONE round-trip the gateway cell sampler
  // folds into cell_fleets events. Same read contracts as the list/cockpit
  // faces — the payload is a bounded VIEW, never raw cockpit trees (50 fleets
  // cap; decision snips ≤80 chars; report snips ≤120; slots ≤4).
  // Formation grid node cap (add-teams-hub-formation-board 1.2): beyond this
  // many posts a team's mini formation renders as a thumbnail (truncated:true)
  // instead of an unreadable hairball; the full formation lives in the cockpit.
  const FORMATION_NODE_CAP = 24;

  router.get("/overview", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      // Hosted cells are single-owner: anyone but the cell owner (or an admin
      // probing the cell) gets nothing — the sampler carries the cell owner's
      // identity by construction.
      if (ctx?.authEnabled && ctx?.cellUserEmail && user.email !== ctx.cellUserEmail
          && !ctx?.isAdminUser?.(user)) {
        return res.status(403).json({ error: "Admin group or cell ownership required" });
      }
      const db = getFleetDatabase();
      const clip = (s, n) =>
        typeof s === "string" ? (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s) : (s ?? null);
      // One catalog merge + one job list for the whole projection: this route
      // walks every member of every fleet (the cell reporter samples it on a
      // timer), so a per-member merge dominated its cost.
      const resolveMember = rosterResolver();
      const jobs = cron.listJobs();
      const model = modelCtx();
      const fleets = db
        .listFleets({ ownerEmail: user.email })
        .slice(0, 50)
        .map((fleet) => {
          db.expireOpenDecisions(fleet.id);
          const tasks = taskIndexFor(fleet.id, jobs);
          const members = db.listMembers(fleet.id).map((m) =>
            memberView(db, fleet, m, tasks, { resolver: resolveMember, model }),
          );
          const counts = { onDuty: 0, paused: 0, missing: 0, vacant: 0, passive: 0, failing: 0 };
          for (const v of members) {
            const k = v.status === "on_duty" ? "onDuty" : v.status;
            if (k in counts) counts[k] += 1;
          }
          // Decisions: open, severity first then closest to policy expiry —
          // the cockpit's ordering, verbatim.
          const policy = fleet.decisionPolicy ?? { expiryHours: 72 };
          const expiryMs = policy.expiryHours > 0 ? policy.expiryHours * 3600_000 : null;
          const decisions = db
            .listDecisions({ fleetId: fleet.id, state: "open" })
            .map((item) => ({
              ...item,
              memberTitle: members.find((m) => m.id === item.memberId)?.title ?? null,
              expiresAt: expiryMs ? item.submittedAt + expiryMs : null,
            }))
            .sort((a, b) => {
              const sev = { high: 0, normal: 1, low: 2 };
              if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
              return (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity);
            });
          const stream = members.map((m) => {
            const latest = m.latestReport;
            const metrics = {};
            for (const s of (latest?.slots ?? []).slice(0, 4)) {
              metrics[s.key] = clip(String(s.value), 24);
            }
            return {
              title: m.title,
              status: m.status,
              reasonSnip: m.statusReason ? clip(m.statusReason, 80) : null,
              at: latest?.at ?? null,
              source: latest?.source ?? null,
              metrics,
              summarySnip: latest?.summary ? clip(latest.summary, 120) : null,
            };
          });
          return {
            id: fleet.id,
            name: clip(fleet.name, 60),
            state: fleet.state,
            counts: { ...counts, total: members.length },
            // Binding health (D8 ③): a template pack whose MCP reference bound to
            // nothing still installs and still reads green everywhere else —
            // surface the dead reference here so the fleet face can say WHICH one
            // is unbound instead of waiting for a post's turn to fail.
            bindings: fleetBindingHealth(fleet, dbModule.getInstalledPack(fleet.sourceTemplate?.packId)),
            // Formation summary (add-teams-hub-formation-board 1.1): the compact
            // node/edge view the hub's formation grid renders — member nodes
            // (id/title/kind/status) plus the DECLARED orchestration edges with
            // read-time supervisor expansion, the same source the cockpit
            // canvas draws. Never a second status computation. `truncated`
            // signals the node cap (1.2).
            formation: {
              members: members.map((m) => ({
                id: m.id,
                title: m.title,
                targetKind: m.target?.kind ?? m.targetKind ?? null,
                status: m.status,
                // Serving face (fix-zhiyu-summon-serving-face 1.1): a2a posts
                // carry their catalog ref + registry deployment path so the
                // gateway's room-summon plan can join real deployments; all
                // other posts report nulls. Keys are ALWAYS present — no
                // has-key dance for consumers. Read-only, owner-only surface,
                // same visibility as member pages' target.id.
                targetId: m.target?.kind === "a2a" ? m.target.id ?? null : null,
                servingPath: m.target?.servingPath ?? null,
              })),
              edges: (fleet.orchestration
                ? expandedEdges({ members, orchestration: fleet.orchestration })
                : []
              ).map((e) => ({ kind: e.kind, from: e.from ?? null, to: e.to ?? null, implicit: e.implicit === true })),
              truncated: members.length > FORMATION_NODE_CAP,
            },
            openDecisions: {
              count: decisions.length,
              top: decisions.slice(0, 3).map((d) => ({
                question: clip(d.question, 80),
                severity: d.severity,
                expiresAt: d.expiresAt,
                memberTitle: d.memberTitle,
              })),
            },
            stream,
          };
        });
      res.json({ v: 1, sampledAt: Date.now(), fleets });
    } catch (err) {
      console.error("[fleets] overview error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Copilot focus for the teams hub (add-teams-hub-formation-board 3.1):
  // which installed pack carries the fleet architect? Resolved by AGENT ID
  // ("fleet-architect"), never by pack id/name — per-deployment minted ids
  // drift (§15.101), the agent id is the stable contract. No architect
  // installed → { copilot: null } and the dock opens unfocused (honest
  // degrade, never a pretend focus).
  router.get("/copilot", (_req, res) => {
    try {
      const packs = dbModule.listInstalledPacks();
      for (const p of packs) {
        const agents = Array.isArray(p.manifest?.agents) ? p.manifest.agents : [];
        if (agents.some((a) => a?.id === "fleet-architect")) {
          return res.json({ line: "fleets", copilot: { agentId: "fleet-architect", packId: p.packId ?? p.id ?? null } });
        }
      }
      return res.json({ line: "fleets", copilot: null });
    } catch (err) {
      console.error("[fleets] copilot resolve error:", err.message);
      return res.json({ line: "fleets", copilot: null });
    }
  });

  // ── 主人经营坞总览 (fleet-owner-surface A/B/C) ────────────────────────────
  // 一屏读面: 集群清单+聚合状态+异常告警计数+花销(a)投影, 与 overview/cockpit
  // 契约同源重算 (不另造状态机)。仅自有组织的集群 (与 list 面同一 scope)。
  router.get("/owner/board", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      // One catalog merge + one job list for the whole board (same roster
      // shape as the list route — this face walks every member too).
      const resolveMember = rosterResolver();
      const jobs = cron.listJobs();
      const model = modelCtx();
      const fleets = db.listFleets({ ownerEmail: user.email }).map((fleet) => {
        db.expireOpenDecisions(fleet.id);
        const tasks = taskIndexFor(fleet.id, jobs);
        const members = db.listMembers(fleet.id).map((m) =>
          memberView(db, fleet, m, tasks, { resolver: resolveMember, model }),
        );
        const counts = { onDuty: 0, paused: 0, missing: 0, vacant: 0, passive: 0, failing: 0 };
        for (const v of members) {
          const k = v.status === "on_duty" ? "onDuty" : v.status;
          if (k in counts) counts[k] += 1;
        }
        const openDecisions = db.listDecisions({ fleetId: fleet.id, state: "open" }).length;
        const policy = fleet.decisionPolicy ?? { expiryHours: 72 };
        const lastActivity = Math.max(
          0,
          ...members.map((m) => m.latestReport?.at ?? 0),
        );
        return {
          id: fleet.id,
          name: fleet.name,
          state: fleet.state,
          sourceTemplate: fleet.sourceTemplate ?? null,
          counts: { ...counts, total: members.length },
          // 告警入口的两个聚合 — 坞面行直达对应面 (decisions / failing)。
          openDecisions,
          failing: counts.failing,
          decisionPolicy: policy,
          lastActivityAt: lastActivity || null,
          spend: db.spendProjection(fleet.id),
          // 个人代理就绪（2026-11-10）：主人每天真会看的是这一屏，配置坏了却只在
          // 设置里能发现，等于不会发现。这里只放两个数（是否可用 + 阻塞项数），
          // 明细仍在 readiness 端点与设置面，避免坞面行变重。
          personalAgent: (() => {
            try {
              const r = assessPersonalAgent({
                mandate: db.getFleetMandatePolicy(fleet.id),
                domainMap: db.getPersonalDomainMap(),
                hasAuditor: members.some((m) => m.targetKind === "auditor"),
                verdictTokenConfigured: Boolean(String(process.env.MANDATE_VERDICT_TOKEN ?? "").trim()),
                citablePrecedents: (db.listCitablePrecedents({ fleetId: fleet.id, limit: 500 }) ?? []).length,
                levelSamples: db.outboundLevelSamples(),
                consistency: {},
              });
              return { ready: r.ready, blocked: r.blocked, verdict: r.verdict };
            } catch {
              // 就绪判定失败不影响坞面：这一行是附加信息，缺失不冒充健康。
              return { ready: null, blocked: null, verdict: "readiness unavailable" };
            }
          })(),
        };
      });
      res.json({ v: 1, sampledAt: Date.now(), fleets });
    } catch (err) {
      console.error("[fleets] owner-board error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 花销读数(a) — 单集群的回合/token 事实投影 (fleet-owner-surface C)。
  router.get("/:id/spend", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      res.json({ fleetId: owned.fleet.id, ...db.spendProjection(owned.fleet.id) });
    } catch (err) {
      console.error("[fleets] spend error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── 跨线成本聚合 (add-owner-cross-line-view 1.2, charter C1) ──────────────
  // 主人侧只读聚合：六账按线分组、各带口径与最近对账时间、互相不混加（schema
  // 层无总额槽）。每线独立 try/catch——任一线失败只降级该线分组。只读铁律：
  // 下方处理器零写入、零扣费、零结算路径（1.4 grep 核证）。
  router.get("/owner/cross-line-spend", async (req, res) => {
    const user = resolveUser(req);
    if (!user) return res.status(401).json({ error: "Authentication required" });
    const email = String(user.email || "").trim();
    const sampledAt = Date.now();
    const line = (id, calibre, fn) =>
      Promise.resolve()
        .then(fn)
        .then((metrics) => ({
          line: id,
          status: metrics === null ? "degraded" : "ok",
          ...(metrics === null
            ? { error: `${id} spend read failed` }
            : { metrics, reconciledAt: metrics.reconciledAt ?? sampledAt }),
          calibre,
        }))
        .catch((err) => ({
          line: id,
          status: "degraded",
          calibre,
          error: String(err?.message || err).slice(0, 200),
        }));

    // fleet — fleet_runs 事实投影（复用既有聚合，零新查询）。
    const fleetLine = line("fleet", "owner.fleet", async () => {
      const db = getFleetDatabase();
      const fleets = db.listFleets({ ownerEmail: email });
      const agg = { runs: 0, turns: 0, usageInput: null, usageOutput: null, costUsd: null, pricedTurns: 0 };
      for (const f of fleets) {
        const p = db.spendProjection(f.id);
        agg.runs += p.allTime?.runs ?? 0;
        agg.turns += p.allTime?.turns ?? 0;
        if (p.allTime?.usageInput != null) {
          agg.usageInput = (agg.usageInput ?? 0) + p.allTime.usageInput;
        }
        if (p.allTime?.usageOutput != null) {
          agg.usageOutput = (agg.usageOutput ?? 0) + p.allTime.usageOutput;
        }
        // Money (add-fleet-cost-read-face): only priced turns contribute, and the
        // total stays null until at least one fleet has a priced turn.
        if (p.allTime?.costUsd != null) agg.costUsd = (agg.costUsd ?? 0) + p.allTime.costUsd;
        agg.pricedTurns += p.allTime?.pricedTurns ?? 0;
      }
      return { ...agg, fleets: fleets.length };
    });

    // market — buyer 成交记（消费侧读数，进程内 market store 直读）。
    const marketLine = line("market", "owner.market", async () => {
      const market = ctx?.localPackMarket?.market;
      if (!market?.purchasesForBuyer) return null;
      const rows = market.purchasesForBuyer(email, { limit: 100 });
      const settled = rows.filter((r) => r.status === "settled");
      const usd = settled
        .map((r) => Number(r.amount_usd))
        .filter((n) => Number.isFinite(n))
        .reduce((a, b) => a + b, 0);
      return {
        purchases: rows.length,
        settled: settled.length,
        ...(settled.length ? { settled_usd: Number(usd.toFixed(2)) } : {}),
        latest_at: rows[0]?.created_at ?? null,
      };
    });

    // wanxing — facade ops 账代读（唯一平台凭据例外；真源在 facade pod）。
    const wanxingLine = line("wanxing", "owner.wanxing", async () => {
      const base = String(process.env.WANXING_FACADE_URL || "").replace(/\/+$/, "");
      const token = String(process.env.AGENT_SERVING_REGISTRY_TOKEN || "");
      if (!base || !token) return { available: false };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const r = await fetch(`${base}/api/wanxing/v1/ops/usage`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(`facade ops/usage → HTTP ${r.status}`);
        const j = await r.json();
        const mine = (j.byCaller ?? []).filter(
          (row) => String(row.email || "").toLowerCase() === email.toLowerCase(),
        );
        const turns = mine.reduce((a, b) => a + (b.turns ?? 0), 0);
        const minutes = mine.reduce((a, b) => a + (b.minutes ?? 0), 0);
        const usd = mine.reduce((a, b) => a + (b.usd ?? 0), 0);
        const pending = mine.reduce((a, b) => a + (b.pending ?? 0), 0);
        return {
          available: true,
          ...(mine.length
            ? { turns, minutes, usd: Number(usd.toFixed(2)), pending }
            : {}),
        };
      } finally {
        clearTimeout(timer);
      }
    });

    // lex / wire — 用户凭据直读（共享 helper，401 翻面语义同 board）。
    const lexLine = line("lex", "owner.lex", async () => {
      const out = await fetchLexUsageFor(email);
      if (out.status === "unconnected") return { unconnected: out.reason };
      if (out.status === "degraded") throw new Error(out.error || "lex usage read failed");
      return out.data ?? {};
    });

    const wireLine = line("wire", "owner.wire", async () => {
      const out = await fetchWireUsageFor(email);
      if (out.status === "unconnected") return { unconnected: out.reason };
      if (out.status === "degraded") throw new Error(out.error || "wire usage read failed");
      return out.data ?? {};
    });

    // balance — sub2api 余额快照（deployer 账户粒度，粗粒度归属）。
    const balanceLine = line("balance", "owner.balance", async () => {
      const snap = ctx?.localPackMarket?.billingSnapshots;
      if (!snap) return null;
      const rows = snap(email, { limit: 1 });
      const latest = rows[0] ?? null;
      return latest
        ? { balance_usd: latest.balanceUsd, sampledAt: latest.sampledAt }
        : { samples: 0 };
    });

    const [fleet, market, wanxing, lex, wire, balance] = await Promise.all([
      fleetLine,
      marketLine,
      wanxingLine,
      lexLine,
      wireLine,
      balanceLine,
    ]);
    res.json({ v: 1, sampledAt, lines: [fleet, market, wanxing, lex, wire, balance] });
  });

  // ── 迭代回路 (fleet-owner-iteration) ─────────────────────────────────────
  // 提议入口: 配置改动主张 → 决策车道（批准前零生效）。
  router.post("/:id/iterations/propose", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const out = createConfigChangeProposal({
        db,
        fleet: owned.fleet,
        ownerEmail: owned.user.email,
        changeDoc: req.body ?? {},
      });
      if (!out.ok) return res.status(400).json({ error: out.error });
      res.status(201).json(out);
    } catch (err) {
      console.error("[fleets] propose error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.get("/:id/iterations", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      res.json({ iterations: getFleetDatabase().listIterations(owned.fleet.id) });
    } catch (err) {
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 从失败环重试: 不重跑整链 (published = 幂等返回)。
  router.post("/:id/iterations/:itId/retry", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const out = await retryIterationCast({
        db: getFleetDatabase(),
        iterationId: req.params.itId,
        ownerEmail: owned.user.email,
        installFn: defaultInstallFn(),
        publishFn: defaultPublishFn(req),
        validateFn: defaultValidateFn(req),
        log: console,
      });
      if (!out.ok && !out.already) return res.status(out.error?.includes("not approved") ? 409 : 502).json({ error: out.error ?? "retry failed", iteration: out.iteration ?? null });
      res.json(out);
    } catch (err) {
      console.error("[fleets] iteration retry error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Digest 订阅 (fleet-owner-iteration) ──────────────────────────────────
  const DIGEST_KINDS = new Set(["daily", "weekly"]);
  router.post("/:id/digest-subscribe", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const cadence = String(req.body?.cadence ?? "");
      if (!DIGEST_KINDS.has(cadence)) return res.status(400).json({ error: "cadence must be daily|weekly" });
      const row = getFleetDatabase().upsertDigestSub({ id: `dg_${Math.random().toString(36).slice(2, 10)}`, fleetId: owned.fleet.id, ownerEmail: owned.user.email, cadence });
      res.status(201).json({ subscription: row });
    } catch (err) {
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.delete("/:id/digest-subscribe/:cadence", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      getFleetDatabase().removeDigestSub(owned.fleet.id, owned.user.email, req.params.cadence);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.get("/owner/digest-subscriptions", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      const names = Object.fromEntries(db.listFleets({ ownerEmail: user.email }).map((f) => [f.id, f.name]));
      res.json({
        subscriptions: db.listDigestSubscriptions({ ownerEmail: user.email }).map((s) => ({ ...s, fleetName: names[s.fleetId] ?? null })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // One round-trip for the whole cockpit (design: no four-fetch flicker).
  // Every segment reuses the previous knives' read contracts verbatim —
  // statuses/evidence/latest from the detail face, decisions from the queue
  // face — plus the health rollup and the template-newer notice (D7).
  router.get("/:id/cockpit", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      db.expireOpenDecisions(owned.fleet.id);
      const resolveMember = rosterResolver();
      const tasks = taskIndexFor(owned.fleet.id);
      const model = modelCtx();
      const members = db.listMembers(owned.fleet.id).map((m) =>
        memberView(db, owned.fleet, m, tasks, { resolver: resolveMember, model }),
      );
      const statusCounts = {};
      for (const v of members) statusCounts[v.status] = (statusCounts[v.status] ?? 0) + 1;
      // Failure dimension: derived from the STATUS now (fix-fleet-failure-
      // visibility D5). The old "latest turn !== ok" reading missed the case
      // that matters most — a post that failed many rounds but happened to
      // succeed last — and let `normal` count downgraded posts.
      const failing = statusCounts.failing ?? 0;

      // Decisions: open, severity first then closest to policy expiry.
      const policy = owned.fleet.decisionPolicy ?? { expiryHours: 72 };
      const expiryMs = policy.expiryHours > 0 ? policy.expiryHours * 3600_000 : null;
      const decisions = db
        .listDecisions({ fleetId: owned.fleet.id, state: "open" })
        .map((item) => ({
          ...item,
          memberTitle: members.find((m) => m.id === item.memberId)?.title ?? null,
          expiresAt: expiryMs ? item.submittedAt + expiryMs : null,
        }))
        .sort((a, b) => {
          const sev = { high: 0, normal: 1, low: 2 };
          if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
          return (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity);
        });

      // Daily stream: each post's latest report, missing posts first.
      const stream = members
        .map((m) => ({ memberId: m.id, title: m.title, status: m.status, latestReport: m.latestReport }))
        .sort((a, b) => {
          if (a.status === "missing" && b.status !== "missing") return -1;
          if (b.status === "missing" && a.status !== "missing") return 1;
          return (b.latestReport?.at ?? 0) - (a.latestReport?.at ?? 0);
        });

      res.json({
        fleet: owned.fleet,
        members,
        statusCounts,
        decisions,
        openDecisions: decisions.length,
        stream,
        // Orchestration read view (agent-fleet-orchestration): declared
        // section + read-time mode expansion (implicit supervisor edges are
        // marked, never stored).
        orchestration: owned.fleet.orchestration
          ? {
              mode: owned.fleet.orchestration.mode ?? null,
              constraints: constraintsOf(owned.fleet.orchestration),
              edges: expandedEdges({ members, orchestration: owned.fleet.orchestration }),
            }
          : null,
        // Edge traffic (agent-fleet-runs): hops in the last 24h grouped by
        // (from post, to post, edge kind) with the outcome split — the canvas
        // weighs edges by it. Pre-v2 rows carry no chain and simply do not
        // appear (honest absence, not a zero).
        edgeTraffic: db.edgeTraffic(owned.fleet.id),
        health: {
          onDuty: statusCounts.on_duty ?? 0,
          paused: statusCounts.paused ?? 0,
          missing: statusCounts.missing ?? 0,
          vacant: statusCounts.vacant ?? 0,
          passive: statusCounts.passive ?? 0,
          failing,
          total: members.length,
          // Budget pressure (fix-fleet-failure-visibility D6): several posts
          // failing on `budget` in the last day is the deployment being out of
          // quota, not a bad post. Null when nothing failed on it — the read
          // face shows a banner only for a real condition, never a zero state.
          budgetPressure: db.budgetPressure(owned.fleet.id),
        },
        template: templateNotice(owned.fleet),
        // 7.2 回链: the page's detail pane fetches THIS route (cockpit), so the
        // source-blueprint projection must ride it too — not only the bare
        // /:id detail (caught by the production walkthrough, 2026-11-03).
        blueprintId: sourceBlueprintId(owned.fleet),
      });
    } catch (err) {
      console.error("[fleets] cockpit error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Team console (add-pack-console) ─────────────────────────────────────────
  // The team's own face: the pack's `console` declaration selects which blocks
  // this fleet shows, on which surface. ONE view model serves both hosts (the
  // platform page and the facet share page) — the share cut happens HERE, in
  // the response, not in the client.
  //
  // Two addresses, one handler: the owner page knows the fleet id; a share page
  // knows only the published slug (handing out ids would let a visitor probe
  // other teams by id). Authority:
  //   · `surface=platform` is owner (or admin) only;
  //   · `surface=share` is anonymous only for a PUBLISHED fleet, and an
  //     unpublished one answers exactly like a missing one (404) — a guess
  //     cannot even confirm that the team exists.
  const serveConsole = (req, res, fleet) => {
    try {
      const surface = req.query?.surface === "share" ? "share" : "platform";
      const db = getFleetDatabase();
      if (!fleet) return res.status(404).json({ error: "Fleet not found" });

      if (surface === "platform") {
        const user = resolveUser(req);
        if (!user) return res.status(401).json({ error: "Authentication required" });
        if (fleet.ownerEmail !== user.email && !ctx?.isAdminUser?.(user)) {
          return res.status(403).json({ error: "Not your fleet" });
        }
      } else {
        const slug = typeof req.query?.slug === "string" ? req.query.slug.trim() : "";
        if (!fleet.consoleSlug || !slug || slug !== fleet.consoleSlug) {
          return res.status(404).json({ error: "Not published" });
        }
      }

      // The declaration rides the pack the fleet was instantiated from. A fleet
      // with no template lineage has no console: an honest empty block list.
      const templatePackId = fleet.sourceTemplate?.packId ?? null;
      const installed = templatePackId ? dbModule.getInstalledPack(templatePackId) : null;
      const section = installed?.manifest?.console ?? null;
      if (!section) {
        return res.json({
          v: 1,
          fleet: { id: fleet.id, name: fleet.name, state: fleet.state, published: Boolean(fleet.consoleSlug) },
          surface,
          headline: null,
          blocks: [],
          sampledAt: Date.now(),
        });
      }

      const view = buildConsoleViewModel({
        section,
        surface,
        db,
        fleet,
        tasks: taskIndexFor(fleet.id),
        model: modelCtx(),
        memberView,
      });
      // Publication state rides the view so the owner page can render its
      // publish/unpublish control without a second round-trip.
      view.fleet.published = Boolean(fleet.consoleSlug);
      view.fleet.slug = fleet.consoleSlug ?? null;
      res.json(view);
    } catch (err) {
      console.error("[fleets] console error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  };

  router.get("/:id/console", (req, res) => serveConsole(req, res, getFleetDatabase().getFleet(req.params.id)));
  // Publish / unpublish (owner or admin). Publishing requires the fleet to
  // actually carry a console declaration — a slug for a team with no declared
  // blocks would be a link to an empty page.
  router.post("/:id/console/publish", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const templatePackId = owned.fleet.sourceTemplate?.packId ?? null;
      const installed = templatePackId ? dbModule.getInstalledPack(templatePackId) : null;
      if (!installed?.manifest?.console) {
        return res.status(400).json({ error: "This team declares no console" });
      }
      const slug = owned.fleet.consoleSlug ?? deriveConsoleSlug(db, owned.fleet);
      db.updateFleet(owned.fleet.id, { consoleSlug: slug, consolePublishedAt: owned.fleet.consolePublishedAt ?? Date.now() });
      res.json({ slug, publishedAt: owned.fleet.consolePublishedAt ?? Date.now() });
    } catch (err) {
      console.error("[fleets] console publish error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/:id/console/unpublish", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      getFleetDatabase().updateFleet(owned.fleet.id, { consoleSlug: null, consolePublishedAt: null });
      res.json({ slug: null });
    } catch (err) {
      console.error("[fleets] console unpublish error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.get("/by-slug/:slug/console", (req, res) => {
    const db = getFleetDatabase();
    const fleet = typeof db.getFleetByConsoleSlug === "function" ? db.getFleetByConsoleSlug(req.params.slug) : null;
    serveConsole(req, res, fleet);
  });

  // Instantiate a fleet from an installed pack's template section. Install
  // never auto-runs: the fleet is born all-paused with a 待启动 banner.
  router.post("/from-template", async (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const packId = req.body?.packId;
      if (typeof packId !== "string" || !packId.trim()) {
        return res.status(400).json({ error: "packId is required" });
      }
      const installed = dbModule.getInstalledPack(packId);
      if (!installed) return res.status(400).json({ error: `pack '${packId}' is not installed here` });
      if (!installed.manifest?.fleet) {
        return res.status(400).json({ error: `pack '${packId}' carries no fleet template` });
      }

      const db = getFleetDatabase();
      const out = await provisionFleetFromTemplate({
        packId,
        version: installed.version ?? null,
        manifest: installed.manifest,
        ownerEmail: user.email,
        // 参数槽（agent-fleet-templates delta）：向导提供的值；必填缺失/
        // 类型不符 → params-invalid 422 指名缺失槽，零实化痕迹。
        params: req.body?.params && typeof req.body.params === "object" && !Array.isArray(req.body.params) ? req.body.params : null,
        deps: {
          db,
          catalogAgentIds: () => new Set(catalog.getChatAgentEntries().map((e) => e.id)),
          resolveExisting: ({ kind, id }) => {
            if (kind === "persona") return !!catalog.getChatAgentEntries().some((e) => e.id === id); // persona-only: 蓝图目标类型不含 auditor
            if (kind === "a2a") {
              const entry = catalog.getAgentEntry(id);
              return !!entry && entry.mode === "a2a";
            }
            // tool/bot resolve through resolveTarget semantics — the same
            // authority the member read face uses (mixed-fleet D4).
            if (kind === "tool" || kind === "bot") {
              return resolveTarget({ targetKind: kind, targetId: id }).alive;
            }
            const cluster = getClusterDatabase().get(id);
            return !!cluster && cluster.status !== "terminated";
          },
          reconcile: (fleetId) =>
            reconcileFleet({ fleetId, db, cronApi: cron, resolveTarget: targetResolver, rosterPresetId }),
        },
      });
      if (!out.ok) {
        // params-invalid 是 422 口径（参数不合 ≠ 请求畸形），其余与既往一致。
        if (out.code === "params-invalid") {
          return res.status(422).json({ error: out.error, code: "params-invalid", errors: out.errors ?? [] });
        }
        return res.status(400).json({ error: out.error });
      }
      // Team plugins land with the team (2.1): recomputed from every live
      // declaration, so a re-provision of an existing team is also a repair.
      syncFleetPlugins(db);
      res.status(out.deduped ? 200 : 201).json(out);
    } catch (err) {
      console.error("[fleets] from-template error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Confirm-start (3.2): the owner reviewed the structure — flip the fleet to
  // active and re-enable every member's cadence (vacant posts park again via
  // reconcile; member-level pauses chosen before start are not a thing here —
  // everything was born paused).
  router.post("/:id/start", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      if (owned.fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived" });
      }
      db.updateFleet(owned.fleet.id, { state: "active" }, auditMeta(req, "POST /api/fleets/:id/start"));
      for (const m of db.listMembers(owned.fleet.id)) {
        if (m.cadence && m.cadence.enabled === false) {
          db.updateMember(m.id, { cadence: { ...m.cadence, enabled: true } });
        }
      }
      const reconcile = await runReconcile(owned.fleet.id);
      res.json({ fleet: db.getFleet(owned.fleet.id), reconcile });
    } catch (err) {
      console.error("[fleets] start error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Export (3.3): whitelist-only manifest — skeleton/slots/cadence survive;
  // reports, decisions, sessions, owner, credentials never do.
  router.get("/:id/export", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const members = db.listMembers(owned.fleet.id);
      const declared = declaredPluginsForFleet({ fleet: owned.fleet, getInstalledPack: dbModule.getInstalledPack });
      const manifest = exportFleetToTemplate(owned.fleet, members, { plugins: declared.plugins });
      res.setHeader("content-disposition", `attachment; filename="fleet-${owned.fleet.id}.json"`);
      res.json(manifest);
    } catch (err) {
      console.error("[fleets] export error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Decision lane (agent-fleet-decision-lane) ─────────────────────────────
  //
  // The escalate bridge (twin of /report): the in-cell fleet MCP child files
  // an approval request from the post the CURRENT turn runs under. The
  // question text, options and severity come from the caller; expiry NEVER
  // does — that is fleet policy (suggestedDeadline is display-only).

  router.post("/escalate", async (req, res) => {
    try {
      const db = getFleetDatabase();
      const payload = validateEscalatePayload(req.body);
      if (!payload.ok) return res.status(400).json({ error: payload.error });

      const personaMembers = [];
      for (const f of db.listFleets()) {
        // Ghost-post guard (0030e1e8 family): a dissolved fleet's posts exit
        // attribution — a persona swapped into a walkthrough fleet's post must
        // not collide with its live post and wedge report/escalate with 409s.
        if (f.state === "archived") continue;
        for (const m of db.listMembers(f.id)) {
          if (isPersonaBackedTargetKind(m.targetKind)) personaMembers.push(m);
        }
      }
      const attribution = resolveAttribution({
        currentPreset: ctx?.currentPreset ?? null,
        runningTasks: cron.listJobs(),
        openTurns: openTurns(),
        personaMembers,
        rosterPresetId,
      });
      if (attribution.kind === "none" || attribution.kind === "ambiguous") {
        return res.status(409).json({ error: attribution.error });
      }
      const member = db.getMember(attribution.memberId);
      if (!member) return res.status(409).json({ error: "the attributed post no longer exists" });
      const fleet = db.getFleet(member.fleetId);

      // Flood (design D5): per-post daily cap from the fleet policy, and the
      // fleet-wide open queue cap — a flooded queue must not paralyze the
      // owner's entry point.
      const now = Date.now();
      db.expireOpenDecisions(fleet.id, { now });
      const dayStart = new Date(now);
      dayStart.setHours(0, 0, 0, 0);
      // 防洪口径改为升级流水（add-deputy-decision-delegate）：归并不落新行，
      // 但每次 escalate 都是一次升级事件——上限必须把归并也算进去，否则重复
      // 升级绕开防洪。
      const dailyCount = db.countEscalationsByMemberSince(member.id, dayStart.getTime());
      const cap = fleet.decisionPolicy?.dailyCapPerMember ?? 10;
      if (dailyCount >= cap) {
        return res.status(429).json({ error: `daily escalation limit reached (${cap}/day for this post)`, dailyRemaining: 0 });
      }
      const openCount = db.countOpenDecisions(fleet.id);
      if (openCount >= OPEN_QUEUE_LIMIT) {
        return res.status(429).json({ error: `the fleet's open decision queue is full (${OPEN_QUEUE_LIMIT}) — resolve pending items first` });
      }

      const sessionId =
        attribution.task?.sessionId ?? chatHistory.currentSessionId?.() ?? null;

      // 归并检查 (design D5)：同岗位近 7 天的相似 open 项——topicKey 精确命中
      // 或问题归一化文本相同。归并 = 既有项升级次数 +1（审计流水记 merged），
      // 不落新行。不跨岗位、不改问题文本与过期基准。
      const dedupeWindowStart = now - 7 * 86_400_000;
      const similar = db.findSimilarOpenDecision({
        memberId: member.id,
        topicKey: payload.item.topicKey,
        question: payload.item.question,
        sinceMs: dedupeWindowStart,
      });
      if (similar) {
        const mergedItem = db.mergeDecisionEscalation(similar.id, { now, sessionId });
        db.recordEscalation({
          id: `e_${now}_${Math.random().toString(36).slice(2, 8)}`,
          fleetId: fleet.id,
          memberId: member.id,
          decisionId: similar.id,
          merged: 1,
          sourceSessionId: sessionId,
          now,
        });
        return res.status(200).json({
          ok: true,
          merged: true,
          itemId: mergedItem?.id ?? similar.id,
          escalations: mergedItem?.escalations ?? (similar.escalations ?? 0) + 1,
          memberTitle: member.title,
          note: "an open item for this topic already exists — this escalation was merged into it",
        });
      }

      // 委托路由 (design D2/D3)：escalate 时按当次生效策略同步打 route——
      // 规则先行（确定性、可解释），deputy 不参与路由。
      const delegationPolicy = db.getFleetDelegationPolicy(fleet.id);
      // domain 先算，因为它决定路由口径（widen-deputy-to-personal-domains 5.1）：
      //   · 未落域或 ops 域 → 既有类别路由（含三类硬锁 owner）
      //   · 个人事务域 → 按委托状是否真的授予了东西决定，不查 ops 的类别表。
      //     「不可委托」在个人域用额度表达，不按类别——spend 恰恰是最常被委托的。
      const domain = domainFor(db.getPersonalDomainMap(), payload.item.source ?? null);
      const route =
        domain && domain !== "ops"
          ? agentMayHandle(db.getFleetMandatePolicy(fleet.id), domain)
            ? "deputy"
            : "owner"
          : routeForItem(
              { category: payload.item.category, itemType: payload.item.itemType, severity: payload.item.severity },
              delegationPolicy,
            );

      // 个人事务域 (widen-deputy-to-personal-domains 1.4)：来源命中映射则落域，
      // 否则 domain=null——即既有舰队内部车道，category 词汇原样不动。
      // 映射只决定「进哪个域」，能自主到哪一步仍由委托状决定。

      const item = db.appendDecision({
        id: `d_${now}_${Math.random().toString(36).slice(2, 8)}`,
        fleetId: fleet.id,
        memberId: member.id,
        question: payload.item.question,
        options: payload.item.options,
        severity: payload.item.severity,
        suggestedDeadline: payload.item.suggestedDeadline,
        recommendation: payload.item.recommendation,
        sourceSessionId: sessionId,
        submittedAt: now,
        route,
        category: payload.item.category,
        topicKey: payload.item.topicKey,
        domain,
      });
      db.recordEscalation({
        id: `e_${now}_${Math.random().toString(36).slice(2, 8)}`,
        fleetId: fleet.id,
        memberId: member.id,
        decisionId: item.id,
        merged: 0,
        sourceSessionId: sessionId,
        now,
      });
      // Best-effort out-of-band ping seam (WeChat envelope et al.): mounted
      // by the deployment when a provider exists; absent = in-app badge only.
      try {
        ctx?.fleetDecisionNotifier?.(fleet, item, member);
      } catch { /* best-effort by contract */ }
      // Fleet working memory (add-zhiyu-team-memory): the decision opening is
      // a team fact. Fire-and-forget; capture never surfaces into the path.
      try {
        ctx?.captureFleetFact?.(fleet.id, member.id, "decision-opened", item.question, `严重度 ${item.severity}${route ? `，路由 ${route}` : ""}`);
      } catch { /* capture never surfaces */ }
      res.status(201).json({
        ok: true,
        itemId: item.id,
        memberTitle: member.title,
        queuePosition: openCount + 1,
        dailyRemaining: cap - dailyCount - 1,
        route,
      });
    } catch (err) {
      console.error("[fleets] escalate error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Deputy bridge (add-deputy-decision-delegate) ──────────────────────────
  //
  // 常务岗的工具面（fleet MCP → bridge）：身份归因与 escalate 同构
  // （currentPreset → 岗位），服务端强制授权在这里逐项执行——**闸在代码不在
  // 提示词**。所有路由都要求：归因成功、归因岗位 = 舰队策略的 deputyMemberId。

  // 校验归因岗位是否为本舰队委托策略的 deputy。返回 { fleet, deputy, policy }
  // 或 { error }。
  function deputyGuard({ db, attribution }) {
    if (attribution.kind === "none" || attribution.kind === "ambiguous") {
      return { error: attribution.error || "deputy identity could not be attributed", status: 409 };
    }
    const deputy = db.getMember(attribution.memberId);
    if (!deputy) return { error: "the attributed post no longer exists", status: 409 };
    const fleet = db.getFleet(deputy.fleetId);
    if (!fleet) return { error: "the deputy's fleet no longer exists", status: 409 };
    const policy = db.getFleetDelegationPolicy(fleet.id);
    if (!policy.enabled || policy.deputyMemberId !== deputy.id) {
      return { error: "this post is not the fleet's delegated deputy", status: 403 };
    }
    return { fleet, deputy, policy };
  }

  // 审计官归属闸（2026-11-10）：与 deputyGuard 同形。调用方必须被归因为某个岗位，
  // 且那个岗位的承载类型是 auditor —— 审计官的结论由它自己的回合提交，不是主人代发。
  function auditorGuard({ db, attribution }) {
    if (attribution.kind === "none" || attribution.kind === "ambiguous") {
      return { error: attribution.error || "auditor identity could not be attributed", status: 409 };
    }
    const auditor = db.getMember(attribution.memberId);
    if (!auditor) return { error: "the attributed post no longer exists", status: 409 };
    if (auditor.targetKind !== "auditor") {
      return { error: "this post is not an auditor post", status: 403 };
    }
    const fleet = db.getFleet(auditor.fleetId);
    if (!fleet) return { error: "the auditor's fleet no longer exists", status: 409 };
    return { fleet, auditor };
  }

  // 审计官提交结论（桥面，供 auditor_submit_verdict 工具调用）。
  // 与上面 owner 直调的 /:id/decisions/:itemId/auditor 并存：那条是主人在控制台
  // 手动记录结论，这条是审计官从自己回合里提交。
  router.post("/auditor/verdict", (req, res) => {
    try {
      const db = getFleetDatabase();
      const personaMembers = [];
      for (const f of db.listFleets()) {
        if (f.state === "archived") continue;
        for (const m of db.listMembers(f.id)) {
          if (isPersonaBackedTargetKind(m.targetKind)) personaMembers.push(m);
        }
      }
      const attribution = resolveAttribution({
        currentPreset: ctx?.currentPreset ?? null,
        runningTasks: cron.listJobs(),
        openTurns: openTurns(),
        personaMembers,
        rosterPresetId,
      });
      const guard = auditorGuard({ db, attribution });
      if (guard.error) return res.status(guard.status).json({ error: guard.error });
      const { fleet } = guard;

      const { itemId, verdict, note } = req.body ?? {};
      if (!isVerdict(verdict)) {
        return res.status(400).json({ error: `verdict must be one of ${Object.values(AUDITOR_VERDICTS).join("|")}` });
      }
      const item = db.getDecision(itemId);
      if (!item || item.fleetId !== fleet.id) return res.status(404).json({ error: "Decision not found" });
      if (item.state !== "open") return res.status(409).json({ error: `already ${item.state}` });
      const reason = typeof note === "string" ? note.slice(0, 2000) : null;
      if (verdict === AUDITOR_VERDICTS.DISSENT && !reason) {
        return res.status(400).json({ error: "a dissent must carry its reason" });
      }
      const patch = { auditorVerdict: verdict, auditorNote: reason };
      if (verdict === AUDITOR_VERDICTS.BLOCK) patch.route = "owner";
      const updated = db.transitionDecision(itemId, "open", patch);
      if (!updated) return res.status(409).json({ error: "first resolution wins" });
      res.json({ ok: true, item: updated });
    } catch (err) {
      console.error("[fleets] auditor verdict (bridge) error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 策略里的「裁决所用模型」落到常务岗这个岗位的 model 字段上——策略是声明，
  // 岗位 model 才是回合实际解析链的第一跳（fleetModelFor → resolveModelChain）。
  // 不这样做 policy.model 就是一只没接线的旋钮：存了、看得见、不影响任何行为。
  // 声明为空则清掉岗位 model，回到继承（舰队默认 → cell 默认）。
  function applyDeputyModel(db, fleetId, policy) {
    const deputyId = policy?.deputyMemberId;
    if (!deputyId) return null;
    const member = db.getMember(deputyId);
    if (!member || member.fleetId !== fleetId) return null;
    const next = typeof policy.model === "string" && policy.model ? policy.model : null;
    if ((member.model ?? null) === next) return member;
    db.updateMember(deputyId, { model: next });
    return db.getMember(deputyId);
  }

  // Deputy 队列：route=deputy 的 open 项 + 每项的来源岗位上下文（标题/状态/
  // 近期报数摘要）与主人过往同类判例（resolved_by=owner 的历史裁决）。
  router.post("/deputy/queue", async (_req, res) => {
    try {
      const db = getFleetDatabase();
      const personaMembers = [];
      for (const f of db.listFleets()) {
        if (f.state === "archived") continue;
        for (const m of db.listMembers(f.id)) {
          if (isPersonaBackedTargetKind(m.targetKind)) personaMembers.push(m);
        }
      }
      const attribution = resolveAttribution({
        currentPreset: ctx?.currentPreset ?? null,
        runningTasks: cron.listJobs(),
        openTurns: openTurns(),
        personaMembers,
        rosterPresetId,
      });
      const guard = deputyGuard({ db, attribution });
      if (guard.error) return res.status(guard.status).json({ error: guard.error });
      const { fleet, policy } = guard;
      db.expireOpenDecisions(fleet.id, { now: Date.now() });
      const items = db.listDecisions({ fleetId: fleet.id, state: "open", route: "deputy" });
      const memberOf = (id) => db.getMember(id);
      const queue = items.map((item) => {
        const m = memberOf(item.memberId);
        const recent = m ? db.listReports(m.id, { limit: 1 }) : [];
        // 判例：主人过往对同一岗位/同类别的裁决（resolved_by=owner），且来源
        // 等级必须是可引用的两级（owner-authored / owner-approved）。
        // deputy-ruled 一律不进判例集：代理起草的稿被原样发出后字面上就是
        // 主人的口径，不加分级回喂会形成自我强化。
        const precedents = db
          .listCitablePrecedents({ fleetId: fleet.id, memberId: item.memberId, limit: 3 })
          .map((d) => ({
            id: d.id,
            question: d.question,
            resolution: d.resolution,
            resolvedAt: d.resolvedAt,
            grade: d.precedentGrade,
          }));
        return {
          id: item.id,
          question: item.question,
          options: item.options,
          severity: item.severity,
          category: item.category,
          submittedAt: item.submittedAt,
          escalations: item.escalations ?? 0,
          member: m ? { id: m.id, title: m.title, status: m.status ?? null } : { id: item.memberId, title: null },
          recentReport: recent[0]?.summary?.slice(0, 300) ?? null,
          // `detail` rides the queue as of 2026-11-10: the submitter's own
          // evidence (steps, tool, attributed cause) is what makes a ruling
          // reviewable, and operator annotations land here too. Omitting it
          // meant the deputy could only rule on the headline question — the
          // same "write point ≠ read face" gap this project keeps fixing.
          detail: item.detail ?? null,
          precedents,
        };
      });
      res.json({
        fleet: { id: fleet.id, name: fleet.name },
        policy: { maxSeverity: policy.maxSeverity, dailyBudget: policy.dailyBudget, routes: policy.routes },
        queue,
      });
    } catch (err) {
      console.error("[fleets] deputy queue error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Deputy 裁决：approve/reject + 依据。强制授权逐项校验——顺序：deputy 身份
  // → 条目 route=deputy → 类别硬闸 → severity 上限 → 日预算。裁决落
  // resolved_by=deputy + 模型 + 依据，走既有 approved/rejected 管线送达。
  router.post("/deputy/resolve", async (req, res) => {
    try {
      const db = getFleetDatabase();
      const personaMembers = [];
      for (const f of db.listFleets()) {
        if (f.state === "archived") continue;
        for (const m of db.listMembers(f.id)) {
          if (isPersonaBackedTargetKind(m.targetKind)) personaMembers.push(m);
        }
      }
      const attribution = resolveAttribution({
        currentPreset: ctx?.currentPreset ?? null,
        runningTasks: cron.listJobs(),
        openTurns: openTurns(),
        personaMembers,
        rosterPresetId,
      });
      const guard = deputyGuard({ db, attribution });
      if (guard.error) return res.status(guard.status).json({ error: guard.error });
      const { fleet, deputy, policy } = guard;

      const { itemId, kind, choice, note, evidence } = req.body ?? {};
      if (!["approve", "reject"].includes(kind)) {
        return res.status(400).json({ error: "kind must be approve or reject (amend is owner-only)" });
      }
      const item = db.getDecision(itemId);
      if (!item || item.fleetId !== fleet.id) return res.status(404).json({ error: "Decision not found" });
      if (item.state !== "open") return res.status(409).json({ error: `already ${item.state}` });
      if (item.route !== "deputy") {
        return res.status(403).json({ error: "beyond delegation mandate — this item is routed to the owner" });
      }
      const category = item.category ?? "routine-ops";
      const route = policy.routes[category] ?? policy.routes.default;
      if (route !== "deputy") {
        return res.status(403).json({ error: `beyond delegation mandate — category '${category}' is routed to ${route}` });
      }
      if ((SEVERITY_RANK[item.severity] ?? 1) > (SEVERITY_RANK[policy.maxSeverity] ?? 1)) {
        return res.status(403).json({ error: `beyond delegation mandate — severity ${item.severity} exceeds the policy cap (${policy.maxSeverity})` });
      }
      const dayStart = new Date(Date.now());
      dayStart.setHours(0, 0, 0, 0);
      const ruled = db
        .listDecisions({ fleetId: fleet.id })
        .filter((d) => d.resolvedBy === "deputy" && (d.resolvedAt ?? 0) > dayStart.getTime()).length;
      if (ruled >= policy.dailyBudget) {
        return res.status(429).json({ error: `deputy daily ruling budget reached (${policy.dailyBudget}/day) — remaining items roll to the owner` });
      }
      const resolution = validateResolution(kind, { choice, note }, item);
      if (!resolution.ok) return res.status(400).json({ error: resolution.error });
      resolution.resolution.by = `deputy:${deputy.title ?? deputy.id}`;
      resolution.resolution.at = Date.now();

      // 裁决所用模型 SHALL 由服务端取（spec「裁决携带身份与依据」）：读本回合
      // 子进程自己发出的 request/header，而不是请求体自报，也不是声明的
      // 模型链（后者会 out-of-band 漂移）。取不到就如实留空，不猜。
      const rulingModel = ctx?.fleetTurnLedger?.observedModelFor?.(deputy.id) ?? null;

      const updated = db.transitionDecision(itemId, "open", {
        state: kind === "reject" ? "rejected" : "approved",
        resolution: resolution.resolution,
        resolvedAt: Date.now(),
        resolvedBy: "deputy",
        resolvedByModel: rulingModel ? String(rulingModel).slice(0, 120) : null,
        rulingEvidence: typeof evidence === "string" ? evidence.slice(0, 2000) : null,
        // 判级由产生路径决定，不看代理自报：代理自裁永远进不了判例集。
        precedentGrade: classifyProvenance({ resolvedBy: "deputy" }),
      });
      if (!updated) return res.status(409).json({ error: "first resolution wins — another decision just landed" });
      // 记忆镜像 (design D7 写侧)：代理裁决即时进主人记忆 reference 层——
      // 主人能在记忆里查证"常务岗判了什么、依据是什么"。fire-and-forget，
      // 失败降级不影响裁决本身（裁决已落审计）。
      try {
        const ownerEmail = fleet.ownerEmail ?? fleet.owner_email ?? null;
        if (ownerEmail) {
          const cli = await memoryRefClientFor(process.env, ownerEmail).catch(() => null);
          if (cli) {
            const label = item.options.find((o) => o.value === choice)?.label ?? choice ?? "";
            cli.writeReference({
              title: `常务岗裁决 · ${updated.memberId} · ${kind === "reject" ? "驳回" : "批准"}`,
              summary: `${String(item.question).slice(0, 120)} → ${kind === "reject" ? "驳回" : label}${evidence ? `（依据：${String(evidence).slice(0, 120)}）` : ""}`,
              source_ref: `decision:${fleet.id}:${item.id}`,
              slug: memoryRefSlug(`deputy-ruling-${item.id}`),
              tier: "draft",
            }).catch((e) => console.warn(`[fleet-memory] deputy ruling mirror failed (degrade open): ${e?.message || e}`));
          }
        }
      } catch (e) {
        console.warn(`[fleet-memory] deputy ruling mirror failed (degrade open): ${e?.message || e}`);
      }
      res.json({ ok: true, decision: updated });
    } catch (err) {
      console.error("[fleets] deputy resolve error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Deputy 上报：判不了的条目转路由 owner 并携带分析——强判比不判糟。
  router.post("/deputy/escalate-to-owner", async (req, res) => {
    try {
      const db = getFleetDatabase();
      const personaMembers = [];
      for (const f of db.listFleets()) {
        if (f.state === "archived") continue;
        for (const m of db.listMembers(f.id)) {
          if (isPersonaBackedTargetKind(m.targetKind)) personaMembers.push(m);
        }
      }
      const attribution = resolveAttribution({
        currentPreset: ctx?.currentPreset ?? null,
        runningTasks: cron.listJobs(),
        openTurns: openTurns(),
        personaMembers,
        rosterPresetId,
      });
      const guard = deputyGuard({ db, attribution });
      if (guard.error) return res.status(guard.status).json({ error: guard.error });
      const { fleet } = guard;
      const { itemId, analysis } = req.body ?? {};
      const item = db.getDecision(itemId);
      if (!item || item.fleetId !== fleet.id) return res.status(404).json({ error: "Decision not found" });
      if (item.state !== "open" || item.route !== "deputy") {
        return res.status(409).json({ error: "only open deputy-routed items can be escalated to the owner" });
      }
      const detail = {
        ...(item.detail ?? {}),
        deputyAnalysis: {
          at: Date.now(),
          analysis: typeof analysis === "string" ? analysis.slice(0, 2000) : null,
        },
      };
      const updated = db.transitionDecision(itemId, "open", { detail });
      if (!updated) return res.status(409).json({ error: "concurrent change — reload and retry" });
      const routed = db.setDecisionRoute(itemId, "owner");
      res.json({ ok: true, decision: routed ?? updated });
    } catch (err) {
      console.error("[fleets] deputy escalate-to-owner error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 存量 triage (design D5 / 角标口径迁移)：发布委托功能时对既有 open 项做
  // 一次性重路由——按当次策略给每项算 route，并把同岗位同主题的重复项归并
  // 到最早一条。幂等：第二次调用不再产生变化（已归并的项 escalations>0 且
  // 状态不变，已路由的项 route 相同）。
  //
  // 返回 {scanned, rerouted, merged}。
  router.post("/:id/decisions/triage", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const fleet = owned.fleet;
      const policy = db.getFleetDelegationPolicy(fleet.id);
      const open = db.listDecisions({ fleetId: fleet.id, state: "open" });
      let rerouted = 0;
      let merged = 0;
      const seen = new Map(); // `${memberId}::${topic}` -> 最早条目
      // 按提交时间升序：最早的条目是归并的落点。
      for (const item of [...open].sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0))) {
        const route = routeForItem(
          { category: item.category, itemType: item.itemType, severity: item.severity },
          policy,
        );
        if (route !== item.route) {
          db.setDecisionRoute(item.id, route);
          rerouted += 1;
        }
        // 归并键：优先提交方声明的 topicKey，否则问题归一化文本。
        const key = `${item.memberId}::${item.topicKey ?? normalizeQuestion(item.question) ?? item.id}`;
        const first = seen.get(key);
        if (!first) {
          seen.set(key, item.id);
          continue;
        }
        const mergedItem = db.mergeDecisionEscalation(first, { now: Date.now() });
        if (mergedItem) {
          db.transitionDecision(item.id, "open", {
            state: "expired",
            resolution: { kind: "dedup", note: `merged into ${first}`, by: null, at: Date.now() },
          });
          merged += 1;
        }
      }
      res.json({ scanned: open.length, rerouted, merged, policy });
    } catch (err) {
      console.error("[fleets] decision triage error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 主人收回委托：route=deputy 的 open 条目转回 owner（design：主人可随时
  // 收回；deputy 队列随之移除）。
  // 就绪检查（2026-11-10）：七个开关分散在三处，配错的表现是「代理很安静」——
  // 和「没配好」一模一样。这个端点把「安静」拆成一句可读结论 + 每条修法。
  // 只读，不改任何状态。
  router.get("/personal-agent/readiness", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      const fleetId = req.query.fleetId ? String(req.query.fleetId) : null;
      const mandate = fleetId ? db.getFleetMandatePolicy(fleetId) : db.getCellMandatePolicy();

      const fleets = fleetId ? [{ id: fleetId }] : db.listFleets().filter((f) => f.state !== "archived");
      const hasAuditor = fleets.some((f) =>
        (db.listMembers?.(f.id) ?? []).some((m) => m.targetKind === "auditor"),
      );

      const consistency = {};
      for (const d of Object.keys(mandate?.domains ?? {})) {
        consistency[d] = fleetId ? db.decisionConsistency({ fleetId, domain: d }) : db.decisionConsistency({ domain: d });
      }
      const precedents = fleets.reduce(
        (n, f) => n + (db.listCitablePrecedents?.({ fleetId: f.id, limit: 500 }) ?? []).length,
        0,
      );

      const result = assessPersonalAgent({
        mandate,
        domainMap: db.getPersonalDomainMap(),
        hasAuditor,
        verdictTokenConfigured: Boolean(String(process.env.MANDATE_VERDICT_TOKEN ?? "").trim()),
        citablePrecedents: precedents,
        levelSamples: db.outboundLevelSamples(),
        consistency,
      });
      res.json(result);
    } catch (err) {
      console.error("[fleets] personal agent readiness error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 判例候选 (widen-deputy-to-personal-domains 4.x)。候选**永不直接生效**：
  // 提议只落候选，只有主人能批准。被拒的候选连同理由保留下来，审计官上下文
  // 会读到它——否则同一条候选会被反复提上来，白烧人一次审阅。
  router.get("/:id/precedent-candidates", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const status = typeof req.query.status === "string" ? req.query.status : null;
      res.json({
        candidates: db.listPrecedentCandidates({ fleetId: owned.fleet.id, status }),
        approved: db.listApprovedPrecedentRules({ fleetId: owned.fleet.id }),
        rejections: db.listPrecedentRejections({ fleetId: owned.fleet.id }),
      });
    } catch (err) {
      console.error("[fleets] precedent candidates read error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/:id/precedent-candidates", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const checked = validateRule(req.body?.ruleText);
      if (!checked.ok) return res.status(400).json({ error: checked.error });
      const domain = typeof req.body?.domain === "string" ? req.body.domain : null;
      const result = db.proposePrecedentCandidate({
        fleetId: owned.fleet.id,
        domain,
        ruleText: checked.rule,
        sourceDecisionId: typeof req.body?.sourceDecisionId === "string" ? req.body.sourceDecisionId : null,
      });
      if (!result.ok) {
        // 重复不是错误——把既有那条（含拒绝理由）交回去，代理才知道别再提。
        return res.status(result.code === "duplicate" ? 200 : 400).json({
          ok: false,
          code: result.code ?? "invalid",
          existing: result.existing ?? null,
          error: result.error ?? "this rule was already proposed",
        });
      }
      res.json({ ok: true, candidate: result.candidate });
    } catch (err) {
      console.error("[fleets] precedent propose error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/:id/precedent-candidates/:candidateId/:op", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { candidateId, op } = req.params;
      if (op !== "approve" && op !== "reject") {
        return res.status(400).json({ error: "op must be approve or reject" });
      }
      const db = getFleetDatabase();
      const existing = db.getPrecedentCandidate(candidateId);
      if (!existing || existing.fleetId !== owned.fleet.id) {
        return res.status(404).json({ error: "candidate not found" });
      }
      const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : null;
      if (op === "reject" && !reason) {
        return res.status(400).json({ error: "a rejection must carry its reason" });
      }
      const result = db.decidePrecedentCandidate(candidateId, {
        approve: op === "approve",
        by: owned.user?.email ?? "owner",
        reason,
      });
      if (!result.ok) return res.status(409).json({ error: result.error });
      res.json({ ok: true, candidate: result.candidate });
    } catch (err) {
      console.error("[fleets] precedent decide error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 审计官结论 (widen-deputy-to-personal-domains 3.4)。三态里只有 block 改变
  // 终局：条目不执行、转路由主人并保持 open。dissent 是「有异议但放行」——
  // 动作照原模式走，异议留痕。agree 什么都不改。
  //
  // 归属校验与 deputy 同款：调用方必须是被归因为本舰队审计官的那个岗位。
  router.post("/:id/decisions/:itemId/auditor", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const { itemId } = req.params;
      const verdict = req.body?.verdict;
      if (!isVerdict(verdict)) {
        return res.status(400).json({ error: `verdict must be one of ${Object.values(AUDITOR_VERDICTS).join("|")}` });
      }
      const item = db.getDecision(itemId);
      if (!item || item.fleetId !== owned.fleet.id) return res.status(404).json({ error: "Decision not found" });
      if (item.state !== "open") return res.status(409).json({ error: `already ${item.state}` });
      const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 2000) : null;
      if (verdict === AUDITOR_VERDICTS.DISSENT && !note) {
        return res.status(400).json({ error: "a dissent must carry its reason" });
      }

      const patch = { auditorVerdict: verdict, auditorNote: note };
      if (verdict === AUDITOR_VERDICTS.BLOCK) {
        // 阻断即改变终局：回主人队列，保持 open。
        patch.route = "owner";
      }
      const updated = db.transitionDecision(itemId, "open", patch);
      if (!updated) return res.status(409).json({ error: "first resolution wins" });
      res.json({ ok: true, item: updated });
    } catch (err) {
      console.error("[fleets] auditor verdict error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/:id/decisions/:itemId/recall", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const item = db.getDecision(req.params.itemId);
      if (!item || item.fleetId !== owned.fleet.id) return res.status(404).json({ error: "Decision not found" });
      if (item.state !== "open" || item.route !== "deputy") {
        return res.status(409).json({ error: "only open deputy-routed items can be recalled" });
      }
      const updated = db.setDecisionRoute(item.id, "owner");
      res.json({ decision: updated });
    } catch (err) {
      console.error("[fleets] decision recall error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 委托策略设置面 (design：cell 默认 + 舰队覆写)。读 = 生效合并结果（+
  // cell 默认与覆写原文）；写 = 各自一路。高风险类别（config-change/hr/spend）
  // 的委托路由 SHALL 被归一化硬闸覆盖——写进来也会被归一成 owner。
  router.get("/delegation-policy", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      const cellDefault = db.getCellSetting("delegationPolicy");
      const fleetId = req.query.fleetId ? String(req.query.fleetId) : null;
      const override = fleetId ? db.getFleetDelegationPolicyRaw(fleetId) : null;
      const effective = fleetId ? db.getFleetDelegationPolicy(fleetId) : normalizeDelegationPolicy(cellDefault, null);
      // Mandate view of the same blob (add-personal-mandate 2.4): the legacy
      // fields above are unchanged; `mandate` adds the per-domain dimensions.
      // Unconfigured domains resolve to `advise` with zero quota.
      const mandate = fleetId ? db.getFleetMandatePolicy(fleetId) : db.getCellMandatePolicy();
      // 放量所需的证据面（6.2）：每域的一致率与样本量。没有这个数字，主人
      // 只能凭感觉决定要不要升到「先做后报」。
      const consistencyByDomain = {};
      for (const d of Object.keys(mandate.domains ?? {})) {
        consistencyByDomain[d] = fleetId
          ? db.decisionConsistency({ fleetId, domain: d })
          : db.decisionConsistency({ domain: d });
      }
      res.json({
        cellDefault: cellDefault ?? null,
        override,
        effective,
        mandate,
        domainMap: db.getPersonalDomainMap(),
        consistency: consistencyByDomain,
        // 层级样本（5.1/6.4）：放量按层级判，界面必须能说清「缺哪一层」。
        levelSamples: db.outboundLevelSamples(),
      });
    } catch (err) {
      console.error("[fleets] delegation policy read error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.put("/delegation-policy", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      const body = req.body ?? {};
      // 归一化即硬闸：routes 里的 config-change/hr/spend 会被强制归一为 owner
      // （normalizeRoutes），无需在此逐项拒绝。
      const scope = body.scope === "fleet" && body.fleetId ? "fleet" : "cell";
      if (body.domainMap !== undefined) {
        // 事项接入开关（widen-deputy-to-personal-domains 6.1）。未知名/未知域由
        // 归一化整条拒绝——半截配置看起来像「开了但没生效」。
        const written = db.setPersonalDomainMap(body.domainMap);
        if (written === null) {
          return res.status(400).json({ error: "invalid domain map: unknown source or domain" });
        }
        return res.json({ ok: true, scope, domainMap: written });
      }
      if (body.mandate !== undefined) {
        // Mandate write path (add-personal-mandate): the value is the RAW
        // declaration. Unknown domain names are rejected here rather than
        // stored-and-ignored, and a null is a 400 rather than a silent reset.
        if (body.mandate === null) return res.status(400).json({ error: "mandate must be an object (omit it to leave unchanged)" });
        const written = scope === "cell"
          ? db.setCellMandatePolicy(body.mandate)
          : db.setFleetMandatePolicy(body.fleetId, body.mandate);
        if (written === null) {
          return res.status(400).json({ error: "invalid mandate: unknown domain or malformed policy" });
        }
        if (scope === "fleet") applyDeputyModel(db, body.fleetId, db.getFleetDelegationPolicy(body.fleetId));
        const effectiveMandate = scope === "cell" ? db.getCellMandatePolicy() : db.getFleetMandatePolicy(body.fleetId);
        return res.json({ ok: true, scope, mandate: effectiveMandate });
      }
      if (scope === "cell") {
        db.setCellSetting("delegationPolicy", body.policy ?? null);
      } else {
        db.setFleetDelegationPolicy(body.fleetId, body.policy ?? null);
        // 裁决所用模型是声明，真正的生效点是常务岗岗位的 model——
        // 策略写入即同步（写空 = 回到继承链）。
        applyDeputyModel(db, body.fleetId, db.getFleetDelegationPolicy(body.fleetId));
      }
      const effective = body.fleetId
        ? db.getFleetDelegationPolicy(body.fleetId)
        : normalizeDelegationPolicy(scope === "cell" ? db.getCellSetting("delegationPolicy") : null, null);
      res.json({ ok: true, scope, effective });
    } catch (err) {
      console.error("[fleets] delegation policy write error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Knowledge profile (add-member-knowledge-profile)：与 delegation-policy
  // 同款两层读写面。归一化即硬闸（normalizeKnowledgeProfile），集合引用经
  // resolveCollection 指名校验（不可见集合写不进去）。写入即失效 per-member
  // patch 缓存——文档集增删对成员下一回合即时生效，无需重铸部署。
  // Collection visibility: the SAME library DB the library MCP child serves,
  // imported directly — a collection exists here = visible to this owner.
  const dbCollectionVisible = (id) => {
    try {
      return Boolean(dbModule.getCollection?.(id));
    } catch {
      return false;
    }
  };
  const invalidateMemberPatchCache = () => ctx?.invalidateMemberPatchCache?.();
  router.get("/knowledge-profile", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      const cellDefault = db.getCellKnowledgeProfile();
      const fleetId = req.query.fleetId ? String(req.query.fleetId) : null;
      const override = fleetId ? db.getFleetKnowledgeProfileRaw(fleetId) : null;
      const cEff = normalizeKnowledgeProfile(cellDefault ?? null);
      const oEff = normalizeKnowledgeProfile(override ?? null);
      const effective = fleetId
        ? effectiveProfile(cEff.ok ? cEff.profile : null, oEff.ok ? oEff.profile : null)
        : cEff.ok
          ? cEff.profile
          : null;
      res.json({ cellDefault: cellDefault ?? null, override, effective: effective && effective.ok ? effective.profile : null });
    } catch (err) {
      console.error("[fleets] knowledge profile read error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.put("/knowledge-profile", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      const body = req.body ?? {};
      const scope = body.scope === "fleet" && body.fleetId ? "fleet" : "cell";
      const verdict = normalizeKnowledgeProfile(body.profile ?? null, {
        resolveCollection: (id) => (dbCollectionVisible(id) ? true : "collection not visible in this deployment"),
      });
      if (!verdict.ok) return res.status(400).json({ error: "invalid_profile", errors: verdict.errors });
      if (scope === "cell") {
        db.setCellKnowledgeProfile(body.profile ?? null);
      } else {
        db.setFleetKnowledgeProfile(body.fleetId, body.profile ?? null);
      }
      // 即时生效的另一半：per-member patch 缓存失效，下一回合重 compose。
      invalidateMemberPatchCache?.();
      const cEff2 = normalizeKnowledgeProfile(db.getCellKnowledgeProfile() ?? null);
      const oEff2 = normalizeKnowledgeProfile(db.getFleetKnowledgeProfileRaw(body.fleetId ?? "") ?? null);
      const effective2 = body.fleetId
        ? effectiveProfile(cEff2.ok ? cEff2.profile : null, oEff2.ok ? oEff2.profile : null)
        : cEff2.ok
          ? cEff2.profile
          : null;
      res.json({ ok: true, scope, effective: effective2 && effective2.ok ? effective2.profile : null });
    } catch (err) {
      console.error("[fleets] knowledge profile write error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // 常务岗设立：两种形态——指定既有 persona 岗位，或（不传 memberId 而传
  // targetId）新建一个专属常务岗。两种都设策略 deputyMemberId + 挂巡逻节奏
  // 与职责提示。已存在 cadence 的岗位 SHALL NOT 被静默改写（显式传 cadence
  // 才覆盖）。
  router.post("/:id/deputy", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      // 新建路径：没有 memberId 但有 targetId（一个 persona 预设 id）。
      if (!req.body?.memberId && typeof req.body?.targetId === "string" && req.body.targetId) {
        if (owned.fleet.state === "archived") {
          return res.status(409).json({ error: "This fleet is archived — no new posts" });
        }
        const targetId = req.body.targetId;
        if (!targetResolver({ targetKind: "persona", targetId }).alive) {
          return res.status(400).json({ error: invalidTargetMessage("persona", targetId) });
        }
        if (db.findPostByTarget("persona", targetId)) {
          return res.status(409).json({ error: "that persona already holds a post — designate it with memberId instead" });
        }
        // 注意：本路由下方声明了 const memberId（请求体字段），会遮蔽模块级
        // 的 memberId() 造号函数——这里直接内联同一造号模式。
        const created = db.createMember({
          id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          fleetId: owned.fleet.id,
          title: typeof req.body?.title === "string" && req.body.title.trim() ? req.body.title.trim().slice(0, 40) : "常务",
          targetKind: "persona",
          targetId,
          cadence: {
            cron: "0 * * * *",
            tz: req.body?.tz ?? "Asia/Shanghai",
            enabled: true,
            promptTemplate: DEPUTY_PROMPT,
            ...(req.body?.cadence ?? {}),
          },
        });
        const policy = db.getFleetDelegationPolicy(owned.fleet.id);
        db.setFleetDelegationPolicy(owned.fleet.id, { ...policy, enabled: true, deputyMemberId: created.id });
        applyDeputyModel(db, owned.fleet.id, db.getFleetDelegationPolicy(owned.fleet.id));
        const reconcile = await reconcileFleet({
          fleetId: owned.fleet.id,
          db,
          cronApi: cron,
          resolveTarget: targetResolver,
          rosterPresetId,
        });
        return res.status(201).json({
          fleet: db.getFleet(owned.fleet.id),
          member: db.getMember(created.id),
          delegationPolicy: db.getFleetDelegationPolicy(owned.fleet.id),
          reconcile,
        });
      }
      const memberId = req.body?.memberId;
      const member = memberId ? db.getMember(memberId) : null;
      if (!member || member.fleetId !== owned.fleet.id) {
        return res.status(404).json({ error: "Member not found in this fleet" });
      }
      // persona-only: 常务岗必须是 persona；审计官是另一个岗位，不得兼任
      if (member.targetKind !== "persona") {
        return res.status(400).json({ error: "the deputy must be a persona post" });
      }
      const cadence = req.body?.cadence ?? member.cadence ?? null;
      // 提示词三级：显式传值 > 显式 resetPrompt（升到当前版本的 DEPUTY_PROMPT）
      // > 岗位既有值 > 当前版本。resetPrompt 是存量岗位的升级通道——没有它，
      // 服务端改了职责提示词，已建成的常务岗永远拿不到（它的 cadence 是副本），
      // 只能改库；而「重新指定一次」按旧值兜底，形同没刷。
      const promptTemplate =
        typeof req.body?.promptTemplate === "string" && req.body.promptTemplate.trim()
          ? req.body.promptTemplate.trim()
          : req.body?.resetPrompt === true
            ? DEPUTY_PROMPT
            : member.cadence?.promptTemplate ?? DEPUTY_PROMPT;
      if (cadence && typeof cadence.cron === "string" && cadence.cron.trim()) {
        db.updateMember(member.id, { cadence: { ...cadence, promptTemplate } });
      }
      const policy = db.getFleetDelegationPolicy(owned.fleet.id);
      db.setFleetDelegationPolicy(owned.fleet.id, { ...policy, enabled: true, deputyMemberId: member.id });
      applyDeputyModel(db, owned.fleet.id, db.getFleetDelegationPolicy(owned.fleet.id));
      const reconcile = await reconcileFleet({
        fleetId: owned.fleet.id,
        db,
        cronApi: cron,
        resolveTarget: targetResolver,
        rosterPresetId,
      });
      res.json({
        fleet: db.getFleet(owned.fleet.id),
        member: db.getMember(member.id),
        delegationPolicy: db.getFleetDelegationPolicy(owned.fleet.id),
        reconcile,
      });
    } catch (err) {
      console.error("[fleets] designate deputy error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Owner queue: lazy expiry sweep first, then the list. `state=open` (the
  // default) is the to-do view; `all` keeps history (expired stay listed).
  router.get("/:id/decisions", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      db.expireOpenDecisions(owned.fleet.id);
      const state = req.query.state === "all" ? null : "open";
      const members = new Map(db.listMembers(owned.fleet.id).map((m) => [m.id, m]));
      const items = db.listDecisions({ fleetId: owned.fleet.id, state }).map((item) => {
        const member = members.get(item.memberId) ?? null;
        return {
          ...item,
          memberTitle: member?.title ?? null,
          memberDeleted: !member,
          pendingDelivery:
            (item.state === "approved" || item.state === "rejected") &&
            item.deliveredAt == null &&
            !!member,
        };
      });
      res.json({
        decisions: items,
        openCount: db.countOpenDecisions(owned.fleet.id),
        // 委托分视 (add-deputy-decision-delegate)：主人视图与常务岗视图各自
        // 计数——角标口径是 route=owner，deputy 队列另计。
        ownerOpenCount: db.countOwnerOpenDecisions(owned.fleet.id),
        deputyOpenCount: db.countDeputyOpenDecisions(owned.fleet.id),
        decisionPolicy: owned.fleet.decisionPolicy,
        delegationPolicy: db.getFleetDelegationPolicy(owned.fleet.id),
      });
    } catch (err) {
      console.error("[fleets] decisions list error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Cadence read contract (enable-wire-content-fleet D3): the fleet's posts
  // with their cadence and target ref — the facts an external content system
  // needs to refuse a refresh schedule equivalent to a post it cannot see.
  // Rhythm and target ONLY: no KPI slots, reports, decisions or credentials.
  // Passive posts answer cron/tz null (the caller reads that as "not in the
  // equivalence comparison").
  router.get("/:id/cadence", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const posts = db.listMembers(owned.fleet.id).map((m) => ({
        ref: m.id,
        title: m.title,
        cron: m.cadence?.cron ?? null,
        tz: m.cadence?.tz ?? null,
        targetRef: { kind: m.targetKind, id: m.targetId },
      }));
      res.json({ fleetId: owned.fleet.id, fleetName: owned.fleet.name, posts });
    } catch (err) {
      console.error("[fleets] cadence read error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // approve | reject | amend | reopen | execute-now — one handler, the state
  // machine's gatekeeping all in one place. Optimistic transitions make a
  // concurrent second resolution read as a conflict (first resolution wins).
  router.post("/:id/decisions/:itemId/:op", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const { fleet } = owned;
      const { itemId, op } = req.params;
      const now = Date.now();
      db.expireOpenDecisions(fleet.id, { now });

      const item = db.getDecision(itemId);
      if (!item || item.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Decision not found" });
      }
      const member = db.getMember(item.memberId) ?? null;

      if (op === "reopen") {
        if (item.state !== "expired") {
          return res.status(409).json({ error: `only expired items can be reopened (state: ${item.state})` });
        }
        const reopened = db.transitionDecision(itemId, "expired", { state: "open", resolution: null, submittedAt: now });
        if (!reopened) return res.status(409).json({ error: "concurrent change — reload and retry" });
        return res.json({ decision: reopened });
      }

      if (op === "execute-now") {
        if (item.state !== "approved") {
          return res.status(409).json({ error: `only approved items can execute now (state: ${item.state})` });
        }
        // Delivery vehicle: the post's materialized task if it has a cadence
        // (prompt override carries the decision segment), else a manual task
        // for persona/a2a posts. A passive CLUSTER post has neither lane —
        // honest refusal; delivery rides its next delegated turn instead.
        const task = taskIndexFor(fleet.id).get(item.memberId) ?? null;
        const deliverable = db.listDecisions({ fleetId: fleet.id, pendingDeliveryFor: item.memberId });
        // 拍板送达即落记忆名份（add-unified-memory-and-outputs 4.2）：交付物是
        // 「做过什么」的最强信号，进 owner 记忆的 reference 页（草稿层，fire-and-forget）。
        {
          const ownerEmail = fleet.ownerEmail ?? fleet.owner_email ?? null;
          const seg = renderDecisionSegment(deliverable);
          if (ownerEmail && seg) {
            const cli = await memoryRefClientFor(process.env, ownerEmail).catch(() => null);
            if (cli) {
              const refId = `deliv-${fleet.id}-${item.memberId}-${item.id}`;
              cli.writeReference({
                title: `拍板送达 · ${member?.title ?? item.memberTitle ?? item.memberId}`,
                summary: String(seg).replace(/\s+/g, " ").slice(0, 200),
                source_ref: `deliverable:${fleet.id}:${item.memberId}:${item.id}`,
                slug: memoryRefSlug(refId),
                tier: "draft",
              }).catch((e) => console.warn(`[fleet-memory] deliverable mirror failed (degrade open): ${e?.message || e}`));
            }
          }
        }
        if (task) {
          // Decision delivery must not cost the turn its context
          // (fix-decision-delivery-context). The old splice REPLACED
          // {{fleetContext}} with the decision digest, so the engine's own
          // injection saw no placeholder and skipped rendering entirely — the
          // highest-stakes turn of all (the owner forcing a ruling) ran with
          // less context than an ordinary round.
          //
          // When a renderer is mounted, KEEP the placeholder: the seam expands
          // it, and buildFleetContext's own decisionDigest provider already
          // renders this post's undelivered rulings — so appending the digest
          // here as well would print it twice. Without a renderer there is
          // nothing to expand, so the digest must ride the appended prompt or
          // the turn would run without the ruling at all.
          const keepsPlaceholder = cron.keepFleetContextPlaceholder?.(task.prompt) === true;
          const base = keepsPlaceholder
            ? `${task.prompt}\n\n主人已在拍板队列作出裁定，请在本回合执行/知悉（裁定原文见上文注入段）。`
            : `${task.prompt ?? ""}\n\n${buildExecuteNowPrompt(deliverable)}`;
          engine.setPromptOverride(task.id, base);
          const r = await cron.runJobNow(task.id);
          if (r?.ok === true || r?.already === true) {
            return res.json({
              executing: true,
              alreadyRunning: r?.already === true,
              taskId: task.id,
              note: r?.already === true ? "a turn is already in flight — delivery rides it" : null,
            });
          }
          return res.status(409).json({ error: r?.error ?? "could not start the turn" });
        }
        // persona-only: 拍板送达的手动回合；审计官落到下面那条 409（无手动车道），响的失败
        if (member && member.targetKind === "persona") {
          const manual = engine.createManualTask({
            // add-fleet-edge-context's rule, applied to the delivery lane: a
            // persona turn that carries a fleet tag gets the fleet view. The
            // placeholder is only expanded when a renderer is mounted, and the
            // instruction leads either way.
            prompt: `${buildExecuteNowPrompt(deliverable)}\n\n{{fleetContext}}`,
            persona: rosterPresetId(member.targetId),
            sessionTitle: `拍板送达 · ${member.title}`,
            origin: { fleet: { fleetId: fleet.id, memberId: member.id } },
            humanPriority: true, // the owner's execute-now IS the human wake (worker pool's extra slot)
          });
          return res.json({ executing: true, taskId: manual.id, manual: true });
        }
        if (member && member.targetKind === "a2a") {
          const manual = engine.createManualTask({
            prompt: buildExecuteNowPrompt(deliverable),
            agent: member.targetId,
            sessionTitle: `拍板送达 · ${member.title}`,
            origin: { fleet: { fleetId: fleet.id, memberId: member.id } },
            humanPriority: true, // the owner's execute-now IS the human wake (worker pool's extra slot)
          });
          return res.json({ executing: true, taskId: manual.id, manual: true });
        }
        if (member && member.targetKind === "tool") {
          // Tool posts: the delivery must BE the arguments — a JSON body, not
          // prose. Decision text is prose by nature, so require an explicit
          // args object on the op.
          const args = req.body?.args;
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            return res.status(400).json({ error: "a tool post's execute-now needs `args` — the tool's JSON arguments (decision prose is not executable)" });
          }
          const manual = engine.createManualTask({
            prompt: JSON.stringify(args),
            tool: member.targetId,
            sessionTitle: `拍板送达 · ${member.title}`,
            origin: { fleet: { fleetId: fleet.id, memberId: member.id } },
            humanPriority: true, // the owner's execute-now IS the human wake (worker pool's extra slot)
          });
          return res.json({ executing: true, taskId: manual.id, manual: true });
        }
        return res.status(409).json({
          error: "this post has no cadence task and no manual lane (passive cluster post) — delivery will ride its next delegated turn",
        });
      }

      if (!["approve", "reject", "amend"].includes(op)) {
        return res.status(400).json({ error: `unknown decision op '${op}'` });
      }
      if (item.state === "expired") {
        return res.status(409).json({ error: "this item expired — reopen it before deciding" });
      }
      if (item.state !== "open") {
        return res.status(409).json({ error: `already ${item.state === "delivered" ? "delivered" : `resolved (${item.state})`}` });
      }
      const resolution = validateResolution(op, req.body ?? {}, item);
      if (!resolution.ok) return res.status(400).json({ error: resolution.error });
      resolution.resolution.by = owned.user.email;
      resolution.resolution.at = now;

      // 判例等级：按产生路径判定。`sourceKind`/`amended` 由调用方声明，
      // 但等级由本函数算——不采信任何「我这是主人原话」的自报；两者缺失
      // 一律落 deputy-ruled（保守方向与迁移回填一致）。
      // 已知局限（option A）：只记录「参数改没改」，分辨不出 typo 修正与重写，
      // 所以改过的稿一律按不可引用处理。
      const precedentGrade = classifyProvenance({
        resolvedBy: "owner",
        sourceKind: req.body?.sourceKind === "agent-draft" ? "agent-draft" : req.body?.sourceKind === "owner-direct" ? "owner-direct" : null,
        amended: req.body?.amended === true ? true : req.body?.amended === false ? false : undefined,
      });
      const updated = db.transitionDecision(itemId, "open", {
        state: op === "reject" ? "rejected" : "approved",
        resolution: resolution.resolution,
        resolvedAt: now,
        resolvedBy: "owner",
        precedentGrade,
      });
      if (!updated) {
        return res.status(409).json({ error: "first resolution wins — another decision just landed" });
      }
      // 迭代回路回调 (fleet-owner-iteration): approved 的 config-change 拍板项
      // 触发铸版链——结论先行落审计, 链在后台写轴迭代行, 链路失败不翻盘。
      // 结果随响应附在 iteration 键下 (additive, 既有响应语义逐字节)。
      // Carrier-change approval callback (add-agent-self-iteration): member-
      // level placement via the SAME updateMember face a human PATCH uses —
      // resolution/fail-open semantics unchanged. No cast chain (the config-
      // change lane's template chain is for pack structure).
      if (op === "approve" && (updated.itemType === "carrier-change" || item?.itemType === "carrier-change")) {
        try {
          const changes = updated.detail?.changes ?? item?.detail?.changes ?? null;
          const memberId = changes?.memberId;
          const carrier = changes?.carrier;
          if (memberId && (carrier === null || CARRIERS.includes(carrier))) {
            const member = db.getMember(memberId);
            if (member && member.fleetId === owned.fleet.id) {
              db.updateMember(memberId, { carrier: carrier ?? null });
              try {
                ctx?.captureFleetFact?.(owned.fleet.id, memberId, "decision-resolved", updated.question, `承载提议已批准：carrier=${carrier ?? "auto"}（裁决者 ${owned.user.email}）`);
              } catch { /* capture never surfaces */ }
            }
          }
        } catch (e) {
          console.warn(`[fleets] carrier-change approval failed (decision kept): ${e?.message || e}`);
        }
      }
      let iteration = null;
      if (op === "approve" && (updated.itemType === "config-change" || item?.itemType === "config-change")) {
        try {
          const fleet = owned.fleet;
          const it = (db.listIterations(fleet.id) ?? []).find((x) => x.decisionId === updated.id) ?? null;
          if (it) {
            iteration = await runIterationCast({
              db,
              iteration: it,
              ownerEmail: owned.user.email,
              installFn: defaultInstallFn(),
              publishFn: defaultPublishFn(req),
              validateFn: defaultValidateFn(req),
              log: console,
            });
          }
        } catch (e) {
          console.warn(`[fleets] iteration cast callback failed (decision kept): ${e?.message || e}`);
        }
      }
      // Fleet working memory (add-zhiyu-team-memory): the ruling is a team
      // fact — the digest lets every member see what the owner decided.
      try {
        ctx?.captureFleetFact?.(owned.fleet.id, updated.memberId, "decision-resolved", updated.question, `${op === "reject" ? "驳回" : "批准"}：${String(resolution.resolution?.detail ?? resolution.resolution?.choice ?? "").slice(0, 200)}（裁决者 ${owned.user.email}）`);
      } catch { /* capture never surfaces */ }
      res.json(iteration ? { decision: updated, iteration } : { decision: updated });
    } catch (err) {
      console.error("[fleets] decision op error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Fleet CRUD ────────────────────────────────────────────────────────────

  router.get("/", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const db = getFleetDatabase();
      // One request, one snapshot of everything the roster read touches:
      // the catalog (merged once — see rosterResolver), the cron job list, and
      // the model roster. Previously each of the 60 members re-merged the
      // catalog and re-listed every cron job, so one roster read blocked the
      // cell's event loop for ~2.8s — long enough to delay the chat WebSocket
      // handshake that carries the transcript.
      const resolveMember = rosterResolver();
      const jobs = cron.listJobs();
      const model = modelCtx();
      const fleets = db
        .listFleets({ ownerEmail: user.email })
        .map((fleet) => {
          const members = db.listMembers(fleet.id);
          const tasks = taskIndexFor(fleet.id, jobs);
          const counts = {};
          for (const m of members) {
            const view = memberView(db, fleet, m, tasks, { resolver: resolveMember, model });
            counts[view.status] = (counts[view.status] ?? 0) + 1;
          }
          return {
            id: fleet.id,
            name: fleet.name,
            state: fleet.state,
            memberCount: members.length,
            statusCounts: counts,
            // Row-level quick-edit fields (agent-teams-management D4): the
            // three inline-editable fields ride the list so the management
            // view never needs a per-row detail round-trip. Absent = null.
            defaultModel: fleet.defaultModel ?? null,
            effort: fleet.effort ?? null,
            contextBudget: fleet.contextBudget ?? null,
            // Spend projection mirrors owner/board (same source of truth).
            spend: db.spendProjection(fleet.id),
            // The pending-decision count the nav badge reads (add-fleet-decision-lane
            // 刀3): the badge is derived from this list, so the number has to
            // ride here — a badge computed from a field the list never carried
            // is a badge that can never appear.
            // 角标口径 (add-deputy-decision-delegate)：「等你 N 件」只计
            // route=owner——委托给常务岗的不再算主人头上。
            openDecisions: db.countOwnerOpenDecisions(fleet.id),
            deputyOpen: db.countDeputyOpenDecisions(fleet.id),
            createdAt: fleet.createdAt,
            updatedAt: fleet.updatedAt,
          };
        });
      res.json({ fleets });
    } catch (err) {
      console.error("[fleets] list error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── 批量动作（agent-teams-management D3）：逐条执行既有单团队语义、逐条回执 ──
  // pause/resume/archive share the PATCH /:id state semantics verbatim
  // (FLEET_STATES gate, archived-is-terminal 409 → per-item error). Any single
  // failure MUST NOT stop the rest; a shape-valid request answers 200 with
  // per-item results — partial failure is a business result, not a request
  // error. Foreign/unknown ids answer "not found" (probing teaches nothing).
  const FLEET_BATCH_MAX = Number(process.env.FLEET_BATCH_MAX || 50);
  const FLEET_BATCH_ACTIONS = { pause: "paused", resume: "active", archive: "archived" };

  router.post("/batch", async (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const action = req.body?.action;
      const ids = req.body?.ids;
      if (!FLEET_BATCH_ACTIONS[action]) {
        return res.status(400).json({ error: `action must be one of ${Object.keys(FLEET_BATCH_ACTIONS).join(", ")}` });
      }
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.trim())) {
        return res.status(400).json({ error: "ids must be a non-empty array of fleet ids" });
      }
      // Dedupe preserving order — a repeated id executes once.
      const unique = [...new Set(ids)];
      if (unique.length > FLEET_BATCH_MAX) {
        return res.status(400).json({
          error: `batch limited to ${FLEET_BATCH_MAX} fleets per call (got ${unique.length})`,
          code: "batch_limit_exceeded",
        });
      }
      const db = getFleetDatabase();
      const targetState = FLEET_BATCH_ACTIONS[action];
      const results = [];
      for (const id of unique) {
        const fleet = db.getFleet(id);
        if (!fleet || fleet.ownerEmail !== user.email) {
          results.push({ id, ok: false, error: "not found" });
          continue;
        }
        if (fleet.state === "archived") {
          results.push({ id, ok: false, error: "This fleet is archived — archived is terminal" });
          continue;
        }
        try {
          db.updateFleet(fleet.id, { state: targetState }, auditMeta(req, `POST /api/fleets/batch ${action}`));
          await runReconcile(fleet.id);
          results.push({ id, ok: true, state: targetState });
        } catch (err) {
          results.push({ id, ok: false, error: err.message || "internal error" });
        }
      }
      // One recompute after the whole batch: a bulk archive must not recompute
      // per item (N writes) nor leave the intermediate states on disk.
      if (results.some((r) => r.ok) && targetState !== "active") syncFleetPlugins(db);
      const summary = {
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      };
      res.json({ action, results, summary });
    } catch (err) {
      console.error("[fleets] batch error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/", (req, res) => {
    try {
      const user = resolveUser(req);
      if (!user) return res.status(401).json({ error: "Authentication required" });
      const name = req.body?.name;
      if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "Fleet name is required" });
      }
      const fleet = getFleetDatabase().createFleet({
        id: fleetId(),
        name: name.trim().slice(0, 120),
        ownerEmail: user.email,
      });
      res.status(201).json({ fleet });
    } catch (err) {
      console.error("[fleets] create error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });


  // ── Instance → Studio-draft promotion (add-supply-studio-migration 3.4, D7) ──
  // One-way fork of the RUNNING instance's configuration state (installed pack
  // manifest segments verbatim, boundary named from the live fleet) into a
  // facet-hosted Studio draft, via the facet internal channel. 单向闸门（3.5）：
  // 只创建草稿——蓝图 API 没有任何回写 fleet 的路径，Studio 编辑永不触碰运行态。
  // v1 fork 范围如实划定：preset/配置/skills；记忆与会话历史不在 fork 内
  // （响应与确认界面显式列出 excluded）。
  router.post("/:id/promote", async (req, res) => {
    const owned = requireOwnedFleet(req, res);
    if (!owned) return;
    const { fleet, user } = owned;
    const packId = fleet.sourceTemplate?.packId;
    if (!packId) {
      return res.status(409).json({
        error: "this fleet has no pack origin to fork — promotion forks the installed configuration state",
        code: "promote_no_origin",
      });
    }
    let manifest = null;
    let installedVersion = null;
    try {
      const installed = dbModule.getInstalledPack(packId);
      manifest = installed?.manifest ?? null;
      installedVersion = installed?.version ?? null;
    } catch {
      manifest = null;
    }
    if (!manifest) {
      return res.status(409).json({ error: "installed pack manifest unreadable — nothing to fork", code: "promote_no_manifest" });
    }
    const content = {
      kind: "team",
      boundary: { name: `${fleet.name}（晋升稿）`, oneLine: manifest?.description ?? "", outOfScope: "" },
      dataSources: [],
      fleet: manifest?.fleet ?? { name: `${fleet.name}（晋升稿）`, members: [] },
      agents: Array.isArray(manifest?.agents) ? manifest.agents : [],
      mcpServers: Array.isArray(manifest?.mcpServers) ? manifest.mcpServers : [],
      skills: Array.isArray(manifest?.skills) ? manifest.skills : [],
      monitoring: {},
      acceptance: [],
      board: {},
      // Provenance rides the document (spec: provenance 如实记录来源实例与时间).
      _promotion: {
        sourceFleetId: fleet.id,
        sourceFleetName: fleet.name,
        sourcePackId: packId,
        sourcePackVersion: installedVersion,
        promotedBy: user.email,
        promotedAt: new Date().toISOString(),
        forkScope: "preset/config/skills",
        excluded: ["记忆", "会话历史"],
      },
    };
    const base = (process.env.FACET_BASE_URL || "").replace(/\/+$/, "");
    if (!base) {
      return res.status(503).json({ error: "supply-domain channel is not configured (FACET_BASE_URL)", code: "promote_channel_unconfigured" });
    }
    let upstream;
    try {
      upstream = await facetRequest({
        base,
        token: process.env.FACET_INTERNAL_TOKEN || "",
        user: { email: user.email, groups: user.groups ?? [] },
        path: "/api/blueprints",
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ name: content.boundary.name, content }),
      });
    } catch (e) {
      return res.status(502).json({ error: `supply-domain unreachable: ${e?.message || e}`, code: "promote_channel_failed" });
    }
    const body = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return res.status(upstream.status ?? 502).json({
        error: body?.error ?? `promotion failed (HTTP ${upstream.status})`,
        code: "promote_rejected",
        upstream: body ?? undefined,
      });
    }
    res.json({
      promoted: {
        studioDocId: body?.blueprint?.id ?? null,
        forkScope: "preset/config/skills",
        excluded: ["记忆", "会话历史"],
      },
    });
  });

  router.get("/:id", (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const db = getFleetDatabase();
      const members = db.listMembers(owned.fleet.id);
      const tasks = taskIndexFor(owned.fleet.id);
      const resolveMember = rosterResolver();
      const model = modelCtx();
      const views = members.map((m) => memberView(db, owned.fleet, m, tasks, { resolver: resolveMember, model }));
      const statusCounts = {};
      for (const v of views) statusCounts[v.status] = (statusCounts[v.status] ?? 0) + 1;
      db.expireOpenDecisions(owned.fleet.id);
      res.json({
        fleet: owned.fleet,
        members: views,
        statusCounts,
        openDecisions: db.countOpenDecisions(owned.fleet.id),
        decisionPolicy: owned.fleet.decisionPolicy,
        // add-agent-builder-workspace 7.2（D7 回链）：来源蓝图 id 从已装包的
        // 铸造追溯读出——只读投影，非新数据形状；无来源包时缺席。
        blueprintId: sourceBlueprintId(owned.fleet),
        // 生效插件（add-fleet-plugin-declaration 3.1/3.2）：从补丁层实时派生，
        // 不落库（D5）——补丁行改了，下一次读就是新值。`source` 区分「团队声明」
        // 与「部署默认启用」；声明了但不在生效集合里的（例如未供给）不显示。
        plugins: fleetPluginsForView(owned.fleet, ctx),
      });
    } catch (err) {
      console.error("[fleets] detail error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      const { name, state, defaultModel, effort, contextBudget } = req.body ?? {};
      const updates = {};

      if (name !== undefined) {
        if (!name || typeof name !== "string" || !name.trim()) {
          return res.status(400).json({ error: "Fleet name must be a non-empty string" });
        }
        updates.name = name.trim().slice(0, 120);
      }
      if (defaultModel !== undefined) {
        if (defaultModel !== null) {
          const err = fleetModelChoiceError({ model: defaultModel, roster: modelRoster() });
          if (err) return res.status(400).json({ error: `defaultModel: ${err}` });
        }
        updates.defaultModel = defaultModel;
      }
      if (state !== undefined) {
        if (!FLEET_STATES.includes(state)) {
          return res.status(400).json({ error: `state must be one of ${FLEET_STATES.join(", ")}` });
        }
        if (fleet.state === "archived") {
          return res.status(409).json({ error: "This fleet is archived — archived is terminal" });
        }
        updates.state = state;
      }
      if (req.body?.orchestration !== undefined) {
        const orch = req.body.orchestration;
        // Full graph validation against the live member set — edges reference
        // posts, so the section lands after the posts exist (create-time
        // fleets have no members: mode/constraints pass, edges cannot).
        const check = validateOrchestration({ members: getFleetDatabase().listMembers(fleet.id), orchestration: orch });
        if (!check.ok) {
          return res.status(400).json({ error: "orchestration: " + check.errors[0].error, errors: check.errors });
        }
        updates.orchestration = orch;
      }

      // Config dimensions at fleet level (add-agent-config-dims D4): the fleet
      // default an undeclared post inherits. Same shape gate as the post PATCH.
      const dims = validateConfigDims({ effort, contextBudget }, effortUnionFrom(ctx?.dshModels));
      if (dims.error) return res.status(400).json({ error: dims.error });
      if (effort !== undefined) updates.effort = dims.effort;
      if (contextBudget !== undefined) updates.contextBudget = dims.contextBudget;

      const updated = getFleetDatabase().updateFleet(fleet.id, updates, auditMeta(req, `PATCH /api/fleets/${fleet.id}`));
      if (updates.state !== undefined) syncFleetPlugins(getFleetDatabase());
      const reconcile = await runReconcile(fleet.id);
      res.json({ fleet: updated, reconcile });
    } catch (err) {
      console.error("[fleets] patch error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Dissolve: archive + delete the materialized tasks, keep every history row.
  router.delete("/:id", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      for (const job of cron.listJobs()) {
        if (job?.sourceTag?.fleetId === fleet.id) {
          await cron.removeJob(job.id);
        }
      }
      const updated = getFleetDatabase().updateFleet(fleet.id, { state: "archived" }, auditMeta(req, `DELETE /api/fleets/${fleet.id}`));
      // Archive is terminal: the fleet now declares nothing, so a recompute is
      // the whole removal path (no separate delete-the-row code to drift).
      syncFleetPlugins(getFleetDatabase());
      res.json({ fleet: updated, dissolved: true });
    } catch (err) {
      console.error("[fleets] delete error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // ── Members ────────────────────────────────────────────────────────────────

  router.post("/:id/members", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      if (fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived — members can no longer be added" });
      }
      const db = getFleetDatabase();

      const title = req.body?.title;
      if (!title || typeof title !== "string" || !title.trim()) {
        return res.status(400).json({ error: "Member title is required" });
      }
      const targetKind = req.body?.targetKind;
      const targetId = req.body?.targetId;
      if (!targetId || typeof targetId !== "string") {
        return res.status(400).json({ error: "targetId is required" });
      }
      if (!MEMBER_TARGET_KINDS.includes(targetKind)) {
        return res.status(400).json({ error: `targetKind must be one of ${MEMBER_TARGET_KINDS.join(", ")}` });
      }
      if (!targetResolver({ targetKind, targetId }).alive) {
        return res.status(400).json({ error: invalidTargetMessage(targetKind, targetId) });
      }
      // Unique post (design D8): persona/cluster globally hold one post; a2a
      // and tool targets are exempt (external execution / stateless calls
      // carry no attribution ambiguity).
      if (targetKind !== "a2a" && targetKind !== "tool") {
        const existing = db.findPostByTarget(targetKind, targetId);
        if (existing) {
          return res.status(409).json({
            error: `already on duty: post '${existing.member.title}' in fleet '${existing.fleet?.name ?? existing.member.fleetId}'`,
            existing: { fleetId: existing.member.fleetId, memberId: existing.member.id, title: existing.member.title },
          });
        }
      }
      const cad = normalizeCadence(req.body?.cadence, { confirmed: req.body?.confirmed });
      const cadToolErr = toolCadenceError(targetKind, cad.cadence);
      if (cadToolErr) return res.status(400).json({ error: cadToolErr });
      if (!cad.ok) {
        return res.status(cad.code ? 400 : 400).json({ error: cad.error, ...(cad.code ? { code: cad.code } : {}) });
      }
      const kpi = normalizeKpiSlots(req.body?.kpiSlots);
      if (!kpi.ok) return res.status(400).json({ error: kpi.error });

      const modelErr = memberModelWriteError({ targetKind, body: req.body });
      if (modelErr) return res.status(400).json({ error: modelErr });

      // Config dimensions on create (fix-member-config-complete D1): the same
      // four fields PATCH accepts, behind the same gates. A create that reads a
      // field and then drops it is a silent lie — either it lands or it is
      // refused before the row exists.
      const { effort, contextBudget, carrier, packId } = req.body ?? {};
      const dims = validateConfigDims({ effort, contextBudget }, effortUnionFrom(ctx?.dshModels));
      if (dims.error) return res.status(400).json({ error: dims.error });
      if (carrier !== undefined && carrier !== null && !CARRIERS.includes(carrier)) {
        return res.status(400).json({ error: `carrier must be one of ${CARRIERS.join("|")} or null` });
      }
      if (packId !== undefined && packId !== null && (typeof packId !== "string" || !packId.trim() || packId.length > 64)) {
        return res.status(400).json({ error: "packId must be a non-empty string (≤64 chars) or null" });
      }

      // 审计官准入 (widen-deputy-to-personal-domains 3.2)：没有委托状就没有
      // 可审的东西；工具面按白名单在保存时拒绝，而不是调用时过滤——保存时
      // 拒绝是响亮的，调用时过滤是沉默的。
      if (targetKind === "auditor") {
        if (!auditorAllowedFor(db.getFleetMandatePolicy(fleet.id))) {
          return res.status(400).json({ error: "auditor requires a configured mandate — configure one domain first" });
        }
        const face = validateAuditorToolFace(req.body?.toolFace);
        if (!face.ok) return res.status(400).json({ error: face.error, rejected: face.rejected });
      }

      const parentId = req.body?.parentId ?? null;
      if (parentId) {
        const parent = db.getMember(parentId);
        if (!parent || parent.fleetId !== fleet.id) {
          return res.status(400).json({ error: "parentId must reference a member of the same fleet" });
        }
      }

      const member = db.createMember({
        id: memberId(),
        fleetId: fleet.id,
        title: title.trim().slice(0, 120),
        parentId,
        targetKind,
        targetId,
        kpiSlots: kpi.kpiSlots,
        cadence: cad.cadence,
        model: req.body?.model ?? null,
        fallbackModel: req.body?.fallbackModel ?? null,
        effort: dims.effort,
        contextBudget: dims.contextBudget,
        carrier: carrier ?? null,
        packId: packId == null ? null : packId.trim(),
      });
      const reconcile = await runReconcile(fleet.id);
      const tasks = taskIndexFor(fleet.id);
      res.status(201).json({ member: memberView(db, fleet, member, tasks, { resolver: targetResolver, model: modelCtx() }), reconcile });
    } catch (err) {
      console.error("[fleets] member create error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.patch("/:id/members/:mid", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }

      const updates = {};
      const { title, parentId, cadence, kpiSlots, model, fallbackModel, effort, contextBudget, carrier, packId } = req.body ?? {};

      if (title !== undefined) {
        if (!title || typeof title !== "string" || !title.trim()) {
          return res.status(400).json({ error: "Member title must be a non-empty string" });
        }
        updates.title = title.trim().slice(0, 120);
      }
      if (kpiSlots !== undefined) {
        const kpi = normalizeKpiSlots(kpiSlots);
        if (!kpi.ok) return res.status(400).json({ error: kpi.error });
        updates.kpiSlots = kpi.kpiSlots;
      }
      if (parentId !== undefined) {
        if (parentId !== null) {
          if (typeof parentId !== "string") {
            return res.status(400).json({ error: "parentId must be a member id or null" });
          }
          const parent = db.getMember(parentId);
          if (!parent || parent.fleetId !== fleet.id) {
            return res.status(400).json({ error: "parentId must reference a member of the same fleet" });
          }
          if (parentId === member.id || wouldCycle(db, member, parentId)) {
            return res.status(400).json({ error: "parent must not form a cycle in the org tree" });
          }
        }
        updates.parentId = parentId;
      }
      if (cadence !== undefined) {
        if (fleet.state === "archived") {
          return res.status(409).json({ error: "This fleet is archived — cadence edits are closed" });
        }
        const cad = normalizeCadence(cadence, { confirmed: req.body?.confirmed });
        if (!cad.ok) {
          return res.status(400).json({ error: cad.error, ...(cad.code ? { code: cad.code } : {}) });
        }
        const cadToolErr = toolCadenceError(member.targetKind, cad.cadence);
        if (cadToolErr) return res.status(400).json({ error: cadToolErr });
        updates.cadence = cad.cadence;
      }
      if (model !== undefined || fallbackModel !== undefined) {
        const modelErr = memberModelWriteError({ existing: member, targetKind: member.targetKind, body: { model, fallbackModel } });
        if (modelErr) return res.status(400).json({ error: modelErr });
        if (model !== undefined) updates.model = model;
        if (fallbackModel !== undefined) updates.fallbackModel = fallbackModel;
      }

      // Config dimensions (add-agent-config-dims D5): the SAME shape gates as
      // the model — an effort must be a level SOME known model declares (the
      // union, since the effective model may change later), a budget must be a
      // sane positive integer. null/"" clears a declaration.
      const dims = validateConfigDims({ effort, contextBudget }, effortUnionFrom(ctx?.dshModels));
      if (dims.error) return res.status(400).json({ error: dims.error });
      if (effort !== undefined) updates.effort = dims.effort;
      if (contextBudget !== undefined) updates.contextBudget = dims.contextBudget;
      if (carrier !== undefined) {
        if (carrier !== null && !CARRIERS.includes(carrier)) {
          return res.status(400).json({ error: `carrier must be one of ${CARRIERS.join("|")} or null` });
        }
        updates.carrier = carrier ?? null;
      }

      // Runner disambiguation (add-runner-packid-disambiguation): the optional
      // pack binding — cross-pack same-key agent keys resolve through it;
      // null clears the binding (the agent key alone decides).
      if (packId !== undefined) {
        if (packId !== null && (typeof packId !== "string" || !packId.trim() || packId.length > 64)) {
          return res.status(400).json({ error: "packId must be a non-empty string (≤64 chars) or null" });
        }
        updates.packId = packId === null ? null : packId.trim();
      }

      const updated = db.updateMember(member.id, updates);
      const reconcile = await runReconcile(fleet.id);
      const tasks = taskIndexFor(fleet.id);
      res.json({ member: memberView(db, fleet, updated, tasks, { resolver: targetResolver, model: modelCtx() }), reconcile });
    } catch (err) {
      console.error("[fleets] member patch error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  // Restaff (换防, ADR-0031): swap the incumbent targetRef in place — the
  // post identity, tree position, KPI slots, and report history are untouched.
  // Default keeps the dedicated session's conversation; freshSession clears
  // it for a clean handover.
  router.post("/:id/members/:mid/swap", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      if (fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived — restaffing is closed" });
      }
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      const targetKind = req.body?.targetKind;
      const targetId = req.body?.targetId;
      if (!targetId || typeof targetId !== "string") {
        return res.status(400).json({ error: "targetId is required" });
      }
      if (!MEMBER_TARGET_KINDS.includes(targetKind)) {
        return res.status(400).json({ error: `targetKind must be one of ${MEMBER_TARGET_KINDS.join(", ")}` });
      }
      if (!targetResolver({ targetKind, targetId }).alive) {
        return res.status(400).json({ error: invalidTargetMessage(targetKind, targetId) });
      }
      if (targetKind !== "a2a" && targetKind !== "tool") {
        const existing = db.findPostByTarget(targetKind, targetId, { excludeMemberId: member.id });
        if (existing) {
          return res.status(409).json({
            error: `already on duty: post '${existing.member.title}' in fleet '${existing.fleet?.name ?? existing.member.fleetId}'`,
            existing: { fleetId: existing.member.fleetId, memberId: existing.member.id, title: existing.member.title },
          });
        }
      }
      // Post model belongs to persona posts only (add-fleet-post-model F1):
      // restaffing to an a2a/cluster target with a model declared would leave
      // a dead declaration on a post whose model is owned elsewhere — refuse.
      // 审计官与 persona 同权：换防到 auditor 不该要求先清模型（它可以有自己的模型）。
      if (!isPersonaBackedTargetKind(targetKind) && (member.model || member.fallbackModel)) {
        return res.status(400).json({ error: "this post declares a model — clear it before restaffing to a non-persona target" });
      }

      // 清史重开: clear the dedicated session's conversation before the new
      // incumbent takes over. Report history lives elsewhere (刀2) and is
      // never touched. A session with a turn in flight cannot be cleared —
      // the swap is refused rather than half-applied.
      //
      // fix-fleet-round-discipline D6: the dsh-side delete inside
      // deleteSession is best-effort (old runtimes have no session/delete RPC
      // and the failure is swallowed) — acceptable BY CONTRACT now: the
      // guarantee lives in the round rotation (cron-runner D4), which gives
      // this post's next round a fresh child conversation id regardless of
      // whether the child-side delete landed, so the new incumbent can never
      // inherit the old one's child-side state (production 2026-10-25: the
      // swap cleared only the mirror; the child resumed its 2.36MB session).
      // 换防交接锚 (add-fleet-memory-anchors D2): the swap fact lands BEFORE
      // the history wipe — "清史改为交接后清" — so the page can carry the
      // outgoing incarnation's last-turn anchor (身体换了，记忆跟着走). The
      // wipe semantics below are unchanged.
      let outgoingAnchor = "";
      try {
        const last = db.listTurnEvents?.(member.id, { limit: 1 })?.[0] ?? null;
        if (last) {
          outgoingAnchor = ` 离任锚：末次回合 turn_id=${last.turnId ?? "-"} status=${last.status} model=${last.model ?? "-"} carrier=${last.carrier ?? "-"}`;
        }
      } catch { /* anchor is best-effort */ }
      try {
        ctx?.captureFleetFact?.(fleet.id, member.id, "swap", `岗位「${member.title}」换防`, `新在岗者 ${String(targetId).slice(0, 80)}${req.body?.freshSession === true ? "（清史重开——对话史清空，记忆与报数史照旧）" : ""}${outgoingAnchor}`);
      } catch { /* capture never surfaces */ }

      if (req.body?.freshSession === true) {
        const task = taskIndexFor(fleet.id).get(member.id);
        if (task?.sessionId) {
          try {
            await chatHistory.deleteSession(task.sessionId);
          } catch (err) {
            if (err?.code === "active") {
              return res.status(409).json({ error: "The post's session has a turn in flight — retry the swap after it settles" });
            }
            // not_found (or a best-effort dsh hiccup) = nothing to clear.
          }
        }
      }

      const updated = db.updateMember(member.id, { targetKind, targetId });
      const reconcile = await runReconcile(fleet.id);
      const tasks = taskIndexFor(fleet.id);
      const view = memberView(db, fleet, updated, tasks, { resolver: targetResolver, model: modelCtx() });
      res.json({ member: view, reconcile });
    } catch (err) {
      console.error("[fleets] swap error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.delete("/:id/members/:mid", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      if (fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived — its history rows are frozen" });
      }
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      // Children are re-parented to the removed post's parent (the tree edge
      // must never dangle); the reconcile pass then removes the task.
      const children = db.listMembers(fleet.id).filter((m) => m.parentId === member.id);
      for (const child of children) {
        db.updateMember(child.id, { parentId: member.parentId ?? null });
      }
      // Orchestration edges must not dangle either: any edge touching the
      // removed post drops with it (explicit-by-declaration, gone-by-removal).
      if (fleet.orchestration?.edges?.length) {
        const kept = fleet.orchestration.edges.filter(
          (e) => (e.from ?? null) !== member.id && e.to !== member.id,
        );
        if (kept.length !== fleet.orchestration.edges.length) {
          db.updateFleet(fleet.id, { orchestration: { ...fleet.orchestration, edges: kept } }, auditMeta(req, `DELETE /api/fleets/${fleet.id}/members/${req.params.mid}`));
        }
      }
      db.deleteMember(member.id);
      const reconcile = await runReconcile(fleet.id);
      res.json({ removed: member.id, reparented: children.map((c) => c.id), reconcile });
    } catch (err) {
      console.error("[fleets] member delete error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/:id/members/:mid/pause", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      if (fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived — cadence writes are closed" });
      }
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      if (!member.cadence) {
        return res.status(400).json({ error: "A passive post has no cadence to pause" });
      }
      const updated = db.updateMember(member.id, { cadence: { ...member.cadence, enabled: false } });
      const reconcile = await runReconcile(fleet.id);
      res.json({ member: { id: updated.id, cadence: updated.cadence }, reconcile });
    } catch (err) {
      console.error("[fleets] member pause error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  router.post("/:id/members/:mid/resume", async (req, res) => {
    try {
      const owned = requireOwnedFleet(req, res);
      if (!owned) return;
      const { fleet } = owned;
      if (fleet.state === "archived") {
        return res.status(409).json({ error: "This fleet is archived — cadence writes are closed" });
      }
      const db = getFleetDatabase();
      const member = db.getMember(req.params.mid);
      if (!member || member.fleetId !== fleet.id) {
        return res.status(404).json({ error: "Member not found" });
      }
      if (!member.cadence) {
        return res.status(400).json({ error: "A passive post has no cadence to resume" });
      }
      const updated = db.updateMember(member.id, { cadence: { ...member.cadence, enabled: true } });
      const reconcile = await runReconcile(fleet.id);
      res.json({ member: { id: updated.id, cadence: updated.cadence }, reconcile });
    } catch (err) {
      console.error("[fleets] member resume error:", err.message);
      res.status(500).json({ error: err.message || "internal error" });
    }
  });

  app.use("/api/fleets", router);
}

