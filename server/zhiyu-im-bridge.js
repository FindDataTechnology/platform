// ── Zhiyu IM bridge, cell half (add-zhiyu-im-bridge, design D-A) ─────────────
//
// Called from bots.js's inbound hook BEFORE the legacy agent-turn: when the
// bot row carries zhiRoomId and the gate is enabled, the group message is
// POSTed to the gateway's bridge ingest lane instead of starting a bot
// session. A fetch-level failure returns false, so the caller degrades to the
// legacy session path for that message only — never silently dropped. The
// outbound half polls the gateway's bot-scoped event face and replays room
// answers back into IM with seat attribution, restarting cursor-safe.

import { GATEWAY_SECRET_HEADER } from "./auth.js";
import { adapterForBot as defaultAdapterForBot } from "./bots/adapter.js";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

const RELAY_MAX_CHARS = 3800; // below every target platform's hard cap, once and for all
const OUTBOUND_PER_MIN = 60;

export function createZhiyuImBridge({ db, env = process.env, fetchImpl = null, log = console, adapterForBotFn = null }) {
  const selectAdapter = adapterForBotFn ?? defaultAdapterForBot;
  const enabled = () => ["1", "true", "yes"].includes(String(env.ZHIYU_IM_BRIDGE_ON || "").toLowerCase());
  const gatewayBase = () => (env.GATEWAY_INTERNAL_URL || `http://127.0.0.1:${env.GATEWAY_PORT || 3080}`).replace(/\/+$/, "");
  const secret = () => env.CELL_GATEWAY_SECRET || "";
  // Outbound call discipline: relay/poll calls ride the shared deadline
  // wrapper (default env bound) — a stalled gateway degrades this bridge to
  // the legacy session path instead of hanging the inbound hook; fetchImpl
  // stays the test seam.
  const doFetch = (url, init = {}) => fetchWithTimeout(url, init, { fetchImpl });
  const pollMs = Number(env.ZHIYU_IM_BRIDGE_POLL_MS || 2500);

  const machineHeaders = (email) => ({
    "Content-Type": "application/json",
    [GATEWAY_SECRET_HEADER]: secret(),
    "x-actor-email": email || "",
  });

  // The actor identity the gateway's machine lane attributes the call to. The
  // gateway answers "machine credential required" to an EMPTY actor, so the
  // email must be real: the bot row's own owner, else the cell's single user
  // (a cell hosts exactly one user, and a bot lives in its owner's cell).
  const actorFor = (bot) => {
    const explicit = String(bot?.ownerEmail ?? "").trim().toLowerCase();
    if (explicit) return explicit;
    return String(env.CELL_USER_EMAIL ?? "").trim().toLowerCase();
  };

  const buckets = new Map();
  const sendFailures = new Map(); // "botId:seq" → consecutive failed attempts
  const take = (key, limit, windowMs) => {
    const now = Date.now();
    const b = buckets.get(key) ?? { n: limit, at: now };
    if (now - b.at >= windowMs) {
      b.n = limit;
      b.at = now;
    }
    if (b.n <= 0) return false;
    b.n -= 1;
    buckets.set(key, b);
    return true;
  };

  // Inbound: attempt the bridge ingest. Returns true when the gateway
  // accepted the message; any failure returns false (legacy path takes it).
  async function handleInbound({ bot, chatKey, senderName, text, imUserId = null }) {
    if (!bot.zhiRoomId) return false;
    if (!bot.enabled) return false;
    if (!enabled()) {
      log.warn(`[zhiyu-im-bridge] bot "${bot.name}" has zhiRoomId but the bridge gate is off; legacy path continues`);
      return false;
    }
    if (!secret()) {
      log.warn("[zhiyu-im-bridge] CELL_GATEWAY_SECRET unavailable; cannot reach the bridge, falling back");
      return false;
    }
    if (!take(`in:${bot.id}`, OUTBOUND_PER_MIN, 60_000)) {
      log.warn(`[zhiyu-im-bridge] inbound bucket for bot "${bot.name}" is exhausted for this minute; dropping`);
      return true; // do NOT fall back on our own rate guard — that would double-answer
    }
    try {
      const r = await doFetch(`${gatewayBase()}/api/zhiyu/im-bridge/rooms/${encodeURIComponent(bot.zhiRoomId)}/messages`, {
        method: "POST",
        headers: machineHeaders(actorFor(bot)),
        body: JSON.stringify({ content: text, chatKey, senderName, imUserId: imUserId ?? senderName }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        log.warn(`[zhiyu-im-bridge] gateway ${r.status} for bot "${bot.name}": ${body.slice(0, 160)}`);
        return false;
      }
      return true;
    } catch (err) {
      log.warn(`[zhiyu-im-bridge] gateway unreachable for bot "${bot.name}": ${err.message}`);
      return false;
    }
  }

  // Room → IM. Which chat a room answer goes to: the bot's currently-active
  // chat for this batch (the most recent chatKey the bridge saw inbound from
  // THIS bot during this process life; falls back to its single recorded chat,
  // or the answer is skipped with an honest log — v1's explicit trade).
  const activeChatFor = new Map(); // botId → chatKey
  function noteInboundChat(botId, chatKey) {
    if (chatKey) activeChatFor.set(botId, chatKey);
  }

  const sendChatFor = (bot) => {
    const remembered = activeChatFor.get(bot.id);
    if (remembered) return remembered;
    try {
      const chats = db.listBotChats().filter((c) => c.botId === bot.id && c.chatKey);
      return chats.length ? String(chats[0].chatKey) : null;
    } catch {
      return null;
    }
  };

  // Sequential splitting with the attribution prefix on the first chunk only.
  function chunksFor(_senderDisplay, content) {
    const text = String(content ?? "");
    if (text.length <= RELAY_MAX_CHARS) return [text];
    const parts = [];
    for (let i = 0; i < text.length; i += RELAY_MAX_CHARS) parts.push(text.slice(i, i + RELAY_MAX_CHARS));
    return parts;
  }

  const formatRow = (row) => {
    if (row.kind === "agent" && row.sender) {
      const pxk = row.sender.kind === "facade" && row.sender.onBehalfOf ? `${row.sender.display || "分身"}(代 ${row.sender.onBehalfOf} 出席): ` : `${row.sender.display || "智能体"}: `;
      return pxk + row.content;
    }
    if (row.kind === "system") return `（会话事件）${row.content || (row.meta?.event ?? "")}`;
    return String(row.content ?? "");
  };

  let ticking = false;
  async function tickBot(bot) {
    if (!secret()) return;
    const adapter = selectAdapter(bot);
    if (!adapter) return;
    const chatKey = sendChatFor(bot);
    if (!chatKey) return; // no known destination yet; wait for a first inbound
    let r;
    try {
      r = await doFetch(
        `${gatewayBase()}/api/zhiyu/im-bridge/rooms/${encodeURIComponent(bot.zhiRoomId)}/events?after=${Number(bot.zhiBridgeCursor || 0)}`,
        { headers: machineHeaders(actorFor(bot)) },
      );
    } catch (err) {
      log.warn(`[zhiyu-im-bridge] events fetch failed for bot "${bot.name}": ${err.message}`);
      return;
    }
    if (!r.ok) {
      // Drain the error body: an unread response leaves the connection unusable
      // and the NEXT poll fails with a transport error instead of the real
      // cause (observed in prod: a silent 401 turned into "fetch failed").
      const body = await r.text().catch(() => "");
      log.warn(`[zhiyu-im-bridge] events ${r.status} for bot "${bot.name}": ${body.slice(0, 160)}`);
      return;
    }
    const { rows = [] } = await r.json().catch(() => ({ rows: [] }));
    if (!rows.length) return;
    if (!take(`out:${bot.id}`, OUTBOUND_PER_MIN, 60_000)) {
      log.warn(`[zhiyu-im-bridge] outbound bucket for bot "${bot.name}" exhausted; batch deferred`);
      return;
    }
    let lastSeq = Number(bot.zhiBridgeCursor || 0);
    let failed = null;
    let failedSeq = null;
    for (const row of rows) {
      const text = formatRow(row);
      if (!text.trim()) {
        lastSeq = Math.max(lastSeq, Number(row.seq) || lastSeq);
        continue;
      }
      try {
        for (const chunk of chunksFor(row.sender?.display, text)) {
          await adapter.sendText(bot.credentials, chatKey, chunk);
        }
      } catch (err) {
        failed = err;
        failedSeq = Number(row.seq) || null;
        break;
      }
      lastSeq = Math.max(lastSeq, Number(row.seq) || lastSeq);
    }
    if (failed) {
      // Bounded retry (design D-E: "retry-three with an honest log, never queue
      // unbounded"). A permanently-failing send — a revoked platform credential,
      // a chat the bot was removed from — would otherwise re-attempt the same row
      // on every poll forever, hammering the platform API and pinning the cursor
      // so every later answer is blocked behind it. After three attempts the row
      // is skipped LOUDLY so the stream resumes.
      const key = `${bot.id}:${failedSeq ?? "?"}`;
      const seen = (sendFailures.get(key) ?? 0) + 1;
      sendFailures.set(key, seen);
      if (seen < 3) {
        log.warn(`[zhiyu-im-bridge] send failed for bot "${bot.name}" at seq ${failedSeq} (attempt ${seen}/3): ${failed.message}`);
      } else {
        sendFailures.delete(key);
        if (failedSeq) lastSeq = Math.max(lastSeq, failedSeq);
        log.warn(`[zhiyu-im-bridge] send failed 3x for bot "${bot.name}" at seq ${failedSeq}; SKIPPING that answer to unblock the stream: ${failed.message}`);
        // Honest surfacing (spec Req5): the room sees WHY the answer never
        // reached the group. Best-effort — the stream is already unblocked.
        void doFetch(
          `${gatewayBase()}/api/zhiyu/im-bridge/rooms/${encodeURIComponent(bot.zhiRoomId)}/delivery-failed`,
          {
            method: "POST",
            headers: { ...machineHeaders(actorFor(bot)), "Content-Type": "application/json" },
            body: JSON.stringify({
              platform: bot.type,
              chatKey,
              seq: failedSeq,
              reason: String(failed.message ?? "unknown").slice(0, 200),
            }),
          },
        ).catch((err) => log.warn(`[zhiyu-im-bridge] delivery-failed event POST failed for bot "${bot.name}": ${err.message}`));
      }
    } else if (failedSeq === null) {
      // A clean pass clears any stale counters for this bot.
      for (const k of sendFailures.keys()) if (k.startsWith(`${bot.id}:`)) sendFailures.delete(k);
    }
    // lastSeq only ever covers rows that were actually SENT (or deliberately
    // skipped), so persisting it here is duplicate-safe: the failed row keeps
    // seq > lastSeq and stays queued for the next poll.
    if (lastSeq !== Number(bot.zhiBridgeCursor || 0)) {
      try {
        db.setBotBridgeCursor(bot.id, lastSeq);
      } catch (e) {
        log.warn(`[zhiyu-im-bridge] cursor write failed for bot "${bot.name}": ${e.message}`);
      }
    }
  }

  let timer = null;
  function startOutbounds() {
    if (timer) return timer;
    const tick = async () => {
      if (ticking) return;
      ticking = true;
      try {
        if (!enabled()) return;
        for (const bot of db.listBots()) {
          if (!bot.zhiRoomId || !bot.enabled) continue;
          await tickBot(bot);
        }
      } catch (e) {
        log.warn(`[zhiyu-im-bridge] outbound tick failed: ${e.message}`);
      } finally {
        ticking = false;
      }
    };
    timer = setInterval(() => void tick(), pollMs);
    timer.unref?.();
    return timer;
  }

  function stopOutbounds() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    handleInbound,
    noteInboundChat,
    tickBot, // test surface: single-bot outbound pass
    startOutbounds,
    stopOutbounds,
    // Introspection for unit tests.
    _activeChatFor: activeChatFor,
  };
}
