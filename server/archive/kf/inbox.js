// ── 微信客服：待回复队列 ────────────────────────────────────────────────────
//
// 「商机接住」这句话落到代码上就是一句判定：
// **客户最后一条消息之后，我们有没有回**。有就是接住了，没有就是漏了。
//
// 三条设计取舍：
//
// 1. **按截止时间排序，不按到达时间**。48 小时窗口是硬截止，越早到达的会话截止越早，
//    所以顺序天然等于"哪个快过期"。按到达时间排会让人先处理一堆还早的。
//
// 2. **错过的单独列出来**。窗口关闭后无法再回复，但它们仍是"客户问过、我们没答"的事实。
//    混进 needsReply 会让队列永远清不空；直接不显示等于把损失藏起来。
//
// 3. **不去重"我方最后一次回复"与事件**。系统事件（进入会话、会话结束）不算回复，
//    否则一条"客户已进入会话"就能把会话判成已处理。

import { REPLY_WINDOW_HOURS } from "./reply.js";

const REPLY_WINDOW_MS = REPLY_WINDOW_HOURS * 3_600_000;

/**
 * 列待回复与已错过。
 *
 * `now` 必传（默认 Date.now()）——测试要能定住时钟，否则断言会跟着真实时间漂移。
 */
export function kfInbox(db, { now = Date.now(), limit = 50 } = {}) {
  const rows = db
    .prepare(
      `SELECT c.conversation_id, c.open_kfid, c.external_userid, c.name,
              (SELECT MAX(sent_at) FROM kf_message m
                 WHERE m.conversation_id = c.conversation_id AND m.origin = 'peer') AS last_peer_at,
              (SELECT MAX(sent_at) FROM kf_message m
                 WHERE m.conversation_id = c.conversation_id AND m.origin = 'self') AS last_self_at,
              (SELECT text FROM kf_message m
                 WHERE m.conversation_id = c.conversation_id AND m.origin = 'peer'
                 ORDER BY sent_at DESC LIMIT 1) AS last_peer_text
         FROM kf_conversation c`,
    )
    .all();

  const needsReply = [];
  const missed = [];

  for (const row of rows) {
    const lastPeerAt = Number(row.last_peer_at || 0);
    if (!lastPeerAt) continue; // 只有系统事件的会话不算商机
    const lastSelfAt = Number(row.last_self_at || 0);
    // 我方最后一次回复在客户最后一条之后 → 已处理。事件不参与这个比较。
    if (lastSelfAt > lastPeerAt) continue;

    const elapsed = Number(now) - lastPeerAt;
    const deadline = lastPeerAt + REPLY_WINDOW_MS;
    const item = {
      conversationId: row.conversation_id,
      openKfId: row.open_kfid,
      externalUserId: row.external_userid,
      name: row.name || "",
      lastPeerAt,
      lastPeerText: row.last_peer_text || "",
      waitingMs: Math.max(0, elapsed),
      waitingHours: Math.max(0, elapsed) / 3_600_000,
      hoursLeft: Math.max(0, (deadline - Number(now)) / 3_600_000),
      deadline,
    };

    if (elapsed > REPLY_WINDOW_MS) missed.push(item);
    else needsReply.push(item);
  }

  // 越晚到达的截止越晚；按截止升序 = 最急的在前。
  needsReply.sort((a, b) => a.deadline - b.deadline);
  missed.sort((a, b) => b.lastPeerAt - a.lastPeerAt);

  const limited = needsReply.slice(0, Math.max(1, Number(limit) || 50));
  return {
    needsReply: limited,
    missed: missed.slice(0, Math.max(1, Number(limit) || 50)),
    summary: {
      needsReply: needsReply.length,
      missed: missed.length,
      // 只有事件、没有客户发言的会话数（不算商机，但能看出账号是否在被使用）
      idle: rows.length - needsReply.length - missed.length,
      windowHours: REPLY_WINDOW_HOURS,
    },
  };
}
