// Turn result events (agent-fleet-core, add-fleet-turn-events).
//
// Two exports do the work behind the spec's "每次成员回合产出回合结果事件":
//   • classifyErrorKind — a pure ordered-pattern classifier (D4). Table-driven,
//     no IO, first match wins, `other` is the floor — an unrecognized error is
//     still classified, never dropped.
//   • recordTurnEvent — the single attribution + write entry called from the
//     runCronJobTurn seam (D1/D2). Attribution order: the task's sourceTag
//     (cron-materialized) → origin.fleet (decision execute-now manual tasks)
//     → resolveAttribution over the live persona scan (delegation wake / plain
//     manual turns). No attribution → not a fleet turn → silent null, zero
//     disturbance to non-fleet tasks.

import { resolveAttribution } from "./fleet-reports.js";
import { isPersonaBackedTargetKind } from "./routes/fleets-db.js";
import { buildTurnRequest } from "./turn-request.js";
import { resolvePersona } from "../dsh-profile.js";
import { isMissingReport } from "./report-contract.js";
import { pricingFor, estimateTurnCost } from "./turn-pricing.js";

// Ordered: the FIRST matching row wins, so runtime-readiness outranks the
// timeout it probably caused and tool/permission outranks a provider echo of
// the denial. Calibration is open — patterns track real error corpora, the
// table is the single tuning point.
export const ERROR_KINDS = [
  "runtime_not_ready",
  "timeout",
  "tool_permission",
  // Budget exhaustion is its own kind, ahead of the upstream bucket: every
  // candidate model being over its daily/monthly budget used to classify as
  // `model_upstream` (the text contains "model"), which is why 441 fleet turns
  // failed in one day with no owner-visible signal — the read face could not
  // tell "the provider wobbled" from "we are out of budget until tomorrow".
  // The remedy differs completely: wait/top up vs fix a provider.
  "budget",
  "model_upstream",
  "business_refused",
  // A turn that ran fine but exceeded its post's declared context budget
  // (add-agent-config-dims): its own kind, because the remedy is "raise the
  // budget or shorten the work", not "fix a provider or a permission".
  "context_budget",
  "other",
];

const ERROR_KIND_PATTERNS = [
  ["runtime_not_ready", /not ready|still starting|stayed busy|could not switch the agent|runtime.*(busy|idle)|未就绪/i],
  ["timeout", /timeout|timed? ?out|超时/i],
  // Bare `403` was dropped here (production 2026-10-25: the lane's
  // "403 status code (no body)" — a sub2api HTTP echo, no permission word in
  // sight — classified as a tool problem and sent triage down the wrong
  // lane). A transport-level "NNN status code" echo now reads as the model
  // lane; a genuine tool refusal carries permission words with or without
  // the status digit.
  ["tool_permission", /permission|denied|forbidden|not authorized|unauthorized|工具|权限/i],
  // Must precede model_upstream: the budget message names a model, and the
  // upstream rule would otherwise swallow it (the live 2026-11-08 corpus is
  // literally `budget_exhausted: all candidate models over daily/monthly
  // budget (model '…' skipped: budget_exhausted (daily))`).
  ["budget", /budget_exhausted|over (the )?(daily|monthly) budget|额度(已)?(用尽|打满|耗尽)|预算(已)?(用尽|超限)/i],
  ["model_upstream", /no runnable model|model switch|invalid model|\b\d{3}\s*status code|429|quota|rate.?limit|provider|upstream|api.?key|api_error|service temporarily unavailable|5\d{2}\s*:|上游|模型/i],
  ["business_refused", /refused|rejected by policy|业务拒绝|拒绝执行/i],
];

export function classifyErrorKind(text) {
  const s = typeof text === "string" ? text : text == null ? "" : String(text);
  for (const [kind, re] of ERROR_KIND_PATTERNS) {
    if (re.test(s)) return kind;
  }
  return "other";
}

// Source derivation lives in ONE place now (agent-turn-contract): the thin
// alias below keeps existing imports stable while recordTurnEvent reads the
// same derivation via buildTurnRequest — one rule, two doors.
export function turnSourceFor(job) {
  return buildTurnRequest(job).source;
}

