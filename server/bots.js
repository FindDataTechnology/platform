// Social chat-platform bots: registry, inbound pipeline, and reply delivery.
//
// One dsh runtime serves the web chat and every bot chat. A bot chat is bound
// to its own dsh session (`bot-<botId>-<sha1(chatKey)16>`), which dsh persists
// and resumes from disk — so a conversation survives a runtime restart and a
// model switch. Notifications for those sessions are routed to a per-turn
// collector by the session-aware pump (server/dsh-events.js), never to the WS
// broadcast path.
//
// Graceful degradation, per the project convention: the module is inert with
// no bots configured, every adapter call is failure-isolated, and a broken bot
// is logged and skipped rather than crashing the server or stalling the others.

import { stripReasoningLeak } from "./reasoning-leak.js";
import crypto from "node:crypto";
import { adapterForBot, validateCredentials, ackCapabilityOfBot } from "./bots/adapter.js";
import { createLaneConfig, copyForEvent } from "../gateway/zhiyu/lane-config.js";
import { sendThrough, fdBotConfigured } from "./fd-bot-client.js";
import { isGenericBotType, packBotMeta, PACK_BOT_CREDENTIAL_KEY } from "../lib/generic-bot-types.js";
import { observeTurnTap } from "./observe-tap.js";
import { gateOutboundMessage, noteBypassAttempt } from "../lib/outbound-message.js";

// Outbound accountability ledger writer (unify-im-solution C4). Decision made:
// a dedicated `outbound_ledger` table (db.js v128), NOT action_audit — that
// table's NOT-NULL action columns cannot describe "said one sentence", and
// mixing the two ledgers would make them disagree. This records the gate's
// ledger shape per outbound message (content原文 never stored — only its digest).
// A write failure is logged and never blocks an already-sent message, but it is
// NOT silent: the spec requires the absence be visible (see the warn sites).
function recordOutboundLedger(entry, channel = "bot") {
  const db = state.ctx?.db;
  // null/absent db = degraded cell; returning quietly here is correct because
  // there is nothing to write to — but insertOutboundLedger itself THROWS on a
  // bad entry, which the callers surface as a warning.
  db?.insertOutboundLedger?.({ channel, ...entry });
}

// Trust-boundary guards (design D3). These bound an untrusted external caller's
// reach into an agent, so they live here — before prompt() — not in the adapters.
const MAX_MESSAGE_CHARS = 4000;
const RATE_LIMIT_PER_MIN = 10;
const TURN_TIMEOUT_MS = Number(process.env.BOTS_TURN_TIMEOUT_MS) || 180_000;

// 中间态心跳（waiting-ack）：回合跑得久时，占位消息不能一直停在同一句话上
// ——「正在处理…」静止三分钟和黑洞的区别就没了。每 BOTS_ACK_BEAT_MS 把它
// 改写一次，带上已经过去的秒数，用户看到的是「还在动」。
// 只在 edit 车道有意义（消息 id 在手才能改）；placeholder 车道改不了，
// 靠一开始那句回执撑住。
const ACK_BEAT_MS = Number(process.env.BOTS_ACK_BEAT_MS) || 45_000;

// Relay guards (add-bot-relay-endpoint, design D6). The same bounds as the
// inbound pipeline's, named separately so either path can move without the
// other. The timeout bounds the response a machine caller waits for; the
// adapters' send fetch takes no AbortSignal, so a hung platform call can
// outlive the reply (recorded as a risk in the change's design).
// MAX_RELAY_CHARS is exported for the route's error message — the cap itself is
// enforced here, at the send.
export const MAX_RELAY_CHARS = 4000;
const RELAY_RATE_PER_MIN = 10;
const RELAY_SEND_TIMEOUT_MS = 15_000;

// v1 posture: bot turns are answer-only. dsh exposes no per-session tool
// control (tools are auto-allowed by the profile's plugins), so this is
// enforced in two places that ARE available: an explicit instruction on the
// prompt, and a reply-side check that refuses to forward an answer derived
// from tool calls. `BOTS_ALLOW_TOOLS=1` lifts both.
// ponytail: prompt-level posture is the ceiling until dsh grows a per-prompt
// tool allowlist; the reply-side check is what makes it observable.
const NO_TOOLS_PREFIX =
  "You are answering a message from an external chat platform. Answer directly from " +
  "your own knowledge. Do not call any tools — the ONE exception is ask_user_question: " +
  "when you need the user's confirmation, a choice, or missing information before you " +
  "can answer, call it (it pauses until the user replies in chat).\n\n";

// ── User questions (add-user-questions, ADR-0012) ───────────────────────────
// A bot turn that calls ask_user_question parks on the platform's provider
// bridge: the ask arrives as a `userQuestion/ask` notification on the turn's
// collector, is rendered as numbered-option text into the chat, and the chat's
// NEXT inbound message is intercepted as the answer attempt — never a new
// turn. The wait window (BOTS_ASK_WAIT_MS, default 10 min) bounds the pause;
// while an ask is pending the turn hard timeout is PAUSED, and on expiry the
// ask is cancelled automatically with the turn continuing to its normal
// conclusion. Matching failures re-prompt the options; after ASK_MAX_ATTEMPTS
// unrecognized replies the ask is cancelled. The no-tools posture exempts the
// ask tool itself: the answer is the user's own words, not tool output.
const ASK_WAIT_MS = Number(process.env.BOTS_ASK_WAIT_MS) || 600_000;
const ASK_MAX_ATTEMPTS = 3;
const ASK_CANCEL_WORDS = new Set(["取消", "cancel"]);

const laneCfg = createLaneConfig();

const state = {
  ctx: null,
  bots: new Map(), // id → { bot, adapter, stopPoll }
  queues: new Map(), // sessionId → tail promise (serializes turns within a chat)
  buckets: new Map(), // `${botId}:${chatKey}` → { tokens, refilledAt }
  relayBuckets: new Map(), // channel name → { tokens, refilledAt }
  // sessionId → the chat's pending ask: {bot, adapter, chatKey, askId,
  // questions, attempts, timer, resolve}. `resolve(cancelled, answers)` is the
  // collectTurn closure that submits to the runtime and resumes the paused
  // turn timeout. Present only while a question waits in that chat.
  pendingAsks: new Map(),
  // sessionId → 该 bot 聊天里待答的结构化输入请求（add-input-request-cards）：
  // {bot, adapter, chatKey, request, values, cursor, attempts}。与 pendingAsks
  // 同一职责，只是来源不同——问询来自 dsh 的 userQuestions，输入请求来自
  // MCP 工具写下的行，所以两边各有各的入口、共用一个拦截位。
  pendingInputs: new Map(),
};

// ── Sender allowlist (add-staff-fleet-channels) ─────────────────────────────
//
// The bot lane's only boundary used to be "whoever the chat platform lets reach
// this webhook". That is fine for a canned reply bot and wrong for one that can
// read memory and act: enabling tools on a bot whose reachable audience is
// undefined means handing the tool face to an undefined audience.
//
// So the allowlist is a per-bot row field, and it is a PREREQUISITE for tools
// (see botToolPosture). Empty list = no allowlist = pre-change behavior.
//
// Discipline: identity travels in the same field the adapter already derives
// from the platform's own signature-verified payload (`senderName`), so nothing
// here trusts anything the sender controls.
export const ALLOWLIST_LIMITS = Object.freeze({ maxEntries: 32, maxChars: 128 });

/**
 * Normalize an allowlist from whatever the write face received.
 *
 * Returns { ok, value } or { ok:false, error }. Accepts an array (the API) or a
 * JSON array string (a row). Trims, drops blanks, dedupes, caps length — but
 * NEVER truncates silently: an over-long entry is an error, because a silently
 * shortened id would match nobody and read as "my allowlist doesn't work".
 */
export function normalizeAllowedSenders(input) {
  if (input === undefined || input === null) return { ok: true, value: [] };
  let list = input;
  if (typeof list === "string") {
    const text = list.trim();
    if (!text) return { ok: true, value: [] };
    try {
      list = JSON.parse(text);
    } catch {
      return { ok: false, error: "allowedSenders must be a JSON array" };
    }
  }
  if (!Array.isArray(list)) return { ok: false, error: "allowedSenders must be an array" };
  if (list.length > ALLOWLIST_LIMITS.maxEntries) {
    return { ok: false, error: `allowedSenders may hold at most ${ALLOWLIST_LIMITS.maxEntries} entries` };
  }
  const out = [];
  for (const raw of list) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string") return { ok: false, error: "allowedSenders entries must be strings" };
    const v = raw.trim();
    if (!v) continue;
    if (v.length > ALLOWLIST_LIMITS.maxChars) {
      return { ok: false, error: `allowedSenders entries must be at most ${ALLOWLIST_LIMITS.maxChars} characters` };
    }
    if (!out.includes(v)) out.push(v);
  }
  return { ok: true, value: out };
}

