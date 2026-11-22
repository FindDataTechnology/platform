// Human-handoff escalation for the Chatwoot lane (chatwoot-ai-handoff).
//
// The stop-guard (server/routes/bot-events.js) makes the AI go silent once a
// conversation is assigned to a HUMAN. THIS is the other half: the explicit
// action that assigns one.
//
// Mechanism, verified against a live Chatwoot 4.19.0 (2026-11-23):
//   POST {baseUrl}/api/v1/accounts/{accountId}/conversations/{convId}/assignments
//   Authorization: Bearer <agent-bot token>
//   body {"assignee_id": <human user id>, "assignee_type": "User"}
//   → 200 {id, name, email, role, ...}
//
// Why NOT toggle_status {status:"pending"} (this change's original bug):
// `pending` on a bot inbox means "the AI is serving" — Chatwoot writes that
// status on every new bot conversation (conversation.rb set_active_bot_conversation,
// with a TODO to make it a setting) and bot_handoff! only fires FROM pending.
// Setting pending therefore leaves the visitor in the AI queue where no human
// can see them, which is the opposite of the intent.
//
// `assignments#create` is on Chatwoot's BOT_ACCESSIBLE_ENDPOINTS
// (access_token_auth_helper.rb), so the same agent-bot token works; and
// Conversations::AssignmentService#assign_agent moves the conversation out of
// pending (`open_on_assignment?`) and clears ai_assignee — exactly the state
// our stop-guard reads as "handed off".
//
// Who we assign to: the target comes from the bot's own credentials
// (`assigneeId`), because the agent-bot token cannot list account users
// (users#index is not bot-accessible, and there is no admin token on this lane).
// A rule-based target is also the honest shape — "who receives escalations" is
// an operator decision made once, not something to guess per message.
//
// Why here and not in fd-bot: "when to involve a human" is a business decision,
// not a platform protocol. fd-bot's boundary is "platform allows X"; this is
// "we want X". See design.md D2/D3.

import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";

/**
 * Assign a Chatwoot conversation to a human, moving it out of the AI queue.
 *
 * @param {object} bot        the bot ROW (type "chatwoot"); its credentials
 *                            carry { baseUrl, apiToken, accountId, assigneeId }.
 * @param {string} chatKey    "accountId:conversationId" (the fd-bot chatKey).
 * @param {object} [opts]     { fetchImpl, timeoutMs }  — fetchImpl is the test seam.
 * @returns {Promise<{ok:true,status:"open",assigneeId:number}
 *                 | {ok:false,failure:string,detail?:string}>}
 *
 * Never throws for a platform verdict (that is an outcome). Throws only on a
 * missing bot, a missing credential, or a bot with no configured target — those
 * are operator/config errors the caller must see, not results to classify.
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
  // A bot with no escalation target would otherwise "escalate" into nothing.
  // Refuse loudly: a silent no-op reads as success and the visitor waits forever.
  const assigneeId = Number(cred.assigneeId);
  if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
    throw new Error("escalateToHuman: chatwoot bot has no assigneeId configured (the human who receives escalations)");
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

  const url = `${base}/api/v1/accounts/${accountId}/conversations/${conversationId}/assignments`;
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ assignee_id: assigneeId, assignee_type: "User" }),
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
    // A 422 here usually means the target id is not an agent on this account.
    // Classify it as target-unavailable so the operator knows to fix the config,
    // distinct from a flat refusal.
    const failure =
      res.status === 401 || res.status === 403 ? "unauthorized"
        : res.status === 404 || res.status === 422 ? "target-unavailable"
          : "rejected";
    return { ok: false, failure, detail: `${res.status} ${text.slice(0, 160)}` };
  }
  // Chatwoot answers 200 with the assigned agent's payload. A null/absent body
  // means assignee_id did not resolve to a user (the controller renders nil).
  let assigned = null;
  try {
    const body = JSON.parse(text);
    assigned = body?.id ?? null;
  } catch {
    /* non-JSON 200: treat as accepted */
  }
  if (assigned === null) {
    return { ok: false, failure: "target-unavailable", detail: "assignments answered 200 with no agent (assigneeId did not resolve)" };
  }
  // AssignmentService moves a pending conversation to `open` on assignment; the
  // stop-guard reads that as handed off.
  return { ok: true, status: "open", assigneeId: Number(assigned) };
}