// The persona → post attribution for manual/delegation turns. Same scan and
// ghost-post guard as fleetIdentityFor (archived fleets release their posts)
// — this returns the ids, not the rendered identity line.
function attributedPostFor(db, presetId, rosterPresetId) {
  if (!presetId) return null;
  const personaMembers = [];
  for (const f of db.listFleets()) {
    if (f.state === "archived") continue;
    for (const m of db.listMembers(f.id)) {
      if (isPersonaBackedTargetKind(m.targetKind)) personaMembers.push(m);
    }
  }
  const attribution = resolveAttribution({ currentPreset: presetId, personaMembers, rosterPresetId });
  if (attribution.kind !== "preset") return null;
  return { fleetId: attribution.fleetId, memberId: attribution.memberId };
}

// Which post does this turnRequest execute? sourceTag (cron-materialized) →
// origin.fleet (execute-now / dispatch / handoff / event wake) → persona scan
// (plain delegation wake). Null = not a fleet turn. Shared by the outcome
// recorder below and the run ledger's begin() (agent-fleet-runs), so the two
// doors read ONE attribution rule.
export function resolveTurnPost(db, request, rosterPresetId = (id) => id) {
  if (request?.evidence?.sourceTag?.fleetId) {
    return { fleetId: request.evidence.sourceTag.fleetId, memberId: request.evidence.sourceTag.memberId ?? null };
  }
  if (request?.evidence?.origin?.fleet?.fleetId) {
    return { fleetId: request.evidence.origin.fleet.fleetId, memberId: request.evidence.origin.fleet.memberId ?? null };
  }
  const post = attributedPostFor(db, request?.targetRef?.id, rosterPresetId);
  if (!post?.fleetId || !post?.memberId) return null;
  return post;
}

// Token usage as the runtime reports it, in the shapes seen across providers
// (dsh TokenUsage input/output, OpenAI prompt/completion, snake_case). Null
// when nothing was reported — never a guessed zero (spec: 用量缺失不虚构).
export function normalizeUsage(u) {
  if (!u || typeof u !== "object") return null;
  const input = u.input ?? u.inputTokens ?? u.promptTokens ?? u.input_tokens ?? u.prompt_tokens ?? null;
  const output = u.output ?? u.outputTokens ?? u.completionTokens ?? u.output_tokens ?? u.completion_tokens ?? null;
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return {
    input: Number.isFinite(input) ? input : null,
    output: Number.isFinite(output) ? output : null,
    // Turn metering (add-turn-metering D4): the TokenUsage细分 rides verbatim —
    // absent fields stay undefined → the columns read NULL (honest absence).
    // usage.input keeps the upstream semantic (UNCACHED input); billed input =
    // input + cacheRead + cacheWrite summed at query time.
    cacheReadTokens: Number.isFinite(u.cacheReadTokens) ? u.cacheReadTokens : null,
    cacheWriteTokens: Number.isFinite(u.cacheWriteTokens) ? u.cacheWriteTokens : null,
    reasoningTokens: Number.isFinite(u.reasoningTokens) ? u.reasoningTokens : null,
  };
}

// Stub turn: the runtime answered, but the answer is a stub (fix-stub-turn-success).
// 128 is not a guess — it is the constant the production rows cluster on: 67 of
// 248 rounds in 24h reported EXACTLY 128 output tokens. Four facts must hold
// together, so a legitimately short round (one report_status call, no prose)
// never matches: it has a tool call and a report.
export const STUB_OUTPUT_TOKENS = 128;

export function isStubTurn({ outputTokens = null, hasText = false, toolCalls = 0, reported = false } = {}) {
  if (!Number.isFinite(outputTokens) || outputTokens > STUB_OUTPUT_TOKENS) return false;
  if (hasText) return false;
  if (Number(toolCalls) > 0) return false;
  if (reported) return false;
  return true;
}

