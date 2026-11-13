# Proposal: add-fleet-event-wake

## Why

第二波代数最后一刀(explore §五/Q9:「event 只绑已有信号源,不建总线;社聊 bot 入站为第一候选」):外部事件唤醒岗位——客户给 bot 发消息、告警到达、需求单落进——舰队里应该有岗自动起来干活。`server/bots.js` 的入站管线是现成信号源(尺寸/频次守卫俱备);turn-contract 的 `event` 源至今是保留位,本 change **解锁它**:第一个事件源绑定,路由图上六种边齐型。

## What Changes

- **边类型 `event`**:`{kind:"event", from:"bot:<botId>", to:<postRef>}`。校验:from 形如 `bot:<id>`(存在性留运行期如实——bot 注册表是运行态,写时强校验会腐烂)、to 为本舰 persona/a2a 岗(cluster/tool 无 manual 车道,拒);事件边无环义,不入 DAG。
- **入站唤醒**:`handleMessage` 守卫(尺寸/频次)通过后,**额外**触发 `triggerFleetEventWake`——扫描舰队 event 边,命中即为目标岗建 manual 回合(brief=发送者+消息原文,`origin.fleet {memberId, depth:0}` + `origin.event {botId, chatKey}`);bot 自身会话回合**照常**(v1 语义:bot 答聊天,岗位异步做舰队事——双回合是 owner 声明边时的知情选择)。护栏:每岗每小时 ≤30(env `FLEET_EVENT_WAKE_HOURLY_CAP`),超限如实落 O1 事件留痕不建任务。
- **source=event 解锁**:`buildTurnRequest` 从 `origin.event` 派生 source=event;`SOURCES` 增 event、RESERVED 只余 peer(O3 派发道);O1 事件三源变四源,舰队级 turns 读面与架构师桥 turns 的 source 过滤值集同步加 event。
- **零新总线**:只绑 bots 入站这一个已有信号源;不做事件路由表、不做通配订阅、不做出站回投(岗位产出落会话+事件,驾驶舱可见;bot 聊天回答仍属 bots.js v1 语义)。

## Capabilities

### New Capabilities

(无)

### Modified Capabilities

- `agent-fleet-orchestration`: MODIFIED——边文法六种(+event,含 bot: 形状与目标域规则);ADDED——bot 入站唤醒(守卫后触发、双回合语义、每小时护栏、超限留痕)。
- `agent-turn-contract`: MODIFIED——event 从保留位转入合法源(保留位仅余 peer),派生自 origin.event。

## Impact

- **代码**:`server/fleet-orchestration.js`(校验)、新 `server/fleet-event-wake.js`(唤醒器,db+engine 注入可测)、`server/bots.js`(handleMessage 一处触发)、`server.js`(ctx 接线)、`server/turn-request.js`(event 解锁)、读面过滤值集两处(fleets.js/fleet-architect.js)。
- **测试**:`test-turn-request` 补 event 派生与合法性;`test-fleet-orchestration` 补 event 边校验;新增 `test-fleet-event-wake.mjs`(命中建任务形状/未命中零扰/护栏超限留痕/cluster-tool 目标拒)。十三套回归零新增红。
- **兼容性**:无 event 边的 bot 行为逐字节不变;既有五类边不变;出片随攒车列车。
- **非目标**:不做通配/多订阅、不做出站回投到聊天、不做第二信号源(覆盖缺口/质量快照等后续按需)、不做事件去重。
