// fd-bot client + transport switch (adopt-fd-bot-transport 6.1-6.3).
//
// WHY A SWITCH AND NOT A REPLACEMENT: the migration is per binding, and a leg
// that regresses must be able to go back without touching the legs that were
// already moved. `BOTS_TRANSPORT=fd-bot|legacy` is read per bot ROW
// (`bot.transport`), not globally, so both paths run in one cell at the same
// time — that is what makes "double-write verification then switch" possible at
// all.
//
// WHAT DOES NOT MOVE: everything about what a message MEANS — the sender
// allowlist, the rate bucket, the readiness latch, the pending-ask state
// machine, the tool posture, the room bridge. fd-bot hands over an envelope and
// takes back a delivery verdict; the turn still runs here.
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

const FD_BOT_URL = () => (process.env.FD_BOT_URL || "").replace(/\/+$/, "");
const FD_BOT_SECRET = () => process.env.FD_BOT_SECRET || "";

export function fdBotConfigured() {
  return Boolean(FD_BOT_URL() && FD_BOT_SECRET());
}

/**
 * The capability of a bot's leg, as fd-bot reports it.
 *
 * Returns { available:false } when fd-bot cannot be reached. That is
 * deliberately DIFFERENT from `{mode:"none"}`: "the platform has no outbound
 * path" and "the transport service is down" need different operator actions,
 * and reporting `none` for the latter would send someone to rebind a bot that
 * is configured correctly. Spec: "服务不可达时调用方必须显式降级".
 */
export async function capabilityFromFdBot(bot, { fetchImpl = null } = {}) {
  if (!fdBotConfigured() || !bot?.fdBotBindingId) return { available: false, reason: "not-configured" };
  const doFetch = (url, init) => fetchWithTimeout(url, init, { fetchImpl, timeoutMs: 3_000 });
  try {
    const r = await doFetch(`${FD_BOT_URL()}/v1/bindings/${encodeURIComponent(bot.fdBotBindingId)}`, {
      headers: { authorization: `Bearer ${FD_BOT_SECRET()}` },
    });
    // Drain the body: an unread response poisons the connection for the NEXT call.
    const text = await r.text();
    if (!r.ok) return { available: false, reason: `http-${r.status}`, detail: text.slice(0, 160) };
    const body = JSON.parse(text);
    return { available: true, mode: body.outbound?.mode ?? "none", inbound: body.outbound?.inbound ?? false, health: body.health ?? null };
  } catch (err) {
    return { available: false, reason: "unreachable", detail: err.message };
  }
}

/** Create a binding on fd-bot for a bot row; returns the binding id. */
export async function createBinding({ platform, credentials, subscriberUrl, deliveryToken, inboundMode = null, label = null, fetchImpl = null }) {
  const doFetch = (url, init) => fetchWithTimeout(url, init, { fetchImpl, timeoutMs: 5_000 });
  const r = await doFetch(`${FD_BOT_URL()}/v1/bindings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${FD_BOT_SECRET()}` },
    body: JSON.stringify({ platform, credentials, subscriberUrl, deliveryToken, inboundMode, label }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`fd-bot refused the binding: ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/**
 * Send through fd-bot. Returns fd-bot's own verdict shape:
 *   { ok:true } | { ok:false, failure, detail }
 * A transport failure (service down) THROWS — the caller must report it as
 * "unreachable", not as a platform failure. Spec: never disguise unreachable
 * as a quiet empty success.
 */
export async function sendThrough({ bindingId, chatKey, text, fetchImpl = null }) {
  const doFetch = (url, init) => fetchWithTimeout(url, init, { fetchImpl, timeoutMs: 15_000 });
  const r = await doFetch(`${FD_BOT_URL()}/v1/send`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${FD_BOT_SECRET()}` },
    body: JSON.stringify({ bindingId, chatKey, text }),
  });
  const bodyText = await r.text();
  if (!r.ok) {
    const err = new Error(`fd-bot send failed: ${r.status} ${bodyText.slice(0, 200)}`);
    err.code = "fd_bot_unreachable";
    throw err;
  }
  return JSON.parse(bodyText);
}