// The outcome → event-field shaping (status/errorKind/error/model/usage),
// pure, shared with the ledger.
export function shapeTurnOutcome(outcome, { model = null, contextBudget = null, hasAttribution = false, reportContract = null } = {}) {
  const ok = outcome?.ok === true;
  const interrupted = outcome?.interrupted === true;
  // fix-fleet-turn-attribution D4: a platform-skipped round (lane breaker
  // open) is its own ending — neither a failure nor a success. The streak
  // never counts it, presence advances, and the UI can tell it apart.
  const skipped = outcome?.skipped === true;
  const usage = normalizeUsage(outcome?.usage);
  // Context budget (add-agent-config-dims D3): judged at settlement, from the
  // usage the runtime actually reported. No usage → no basis → never judged
  // (an invented zero would fail turns nobody measured).
  const spent = usage && (usage.input != null || usage.output != null) ? (usage.input ?? 0) + (usage.output ?? 0) : null;
  const overBudget = ok && Number.isFinite(contextBudget) && spent != null && spent > contextBudget;
  // Detail (fix-fleet-turn-attribution D1): the executor's own attribution
  // (timeout shape, degradedTo) rides the row verbatim — the recorder adds
  // nothing it did not observe.
  const detail = outcome?.detail && typeof outcome.detail === "object" ? outcome.detail : null;
  // An "ok" with nothing behind it is not a success (harden-fleet-tool-face-and-
  // queue 3.5 / ledger E21's third shape). Live 2026-11-09: three turns came
  // back `status=ok` with `model=null`, `traceTurnId=null`, no usage and no new
  // report — the platform restarted mid-turn, the executor's success path
  // returned an empty `{ok:true}` and the row claimed a round that never ran.
  // A round that produced no usage, no attribution detail and no ledger handle
  // cannot be distinguished from "never started", so it settles as interrupted
  // (re-runnable, honest) rather than ok (which advances presence and hides it).
  // Narrow on purpose: `contextBudget` has its own contract (no usage → no
  // verdict, status stays ok — add-agent-config-dims), so the hollow check
  // only fires when the execution seam EXPLICITLY says the round never ran.
  const hollowOk = ok && outcome?.hollow === true && !usage && !hasAttribution;
  // Stub-turn guard (fix-stub-turn-success). Live 2026-11-09: **67 of 248 rounds
  // in 24h reported exactly 128 output tokens and every one settled `ok`** — 62
  // with `model=null`, several whose trace holds no events at all. The hollow
  // check above cannot see them: it requires usage to be ABSENT, and these
  // rounds carry usage (128 tokens of it).
  //
  // The four facts together — tiny output, no text, no tool call, no report —
  // are the shape of "the runtime answered with a stub and nothing happened".
  // Any ONE failing keeps the old behaviour byte-for-byte: a short round that
  // called report_status has a tool call and a report, so it stays ok.
  const stubFacts = {
    outputTokens: usage?.output ?? null,
    hasText: Boolean(String(outcome?.text ?? "").trim()),
    toolCalls: Array.isArray(outcome?.toolBlocks) ? outcome.toolBlocks.length : 0,
    reported: outcome?.reported === true,
  };
  const stub = ok && !hollowOk && isStubTurn(stubFacts);
  // Observation only (design D4): a window filled to 95% is a fact about the
  // round, never a verdict — the four facts above decide.
  const windowFull =
    Number.isFinite(outcome?.contextWindow) && outcome.contextWindow > 0
    && Number.isFinite(outcome?.inputTokens) && outcome.inputTokens >= outcome.contextWindow * 0.95;
  const shapedDetail = stub || windowFull
    ? {
        ...(detail ?? {}),
        ...(stub ? { stubTurn: true, stubEvidence: stubFacts } : {}),
        ...(windowFull ? { windowFull: true, outputTokens: stubFacts.outputTokens } : {}),
      }
    : detail;
  // Delivery contract (enforce-report-contract). The template says 「收尾必
  // report_status」 for 34 of its 35 posts, and production ran 516 turns in 24h
  // filing 129 reports — settlement never noticed because `ok` only ever meant
  // "the loop ended". The status is deliberately NOT changed: the round really
  // did run (tokens spent, tools called), so making it `failed` would pollute
  // the failure rate and the re-run face. What changes is that the row can now
  // say "ran, but delivered nothing".
  // The FINAL status decides, not the pre-settlement fact (live 2026-11-10: the
  // first stub row settled `interrupted` and still carried `missingReport`, i.e.
  // two rules judged one round). A round that was re-classified as interrupted
  // never got the chance to deliver, so it cannot break the delivery contract.
  const finalStatus = skipped
    ? "skipped"
    : overBudget
      ? "failed"
      : hollowOk || stub
        ? "interrupted"
        : ok
          ? "ok"
          : interrupted
            ? "interrupted"
            : "failed";
  const missingReport = isMissingReport({
    status: finalStatus,
    reportContract,
    reported: outcome?.reported === true,
  });
  const finalDetail = missingReport
    ? { ...(shapedDetail ?? {}), missingReport: true, reportContract: "required" }
    : shapedDetail;
  return {
    status: finalStatus,
    errorKind: skipped ? null : overBudget ? "context_budget" : ok && !stub ? null : classifyErrorKind(outcome?.error),
    error: overBudget
      ? `context budget exceeded: spent ${spent} tokens, budget ${contextBudget}`
      : hollowOk
        ? "turn produced no usage and no attribution — treated as interrupted (the platform restarted mid-turn)"
        : stub
          ? `turn produced a ${stubFacts.outputTokens ?? 0}-token stub and nothing else — treated as interrupted (no text, no tool call, no report)`
          : ok
            ? null
            : String(outcome?.error ?? "execution failed").slice(0, 500),
    model: model ?? outcome?.usage?.model ?? null,
    usage,
    detail: finalDetail,
  };
}