/**
 * May this sender talk to this bot?
 *
 * Fails CLOSED when an allowlist exists but no sender id is available: an
 * inbound path that cannot say who is calling must not inherit access just
 * because the comparison failed.
 */
export function isSenderAllowed(bot, senderId) {
  const list = normalizeAllowedSenders(bot?.allowedSenders).value ?? [];
  if (list.length === 0) return true;
  const id = typeof senderId === "string" ? senderId.trim() : "";
  if (!id) return false;
  return list.includes(id);
}

// Stable, non-reversible label for a rejected sender. Long enough to tell two
// senders apart in logs, short enough not to be a lookup table.
function hashSender(senderId) {
  const id = typeof senderId === "string" ? senderId.trim() : "";
  if (!id) return "anonymous";
  return crypto.createHash("sha1").update(id).digest("hex").slice(0, 12);
}

// Per-bot tool posture (harden-bot-reply-lane, design D3). The deployment env
// is a CEILING, not the switch: `BOTS_ALLOW_TOOLS` off means no bot runs tools
// whatever its own flag says (the群聊 decision: a multi-member room must be
// able to be clamped shut from the deployment). The prompt prefix and the
// reply-side withhold BOTH read this one function — they were two separate
// checks that the same env lifted together, which is how the prod drift
// (BOTS_ALLOW_TOOLS=1 → every bot answered with fleet-operator tool output)
// went unnoticed.
//
// add-staff-fleet-channels adds the third condition: a non-empty sender
// allowlist. Tools authorize reading memory and taking actions; that authority
// cannot hang off an entry point whose audience is undefined.
//
// The reason is part of the return value (not a log-only detail) because a
// tightening that is invisible reads to the operator as "the bot broke": the
// admin row must be able to say WHY tools are off.
export const TOOL_POSTURE_REASONS = Object.freeze({
  ON: "on",
  CEILING_OFF: "ceiling_off",
  BOT_SWITCH_OFF: "bot_switch_off",
  ALLOWLIST_EMPTY: "allowlist_empty",
});

export function botToolPosture(bot, env = process.env) {
  if (env.BOTS_ALLOW_TOOLS !== "1") return { toolsOn: false, reason: TOOL_POSTURE_REASONS.CEILING_OFF };
  if (!bot?.allowTools) return { toolsOn: false, reason: TOOL_POSTURE_REASONS.BOT_SWITCH_OFF };
  const list = normalizeAllowedSenders(bot?.allowedSenders).value ?? [];
  if (list.length === 0) return { toolsOn: false, reason: TOOL_POSTURE_REASONS.ALLOWLIST_EMPTY };
  return { toolsOn: true, reason: TOOL_POSTURE_REASONS.ON };
}

const allowToolsFor = (bot) => botToolPosture(bot).toolsOn;

// Runtime readiness wait (design D1). The webhook route ACKs the platform
// BEFORE the turn runs, so waiting here costs the chat platform nothing —
// whereas the old early return turned every rollout into a canned "starting
// up" reply that the user reads as "the bot is broken" (prod 2026-10-31).
const READY_POLL_MS = 250;
// Read at call time, not import time: the budget is a deployment knob the
// tests (and a restart-free config change) must be able to move.
const readyWaitMs = () => Number(process.env.BOTS_READY_WAIT_MS) || 90_000;

async function waitForRuntime(ctx, budgetMs) {
  if (ctx?.dshBridge?.isReady?.()) return 0;
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
    if (ctx?.dshBridge?.isReady?.()) return Date.now() - startedAt;
  }
  return null;
}

export function publicBaseUrl() {
  return process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || null;
}

// Stable per-(bot, external chat) dsh session id (design D2). Derived, not
// stored: the conversation itself lives in dsh's session store.
export function sessionIdFor(botId, chatKey) {
  const hash = crypto.createHash("sha1").update(String(chatKey)).digest("hex").slice(0, 16);
  return `bot-${botId}-${hash}`;
}

export function webhookUrlFor(bot) {
  const base = publicBaseUrl() ?? "";
  return `${base}/api/bots/webhook/${bot.id}/${bot.secret}`;
}

// Browser-facing shape. Credential VALUES never leave the server — only the
// set of keys that are configured, so the UI can show "configured" hints.
// A pack-materialized bot additionally exposes its provenance (owning pack,
// mounted skill) and an awaitingConnection flag: pack bots are born disabled
// with no channel credentials — enabling and credentialing are the
// operator's explicit actions, never side effects of installing a pack.
export function maskBot(bot) {
  const meta = packBotMeta(bot.credentials);
  const configured = Object.entries(bot.credentials ?? {})
    .filter(([k, v]) => k !== PACK_BOT_CREDENTIAL_KEY && String(v ?? "").trim())
    .map(([k]) => k);
  const mask = {
    id: bot.id,
    type: bot.type,
    name: bot.name,
    enabled: bot.enabled,
    createdAt: bot.createdAt,
    configuredCredentials: configured,
    webhookUrl: webhookUrlFor(bot),
    // Config dimensions (add-agent-config-dims): declared effort/budget ride
    // the masked row so the edit form can prefill; null = not declared.
    effort: bot.effort ?? null,
    contextBudget: bot.context_budget ?? null,
    // Identity and tool posture (harden-bot-reply-lane): neither is a secret —
    // the edit form needs both back, and the operator must be able to SEE
    // whether this bot is allowed to run tools.
    persona: bot.persona ?? null,
    allowTools: Boolean(bot.allowTools),
    // Allowlist + the EFFECTIVE tool posture (add-staff-fleet-channels D3).
    // `toolPosture.reason` is the point: tightening the rule without showing
    // why turns "tools are off" into an unexplained regression the operator
    // chases through models and credentials.
    allowedSenders: normalizeAllowedSenders(bot.allowedSenders).value ?? [],
    toolPosture: botToolPosture(bot),
    // The binding id, so the edit panel can tell "bound" from "unbound" and ask
    // the liveness face about it (harden-zhiyu-outbound-lanes 3.3). It was
    // `savedBot.zhiRoomId` in the panel all along, but this projection never
    // carried it — so a bound bot rendered exactly like an unbound one, and the
    // stale binding in production was invisible in the very panel built to
    // show it. Not a secret: it is a room id, which the owner can already see
    // everywhere else in the product.
    zhiRoomId: bot.zhiRoomId ?? null,
  };
  if (meta) {
    mask.pack = { packId: meta.packId, skill: meta.skill ?? null, generic: meta.generic ?? bot.type };
    mask.awaitingConnection = validateCredentials(bot.type, bot.credentials) !== null;
  }
  return mask;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Boot latch (2026-10-29 fd-prod): `server.listen` runs BEFORE `bots.initBots`
// — db open and the dsh handshake sit between them. The gateway proxies a bot
// webhook as soon as the cell's port answers, so a message landing in that
// window found an EMPTY registry and got a fast 403 "unknown"; the chat
// platform treats a definite refusal as final and the message is LOST (two
// observed drops). The webhook route therefore waits on this latch instead of
// answering prematurely: a genuinely unknown bot still gets the identical 403
// once boot completes, so the attack surface is unchanged.
let bootSettled = false;
let bootResolve;
const bootPromise = new Promise((resolve) => { bootResolve = resolve; });

export function bootPending() {
  return !bootSettled;
}

// Resolves true when the registry is loaded, false when the budget ran out.
// The timer is deliberately NOT unref'd: this wait is bounded by the live
// webhook request that called it, and a ref'd timer keeps the answer honest
// even when nothing else is scheduled.
export function whenBooted(timeoutMs) {
  if (bootSettled) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    bootPromise.then(() => { clearTimeout(timer); resolve(true); });
  });
}

function settleBoot() {
  if (bootSettled) return;
  bootSettled = true;
  bootResolve?.();
}

