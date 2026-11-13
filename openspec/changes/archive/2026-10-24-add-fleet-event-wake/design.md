# Design: add-fleet-event-wake

> 第二波最后一刀;「零新总线」——只绑 bots.js 入站这一个既有信号源。

## D1 · 唤醒器独立小模块(可测)

新 `server/fleet-event-wake.js`:`triggerFleetEventWake({db, engine, roster}, botId, {chatKey, senderName, text})`——扫非归档舰队的 orchestration event 边(from 精确匹配 `bot:<botId>`),逐命中建 manual 任务(prompt=【事件唤醒】发送者+原文;persona/a2a;origin.fleet {memberId, depth:0} + origin.event {botId, chatKey});每岗每小时护栏(in-memory 桶,同 dispatch 款,env `FLEET_EVENT_WAKE_HOURLY_CAP` 默认 30),超限落 O1 事件(status=failed, error=event wake hourly cap)。返回创建清单(日志用)。bots.js 只调 `state.ctx.triggerFleetEventWake?.(...)`——缺省静默(老部署/测试无舰队面零扰)。

## D2 · source=event 解锁(契约)

`buildTurnRequest`:`origin.event?.botId` 存在 → source="event"、depth=0(外部发起,优先于 fleet 归属链);`SOURCES` + event,RESERVED 只余 peer。O1 归属照旧走 origin.fleet(事件任务两段都带);recordTurnEvent 的 source 自动随契约(单一定源)。读面 source 过滤值集(fleets.js turns 端点 + architect 桥)加 "event"。

## D3 · 校验

event 边:from 形状 `/^bot:[A-Za-z0-9._-]+$/`(存在性留运行期——bot 注册表是运行态);to 存在且 kind ∈ {persona,a2a}(cluster/tool 拒,文案同 fanout 款);不入 DAG;from 形状失败时 from 的存在性错误信息换 bot 措辞(generic ref 检查跳过 event 的 from)。

## D4 · 双回合语义(如实记)

命中消息产生**两个**回合:bot 会话回合(答聊天,bots.js v1 不动)+ 岗位 manual 回合(做舰队事)。这是 owner 声明边时的知情选择——成本预估面由架构师 diff 呈现(后续);本刀不做「绑边后 bot 静默」选项、不做岗位产出回投聊天(那些是 channel-fusion 的活,另一刀)。

## D5 · 测试

新 `test-fleet-event-wake.mjs`:命中建任务(origin 两段+prompt)/未命中零扰/护栏超限落事件/cluster-tool 目标在建面被拒(校验侧);turn-request 补 event 派生两断言;orchestration 补 event 边三态。十三套回归零新增红。

## D6 · 不做

通配订阅/多信号源(后续按需:覆盖缺口、质量快照、需求单)、出站回投聊天、事件去重、bot 静默模式。