// `outcome` is the executor's return: { ok, error?, interrupted?, usage? }.
// `meta` carries { startedAt, endedAt, model } from the seam (the wrapper
// knows when the turn began and what the runtime landed on) and, when the run
// ledger opened this turn, `ledgerTurn` — the handle whose turnId/runId/chain
// position/trace key land on the row. Returns the stored event, or null when
// the turn carries no fleet attribution.
export function recordTurnEvent(db, job, outcome, { startedAt, endedAt, model = null, rosterPresetId = (id) => id, ledgerTurn = null, contextBudget = null, reportContract = null } = {}) {
  // Single derivation source (agent-turn-contract): attribution and source
  // both read off the same turnRequest — one rule for both doors.
  const request = buildTurnRequest(job);
  const post = ledgerTurn
    ? { fleetId: ledgerTurn.fleetId, memberId: ledgerTurn.memberId }
    : resolveTurnPost(db, request, rosterPresetId);
  if (!post?.fleetId || !post?.memberId) return null;

  // `ledgerTurn` is the run-ledger handle: when the run lane opened this turn,
  // the row gets a real turnId/trace key. Its absence on an otherwise "ok"
  // outcome is exactly the hollow-turn shape the guard below settles as
  // interrupted.
  const shaped = shapeTurnOutcome(outcome, { model, contextBudget, hasAttribution: Boolean(ledgerTurn), reportContract });
  return db.appendTurnEvent({
    fleetId: post.fleetId,
    memberId: post.memberId,
    source: request.source,
    ...shaped,
    startedAt,
    endedAt,
    sessionId: job?.sessionId ?? null,
    turnId: ledgerTurn?.turnId ?? null,
    runId: ledgerTurn?.runId ?? request.chain?.runId ?? null,
    parentTurnId: ledgerTurn?.parentTurnId ?? request.chain?.parentTurnId ?? null,
    edgeKind: ledgerTurn?.edgeKind ?? request.chain?.edgeKind ?? null,
    traceTurnId: ledgerTurn?.traceTurnId ?? null,
    metering: meteringOf(request, job, outcome),
    pricing: pricingOf(shaped),
  });
}

// ── Turn pricing (add-turn-pricing) ──────────────────────────────────────────
//
// Synchronous estimate at the seam: the cached per-token rate (pricingFor)
// times THIS turn's usage, at the price version live at turn time. The same
// estimate lands on the turn row AND accumulates into the DAILY row
// (add-fleet-cost-read-face superseded add-turn-pricing D4a: the daily key has
// no run/edge dimension, so the turn row is the only place a per-run / per-hop
// attribution can come from). Unpriced model / cold cache → null (honest
// absence; neither copy fabricates a zero).
function pricingOf(shaped) {
  const model = shaped.model ?? null;
  if (!model) return null;
  const rates = pricingFor(model);
  if (!rates) return null;
  const usage = shaped.usage ?? {};
  return estimateTurnCost(usage, rates);
}

