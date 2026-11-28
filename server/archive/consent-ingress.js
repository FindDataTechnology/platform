// ── 同意变更回调的平台入口（cell 形态）───────────────────────────────────────
//
// `applyApprovalEvent` 早就写好了，但它唯一的调用者是 `cli.mjs consent-event`——
// 从 **stdin** 读明文 XML。平台 cell 里没人会往那个进程的标准输入灌企微回调：
// 拉取是 CronJob，读面是 MCP，`server.js` 全文没有一个 `consent`。
//
// 于是客户撤回同意之后，拉取侧最多还会继续写 5 分钟（`createConsentCache` 的 TTL）。
// 那不是延迟，是"客户说不许存、我们还在存"。
//
// 这个模块把已有的验签入口（`/api/bots/webhook/:botId/:secret` → `adapter.parseEvent`）
// 接到 `applyApprovalEvent` 上。三条边界：
//
// 1. **只碰库，不碰进程内缓存。** 缓存属于拉取进程（另一个进程），清了也没用。
//    真正把两边连起来的是 `archive_consent_event` 水位表：`consent-api.js` 判
//    `entry.at >= eventAt` 才敢用缓存，所以写下水位的效果就是"下一次必须重查"。
//
// 2. **开关只有一个：`ARCHIVE_DB`。** 不加第二个 enable 开关——"两处开一处忘"
//    是本项目反复踩的形态。未配置时整条路径 no-op，且不打开库、不建文件。
//
// 3. **永不抛到调用方。** 调用方是企微回调入口，企微对非 200 会重试；重试不会
//    让库突然可写，只会把故障窗口拉长并拖累共用同一 URL 的 bot 车道。失败在这里
//    收口成返回值，由入口记一行日志。

import { DatabaseSync } from "node:sqlite";
import { APPROVAL_EVENT, applyApprovalEvent } from "./consent-event.js";
import { ensureArchiveSchema, recordConsentEvent } from "./store.js";

/**
 * 消费一条已验证签的回调事件。
 *
 * @param {object} deps
 * @param {{event:string, xml:string, from?:string}} deps.event  适配器交出的明文事件
 * @param {object} [deps.env]    读 `ARCHIVE_DB`
 * @param {() => number} [deps.now]
 * @returns {{handled:boolean, reason?:string, event:string, [k:string]:unknown}}
 */
export function handleInboundEvent({ event, env = process.env, now = () => Date.now() } = {}) {
  const name = String(event?.event ?? "");

  // 先按事件名分流，再碰库：回调 URL 往往是全企业共用的，别的车道的事件
  // 必须零副作用（不进库、不开库）。
  if (name !== APPROVAL_EVENT) {
    return { handled: false, reason: "not_approval_event", event: name };
  }

  const dbPath = String(env.ARCHIVE_DB ?? "").trim();
  if (!dbPath) {
    return { handled: false, reason: "archive_db_unset", event: name };
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    ensureArchiveSchema(db);
    // 报文不是 XML（机器人世代用 JSON 事件，字段形状未经实证）：**不猜字段**，
    // 只记一次全局水位。效果是下一轮拉取对所有会话重新问官方接口——方向安全
    // （宁可多问一次），代价是一次全量重查。反过来"什么都不做"会让撤回漏掉。
    if (!String(event?.xml ?? "").trim()) {
      recordConsentEvent(db, "*", now());
      return {
        handled: false,
        reason: "opaque_event_global_invalidate",
        event: name,
        invalidated: "all",
        persisted: false,
      };
    }
    const out = applyApprovalEvent({ db, xml: String(event?.xml ?? ""), now });
    return { ...out, event: name };
  } catch (err) {
    // 不抛：见文件头第 3 条。原因要能读，否则"事件没生效"和"事件没到"看不出区别。
    return {
      handled: false,
      reason: `archive_error:${err?.name || "Error"}:${err?.message || ""}`.slice(0, 300),
      event: name,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* 关不掉不影响结论 */
    }
  }
}
