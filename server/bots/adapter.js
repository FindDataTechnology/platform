// Bot adapter contract + shared plumbing (design D1).
//
// Every chat platform reduces to the same three functions; the rest is
// per-platform crypto/HTTP. An adapter module exports:
//
//   credentialFields: [{ key, label, required?, secret? }]   // config-form spec
//   verifyWebhook(req, cred) -> Promise<string | null>
//        Verify the request. Returns the literal body to echo when the request
//        is the platform's URL-verification handshake, or null when it is a
//        real message to parse. THROWS to reject (the route answers 403).
//   parseMessage(req, cred) -> Promise<{ chatKey, senderName, text, platformMessageId? } | null>
//        null = ignore (edits, reactions, our own echoes, non-text messages).
//        platformMessageId: the platform's own message identifier when the
//        payload carries one (WeCom/WeChat MsgId, Feishu/Telegram message_id)
//        — the webhook acceptance layer's idempotency key input; absent/null
//        means the payload dedupes by nothing (never a guessed key).
//   sendText(cred, chatKey, text) -> Promise<void>
//   start?(bot, deliver) / stop?()   // optional polling loop (telegram)
//   qr: { strategy, hintKey, field?, resolve?(cred) }
//        User-entry QR capability (redesign-bots-surface). strategy is
//        "telegram-me" | "wechat-qrcode" | "manual"; hintKey is the i18n key
//        for the per-platform setup steps; manual platforms name their
//        operator-provided link `field`. resolve() runs server-side and
//        returns { url } or throws — the route maps a throw to the manual
//        fallback state, so a broken upstream never breaks bot management.
//
// Adapters are stateless modules; per-bot mutable state (access-token cache,
// poll loop) lives in a closure created by `create(bot)` when the adapter
// needs it. Adapters that need no state omit `create`.

// The adapters and this module import each other (they use the plumbing
// below), so the registry is built on first lookup rather than at module
// evaluation — by then every module in the cycle is fully initialized.
import { registry as telegram } from "./telegram.js";
import { registry as feishu } from "./feishu.js";
import { registry as wecom } from "./wecom.js";
import { registry as wechatOa } from "./wechat-oa.js";
import { registry as wecomBot } from "./wecom-bot.js";
import { registry as wecomWebhook } from "./wecom-webhook.js";
import { registry as slack } from "./slack.js";
import { registry as mattermost } from "./mattermost.js";
import { fetchWithTimeout } from "../../lib/fetch-with-timeout.js";

export const BOT_TYPES = ["telegram", "feishu", "wecom", "wechat-oa", "wecom-bot", "slack", "mattermost", "wecom-webhook"];

// Types that cannot receive a callback (make-im-lane-outbound-capable). Only
// `wecom-webhook` today: a group robot is push-only by platform design. The
// inbound route layer consults this so the absence of a receive path is
// structural, not a convention someone can forget.
export function isOutboundOnly(type) {
  return getAdapter(type)?.outbound?.inbound === false;
}

let registry = null;
function adapters() {
  if (!registry) registry = { telegram, feishu, wecom, "wechat-oa": wechatOa, "wecom-bot": wecomBot, slack, mattermost, "wecom-webhook": wecomWebhook };
  return registry;
}

export function getAdapter(type) {
  return adapters()[type] ?? null;
}

// Resolve a bot ROW's adapter (pack-bot-units). A plain row names its platform
// in `type`. A generic-type row (v1: "channel", born from a pack install)
// defers the platform choice to the operator's binding inside credentials —
// the pack never picks a platform, it only references the generic type. Null
// until the operator configures the binding (the bot stays awaiting-connection
// and no runtime entry exists, so nothing is reachable).
export function adapterForBot(bot) {
  if (bot?.type === "channel") return getAdapter(bot.credentials?.platform);
  return getAdapter(bot?.type);
}

// Adapter-declared credential fields, for the config form and save validation.
export function credentialFieldsFor(type) {
  return getAdapter(type)?.credentialFields ?? [];
}

