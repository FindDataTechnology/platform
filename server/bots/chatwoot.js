// Chatwoot adapter (unify-im-solution). The self-hosted support desk is reached
// through fd-bot like every other platform: Inbound rides fd-bot's chatwoot
// adapter (Agent Bot webhook → fd-bot → the cell's /api/bots/events), and this
// module supplies only what the CELL needs to know about chatwoot — its
// credential shape, its outbound capability, and a direct send for the case
// where a row is still on `legacy` (no fd-bot binding) or an operator sends
// before a binding exists.
//
// Why a direct send lives here at all: fd-bot's outbound is Bearer-authenticated
// against the SAME API. Verified against live Chatwoot 4.19.0 (2026-11-21):
//   POST {base}/api/v1/accounts/{acc}/conversations/{conv}/messages
//   Authorization: Bearer <agent-bot token>, body {content, message_type:"outgoing"}
//   → 200. (The Bearer scheme is load-bearing; `Bot <token>` returned 401.)
//
// Inbound methods THROW: with the fd-bot transport, a chatwoot callback must
// arrive through /api/bots/events, never the legacy per-bot webhook. If a caller
// reaches verifyWebhook/parseMessage the routing is wrong — a silent null would
// hide exactly the dual-path drift this migration exists to remove.

import { fetchWithTimeout } from "../../lib/fetch-with-timeout.js";

// chatKey is "accountId:conversationId" (same shape fd-bot's adapter produces),
// so the outbound URL is derivable with no other lookup.
export function splitChatKey(chatKey) {
  const s = String(chatKey ?? "");
  const i = s.indexOf(":");
  return { accountId: s.slice(0, i), conversationId: i === -1 ? "" : s.slice(i + 1) };
}

export const registry = {
  // One credential both receives (via fd-bot) and sends; no caller-IP allowlist.
  outbound: { mode: "url-keyed", inbound: true },

  credentialFields: [
    { key: "baseUrl", label: "Chatwoot 实例地址 (https://desk.example.com)", required: true,
      validate: (v) => (/^https?:\/\/[^\s]+$/.test(String(v ?? "").trim()) ? null : "必须是 http(s):// 开头的完整地址") },
    { key: "apiToken", label: "Agent Bot access token", secret: true, required: true },
    { key: "accountId", label: "Account id", required: true },
    { key: "webhookSecret", label: "Webhook secret（= Agent Bot 的 secret 列）", secret: true, required: true },
  ],

  // No QR: a chatwoot bot is an Agent Bot created in the desk's own settings.
  qr: { strategy: "manual", field: "baseUrl", hintKey: "botsPage.qr.hint.manual" },

  async verifyWebhook() {
    throw new Error("chatwoot inbound is delivered by fd-bot (/api/bots/events), not the per-bot webhook");
  },
  async parseMessage() {
    throw new Error("chatwoot inbound is delivered by fd-bot (/api/bots/events), not the per-bot webhook");
  },

  async sendText(cred, chatKey, text) {
    const base = String(cred?.baseUrl ?? "").trim().replace(/\/+$/, "");
    const token = String(cred?.apiToken ?? "").trim();
    const accountId = String(cred?.accountId ?? "").trim();
    if (!base || !token || !accountId) throw new Error("chatwoot: baseUrl/apiToken/accountId are required to send");
    const { conversationId } = splitChatKey(chatKey);
    if (!conversationId) throw new Error("chatwoot: chatKey carries no conversation id");
    const res = await fetchWithTimeout(
      `${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: String(text ?? ""), message_type: "outgoing" }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`chatwoot send failed: ${res.status} ${body.slice(0, 160)}`.trim());
    }
    const created = await res.json().catch(() => ({}));
    return created?.id != null ? String(created.id) : null;
  },

  // 中间态：占位 + PATCH 改写（Chatwoot 支持编辑自己发的 outgoing 消息）。
  ack: {
    mode: "edit",
    async placeholder(cred, chatKey, text) {
      const base = String(cred?.baseUrl ?? "").trim().replace(/\/+$/, "");
      const token = String(cred?.apiToken ?? "").trim();
      const accountId = String(cred?.accountId ?? "").trim();
      if (!base || !token || !accountId) throw new Error("chatwoot: baseUrl/apiToken/accountId are required");
      const { conversationId } = splitChatKey(chatKey);
      if (!conversationId) throw new Error("chatwoot: chatKey carries no conversation id");
      const res = await fetchWithTimeout(
        `${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ content: String(text ?? ""), message_type: "outgoing" }),
        },
      );
      if (!res.ok) throw new Error(`chatwoot ack failed: ${res.status}`);
      const created = await res.json().catch(() => ({}));
      return created?.id != null ? String(created.id) : null;
    },
    async edit(cred, chatKey, messageId, text) {
      const base = String(cred?.baseUrl ?? "").trim().replace(/\/+$/, "");
      const token = String(cred?.apiToken ?? "").trim();
      const accountId = String(cred?.accountId ?? "").trim();
      const { conversationId } = splitChatKey(chatKey);
      if (!base || !token || !accountId || !conversationId) return false;
      try {
        const res = await fetchWithTimeout(
          `${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages/${encodeURIComponent(messageId)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ content: String(text ?? "") }),
          },
        );
        return res.ok;
      } catch {
        return false;
      }
    },
  },
};

export default registry;
