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
import { sendThrough, fdBotConfigured } from "./fd-bot-client.js";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";
import { createLaneConfig, copyForEvent } from "../gateway/zhiyu/lane-config.js";

// IM lane data layer: copy, whitelists, dispatch rules and timeouts ship as
// configuration, not code (externalize-im-platform-adapters).
const laneCfg = createLaneConfig();

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
  // Same-cause coalescing (fix-zhiyu-pass-mark-and-delivery-failure-surface):
  // a global misconfiguration used to surface one failure row PER answer (19 in
  // one production room in half an hour, each carrying the egress IP). The room
  // needs to learn the cause ONCE; more rows of the same cause add noise, not
  // information. A changed cause is a different fact and surfaces immediately.
  const failureRuns = new Map(); // botId → { cause, count, lastNotifiedAt }
  const COALESCE_MS = Number(env.ZHIYU_IM_FAIL_COALESCE_MS || 300_000);
  const causeOf = (message) =>
    String(message ?? "unknown")
      .replace(/hint: \[[^\]]*\]/g, "")
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>") // egress address is ops detail, not room content
      .replace(/\d{10,}/g, "")
      .slice(0, 120)
      .trim();
  // Failure CLASS (make-im-lane-outbound-capable 4.1). The two crippling causes
  // need different actions, so they must not share a sentence:
  //   ip-not-allowed      → change the egress, or move outbound to a URL-keyed leg
  //   reply-window-closed → wait for the next inbound, or move outbound
  //
  // Deliberately NOT a substring match on the vendor's prose ("not allow to
  // access from your ip" is a sentence WeCom can reword any day). Only two
  // sources are trusted: the stable error OUR adapter throws, and the numeric
  // platform codes that are part of the API contract.
  const IP_GATED_CODES = new Set([60020, 40164, 45009]); // WeCom/WeChat IP + freq families
  function failureClassOf(message) {
    const text = String(message ?? "");
    if (/no live response_url/i.test(text)) return "reply-window-closed"; // our adapter's own signal
    for (const m of text.matchAll(/\b(\d{4,5})\b/g)) {
      if (IP_GATED_CODES.has(Number(m[1]))) return "ip-not-allowed";
    }
    return "other";
  }
  const CLASS_REASON = {
    "ip-not-allowed": "出口地址不被平台接受（企业可信IP）——换出口或改用不受出口约束的出流通道",
    "reply-window-closed": "被动回复窗口已关闭——等群里再说一句，或改用可主动发送的出流通道",
    other: null, // fall through to the cleaned vendor text
  };
  // Returns the reason string to POST, or null when this failure is already
  // covered by a recent notice of the same cause.
  function shouldSurfaceFailure(botId, message) {
    const cause = causeOf(message);
    const now = Date.now();
    const run = failureRuns.get(botId);
    if (!run || run.cause !== cause) {
      failureRuns.set(botId, { cause, count: 1, lastNotifiedAt: now });
      return { reason: cause, count: 1 };
    }
    run.count += 1;
    if (now - run.lastNotifiedAt < COALESCE_MS) return null;
    run.lastNotifiedAt = now;
    return { reason: cause, count: run.count };
  }
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

  // Account-bound bots have no room id of their own (add-zhiyu-team-account:
  // the room is opened on demand), so the INBOUND response tells us which room
  // this chat lives in. Kept beside the chat key because both are "where this
  // conversation currently is", learned from the same inbound message, and
  // both die with the process (the next inbound re-learns them).
  const activeRoomFor = new Map(); // botId → roomId

  // Inbound: attempt the bridge ingest. Returns true when the gateway
  // accepted the message; any failure returns false (legacy path takes it).
  async function handleInbound({ bot, chatKey, senderName, text, imUserId = null }) {
    // A bot names EITHER a room or a team account (add-zhiyu-team-account);
    // neither → this bot was never bound and the legacy session path is right.
    const bound = bot.zhiAccountId
      ? { kind: "account", id: bot.zhiAccountId }
      : bot.zhiRoomId
        ? { kind: "room", id: bot.zhiRoomId }
        : null;
    if (!bound) return false;
    if (!bot.enabled) return false;
    if (!enabled()) {
      log.warn(`[zhiyu-im-bridge] bot "${bot.name}" has a ${bound.kind} binding but the bridge gate is off; legacy path continues`);
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
      const lane = bound.kind === "account" ? "team-accounts" : "rooms";
      const r = await doFetch(`${gatewayBase()}/api/zhiyu/im-bridge/${lane}/${encodeURIComponent(bound.id)}/messages`, {
        method: "POST",
        headers: machineHeaders(actorFor(bot)),
        body: JSON.stringify({ content: text, chatKey, senderName, imUserId: imUserId ?? senderName }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        // A 404 here is not "the gateway is having a bad day" — it is "this
        // binding points at a room that no longer exists". Production ran with
        // exactly that: `智语·WeCom` bound to a room deleted straight out of
        // sqlite, every group message falling back to the legacy session path
        // while the panel still showed a healthy binding. The stable tag is
        // what makes that greppable/alertable instead of a reworded warn.
        if (r.status === 404) {
          log.warn(`[zhiyu-im-bridge][binding-stale] bot "${bot.name}" (${bot.id}) is bound to ${bound.kind} ${bound.id}, which the gateway does not have; inbound falls back to the legacy session path`);
          return false;
        }
        // 5xx = transient (cell booting/restarting behind the gateway) → retryable,
        // so fd-bot re-delivers instead of the message being dropped on a 200.
        // 4xx other than 404 = the request itself is refused → a real decline.
        if (r.status >= 500) {
          const e = new Error(`gateway ${r.status} for bot "${bot.name}": ${body.slice(0, 120)}`);
          e.code = "bridge_unreachable";
          e.retryable = true;
          throw e;
        }
        log.warn(`[zhiyu-im-bridge] gateway ${r.status} for bot "${bot.name}": ${body.slice(0, 160)}`);
        return false;
      }
      // Account-bound bots: the gateway opened (or reused) a room for this
      // chat and answers with its id. Record it so the OUTBOUND tick knows
      // which room's stream this bot speaks for — the room id is not on the
      // bot row, because the account decides it per chat.
      if (bound.kind === "account") {
        const payload = await r.json().catch(() => null);
        if (payload?.roomId) activeRoomFor.set(bot.id, payload.roomId);
      }
      return true;
    } catch (err) {
      // TRANSIENT — do NOT return false. Returning false made the caller fall
      // through to the legacy session path, which on a cold cell is a no-op, and
      // the message was silently lost (fd-bot already got 200). A fetch failure
      // here is "the gateway/cell is not reachable yet" (cold start, restart) —
      // retryable. Surface it as a throwable with `.retryable` so the route
      // answers 5xx and fd-bot re-delivers once the cell is up.
      const e = new Error(`gateway unreachable for bot "${bot.name}": ${err.message}`);
      e.code = "bridge_unreachable";
      e.retryable = true;
      throw e;
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

  // What the GROUP reads for each room row. Event rows carry no content of their
  // own, so they need a sentence here — and never the internal event name: a
  // group of customers must not learn that our rooms speak in `all_passed`.
  //
  // `all_passed` / `pass` are here because silence is not an answer
  // (2026-11-19): a round where every seat passed produced 32s of dead air in
  // the group, and the sender could not tell "nobody could help" from "the bot
  // is broken".
  // Copy comes from the IM lane data layer (externalize-im-platform-adapters),
  // re-read per call so a changed sentence needs no image and no restart. A row
  // whose event has no sentence falls back to the generic line — never to its
  // internal name.
  const sayFor = (row) => copyForEvent(laneCfg.get(), String(row.meta?.event ?? ""), row);
  const formatRow = (row) => {
    if (row.kind === "agent" && row.sender) {
      const pxk = row.sender.kind === "facade" && row.sender.onBehalfOf ? `${row.sender.display || "分身"}(代 ${row.sender.onBehalfOf} 出席): ` : `${row.sender.display || "智能体"}: `;
      return pxk + row.content;
    }
    if (row.kind === "system" || row.kind === "event") {
      if (row.content?.trim()) return row.content;
      return sayFor(row);
    }
    return String(row.content ?? "");
  };

  let ticking = false;
  async function tickBot(bot) {
    if (!secret()) return;
    // Outbound leg (make-im-lane-outbound-capable 3.3): the room's answers may be
    // delivered through a DIFFERENT bot than the one carrying inbound — every
    // WeCom inbound leg is crippled on outbound (self-built app: allowlisted
    // egress; intelligent robot: passive window only), while a group webhook has
    // neither constraint.
    //
    // Cursor and chatKey stay on the INBOUND row: the cursor is "this room's
    // delivery progress" (the room is bound to the inbound bot) and the chat is
    // where the message came from. Only adapter + credentials come from the
    // outbound row.
    let outboundBot = bot;
    if (bot.zhiOutboundBotId) {
      let row = null;
      try {
        row = db.getBot(bot.zhiOutboundBotId);
      } catch {
        row = null;
      }
      if (!row) {
        // A binding that half-exists must not look like a quiet room.
        log.warn(`[zhiyu-im-bridge] bot "${bot.name}" points at outbound bot ${bot.zhiOutboundBotId}, which no longer exists; falling back to its own leg`);
      } else {
        outboundBot = row;
      }
    }
    const adapter = selectAdapter(outboundBot);
    if (!adapter) {
      log.warn(`[zhiyu-im-bridge] outbound bot "${outboundBot.name}" has no adapter; skipping this tick`);
      return;
    }
    const chatKey = sendChatFor(bot);
    if (!chatKey) return; // no known destination yet; wait for a first inbound
    // Which room's answers does this bot carry back out?
    //   room binding    → the row's own room id (unchanged).
    //   account binding → the room the account opened for THIS chat, learned
    //                     from the last inbound response. Before the first
    //                     inbound there is nothing to deliver, which is correct:
    //                     an account bot only speaks after someone spoke to it.
    const roomId = bot.zhiAccountId ? activeRoomFor.get(bot.id) : bot.zhiRoomId;
    if (!roomId) return;
    let r;
    try {
      r = await doFetch(
        `${gatewayBase()}/api/zhiyu/im-bridge/rooms/${encodeURIComponent(roomId)}/events?after=${Number(bot.zhiBridgeCursor || 0)}`,
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
    const payload = await r.json().catch(() => ({ rows: [] }));
    const { rows = [] } = payload;
    // Advance past rows the gateway deliberately did not show this room's group
    // (fleet reports, internal events). Without this the cursor pins at the first
    // unshowable row and every later answer is stuck behind it — 2026-11-19:
    // cursor 138, room at 144, and the tick quietly believed there was nothing
    // to deliver.
    const watermark = Number(payload.watermark ?? 0);
    if (!rows.length) {
      const floor = Number(bot.zhiBridgeCursor || 0);
      if (watermark > floor && typeof db.setBotBridgeCursor === "function") {
        try {
          db.setBotBridgeCursor(bot.id, watermark);
        } catch (e) {
          log.warn(`[zhiyu-im-bridge] watermark write failed for bot "${bot.name}": ${e.message}`);
        }
      }
      return;
    }
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
        // Transport-aware send (unify-im-solution): a bot on fd-bot must send
        // through fd-bot, NOT the legacy paas adapter. The bridge had its own
        // adapter.sendText call that never learned about the transport switch, so
        // a migrated bot's answers hit the legacy passive-window path and failed
        // ("no live response_url"). Route by transport here so the room's answers
        // go out the same leg the inbound came in on.
        const viaFd = outboundBot.transport === "fd-bot" && outboundBot.fdBotBindingId && fdBotConfigured();
        for (const chunk of chunksFor(row.sender?.display, text)) {
          if (viaFd) {
            const verdict = await sendThrough({ bindingId: outboundBot.fdBotBindingId, chatKey, text: chunk });
            if (!verdict.ok) {
              const e = new Error(verdict.detail || `send failed (${verdict.failure})`);
              e.failure = verdict.failure;
              throw e;
            }
          } else {
            await adapter.sendText(outboundBot.credentials, chatKey, chunk);
          }
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
        // Coalesced by cause: the first failure of a cause surfaces, repeats
        // within the window do not (they are the same fact, not new ones).
        //
        // The CLASS decides the wording (4.2): "egress not accepted" and "reply
        // window closed" have different fixes, so one generic sentence would
        // send the reader to the wrong settings page half the time.
        const klass = failureClassOf(failed.message);
        const surfaced = shouldSurfaceFailure(bot.id, `${klass}|${failed.message}`);
        if (surfaced) {
          const base = CLASS_REASON[klass] ?? surfaced.reason;
          void doFetch(
            `${gatewayBase()}/api/zhiyu/im-bridge/rooms/${encodeURIComponent(bot.zhiRoomId)}/delivery-failed`,
            {
              method: "POST",
              headers: { ...machineHeaders(actorFor(bot)), "Content-Type": "application/json" },
              body: JSON.stringify({
                // The platform of the leg that actually TRIED to deliver. With a
                // separate outbound leg, naming the inbound bot's platform would
                // point the operator at the wrong settings page.
                platform: outboundBot.type,
                chatKey,
                seq: failedSeq,
                // Which legs were involved. A combined binding has two, and
                // "delivery failed" without saying WHICH one is the ambiguity
                // this change exists to remove.
                via: outboundBot.id === bot.id ? "same-leg" : `inbound:${bot.type}/${bot.name} outbound:${outboundBot.type}/${outboundBot.name}`,
                cause: klass,
                reason: surfaced.count > 1 ? `${base}（已连续 ${surfaced.count} 条）` : base,
              }),
            },
          ).catch((err) => log.warn(`[zhiyu-im-bridge] delivery-failed event POST failed for bot "${bot.name}": ${err.message}`));
        }
      }
    } else if (failedSeq === null) {
      // A clean pass clears any stale counters for this bot — including the
      // same-cause run, so the NEXT failure (whenever it comes) surfaces again
      // as a first-of-cause rather than being suppressed by a stale window.
      for (const k of sendFailures.keys()) if (k.startsWith(`${bot.id}:`)) sendFailures.delete(k);
      failureRuns.delete(bot.id);
    }
    // lastSeq only ever covers rows that were actually SENT (or deliberately
    // skipped), so persisting it here is duplicate-safe: the failed row keeps
    // seq > lastSeq and stays queued for the next poll.
    // Cursor write (make-im-lane-outbound-capable 5.2): never move BACKWARDS.
    // `bot` is a snapshot taken at tick start, so a cursor written from outside
    // during this tick (a rebind aligning to the room tail) would be clobbered by
    // our older value — observed 2026-11-18: rebind set 94, the running tick wrote
    // 57 back, and the room's history started replaying into the group.
    if (lastSeq !== Number(bot.zhiBridgeCursor || 0)) {
      try {
        const fresh = typeof db.getBot === "function" ? db.getBot(bot.id) : null;
        const current = Number(fresh?.zhiBridgeCursor ?? bot.zhiBridgeCursor ?? 0);
        if (lastSeq > current) db.setBotBridgeCursor(bot.id, lastSeq);
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
          // A bot speaks back out when it is bound EITHER to a room or to a
          // team account (add-zhiyu-team-account). This test used to name only
          // `zhiRoomId`, so an account-bound bot carried messages IN and never
          // carried answers OUT — the room filled up and the group stayed
          // silent (2026-11-19, found by testing Slack end to end).
          if (!(bot.zhiRoomId || bot.zhiAccountId) || !bot.enabled) continue;
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
