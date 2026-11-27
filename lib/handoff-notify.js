// Notify a human when a conversation lands in their queue (chatwoot-ai-handoff follow-up).
//
// Why this exists: the stop-guard and the handoff make a conversation "handed
// off" the moment it is assigned, but nobody learns about it — a support desk
// is a place you have to be LOOKING AT. If no agent has the dashboard open,
// the visitor sits in the queue indefinitely, which reads to them exactly like
// the AI being broken.
//
// Deliberately small and decoupled:
//   - It sends through **fd-bot by binding id**, not `bots.sendTo`. sendTo only
//     works for a bot loaded in THIS cell; the notification destination (an
//     internal group) normally lives in a different owner's cell. fd-bot is
//     deployment-wide, so a binding id is addressable from anywhere.
//   - It is BEST-EFFORT. A failed notification must never fail the handoff —
//     the assignment already landed, and the visitor is already better off
//     than before. Logged, not thrown.
//   - The destination is OPERATOR-CONFIGURED (bot credentials
//     `notifyBindingId` / `notifyChatKey`), never guessed: these are internal
//     group chats, and picking one by heuristic would page the wrong team.
//
// Not a general notification bus. A second consumer should get its own change
// rather than quietly widening this one.


/**
 * Send one alert line to the configured notification destination.
 *
 * @param {object} bot   the chatwoot bot ROW (credentials carry the destination)
 * @param {object} info  { chatKey, reason, note, summary, assigneeId }
 * @param {object} [opts] { send }  — the test seam (sendThrough in prod).
 * @returns {Promise<{sent:true}|{sent:false,why:string}>}  never throws.
 */
export async function notifyHandoff(bot, info = {}, { send } = {}) {
  if (typeof send !== "function") {
    // Keep this module pure: the outbound path lives in server/fd-bot-client.js,
    // and importing it here would drag the transport stack into a unit test.
    // The caller (the escalate route) injects sendThrough.
    return { sent: false, why: "no sender injected" };
  }
  const cred = bot?.credentials ?? {};
  const notifyBindingId = String(cred.notifyBindingId ?? "").trim();
  const notifyChatKey = String(cred.notifyChatKey ?? "").trim();
  if (!notifyBindingId || !notifyChatKey) {
    return { sent: false, why: "no notification destination configured" };
  }

  const text = renderAlert(info);
  try {
    // sendThrough returns a verdict; a non-ok verdict is still a failed page.
    const verdict = await send({ bindingId: notifyBindingId, chatKey: notifyChatKey, text });
    if (verdict && verdict.ok === false) {
      return { sent: false, why: verdict.detail || verdict.failure || "fd-bot refused" };
    }
    return { sent: true };
  } catch (err) {
    // Unreachable channel, disclosure gate, rate limit — all non-fatal here.
    return { sent: false, why: err?.message ?? String(err) };
  }
}

/**
 * The alert text. Pure, so the wording is testable without a channel.
 *
 * Privacy: `summary` was already authored by the agent under the "do not
 * include data the visitor did not volunteer" rule; it is forwarded as-is and
 * NOT re-quoted with contact details. The chat key is an opaque internal id.
 */
export function renderAlert({ chatKey, reason, note, summary, assigneeId } = {}) {
  const lines = ["【访客转人工】有一条会话等待接待。"];
  const why = {
    cannot_answer: "AI 判断回答不了",
    visitor_asked: "访客明确要求人工",
    beyond_authority: "超出 AI 授权范围",
  }[reason] || (reason ? String(reason) : "未注明原因");
  lines.push(`原因：${why}`);
  if (note) lines.push(`备注：${String(note).slice(0, 300)}`);
  if (summary) lines.push(`访客说：${String(summary).slice(0, 500)}`);
  if (chatKey) lines.push(`会话：${String(chatKey)}`);
  if (assigneeId) lines.push(`已指派给用户 #${String(assigneeId)}（请在客服台接手）`);
  return lines.join("\n");
}