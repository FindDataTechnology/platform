// Human-handoff escalation for the Chatwoot lane (unify-im-solution C1.4).
//
// The stop-guard (server/routes/bot-events.js) already makes the AI go silent
// once a conversation is `pending` or assigned to a human. THIS is the other
// half: the explicit action that PUTS a conversation into the human queue.
//
// Mechanism, verified against a live Chatwoot 4.19.0 (2026-11-21):
//   POST {baseUrl}/api/v1/accounts/{accountId}/conversations/{convId}/toggle_status
//   Authorization: Bearer <agent-bot token>   body {"status":"pending"}
//   → 200, conversation status becomes "pending" (sits in the human queue,
//     often still unassigned). A human later assigns themselves; bot_handoff!
//     fires then. Both states stop the AI (see the guard's two conditions).
//
// Why here and not in fd-bot: "when to involve a human" is a business decision,
// not a platform protocol. fd-bot's boundary is "platform allows X"; this is
// "we want X". See design.md D7.

import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

/**
 * Flip a Chatwoot conversation into the human queue.
 *
 * @param {object} bot        the bot ROW (type "chatwoot"); its credentials
 *                            carry { baseUrl, apiToken, accountId }.
 * @param {string} chatKey    "accountId:conversationId" (the fd-bot chatKey).
 * @param {object} [opts]     { fetchImpl, timeoutMs }  — fetchImpl is the test seam.
 * @returns {Promise<{ok:true,status:string} | {ok:false,failure:string,detail?:string}>}
 *
 * Never throws for a platform verdict (that is an outcome). Throws only on a
 * missing bot/credential, which is a programmer error the caller must see.
 */
export async function escalateToHuman(bot, chatKey, { fetchImpl = null, timeoutMs = 10_000 } = {}) {
  if (!bot || bot.type !== "chatwoot") throw new Error("escalateToHuman: bot is not a chatwoot bot");
  const cred = bot.credentials ?? {};
  const base = String(cred.baseUrl ?? "").trim().replace(/\/+$/, "");
  const token = String(cred.apiToken ?? "").trim();
  const accountId = String(cred.accountId ?? "").trim();
  if (!base || !token || !accountId) {
    throw new Error("escalateToHuman: chatwoot bot is missing baseUrl/apiToken/accountId");
  }
  const i = String(chatKey ?? "").indexOf(":");
  const keyAccount = i === -1 ? "" : String(chatKey).slice(0, i);
  const conversationId = i === -1 ? "" : String(chatKey).slice(i + 1);
  // The chatKey carries the account id; if it disagrees with the credential,
  // trust the credential's accountId (it is what the token is scoped to).
  if (!conversationId) return { ok: false, failure: "bad-key", detail: `bad chatKey "${chatKey}"` };
  if (keyAccount && keyAccount !== accountId) {
    return { ok: false, failure: "account-mismatch", detail: `chatKey account ${keyAccount} != credential ${accountId}` };
  }

  const url = `${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`;
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: "pending" }),
      },
      { fetchImpl, timeoutMs },
    );
  } catch (err) {
    // Transport failure: the caller must be able to distinguish "we could not
    // reach the desk" from "the desk refused" — same discipline as fd-bot sends.
    return { ok: false, failure: "unreachable", detail: err.message };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, failure: res.status === 401 || res.status === 403 ? "unauthorized" : "rejected", detail: `${res.status} ${text.slice(0, 160)}` };
  }
  // Chatwoot answers 200 with the conversation payload; status is the proof.
  let status = null;
  try {
    const body = JSON.parse(text);
    status = body?.status ?? body?.payload?.status ?? null;
  } catch {
    /* non-JSON 200: treat as accepted, status unknown */
  }
  return { ok: true, status: status ?? "pending" };
}
