# Tasks — clarify-zhiyu-guest-failure-copy

## 1. 服务端归类

- [x] 1.1 `room-router.js` 失败分支：按 reason 正则标 `retryable`（429/5xx/ECONN*/ETIMEDOUT/socket hang up/Connection error/timeout/aborted = true；405/parked/未部署/未知 = false），仅对 `agent_failed` 事件附加（`agent_declined_insolvent` 不附）；验证：六类真实 reason 归类脚本全对（4 retryable + 2 fatal）
- [x] 1.2 `meta.reason` 仍保留（进日志/运维视角），但**不出现在任何访客可见文案**；验证：访客侧只渲染固定词条，代码审查确认无 reason 插值

## 2. 访客与站内文案

- [x] 2.1 嵌入页：新增 `agent_failed_retryable: 「接待席位正忙，请稍后再问一次」`，`labelFor()` 按 `meta.retryable` 选词条，白名单同时容纳两个 key；验证：`npm --prefix web run typecheck` 绿
- [x] 2.2 站内房间页：`zhiyu.event.agent_failed_retryable` 词条（五语）+ 白名单 + key 派生按 `meta.retryable`；验证：typecheck + `check:locales` 五语绿
- [x] 2.3 五语词条：zh-CN/en/es/fr/ja 各自真翻，不回落中文；验证：`npm run check:locales` 报 all 5 locales OK

## 3. 回归与收口

- [x] 3.1 zhiyu 七套件回归；验证：76/76 绿
- [x] 3.2 `openspec validate clarify-zhiyu-guest-failure-copy --strict`；验证：绿
- [x] 3.3 上产核验（2026-11-10，镜像 `sha-4d5662e`，基线 `a0a2c3de7`）：三层逐项对位——①服务端 `/app/gateway/zhiyu/room-router.js` 的 `retryable` 命中 2；②`ZhiyuEmbedPage-*.js` 命中 `agent_failed_retryable` 1 处；③`ZhiyuRoomPage-*.js` 命中 2 处。分类正确性由六类真实 reason 的脚本比对保证（4 retryable / 2 fatal 全对）。
  注：**没有制造一次真实可重试失败**做端到端肉眼验（要制造 429/5xx 得改上游配置或压测，代价与风险都不值），因此"访客真的看到『正忙』"这一眼仍未取得；这是本项唯一没走到的最后一米，如实记下。

## 实施记录

- 归类判据直接取自演示房生产记录的六类真实 reason（429/502/503/连接错误/405/parked），脚本逐条比对，4 判 retryable、2 判 fatal，全对。
- 未改任何重试行为与计费——只把话说准：忙 ≠ 坏。

## 4. 等待期诚实读数（同批，同一体验面）

- [x] 4.1 实测四席应答耗时 14.5s / 15.3s / 24.4s / 27.0s（a2a ping，2026-11-10）；当时访客侧气泡只有一个「…」，半分钟读作死寂。改为显示**已等 N 秒**，超过 15 秒补一句「上游较慢，仍在等」；气泡不足 3 秒不显示秒数（避免闪烁）
- [x] 4.2 实现：overlay 增 `startedAt`，仅在有气泡时每秒 tick 强制重渲染（无气泡不空转）；验证：`typecheck` + `vite build` 绿
- [x] 4.3 上产后真机验（镜像 `sha-0ef03c7`，基线 `f2c66d444`）：390×844 视口打开公开 embed 令牌、以访客身份发问，每秒采样气泡文案 23 次，直至答案落行。结果：
  - 首次出现秒数：`产品向导 · 正在作答（已等 3 秒）`（<3 秒不显示，符合设计）
  - 15 秒起补提示：`（已等 15 秒，上游较慢，仍在等）`
  - 消失前最后一次：`（已等 22 秒，上游较慢，仍在等）`
  - 秒数单调递增（23 个采样逐点比对为真），答案随后落行（`answered: true`）
  即长等待不再读作死寂。探针行已按 seq 窗口清理（见任务备注）。

## 备注（2026-11-10 19:03 上产核验）

- ArgoCD 应用层仍是 `OutOfSync / Progressing`，但 **platform 这一个 workload 已同步**：`desired=1 updated=1 available=1 ready=1`，`rollout status` 返回 `successfully rolled out`，运行时镜像 `sha-0ef03c7`。应用层 OutOfSync 来自同一 app 里的其它 workload（如 `platform-demo` 在别人的 `sha-b3a68fc` 上），不是本片。
- 保留期 sweep 日志**本 pod 无输出是正确的**：`minIntervalMs` 默认 20 小时，标记停在 `14:01:18`，19:03 时只过了约 5 小时 → 未到期 → `retentionTick` 返回 `ran:false` 且不打日志。真实跑过的证据是 12:09:46 与 14:01:18 两次标记推进（且 14:01:18 那次真删了 40 天前的 system 行）。
- 顺带发现（不在本单范围，未处理）：演示房一次作答的结算报 `host-settle HTTP 404: {"error":"no such deployment"}` —— 席位能答但计费落点找不到台账行。属计费链问题，另立。