// ── Outbound capability (make-im-lane-outbound-capable) ─────────────────────
//
// "Is this bot bound?" and "can this bot actually DELIVER?" are different
// questions, and 2026-11-18 production answered them differently for every send:
// a bound WeCom app answered with 60020 for half an hour while the panel showed
// a healthy binding. The capability is declared by each adapter (next to the
// code that implements the sending) rather than inferred here, so adding a
// platform forces the author to state its outbound shape.
//
//   url-keyed           credentials ride the URL/body and no caller-IP allowlist
//                       applies — survives an egress change
//   proactive-ip-gated  can send unprompted, but only from an allowlisted IP
//   passive-window      can only reply inside the window a recent inbound opened
//   none                no outbound path at all
export const OUTBOUND_MODES = ["url-keyed", "proactive-ip-gated", "passive-window", "none"];

/** The declared outbound capability of a bot TYPE. Unknown types answer "none". */
export function outboundCapabilityFor(type) {
  const adapter = getAdapter(type);
  const declared = adapter?.outbound;
  if (!declared || !OUTBOUND_MODES.includes(declared.mode)) return { mode: "none", inbound: false };
  return { mode: declared.mode, inbound: declared.inbound !== false };
}

/**
 * The same answer for a bot ROW (generic `channel` rows defer to the platform
 * they were bound to — the row's own type says nothing about sending).
 */
export function outboundCapabilityOfBot(bot) {
  if (bot?.type === "channel") return outboundCapabilityFor(bot.credentials?.platform);
  return outboundCapabilityFor(bot?.type);
}

// Browser-safe QR capability descriptor (no resolve function crosses over).
export function qrCapabilityFor(type) {
  const { strategy, hintKey, field } = getAdapter(type)?.qr ?? {};
  return strategy ? { strategy, hintKey, field } : null;
}

// Reject a save whose credentials miss a required field. Returns an error
// string, or null when the credentials are acceptable. A generic channel row
// (pack-bot-units) validates against its platform binding: the binding must
// name one of the four platforms, then that platform's required fields apply.
export function validateCredentials(type, credentials) {
  if (type === "channel") {
    const platform = credentials?.platform;
    if (!BOT_TYPES.includes(platform)) {
      return `Channel bot needs a platform binding (credentials.platform: one of ${BOT_TYPES.join(", ")})`;
    }
    const missing = (getAdapter(platform)?.credentialFields ?? [])
      .filter((f) => f.required !== false && !String(credentials[f.key] ?? "").trim())
      .map((f) => f.key);
    return missing.length ? `Missing credentials: ${missing.join(", ")}` : null;
  }
  const adapter = getAdapter(type);
  if (!adapter) return `Unknown bot type "${type}"`;
  const missing = adapter.credentialFields
    .filter((f) => f.required !== false && !String(credentials?.[f.key] ?? "").trim())
    .map((f) => f.key);
  if (missing.length) return `Missing credentials: ${missing.join(", ")}`;
  // Field-level shape checks (make-im-lane-outbound-capable 2.1): a credential
  // that is PRESENT but unusable is the worse failure — it saves cleanly and
  // only fails at send time, when someone is waiting for an answer.
  for (const f of adapter.credentialFields) {
    if (typeof f.validate !== "function") continue;
    const value = String(credentials?.[f.key] ?? "").trim();
    if (!value) continue;
    const problem = f.validate(value);
    if (problem) return problem;
  }
  return null;
}

// ── Shared plumbing ──────────────────────────────────────────────────────────

// POST JSON and return the parsed body. Throws on transport failure or a
// non-2xx; platform-level error codes inside a 200 body are the adapter's job.
// Outbound call discipline: shared deadline wrapper (default env bound) — a
// stalled IM platform must not hang the bot lane.
export async function postJson(url, body, headers = {}) {
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

// Flat-XML field extractor for the WeCom/WeChat payloads, which are always
// <xml><Tag><![CDATA[value]]></Tag>…</xml> with no nesting or attributes.
// ponytail: a real XML parser would be a dependency for one shape that the
// platforms' own docs specify as flat; swap it in if a nested payload appears.
export function xmlField(xml, tag) {
  const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`).exec(xml);
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
}

// Cache a short-lived platform access token per adapter instance. `fetchToken`
// resolves { token, expiresInSec }; the cache expires 60s early so an in-flight
// request never races the real expiry.
export function tokenCache(fetchToken) {
  let token = null;
  let expiresAt = 0;
  return {
    async get() {
      if (token && Date.now() < expiresAt) return token;
      const fresh = await fetchToken();
      token = fresh.token;
      expiresAt = Date.now() + Math.max(0, (fresh.expiresInSec ?? 7200) - 60) * 1000;
      return token;
    },
    invalidate() { token = null; expiresAt = 0; },
  };
}
