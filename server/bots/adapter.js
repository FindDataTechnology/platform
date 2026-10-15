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
//   parseMessage(req, cred) -> Promise<{ chatKey, senderName, text } | null>
//        null = ignore (edits, reactions, our own echoes, non-text messages).
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

export const BOT_TYPES = ["telegram", "feishu", "wecom", "wechat-oa"];

let registry = null;
function adapters() {
  if (!registry) registry = { telegram, feishu, wecom, "wechat-oa": wechatOa };
  return registry;
}

export function getAdapter(type) {
  return adapters()[type] ?? null;
}

// Adapter-declared credential fields, for the config form and save validation.
export function credentialFieldsFor(type) {
  return getAdapter(type)?.credentialFields ?? [];
}

// Browser-safe QR capability descriptor (no resolve function crosses over).
export function qrCapabilityFor(type) {
  const { strategy, hintKey, field } = getAdapter(type)?.qr ?? {};
  return strategy ? { strategy, hintKey, field } : null;
}

// Reject a save whose credentials miss a required field. Returns an error
// string, or null when the credentials are acceptable.
export function validateCredentials(type, credentials) {
  const adapter = getAdapter(type);
  if (!adapter) return `Unknown bot type "${type}"`;
  const missing = adapter.credentialFields
    .filter((f) => f.required !== false && !String(credentials?.[f.key] ?? "").trim())
    .map((f) => f.key);
  return missing.length ? `Missing credentials: ${missing.join(", ")}` : null;
}

// ── Shared plumbing ──────────────────────────────────────────────────────────

// POST JSON and return the parsed body. Throws on transport failure or a
// non-2xx; platform-level error codes inside a 200 body are the adapter's job.
export async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
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
