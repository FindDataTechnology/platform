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

import crypto from "node:crypto";
import { getAdapter, validateCredentials } from "./bots/adapter.js";

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
export function maskBot(bot) {
  return {
    id: bot.id,
    type: bot.type,
    name: bot.name,
    enabled: bot.enabled,
    createdAt: bot.createdAt,
    configuredCredentials: Object.entries(bot.credentials ?? {})
      .filter(([, v]) => String(v ?? "").trim())
      .map(([k]) => k),
    webhookUrl: webhookUrlFor(bot),
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function initBots(ctx) {
  state.ctx = ctx;
  if (!ctx.db.isDbReady()) {
    console.warn("[bots] disabled: database unavailable");
    return;
  }
  for (const bot of ctx.db.listBots()) reload(bot);
  const live = [...state.bots.values()].filter((e) => e.bot.enabled).length;
  if (live) console.log(`[bots] ${live} bot(s) active`);
}

// (Re)build one bot's runtime entry from its row: stop whatever was running,
// then start the new config. Called on every config mutation, so changes take
// effect without a server restart.
export function reload(bot) {
  stop(bot.id);
  const adapter = getAdapter(bot.type);
  if (!adapter) {
    console.warn(`[bots] "${bot.name}" has unknown type "${bot.type}"; skipped`);
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

// Collect one turn's outcome off the session's notification stream. Registered
// BEFORE prompt() so no early event is missed; always unregistered. With
// {bot, adapter, chatKey} the collector also serves as this turn's ask
// surface (add-user-questions): a `userQuestion/ask` notification renders the
// question into the chat and registers the interception entry; the turn's
// hard timeout PAUSES while the human holds the floor and resumes with its
// remaining budget when the ask resolves.
function collectTurn(ctx, sessionId, { bot = null, adapter = null, chatKey = null } = {}) {
  return new Promise((resolve, reject) => {
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
          .catch((e) => console.warn(`[bots] "${bot.name}" send failed: ${e.message}`));
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
      } else if (
        ev?.type === "assistant/chunk" &&
        ev.data?.chunk?.type === "finish" &&
        ev.data.chunk.reason?.kind === "error"
      ) {
        error = ev.data.chunk.reason.failure?.message || "LLM request failed";
      }
    });
  });
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
    return;
  }
  recordChat(bot, botId, chatKey, senderName);
  if (!takeToken(botId, chatKey)) {
    console.warn(`[bots] "${bot.name}" rate limit hit for a chat; message dropped`);
    return;
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

async function runTurn({ bot, adapter }, sessionId, chatKey, text) {
  const ctx = state.ctx;
  const reply = async (body) => {
    try { await adapter.sendText(bot.credentials, chatKey, body); }
    catch (e) { console.warn(`[bots] "${bot.name}" send failed: ${e.message}`); }
  };
  if (!ctx?.dshBridge?.isReady()) return reply("The assistant is starting up. Please try again shortly.");

  const collected = collectTurn(ctx, sessionId, { bot, adapter, chatKey });
  const prompt = allowTools() ? text : NO_TOOLS_PREFIX + text;
  let result;
  try {
    await ctx.dshBridge.prompt(sessionId, [{ type: "text", text: prompt }]);
    result = await collected;
  } catch (e) {
    ctx.sessionCollectors.delete(sessionId);
    console.warn(`[bots] "${bot.name}" turn failed: ${e.message}`);
    return reply("Sorry — I could not complete that request.");
  }

  if (result.error) return reply(`Sorry — ${result.error}`);
  if (result.usedTools && !allowTools()) {
    console.warn(`[bots] "${bot.name}" turn used tools under the no-tools posture; reply withheld`);
    return reply("Sorry — I cannot answer that from this channel.");
  }
  // Assistant final text only — never tool output or raw events (design D3.4).
  if (result.text) await reply(result.text);
}

// Proactive outbound send (admin-gated at the route).
export async function sendTo(botId, chatKey, text) {
  const entry = state.bots.get(botId);
  if (!entry) throw new Error("Bot not found or not running");
  await entry.adapter.sendText(entry.bot.credentials, chatKey, text);
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