export function initBots(ctx) {
  state.ctx = ctx;
  try {
    if (!ctx.db.isDbReady()) {
      console.warn("[bots] disabled: database unavailable");
      return;
    }
    for (const bot of ctx.db.listBots()) reload(bot);
    const live = [...state.bots.values()].filter((e) => e.bot.enabled).length;
    if (live) console.log(`[bots] ${live} bot(s) active`);
  } finally {
    // Always release waiting webhooks: a half-loaded or broken registry must
    // cost one 403, never a 4s stall on every message for the process lifetime.
    settleBoot();
  }
}

// (Re)build one bot's runtime entry from its row: stop whatever was running,
// then start the new config. Called on every config mutation, so changes take
// effect without a server restart.
export function reload(bot) {
  stop(bot.id);
  const adapter = adapterForBot(bot);
  if (!adapter) {
    // A generic-type row (pack bot) without a platform binding is not an
    // error state — it is the born awaiting-connection posture. Log it
    // quietly; no runtime entry exists, so nothing is reachable.
    if (isGenericBotType(bot.type)) {
      console.log(`[bots] "${bot.name}" (${bot.type}) awaiting a platform binding; not registered`);
    } else {
      console.warn(`[bots] "${bot.name}" has unknown type "${bot.type}"; skipped`);
    }
    return;
  }
  const entry = { bot, adapter, stopPoll: null };
  state.bots.set(bot.id, entry);
  if (!bot.enabled) return;
  // Tool posture notice (add-staff-fleet-channels 1.3). Only for bots that ASKED
  // for tools: a bot with the switch off is the normal case and saying anything
  // about it would bury this line. The three refusal reasons are logged apart,
  // because the fix differs — and because "tools are off" with no reason reads
  // as a regression the operator chases through models and credentials.
  if (bot.allowTools) {
    const posture = botToolPosture(bot);
    if (!posture.toolsOn) {
      const why = {
        [TOOL_POSTURE_REASONS.CEILING_OFF]: "the deployment ceiling BOTS_ALLOW_TOOLS is not enabled",
        [TOOL_POSTURE_REASONS.ALLOWLIST_EMPTY]: "its sender allowlist is empty — set at least one sender, or the tool face stays closed",
        [TOOL_POSTURE_REASONS.BOT_SWITCH_OFF]: "its own tool switch is off",
      }[posture.reason] ?? posture.reason;
      console.warn(`[bots] "${bot.name}" asks for tools but runs WITHOUT them: ${why}`);
    }
  }
  // Polling fallback: adapters that support it (telegram) run a long-poll loop
  // when the server has no public URL for the platform to call back to.
  if (adapter.start && !publicBaseUrl()) {
    try {
      entry.stopPoll = adapter.start(bot, (msg) => {
        void handleMessage(bot.id, msg).catch((e) =>
          console.warn(`[bots] "${bot.name}" polled turn failed: ${e.message}`),
        );
      });
      console.log(`[bots] "${bot.name}" polling (no PUBLIC_BASE_URL)`);
    } catch (e) {
      console.warn(`[bots] "${bot.name}" poll start failed: ${e.message}`);
    }
  }
}

export function stop(botId) {
  const entry = state.bots.get(botId);
  if (!entry) return;
  try { entry.stopPoll?.(); } catch (e) { console.warn(`[bots] stop failed: ${e.message}`); }
  state.bots.delete(botId);
}

export function stopAll() {
  for (const id of [...state.bots.keys()]) stop(id);
}

export function getEntry(botId) {
  return state.bots.get(botId) ?? null;
}

export { validateCredentials };

// ── Guards ───────────────────────────────────────────────────────────────────

