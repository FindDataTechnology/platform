# Proposal — add-fleet-edge-context

## Why

舰队有四类"被动"回合，prompt 是手拼的、**都不含占位符**，于是它们拿不到任何舰队
上下文，而定时巡视轮能拿到 24KB：

| 回合 | 现状 | 证据 |
|---|---|---|
| 派发子回合 | 只有 4000 字 brief | `server/routes/fleets.js:1084-1086` |
| 接棒子回合 | 只有上游 2000/500 字结果 | `server/fleet-handoffs.js:101-108` |
| 扇出子回合 | 同上 | `server/fleet-handoffs.js:157-160` |
| 事件唤醒 | 只有 4000 字消息 | `server/fleet-event-wake.js:44-49` |

注入缝本身是唯一的、已经在的（引擎 `beforeTurn` → `cron.js composeFleetPrompt`，覆盖
四条入队路径），但它**只在 prompt 含 `{{fleetContext}}` 时渲染**。手拼的 prompt 不含，
所以这四类回合的下属一睁眼就只知道自己被点的这一件事：同一个舰队里兄弟岗位的报数、
阻塞、以及自己上一轮说过什么，全都不在。

后果不是"体验差"，是**重复劳动与互相踩踏**：被派发的岗位会重新去查一份兄弟岗位已经
报过的数；接棒的岗位会把上游刚做完的判断再过一遍；被唤醒的岗位不知道自己上一轮
在这个聊天里已经承诺了什么。

## What Changes

- 四类边回合的 prompt 末尾带上 `{{fleetEdgeContext}}`（persona 目标才带；a2a 是别的
  服务、tool 岗的 prompt 就是它的 JSON 参数，都不许污染）。
- `buildFleetContext` 增加 `mode: "edge"`：同一份舰队视图，但**去掉巡逻纪律尾段**
  （那段写着"先报数再补充：读完上下文就调用 report_status"——对一条被派发的回合是
  反向指令），**不渲染决策送达段**（送达是巡视轮的义务，在边回合消耗会把裁决标记成
  已送达而实际没人看），总量池 24KB → 8KB（边回合的主料是 brief，背景不能挤掉它）。
- 巡检轮（`{{fleetContext}}`）行为逐字节不变。

## Impact

- Affected specs: `agent-fleet-report-lane`（1 个新增 requirement）
- Affected code: `cron.js`（占位符识别）、`server/fleet-context.js`（edge 模式）、
  `server/routes/fleets.js`、`server/fleet-handoffs.js`、`server/fleet-event-wake.js`
  （四处 prompt 模板）、`server.js`（模式透传）
- 无迁移、无新表、无新依赖；token 渲染仍走既有注入缝，故"每次执行恰好一次"、
  "渲染失败显性化"两条既有条款自动适用。
