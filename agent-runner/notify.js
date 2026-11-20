// ── Runner-side notification forwarder (add-agent-notifications D3/D5) ──────
//
// One instance per runner: the policy and the egress for every child's
// `bot_notify` call. The child only names an event; everything a notification
// needs to actually reach a chat — the deployment's bound channel, the
// per-agent rate bound, the relay credential — lives HERE, in host
// configuration, and never enters the child's environment.
//
// The forward reuses the platform's existing bot relay verbatim (no second
// outbound path, design D1/non-goals): POST {relayUrl} with the machine
// token, {channel, text: "[event] text"}, 10s bound. The relay's guarantees
// (per-channel rate limit, length cap, admin-managed destinations, audit
// without content) all apply on top of the runner's own per-agent bound.
//
// Every decision and egress attempt lands one jsonl audit line
// ({agent, channel, outcome, reason, textLen} — never the text), mirroring
// the relay's own no-content law; the two audit layers are by design (D5).
//
// Returns the relay's outcome or failure shape verbatim; the caller (the
// child's pump) hands it back to the calling turn over `botNotify/result`.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const RELAY_TIMEOUT_MS = 10_000;

export function createNotifier({ config, log = console, fetchImpl, now = () => Date.now() } = {}) {
  const ratePerMin = Number(config?.notifyRatePerMin) > 0 ? Number(config.notifyRatePerMin) : 6;
  const buckets = new Map(); // agentKey → { tokens, refilledAt } (lazy, unbounded growth bounded by agent count)

  const audit = (agent, channel, outcome, reason, textLen) => {
    try {
      mkdirSync(path.dirname(config.notifyLogFile), { recursive: true });
      appendFileSync(
        config.notifyLogFile,
        `${JSON.stringify({
          agent,
          channel: channel ?? null,
          outcome,
          reason: reason ?? null,
          textLen,
          at: new Date(now()).toISOString(),
        })}\n`,
      );
    } catch (e) {
      log.warn?.(`[agent-runner] notify audit write failed: ${e?.message || e}`);
    }
  };

  // Per-agent token bucket: capacity ratePerMin, refilled continuously at
  // ratePerMin/60s. Per AGENT (not per runner, not per child) — a respawned
  // child inherits the same budget, so an over-eager loop cannot reset its
  // bound by crashing.
  const take = (agentKey) => {
    const t = now();
    let bucket = buckets.get(agentKey);
    if (!bucket) {
      bucket = { tokens: ratePerMin, refilledAt: t };
      buckets.set(agentKey, bucket);
    }
    const refill = ((t - bucket.refilledAt) / 60_000) * ratePerMin;
    if (refill > 0) {
      bucket.tokens = Math.min(ratePerMin, bucket.tokens + refill);
      bucket.refilledAt = t;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };

  return {
    // `boundChannel` is the deployment descriptor's notify_channel (string or
    // null). Returns {ok:true} or {ok:false, reason, message[, status]} — the
    // shape travels to the child and into the turn.
    async send({ agent, boundChannel = null, event, text, channel } = {}) {
      const textLen = typeof text === "string" ? text.length : 0;
      const decline = (reason, message) => {
        audit(agent, boundChannel, "rejected", reason, textLen);
        return { ok: false, reason, message };
      };

      // Shape first: a malformed call must not produce a "[undefined]" send.
      if (typeof event !== "string" || !event.trim() || typeof text !== "string" || !text.trim()) {
        return decline("invalid-request", "bot_notify needs a non-empty event and text");
      }
      if (!config.relayToken) {
        return decline("not-configured", "notifications are not configured on this deployment (the relay token is not set)");
      }
      if (!boundChannel) {
        return decline("unbound", "this deployment binds no notification channel — the deployer must bind one before the agent can notify");
      }
      if (channel != null && channel !== boundChannel) {
        return decline("channel-mismatch", `this deployment notifies '${boundChannel}' only — '${channel}' is not its bound channel`);
      }
      if (!take(agent)) {
        return decline("rate-limited", `notification rate exceeded (${ratePerMin} per minute per agent)`);
      }
      if (!config.relayUrl) {
        return decline("not-configured", "notifications are not configured on this deployment (the relay URL is not set)");
      }

      const doFetch = fetchImpl ?? fetch;
      try {
        const res = await doFetch(config.relayUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.relayToken}`,
          },
          body: JSON.stringify({ channel: boundChannel, text: `[${event.trim()}] ${text}` }),
          signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
        });
        const doc = await res.json().catch(() => ({}));
        if (res.ok) {
          audit(agent, boundChannel, "sent", null, textLen);
          return { ok: true };
        }
        audit(agent, boundChannel, "failed", `relay ${res.status}`, textLen);
        return {
          ok: false,
          reason: "relay",
          status: res.status,
          message: doc?.error || `the relay refused the notification (${res.status})`,
        };
      } catch (e) {
        audit(agent, boundChannel, "failed", "relay-unreachable", textLen);
        return { ok: false, reason: "relay-unreachable", message: `the relay could not be reached: ${e?.message || e}` };
      }
    },
  };
}