// Token bucket, refilled continuously. Returns false when `key` has exhausted
// its allowance for the current window. Shared by the inbound limiter (keyed by
// bot + chat) and the relay limiter (keyed by channel).
function takeBucket(store, key, perMin) {
  const now = Date.now();
  const b = store.get(key) ?? { tokens: perMin, refilledAt: now };
  b.tokens = Math.min(perMin, b.tokens + ((now - b.refilledAt) / 60_000) * perMin);
  b.refilledAt = now;
  store.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function takeToken(botId, chatKey) {
  return takeBucket(state.buckets, `${botId}:${chatKey}`, RATE_LIMIT_PER_MIN);
}

function takeRelayToken(channel, botId, chatKey) {
  return takeBucket(state.relayBuckets, `${channel}:${botId}:${chatKey}`, RELAY_RATE_PER_MIN);
}

// ── Turn runner ──────────────────────────────────────────────────────────────

// Render one ask's questions as chat text: numbered options with descriptions,
// multi-select guidance, and the reply contract. Presentation intents
// (plan-review) render as the generic list — the answer encoding is identical.
export function renderQuestionText(questions) {
  const lines = [];
  questions.forEach((q, i) => {
    if (questions.length > 1) lines.push(i === 0 ? "" : "", `问题 ${i + 1}：`);
    if (q.header) lines.push(`【${q.header}】`);
    if (q.detail) lines.push(String(q.detail));
    lines.push(String(q.question ?? ""));
    const options = Array.isArray(q.options) ? q.options : [];
    options.forEach((o, j) => {
      lines.push(`${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
    });
  });
  const first = questions[0] ?? {};
  const hasOptions = (Array.isArray(first.options) ? first.options.length : 0) > 0;
  lines.push(
    hasOptions
      ? `回复数字${first.multiSelect ? "（多选用逗号分隔）" : ""}或选项原文；回复“取消”结束问询`
      : "直接回复文字作答；回复“取消”结束问询",
  );
  return lines.filter((l) => l !== "").join("\n");
}

// Map one inbound reply onto the pending ask. Outcomes:
//   {kind:"cancel"}            — the user said the cancel word
//   {kind:"answers", answers}  — numbers/labels matched, or the text is the
//                                custom answer of free-text questions
//   {kind:"reprompt"}          — matched nothing answerable; re-prompt
// A pure-number list maps onto options (multi-number only on multiSelect);
// a leading "1. "/"1、" strip lets a copied render line match its label.
export function parseAnswer(text, questions) {
  const trimmed = String(text ?? "").trim();
  if (ASK_CANCEL_WORDS.has(trimmed.toLowerCase())) return { kind: "cancel" };
  const stripped = trimmed.replace(/^\d+\s*[.、)．]\s*/, "");
  const answers = [];
  for (const q of Array.isArray(questions) ? questions : []) {
    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length === 0) continue;
    const nums = trimmed.split(/[\s,，、]+/).filter(Boolean);
    if (nums.length > 0 && nums.every((n) => /^\d+$/.test(n))) {
      const indexes = nums.map((n) => Number(n) - 1);
      if (indexes.every((i) => i >= 0 && i < options.length)) {
        const selected = indexes.map((i) => options[i].label);
        if (q.multiSelect === true || selected.length === 1) {
          answers.push({ id: q.id, selected });
          continue;
        }
      }
    }
    const byLabel = options.find((o) => o.label === stripped);
    if (byLabel) answers.push({ id: q.id, selected: [byLabel.label] });
  }
  if (answers.length > 0) return { kind: "answers", answers };
  // No option matched: free-text questions take the reply as the custom
  // answer (ALL of them — one reply answers one ask, not one question each).
  const freeText = (Array.isArray(questions) ? questions : []).filter(
    (q) => !Array.isArray(q.options) || q.options.length === 0,
  );
  if (freeText.length > 0 && trimmed) {
    return { kind: "answers", answers: freeText.map((q) => ({ id: q.id, selected: [], custom: trimmed })) };
  }
  return { kind: "reprompt" };
}

// Submit one intercepted reply against the chat's pending ask: resolve,
// re-prompt (bounded), or cancel. Failure-isolated sends, same as turn replies.
async function deliverAskAttempt(entry, text) {
  const { bot, adapter, chatKey } = entry;
  const reply = (body) =>
    deliverText(bot, adapter, chatKey, body).catch((e) => {
      console.warn(`[bots] "${bot.name}" send failed: ${e.message}`);
    });
  const outcome = parseAnswer(text, entry.questions);
  if (outcome.kind === "cancel") {
    entry.resolve(true);
    await reply("已取消本次问询。");
    return;
  }
  if (outcome.kind === "answers") {
    entry.resolve(false, outcome.answers);
    return;
  }
  entry.attempts += 1;
  if (entry.attempts >= ASK_MAX_ATTEMPTS) {
    entry.resolve(true);
    await reply(`未能识别回答（${ASK_MAX_ATTEMPTS} 次尝试），已取消本次问询。`);
    return;
  }
  await reply(
    `未识别的回答，请回复数字或选项原文（还可尝试 ${ASK_MAX_ATTEMPTS - entry.attempts} 次）。\n${renderQuestionText(entry.questions)}`,
  );
}

// ── 结构化输入请求的 bot 车道（add-input-request-cards 4.5） ────────────────
//
// 卡片在 bot 聊天里没有可渲染的 UI，所以摊成编号问答：一次问一个必填字段，
// 每条入站消息填当前字段，填满就落到那一行上。它与 ask 通道共用同一条纪律：
// 不识别就重问、最多三次、支持「取消」、到期自动放手。
//
// 归属：行上的 session_id 是 `bot-<botId>-<sha1(chatKey)[0..16]>`，所以反查
// 靠 bot_chats 列表逐条哈希比对（这张表很小）。找不到就不用投递——一个没有
// 聊天可投的行仍然可以在 web 上被答。

function botChatForSession(sessionId) {
  const text = String(sessionId ?? "");
  if (!text.startsWith("bot-")) return null;
  for (const row of state.ctx?.db?.listBotChats?.() ?? []) {
    if (sessionIdFor(row.bot_id, row.chat_key) === text) return { botId: row.bot_id, chatKey: row.chat_key };
  }
  return null;
}

function renderInputFieldPrompt(card, cursor) {
  const f = card.fields[cursor];
  const total = card.fields.length;
  const lines = [];
  if (cursor === 0 && card.title) lines.push(`【${card.title}】`);
  if (cursor === 0 && card.detail) lines.push(String(card.detail));
  lines.push(`${total > 1 ? `（${cursor + 1}/${total}）` : ""}${f.label}${f.required ? "（必填）" : ""}`);
  if (f.kind === "enum") {
    (f.options ?? []).forEach((o, i) => {
      lines.push(`${i + 1}. ${o.label}`);
    });
    lines.push("回复数字或选项原文；回复“取消”结束");
  } else if (f.kind === "boolean") {
    lines.push("回复「是」或「否」；回复“取消”结束");
  } else if (f.kind === "number") {
    lines.push(`请回复数字${f.unit ? `（单位：${f.unit}）` : ""}；回复“取消”结束`);
  } else if (f.kind === "date") {
    lines.push("请回复日期（YYYY-MM-DD）；回复“取消”结束");
  } else if (f.kind === "file") {
    lines.push("请直接发送文件或资源链接；回复“取消”结束");
  } else {
    lines.push("请直接回复文字；回复“取消”结束");
  }
  return lines.join("\n");
}

/** Parse one inbound reply for the field at `cursor`. */
export function parseInputField(text, field) {
  const trimmed = String(text ?? "").trim();
  if (ASK_CANCEL_WORDS.has(trimmed.toLowerCase())) return { kind: "cancel" };
  if (field.kind === "enum") {
    const options = field.options ?? [];
    const stripped = trimmed.replace(/^\d+\s*[.、)．]\s*/, "");
    if (/^\d+$/.test(trimmed)) {
      const idx = Number(trimmed) - 1;
      if (idx >= 0 && idx < options.length) return { kind: "value", value: options[idx].value };
    }
    const byLabel = options.find((o) => o.label === stripped || o.value === stripped);
    if (byLabel) return { kind: "value", value: byLabel.value };
    return { kind: "reprompt" };
  }
  if (field.kind === "boolean") {
    if (/^(是|对|好|确认|yes|y|true|1)$/i.test(trimmed)) return { kind: "value", value: true };
    if (/^(否|不|取消确认|no|n|false|0)$/i.test(trimmed)) return { kind: "value", value: false };
    return { kind: "reprompt" };
  }
  if (field.kind === "number") {
    const n = Number(trimmed.replace(/[,，\s]/g, ""));
    return Number.isFinite(n) ? { kind: "value", value: n } : { kind: "reprompt" };
  }
  if (!trimmed) return { kind: "reprompt" };
  return { kind: "value", value: trimmed };
}

/**
 * Deliver a freshly created request into its bot chat (registered on ctx by
 * registerBotRoutes so the route has no hard import of this module).
 */
export async function deliverInputRequestToBotChat(sessionId, request) {
  const found = botChatForSession(sessionId);
  if (!found) return false;
  const bot = state.ctx?.db?.getBot?.(found.botId);
  if (!bot || !bot.enabled) return false;
  const adapter = adapterForBot(bot);
  const entry = {
    bot,
    adapter,
    chatKey: found.chatKey,
    request,
    values: {},
    cursor: firstOpenField(request.card, 0),
    attempts: 0,
    timer: null,
  };
  state.pendingInputs.set(sessionId, entry);
  entry.timer = setTimeout(() => {
    // 到期不私自取消：行的无人应答策略说了算（TTL 扫尾会收）。这里只放手，
    // 别让一条过期的拦截把后面所有入站消息都吃掉。
    state.pendingInputs.delete(sessionId);
  }, ASK_WAIT_MS);
  const card = request.card;
  if (!card || !card.fields?.length) return false;
  await adapter
    .sendText(bot.credentials, found.chatKey, renderInputFieldPrompt(card, entry.cursor))
    .catch((e) => console.warn(`[bots] "${bot.name}" send failed: ${e.message}`));
  return true;
}

function firstOpenField(card, from) {
  for (let i = from; i < card.fields.length; i++) {
    const f = card.fields[i];
    if (f.required) return i;
  }
  return card.fields.length - 1;
}

/** One intercepted reply on the bot's input-request lane. */
async function deliverInputAttempt(entry, text) {
  const { bot, adapter, chatKey, request } = entry;
  const reply = (body) =>
    deliverText(bot, adapter, chatKey, body).catch((e) => {
      console.warn(`[bots] "${bot.name}" send failed: ${e.message}`);
    });
  const card = request.card;
  const field = card.fields[entry.cursor];
  const outcome = parseInputField(text, field);
  if (outcome.kind === "cancel") {
    clearTimeout(entry.timer);
    state.pendingInputs.delete(sessionIdOf(entry));
    try {
      await import("./input-requests.js").then((m) => m.cancelInputRequest(state.ctx.db.getDb?.() ?? state.ctx.db, request.requestId));
    } catch (e) {
      console.warn(`[bots] cancel input request failed: ${e.message}`);
    }
    await reply("已取消本次填写。");
    return;
  }
  if (outcome.kind === "reprompt") {
    entry.attempts += 1;
    if (entry.attempts >= ASK_MAX_ATTEMPTS) {
      clearTimeout(entry.timer);
      state.pendingInputs.delete(sessionIdOf(entry));
      await reply(`未能识别回答（${ASK_MAX_ATTEMPTS} 次尝试），本次填写已结束。`);
      return;
    }
    await reply(`未识别的回答（还可尝试 ${ASK_MAX_ATTEMPTS - entry.attempts} 次）。\n${renderInputFieldPrompt(card, entry.cursor)}`);
    return;
  }
  entry.values[field.key] = outcome.value;
  entry.attempts = 0;
  const next = card.fields.findIndex((f, i) => i > entry.cursor && f.required);
  if (next === -1) {
    clearTimeout(entry.timer);
    state.pendingInputs.delete(sessionIdOf(entry));
    try {
      const core = await import("./input-requests.js");
      const { changed, request: row } = core.answerInputRequest(state.ctx.db, request.requestId, {
        values: entry.values,
        answeredBy: request.ownerEmail,
      });
      await reply(changed ? "已收到，正在继续。" : `本次填写${row?.state === "answered" ? "已由他人完成" : "已失效"}。`);
    } catch (err) {
      await reply(`提交失败：${err.message}`);
    }
    return;
  }
  entry.cursor = next;
  await reply(renderInputFieldPrompt(card, next));
}

function sessionIdOf(entry) {
  for (const [sid, e] of state.pendingInputs) if (e === entry) return sid;
  return null;
}

// Strip reasoning markup that a model sometimes emits INSIDE a plain text block
// (prod 2026-10-29: a WeCom reply began literally with "<thinking>The user is
// asking me to…"). The clean path puts reasoning in its own `reasoning` block
// and the collector already drops those; this is the defensive net for models
// that fold the trace into text. Chat platforms have no collapsible UI, so any
// surviving trace is user-visible noise.



// Collect one turn's outcome off the session's notification stream. Registered
// BEFORE prompt() so no early event is missed; always unregistered. With
// {bot, adapter, chatKey} the collector also serves as this turn's ask
// surface (add-user-questions): a `userQuestion/ask` notification renders the
// question into the chat and registers the interception entry; the turn's
// hard timeout PAUSES while the human holds the floor and resumes with its
// remaining budget when the ask resolves.
function collectTurn(ctx, sessionId, { bot = null, adapter = null, chatKey = null } = {}) {
  let abortFn = null;
  const promise = new Promise((resolve, reject) => {
    let text = "";
    let error = null;
    let usedTools = false;
    let askEntry = null; // live while a question waits in this chat
    let deadlineAt = 0; // turn-timeout bookkeeping across ask pauses
    let timer = null;
    const settle = (fn, arg) => {
      clearTimeout(timer);
      // A turn ending with a question still waiting cannot happen in-child
      // (the ask parks the tool call), but a crashed child or a lost collector
      // can produce it — never leave an interception entry behind a dead turn.
      if (askEntry) {
        clearTimeout(askEntry.timer);
        state.pendingAsks.delete(sessionId);
        askEntry = null;
      }
      ctx.sessionCollectors.delete(sessionId);
      fn(arg);
    };
    const armTimeout = (ms) => {
      clearTimeout(timer);
      if (ms <= 0) return;
      deadlineAt = Date.now() + ms;
      timer = setTimeout(() => settle(reject, new Error("turn timed out")), ms);
    };
    armTimeout(TURN_TIMEOUT_MS);
    // Abandon path: if the caller bails (prompt() throws before the collector
    // is ever reached), settle now — otherwise the armed hard timeout fires
    // TURN_TIMEOUT_MS later into an unhandled rejection and the process hangs
    // the full window (boot-latch test, 2026-10-30: "turn timed out" at 180s).
    abortFn = () => settle(reject, new Error("turn aborted"));

    // Resolve the live ask (answer or cancel): unregister the interception
    // entry, resume the paused turn timeout with its remaining budget, and
    // submit to the runtime — the turn then continues to its own idle.
    const resolveAsk = (cancelled, answers = []) => {
      if (!askEntry) return;
      const entry = askEntry;
      askEntry = null;
      state.pendingAsks.delete(sessionId);
      clearTimeout(entry.timer);
      armTimeout(Math.max(0, deadlineAt - Date.now()));
      ctx.dshBridge?.answerUserQuestion
        ?.({ sessionId, askId: entry.askId, ...(cancelled ? { cancelled: true } : { answers }) })
        ?.catch((e) => console.warn(`[bots] "${bot?.name}" ask submit failed: ${e.message}`));
    };

    ctx.sessionCollectors.set(sessionId, (notif) => {
      const { method, params } = notif;
      if (method === "session.status" && params.status === "idle") {
        return settle(resolve, { text, error, usedTools });
      }
      if (method === "userQuestion/ask") {
        const askId = typeof params?.askId === "string" ? params.askId : null;
        const questions = Array.isArray(params?.questions) ? params.questions : [];
        if (!askId || !adapter || questions.length === 0) return;
        // Pause the hard timeout while the human holds the floor.
        clearTimeout(timer);
        askEntry = {
          bot,
          adapter,
          chatKey,
          askId,
          questions,
          attempts: 0,
          timer: null,
          resolve: resolveAsk,
        };
        state.pendingAsks.set(sessionId, askEntry);
        askEntry.timer = setTimeout(() => {
          // Wait window expired: cancel the ask; the turn continues normally.
          if (askEntry) {
            const notice = "等待超时，已取消本次问询。";
            resolveAsk(true);
            adapter
              .sendText(bot.credentials, chatKey, notice)
              .catch((e) => console.warn(`[bots] "${bot.name}" send failed: ${e.message}`));
          }
        }, ASK_WAIT_MS);
        adapter
          .sendText(bot.credentials, chatKey, renderQuestionText(questions))
          .then(() => console.log(`[bots] "${bot.name}" asked ${chatKey} a question (${questions.length} q)`))
          .catch((e) => console.warn(`[bots] "${bot.name}" send failed: ${e.message}`));
        return;
      }
      // LLM failure capture rides the bridge-forwarded stream lane's finish
      // frames (restore-assistant-stream-020 — the 0.2.0 session format
      // removed the assistant/chunk event this used to read).
      if (method === "platform/stream") {
        const chunk = params?.frame?.chunk;
        if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
          error = chunk.reason.failure?.message || "LLM request failed";
        }
        return;
      }
      if (method !== "session.event") return;
      const ev = params.event;
      if (ev?.type === "assistant/message") {
        const blocks = ev.data?.message?.content;
        if (Array.isArray(blocks)) {
          const t = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) text = t;
        }
      } else if (ev?.type === "tool/call") {
        // The ask tool is the whitelisted exception (add-user-questions): a
        // turn that only asked must not count as tool-derived — its reply is
        // the user's own answer carried back.
        if (ev.data?.name !== "ask_user_question") usedTools = true;
      }
    });
  });
  // Exposed for the caller's bail path (prompt threw): settles the collector
  // so the hard timeout is disarmed and never surfaces as an unhandled reject.
  promise.abort = () => abortFn?.();
  return promise;
}

// ── Seen chats (relay destinations) ─────────────────────────────────────────
//
// The chat key only ever arrives with a message, and the dsh session id is a
// one-way hash of it — so without this record there is no way to enumerate (or
// bind) a destination. Recorded only after the platform's own verification and
// the size check, so unverified content still never reaches storage, and
// failure-isolated: a broken store must not cost the user their answer.
function recordChat(bot, botId, chatKey, senderName) {
  try {
    state.ctx?.db?.upsertBotChat(botId, chatKey, senderName);
  } catch (e) {
    console.warn(`[bots] "${bot.name}" could not record the chat: ${e.message}`);
  }
}

// Run one agent turn for an inbound message and deliver the reply. Turns within
// a chat are serialized (queued on the session id); different chats run in
// parallel. Every failure path still tries to tell the user something.
export async function handleMessage(botId, { chatKey, senderName, text }) {
  const entry = state.bots.get(botId);
  if (!entry || !entry.bot.enabled) return;
  const { bot } = entry;

  if (!text || text.length > MAX_MESSAGE_CHARS) {
    console.warn(`[bots] "${bot.name}" dropped an oversized/empty message from a chat`);
    state.ctx?.recordSignalDisposition?.(botId, { fate: "filtered", reason: text ? "size_guard" : "empty_message", chatKey: chatKey ?? null });
    return;
  }
  // Sender allowlist (add-staff-fleet-channels D1): the gate sits BEFORE every
  // side effect — no chat record, no rate token, no readiness wait, no session,
  // no model call. Order matters: rejecting after recording/limiting would let
  // a stranger consume this bot's bookkeeping and its per-chat budget.
  if (!isSenderAllowed(bot, senderName)) {
    // Log the fact, never the identity: a plaintext id in the log would turn
    // "who tried" into something retrievable from disk. The hash is enough to
    // tell two different senders apart and to count them.
    const who = hashSender(senderName);
    console.warn(`[bots] "${bot.name}" rejected a sender outside its allowlist (sender#${who})`);
    state.ctx?.recordSignalDisposition?.(botId, { fate: "filtered", reason: "sender_not_allowed", chatKey: chatKey ?? null, sender: who });
    return;
  }
  recordChat(bot, botId, chatKey, senderName);
  if (!takeToken(botId, chatKey)) {
    console.warn(`[bots] "${bot.name}" rate limit hit for a chat; message dropped`);
    state.ctx?.recordSignalDisposition?.(botId, { fate: "filtered", reason: "rate_limited", chatKey: chatKey ?? null, sender: senderName ?? null });
    return;
  }

  // Fleet event wake (add-fleet-event-wake): a declared event edge turns this
  // inbound message into a post's manual turn. Optional-chained — no fleet
  // face (or old deployment) means zero disturbance. The bot's own turn below
  // is untouched: the dual-turn is the edge owner's declared choice.
  // add-turn-mandate-lane: `addressed` is the v1 mention heuristic (the bot's
  // name appears in the text) — only the admission table's non-edge rows read
  // it; edge hits are unaffected.
  try {
    const addressed = Boolean(bot.name) && text.toLowerCase().includes(String(bot.name).toLowerCase());
    const woken = state.ctx?.triggerFleetEventWake?.(botId, { chatKey, senderName, text, addressed });
    if (Array.isArray(woken) && woken.length) {
      console.log(`[bots] "${bot.name}" message woke ${woken.length} fleet post(s): ${woken.map((w) => w.memberId).join(",")}`);
    }
  } catch { /* the wake's own guard already logged; the chat turn proceeds */ }

  // Zhiyu IM bridge (add-zhiyu-im-bridge): a bound bot routes to the room
  // instead of founding a bot session. When the bridge declines (gate off,
  // outbound fetch failure), the legacy session path continues — the message
  // degrades honestly instead of vanishing.
  if (bot.zhiRoomId || bot.zhiAccountId) {
    let bridged = false;
    try {
      state.ctx?.zhiyuImBridge?.noteInboundChat(bot.id, chatKey);
      bridged = Boolean(await state.ctx?.zhiyuImBridge?.handleInbound({ bot, chatKey, senderName, text }));
    } catch (err) {
      console.warn(`[bots] zhiyu-im-bridge erred for "${bot.name}": ${err.message}; legacy path continues`);
      bridged = false;
    }
    if (bridged) return;
  }

  const sessionId = sessionIdFor(botId, chatKey);
  // 结构化输入请求待答？（add-input-request-cards）它比问询更早判：一张卡可能
  // 在回合结束后仍然待答，此时入站消息只可能是它的答案。
  const pendingInput = state.pendingInputs.get(sessionId);
  if (pendingInput) {
    void deliverInputAttempt(pendingInput, text);
    return;
  }
  // A question waiting in this chat? The message is its answer attempt, not a
  // new turn (add-user-questions). The guards above still applied — answering
  // an ask enjoys no size/rate exemption.
  const pendingAsk = state.pendingAsks.get(sessionId);
  if (pendingAsk) {
    void deliverAskAttempt(pendingAsk, text);
    return;
  }
  const tail = state.queues.get(sessionId) ?? Promise.resolve();
  const run = tail.then(() => runTurn(entry, sessionId, chatKey, text));
  // Keep the chain alive past a failed turn, and drop the entry once idle so
  // the map does not grow without bound across many chats.
  state.queues.set(
    sessionId,
    run.then(
      () => { if (state.queues.get(sessionId) === run) state.queues.delete(sessionId); },
      () => { if (state.queues.get(sessionId) === run) state.queues.delete(sessionId); },
    ),
  );
  return run;
}

// Identity block (design D2). Without one, a bot turn runs under the CELL's
// default preset — the owner's own operator persona — which is how "what can
// you do" got answered with the fleet's decision queue (prod 2026-10-31). The
// neutral default names the bot and forbids impersonating internal roles, so an
// unconfigured bot still answers as itself.
function personaBlock(bot) {
  const own = String(bot?.persona ?? "").trim();
  if (own) return own;
  return (
    `你是「${bot?.name ?? "助手"}」，一个对外聊天渠道里的助手。` +
    "只用你自己的知识回答；不要冒充运营者、舰队副驾、内部运维或其他内部角色，" +
    "也不要描述内部决策队列、运营状态或工具面。"
  );
}

// Mounted pack skill (pack-bot-units, spec pack-bot-units): a channel bot
// born from a pack may mount exactly one of the pack's own skills; the
// inbound turn is then answered through THAT skill's session — the skill's
// process and honesty constraints govern the answer, with no fleet involved.
// The skill body is read from the cell's skill store at turn time (fresh
// after pack upgrades) and injected as the session's opening context block;
// a missing/uninstalled skill degrades to the plain turn (logged).
function mountedSkillPreamble(bot) {
  const meta = packBotMeta(bot.credentials);
  const skillName = meta?.skill;
  if (!skillName) return null;
  let row = null;
  try {
    row = state.ctx?.db?.getCustomSkill?.(skillName) ?? null;
  } catch { /* a broken store must not cost the user their answer */ }
  if (!row?.content?.trim()) {
    console.warn(`[bots] "${bot.name}" mounted skill '${skillName}' is not available; answering without it`);
    return null;
  }
  return (
    `You are the bot "${bot.name}". The skill below governs this conversation: follow its process, ` +
    `workflow and honesty constraints when answering the user's messages.\n\n` +
    `# Mounted skill: ${row.name}\n\n${row.content.trim()}`
  );
}

async function runTurn({ bot, adapter }, sessionId, chatKey, text) {
  const ctx = state.ctx;
  // 中间态句柄（waiting-ack）：edit 车道会在结束时把答案编辑进占位消息，
  // placeholder 车道的占位已经发出去、答案另发。none 车道这里拿到 null。
  // 放在最前面：用户等的是「有没有被接住」，越早越好。
  const ackBinding = await beginAck(bot, adapter, chatKey);
  const reply = async (body) => {
    const clean = stripReasoningLeak(body);
    if (!clean) {
      // Nothing but reasoning came back: answer honestly instead of sending a
      // bare "<thinking>…" wall to the chat platform.
      console.warn(`[bots] "${bot.name}" dropped a reasoning-only reply to ${chatKey}`);
      return replyRaw("Sorry — I could not put that answer into words. Please ask again.");
    }
    return replyRaw(clean);
  };
  // 对外发言闸 (add-principal-disclosure-gate)。出站只有这一个门：披露判定读
  // 将要发出的原文，不是摘要；台账只存 digest（在平台再存一份「代理以你名义
  // 说过的话」等于凭空造出第二个敏感面）。
  //
  // 未持有委托状（bot 由主人自己驱动、无域配置）→ fallback，行为与改造前一致。
  // 这是刻意的：先让闸可观测，再让闸可拒绝。
  const gateAndSend = async (body) => {
    const mandate = typeof bot.mandate === "object" && bot.mandate ? bot.mandate : null;
    const gate = gateOutboundMessage({
      policy: mandate?.policy ?? null,
      domain: mandate?.domain ?? null,
      text: String(body ?? ""),
      to: chatKey,
      channel: bot?.channel ?? bot?.type ?? "bot",
      principal: mandate ? { kind: "agent", email: bot.ownerEmail ?? null } : { kind: "owner", email: bot.ownerEmail ?? null },
      declaredSources: mandate?.declaredSources ?? [],
    });
    if (!gate.ok && gate.decision !== "fallback") {
      console.warn(`[bots] "${bot.name}" reply withheld by disclosure gate (${gate.reason})`);
      return;
    }
    // 中间态是 edit 时，答案直接编辑进那条占位消息——同一条消息从头到尾，
    // 用户不会先看到「正在处理」再看到答案，而是它变成了答案。编辑失败则
    // deliverText 另发一条（setttleAck 返回 false）。
    if (!(await settleAck(bot, null, ackBinding, body))) {
      await deliverText(bot, adapter, chatKey, body);
    }
    // 台账写入 (3.2)：只存 digest，不存原文。写失败不阻断发送——发送已经
    // 发生了，把失败留给日志而不是回滚一条已发出的消息。
    if (gate.ok && gate.ledger) {
      try {
        recordOutboundLedger?.(gate.ledger);
      } catch (e) {
        console.warn(`[bots] outbound ledger write failed: ${e.message}`);
      }
    } else if (gate.decision === "fallback") {
      // 无委托状的出站（bot 由主人自己驱动）：记可观测事实但不算代理发言。
      // 这里不写台账——它不是「代理以你名义说的话」，混进去会污染放量样本。
    }
  };
  const replyRaw = async (body) => {
    try { await gateAndSend(body); }
    catch (e) { console.warn(`[bots] "${bot.name}" send failed: ${e.message}`); return; }
    // A SUCCESSFUL send is otherwise silent — "did the reply land" was
    // indistinguishable from "the turn never ran" (fd-prod 2026-10-29: the
    // WeCom loop looked dead for an hour while it was answering fine). Mirror
    // the inbound line's shape; same 60-char trim, same content policy.
    console.log(`[bots] "${bot.name}" replied to ${chatKey}: "${String(body).slice(0, 60)}"`);
  };
  // Runtime readiness (design D1): wait within budget instead of replying
  // "starting up" the instant the flag is false. A rollout makes this window
  // routine — every deploy restarts the child — and the platform has already
  // been ACKed, so waiting costs nothing but latency.
  if (!ctx?.dshBridge?.isReady()) {
    const budget = readyWaitMs();
    const waited = await waitForRuntime(ctx, budget);
    if (waited === null) {
      console.warn(
        `[bots] "${bot.name}" runtime still not ready after ${budget}ms wait; replying with the startup notice`,
      );
      return reply("The assistant is starting up. Please try again shortly.");
    }
    console.log(`[bots] "${bot.name}" waited ${waited}ms for the runtime before starting the turn`);
  }

  // durationMs starts at the agent turn proper (observe-tap): the readiness
  // wait above is a pre-turn bounce, not part of the turn being captured.
  const turnStartedAt = Date.now();
  const collected = collectTurn(ctx, sessionId, { bot, adapter, chatKey });
  const toolsOn = allowToolsFor(bot);
  const prompt = toolsOn ? text : NO_TOOLS_PREFIX + text;
  // Block order (design D2): identity first, then the mounted pack skill (if
  // any), then the user's message. The identity block is what stops a bot from
  // speaking as the cell's default operator persona.
  const blocks = [{ type: "text", text: personaBlock(bot) }];
  const skillPreamble = mountedSkillPreamble(bot);
  if (skillPreamble) blocks.push({ type: "text", text: skillPreamble });
  blocks.push({ type: "text", text: prompt });
  let result;
  // Observe-tap outcome bookkeeping (add-platform-guaranteed-capture D1.2):
  // promptSettled separates a prompt-throw (→ error) from a collector
  // termination after the prompt landed — the collector only rejects through
  // its own hard timeout / abort, i.e. the turn was cut short without an LLM
  // conclusion (→ aborted).
  let tapOutcome = null;
  let promptSettled = false;
  // The streaming flag is what dsh-mcp-delivery's isStreaming() reads and what
  // bridge.exit's fan-out enumerates: the bot lane bypasses ctx.session.prompt
  // (which is what sets this flag for web turns), so without it a credential-
  // change restart sees "idle" and kills the runtime MID-TURN — the collector
  // then waits for a session.status idle that never comes and dies on the
  // 180s timeout (prod: every bot turn died this way).
  ctx.setStreaming?.(sessionId, true);
  try {
    await ctx.dshBridge.prompt(sessionId, blocks);
    promptSettled = true;
    result = await collected;
  } catch (e) {
    // Abandon the collector: a throw here (or a later unawaited timeout) must
    // not linger; abort disarms the hard timeout so it cannot fire into an
    // unhandled rejection after this function has already returned.
    tapOutcome = promptSettled ? "aborted" : "error";
    if (typeof collected?.abort === "function") collected.abort();
    else ctx.sessionCollectors.delete(sessionId);
    collected?.catch?.(() => {});
    console.warn(`[bots] "${bot.name}" turn failed: ${e.message}`);
    return reply("Sorry — I could not complete that request.");
  } finally {
    // 心跳必须在这里停：它在 finally 之外还可能延续到回合结束后。
    if (ackBinding?.beat) { clearInterval(ackBinding.beat); ackBinding.beat = null; }
    ctx.setStreaming?.(sessionId, false);
    // Platform-guaranteed capture (add-platform-guaranteed-capture D1.2): one
    // L0 turn_outcome per bot turn into the deployment owner's person root —
    // fire-and-forget, never awaited, never throws; delivery, the reply gate
    // and the audit path are untouched. The gate check below runs AFTER the
    // turn has completed, so a gate-withheld turn still reports ok here (the
    // outcome records the turn, not the reply disposition). A legacy row
    // without owner_email drops the tap inside (fail-open, same contract as
    // the fleet capture).
    observeTurnTap({
      ownerEmail: bot.ownerEmail ?? null,
      lane: "bot",
      sessionId: chatKey,
      agentId: bot.id,
      outcome: tapOutcome ?? (result?.error ? "error" : "ok"),
      durationMs: Date.now() - turnStartedAt,
      title: text,
      body: result?.text ?? "",
    });
  }

  if (result.error) return reply(`Sorry — ${result.error}`);
  if (result.usedTools && !toolsOn) {
    console.warn(`[bots] "${bot.name}" turn used tools under the no-tools posture; reply withheld`);
    return reply("Sorry — I cannot answer that from this channel.");
  }
  // Assistant final text only — never tool output or raw events (design D3.4).
  if (result.text) await reply(result.text);

  // 占位消息的兜底收尾（waiting-ack）：正常路径上 reply 已经通过 settleAck
  // 把占位编辑成答案了；但披露闸拦截、tools-posture 拦截这类**不发**的分支
  // 不会调用 reply，占位就会永远停在「正在处理…」——那比黑洞更糟（它明确
  // 承诺了有下文）。放在所有 reply 之后：早放会抢在答案前面把占位改写掉。
  if (ackBinding && !ackBinding.used && ackBinding.messageId) {
    await settleAck(bot, null, ackBinding, "抱歉，这次没能给出回答，请再试一次。").catch(() => {});
  }
}

/**
 * 旁路尝试落盘 (add-principal-disclosure-gate 1.3b)。
 *
 * 一个只有写入入口、没有消费方的告警等于没有告警——所以这条记录直接进同一本
 * 越界计数（`mandateViolations`），摘要里会出现「旁路尝试 × N」。
 *
 * 记录永不抛：检测失败不能让本来正常的路径崩掉。
 */
export function noteOutboundBypass(source, detail = null) {
  return noteBypassAttempt({
    source,
    detail,
    onRecord: (entry) => {
      try {
        // 惰性导入：bots 模块在 fleet DB 未启用时也必须能加载。
        import("./routes/fleets-db.js")
          .then((m) => m.getFleetDatabase?.()?.recordMandateViolation?.(null, "bypass"))
          .catch(() => {});
      } catch {
        /* 记录失败不阻断 */
      }
      return entry;
    },
  });
}

// Proactive outbound send (admin-gated at the route).
//
// 走同一道披露闸 (add-principal-disclosure-gate 1.2/1.3)。这条路一开始是直接
// 调 adapter 的——那本身就是一条旁路，而且是最容易被忽略的一条：它不是「代理
// 在说话」，而是「有人用代理的嘴说话」，所以更需要留痕。
//
// 无委托状（owner 主动外发）→ fallback → 照发（行为不变），但不入代理发言台账：
// 混进去会把「主人自己发的」算成「代理判断正确」，污染放量样本。
/**
 * Send one message through whichever transport this bot row is on
 * (adopt-fd-bot-transport 6.3). This is the ONLY place that decides, so the two
 * paths cannot drift: every caller above it already applied the disclosure gate
 * and the guards, and neither knows which leg carries the bytes.
 *
 * fd-bot answers `{ok:false, failure}` with HTTP 200 for platform verdicts
 * (ip-not-allowed / reply-window-closed / other). Those are THROWN here as an
 * Error carrying `.failure`, because every caller treats "did not land" as a
 * failure — but the classification survives for the caller to report.
 * A transport failure (service down) throws with `.code = "fd_bot_unreachable"`.
 */
// ── 中间态：让提问的人知道消息被接住了 ────────────────────────────────────────
//
// 问题的形状（2026-11-22）：复杂问话的回答可能要几分钟，而这期间平台上**一条
// 消息都没有**——用户看到的是吞掉输入的黑洞，读成「功能坏了」。
//
// 但「怎么告诉用户在处理」不是一句话能统一的事，平台机制差别极大（能力位声明
// 在 adapter.ack，这里只按能力执行）：
//
//   edit        先发占位，跑完后编辑成答案。一条消息从头到尾，最干净。
//               编辑失败 → 回落成另发一条（答案不能因为编辑失败丢）。
//   placeholder 先发短回执，答案另发。两条消息，但每个平台都能做。
//   none        不发（wecom-bot 的 response_code 一次性消费，发了回执答案就发
//               不出去；wecom-webhook 出站专用）。这条车道只能靠「尽快出答案」。
//
// 中间态的任何失败都**不能**影响答案：这里的每一个调用都是尽力而为，抛了就记
// 日志继续跑回合。
const ACK_COPY_EVENT = "bot_ack";

function ackCopy() {
  try {
    const text = copyForEvent(laneCfg.get(), ACK_COPY_EVENT, null);
    return String(text ?? "").trim();
  } catch {
    return "";
  }
}

// 回合开始：按能力发中间态。返回一个句柄给 settleAck 用；null = 这条车道不发
// （能力 none，或文案被配置成空）。
async function beginAck(bot, adapter, chatKey) {
  const cap = ackCapabilityOfBot(bot);
  if (cap.mode !== "edit" && cap.mode !== "placeholder") return null;
  const text = ackCopy();
  if (!text) return null;
  // fd-bot transport owns its own delivery window; the intermediate state is a
  // property of the platform adapter, so an fd-bot bot skips it here rather
  // than double-sending through two paths.
  if (bot.transport === "fd-bot" && bot.fdBotBindingId) return null;
  const ack = adapter?.ack;
  if (!ack || typeof ack.placeholder !== "function") return null;
  try {
    const messageId = await ack.placeholder(bot.credentials, chatKey, text);
    const binding = { mode: cap.mode, chatKey, messageId: messageId ?? null, ack, used: false, beat: null };
    // 心跳只对 edit 生效（没有 messageId 就无从改写）。
    if (cap.mode === "edit" && binding.messageId && typeof ack.edit === "function" && ACK_BEAT_MS > 0) {
      const started = Date.now();
      binding.beat = setInterval(() => {
        if (binding.used) return;
        const secs = Math.round((Date.now() - started) / 1000);
        const tick = `${text.replace(/[….]+$/, "")}（已 ${secs} 秒）`;
        ack.edit(bot.credentials, chatKey, binding.messageId, tick).catch(() => {});
      }, ACK_BEAT_MS);
      if (typeof binding.beat.unref === "function") binding.beat.unref();
    }
    return binding;
  } catch (e) {
    console.warn(`[bots] "${bot?.name}" ack placeholder failed: ${e.message}`);
    return null;
  }
}

// 回合结束：把答案交给中间态（编辑成答案），或者回落到另发一条。
// 返回 true 表示答案已经送出去了，调用方不必再 deliverText。
async function settleAck(bot, entry, binding, answer) {
  if (!binding || binding.used) return false;
  // placeholder 模式：占位已经发出去了，答案另发一条（走正常的发送路径，
  // 因为答案要过披露闸）。
  if (binding.mode !== "edit" || !binding.messageId) return false;
  // 编辑只发生一次：这条回合的第一个真实回复占据占位消息。之后的回复
  // （问询追问、错误兜底）另发——占位消息已经是第一条答案的正文。
  binding.used = true;
  if (binding.beat) { clearInterval(binding.beat); binding.beat = null; }
  try {
    const ok = await binding.ack.edit(bot.credentials, binding.chatKey, binding.messageId, answer);
    if (ok) return true;
    console.warn(`[bots] "${bot?.name}" ack edit failed; falling back to a separate answer message`);
    return false;
  } catch (e) {
    console.warn(`[bots] "${bot?.name}" ack edit threw: ${e.message}; falling back`);
    return false;
  }
}

async function deliverText(bot, adapter, chatKey, text) {
  if (bot.transport === "fd-bot" && bot.fdBotBindingId) {
    if (!fdBotConfigured()) {
      // Configured to use fd-bot but the cell has no address for it: refuse
      // loudly. Falling back to the legacy adapter would double-deliver once
      // fd-bot comes back and re-delivers its queue.
      const err = new Error("bot is on the fd-bot transport but FD_BOT_URL/FD_BOT_SECRET are not set");
      err.code = "fd_bot_unreachable";
      throw err;
    }
    const verdict = await sendThrough({ bindingId: bot.fdBotBindingId, chatKey, text });
    if (!verdict.ok) {
      const err = new Error(verdict.detail || `send failed (${verdict.failure})`);
      err.failure = verdict.failure;
      throw err;
    }
    return;
  }
  await adapter.sendText(bot.credentials, chatKey, text);
}

export async function sendTo(botId, chatKey, text) {
  const entry = state.bots.get(botId);
  if (!entry) throw new Error("Bot not found or not running");
  const bot = entry.bot;
  const mandate = typeof bot.mandate === "object" && bot.mandate ? bot.mandate : null;
  const gate = gateOutboundMessage({
    policy: mandate?.policy ?? null,
    domain: mandate?.domain ?? null,
    text: String(text ?? ""),
    to: chatKey,
    channel: bot?.channel ?? bot?.type ?? "bot",
    principal: mandate ? { kind: "agent", email: bot.ownerEmail ?? null } : { kind: "owner", email: bot.ownerEmail ?? null },
    declaredSources: mandate?.declaredSources ?? [],
    channelRevocable: bot?.revocable === true,
  });
  if (!gate.ok && gate.decision !== "fallback") {
    const err = new Error(`outbound withheld by disclosure gate: ${gate.reason}`);
    err.code = "disclosure_gate";
    err.violations = gate.disclosure?.violations ?? [];
    throw err;
  }
  await deliverText(bot, entry.adapter, chatKey, text);
  if (gate.ok && gate.ledger) {
    try { recordOutboundLedger?.(gate.ledger); } catch { /* 台账失败不阻断已发出的消息 */ }
  }
}

// ── Relay: machine callers on a trusted network ──────────────────────────────
//
// Authentication lives in the route (server/routes/bot-relay.js); everything
// past it is destination resolution, guards, delivery, and audit. Delivery goes
// through the runtime entry's adapter — the same object the reply path uses —
// so platform token caches and any polling loop keep exactly one owner in this
// process (design D1). The caller names a channel; the destination is the
// admin's binding, so a leaked token can only reach approved chats.

// A bounded response for a machine caller. The adapter's fetch keeps running
// without an AbortSignal, so this bounds the wait, not the socket.
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`send timed out after ${ms}ms`)), ms);
    }),
  ]);
}

