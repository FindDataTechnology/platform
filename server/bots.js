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
import { adapterForBot, validateCredentials } from "./bots/adapter.js";
import { isGenericBotType, packBotMeta, PACK_BOT_CREDENTIAL_KEY } from "../lib/generic-bot-types.js";
import { observeTurnTap } from "./observe-tap.js";
import { gateOutboundMessage, noteBypassAttempt } from "../lib/outbound-message.js";

// Outbound accountability ledger writer — NOT IMPLEMENTED YET, and this null is
// deliberate. The call sites below said `recordOutboundLedger?.(…)` with no such
// binding anywhere: `?.` guards a nullish VALUE, never an undeclared NAME, so
// every bot send that carried `gate.ledger` threw `ReferenceError:
// recordOutboundLedger is not defined` — swallowed by their try/catch, leaving
// the accountability trail (spec: principal-disclosure-accountability, "每次对外
// 发言 SHALL 记录") silently empty and, on one site, a misleading warning per
// send. Declaring the seam makes the optional call what it always meant to be.
//
// Wiring it for real needs a decision the disclosure owner has to make: the
// audit table (`action_audit`) requires line/action_id/args_digest/risk/target/
// impact_text/result_summary as NOT NULL, and a bot utterance has none of those.
// Tracked in openspec/changes/bot-outbound-accountability-ledger.
const recordOutboundLedger = null;

// Trust-boundary guards (design D3). These bound an untrusted external caller's
// reach into an agent, so they live here — before prompt() — not in the adapters.
const MAX_MESSAGE_CHARS = 4000;
const RATE_LIMIT_PER_MIN = 10;
const TURN_TIMEOUT_MS = Number(process.env.BOTS_TURN_TIMEOUT_MS) || 180_000;

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
};

const allowTools = () => process.env.BOTS_ALLOW_TOOLS === "1";

// Per-bot tool posture (harden-bot-reply-lane, design D3). The deployment env
// is a CEILING, not the switch: `BOTS_ALLOW_TOOLS` off means no bot runs tools
// whatever its own flag says (the群聊 decision: a multi-member room must be
// able to be clamped shut from the deployment). The prompt prefix and the
// reply-side withhold BOTH read this one function — they were two separate
// checks that the same env lifted together, which is how the prod drift
// (BOTS_ALLOW_TOOLS=1 → every bot answered with fleet-operator tool output)
// went unnoticed.
const allowToolsFor = (bot) => allowTools() && Boolean(bot?.allowTools);

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
    adapter.sendText(bot.credentials, chatKey, body).catch((e) => {
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
  if (bot.zhiRoomId) {
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
    await adapter.sendText(bot.credentials, chatKey, body);
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
  await entry.adapter.sendText(bot.credentials, chatKey, text);
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
      entry.adapter.sendText(bot.credentials, binding.chatKey, text),
      RELAY_SEND_TIMEOUT_MS,
    );
  } catch (err) {
    const error = redactCredentials(err.message, bot.credentials);
    audit("failed", bot.id, error);
    return { ok: false, reason: "send-failed", error };
  }
  audit("sent", bot.id, null);
  return { ok: true };
}