// ── Turn metering (add-turn-metering) ────────────────────────────────────────
//
// Aggregate fields ride the SAME event row as columns (never detail JSON —
// detail is read by row, never queried). Absent dimension or unreported
// runtime field → NULL (honest absence), never 0 impersonating an observation.
// carrier comes from the execution-carrier mark (enqueue default or the worker
// slot claim) carried on outcome.metering by the executor — derived NOWHERE
// else. depth is the turnRequest's chain position (single derivation rule);
// wave reads the origin chain. presetSource classifies the roster id once:
// catalog pack entry → "catalog", custom preset → "custom", the platform's
// baseline composition id → "shipped", anything unresolvable → NULL.
const BASELINE_PRESET_ID = "standard";
function meteringOf(request, job, outcome) {
  const usage = outcome?.usage ?? {};
  const m = outcome?.metering ?? {};
  let presetSource = null;
  if (job?.preset) {
    if (job.preset === BASELINE_PRESET_ID) presetSource = "shipped";
    else {
      try {
        const persona = resolvePersona(job.preset);
        presetSource = persona ? (persona.customPreset ? "custom" : "catalog") : null;
      } catch { /* degrade open — source stays NULL */ }
    }
  }
  return {
    presetId: job?.preset ?? null,
    presetSource,
    provider: m.provider ?? null,
    effort: m.effort ?? null,
    carrier: m.carrier ?? null,
    carrierInstance: m.carrierInstance ?? null,
    laneId: outcome?.detail?.laneId ?? null,
    depth: request.depth ?? null,
    wave: job?.origin?.fleet?.wave ?? null,
    queueWaitMs: Number.isFinite(m.queueWaitMs) ? Math.max(0, Math.round(m.queueWaitMs)) : null,
    spinUpMs: Number.isFinite(m.spinUpMs) ? Math.max(0, Math.round(m.spinUpMs)) : null,
    ttftMs: Number.isFinite(m.ttftMs) ? Math.max(0, Math.round(m.ttftMs)) : null,
    usageCachedInput: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null,
    usageCacheWrite: Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : null,
    usageReasoning: Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : null,
  };
}

// Derived-lane carrier marking (add-turn-metering §15.115挂账 enrichment, cut ⑤
// follow-up): the handoff/fanout/event-wake seam writes synthetic failure rows
// for turns that NEVER dispatched (depth bound, missing edge args, hourly cap)
// — no task, no executor, so the execution-carrier mark never lands. Those rows
// still belong to a lane: a2a targets always ride the remote lane; persona
// members resolve through the same three layers as dispatch (member → fleet
// constraint → env default), mapped into the metering vocabulary
// (runner→remote, worker→worker, auto/cell→cell). The column marks the LANE,
// never a claimed body — carrierInstance stays null, and the runtime fields
// (queue/spin/ttft/usage) stay honestly absent. Tool/cluster targets carry no
// lane (consistent with executed tool turns, which stamp none). The layer
// order is pinned against resolveTaskCarrier by test.
export function derivedLaneCarrier({ member = null, fleet = null, targetKind = null } = {}) {
  if (targetKind === "a2a") return "remote";
  // 审计官与 persona 同族：它在本机跑，就该有本机车道标记。原来写死 !== "persona"
  // 会让审计官回合的 carrier 恒为 null——「无车道」和「本机」是两件事。
  if (!isPersonaBackedTargetKind(targetKind)) return null;
  const val = (v) => (["cell", "worker", "runner"].includes(v) ? v : null);
  const rc =
    val(member?.carrier) ??
    val(fleet?.orchestration?.constraints?.carrier) ??
    val(String(process.env.CELL_CARRIER_DEFAULT ?? "").trim()) ??
    "auto";
  return rc === "runner" ? "remote" : rc === "worker" ? "worker" : "cell";
}