// Platform errors quote the request URL, and for Telegram that URL *is* the
// credential (`/bot<token>/sendMessage`); WeCom/WeChat put an access token in a
// query string. Both the HTTP answer and the audit row go through this, so a
// failed send never republishes the bot's credentials.
function redactCredentials(message, credentials) {
  let out = String(message ?? "");
  for (const value of Object.values(credentials ?? {})) {
    const secret = String(value ?? "");
    if (secret.length >= 6) out = out.split(secret).join("***");
  }
  return out;
}

// Returns { ok: true } or { ok: false, reason, error }, with `reason` a stable
// token the route maps to an HTTP status. Every attempt past authentication
// writes exactly one audit row — length, never text.
export async function relaySend(channel, rawText) {
  const db = state.ctx?.db;
  const text = String(rawText ?? "");
  const chars = text.length;
  const audit = (outcome, botId, error) => {
    try {
      db?.insertRelayLog({ channel, botId, textChars: chars, outcome, error });
    } catch (e) {
      console.warn(`[bots] relay audit write failed: ${e.message}`);
    }
  };

  if (!db?.isDbReady()) {
    console.warn("[bots] relay send refused: database unavailable");
    return { ok: false, reason: "unavailable" };
  }

  const binding = db.getChannel(channel);
  if (!binding) {
    audit("rejected", null, "unknown channel");
    return { ok: false, reason: "unknown-channel" };
  }

  // Deliberately stricter than the admin endpoint (design D7): the relay is
  // network-reachable, so a disabled bot means the channel is out of service.
  const bot = db.getBot(binding.botId);
  if (!bot || !bot.enabled) {
    audit("rejected", binding.botId, "bot missing or disabled");
    return { ok: false, reason: "bot-unavailable" };
  }

  if (!text || chars > MAX_RELAY_CHARS) {
    audit("rejected", bot.id, text ? "text over the relay cap" : "empty text");
    return { ok: false, reason: "too-long" };
  }

  if (!takeRelayToken(binding.name, bot.id, binding.chatKey)) {
    audit("rejected", bot.id, "channel rate limit");
    return { ok: false, reason: "rate-limited" };
  }

  const entry = state.bots.get(bot.id);
  if (!entry) {
    audit("rejected", bot.id, "no runtime entry for the bot");
    return { ok: false, reason: "bot-unavailable" };
  }

  try {
    await withTimeout(
      deliverText(bot, entry.adapter, binding.chatKey, text),
      RELAY_SEND_TIMEOUT_MS,
    );
  } catch (err) {
    const error = redactCredentials(err.message, bot.credentials);
    audit("failed", bot.id, error);
    return { ok: false, reason: "send-failed", error };
  }
  audit("sent", bot.id, null);
  // Outbound accountability (C4.2): the relay lane writes its own ledger row with
  // channel "relay" so a machine caller's message is traceable on the same face
  // as a bot reply. Digest only (from the identical text); never原文.
  try {
    recordOutboundLedger(
      { audience: `${bot.type}:${binding.chatKey}`, contentDigest: crypto.createHash("sha256").update(String(text)).digest("hex") },
      "relay",
    );
  } catch (e) {
    console.warn(`[bots] relay outbound ledger write failed: ${e.message}`);
  }
  return { ok: true };
}
