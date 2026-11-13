# Proposal: add-fleet-fanout

## Why

第二波代数第一刀(explore §五/Q9/Q10):辩论/并行意见/多方案竞选是 supervisor/pipeline 之外的第三种高频范式。既有 cluster 扇出只在**单集群内部**聚合;舰队级「一岗并行问 N 岗 + 一人裁决」无表达。本 change 加 **fanout 边**:回合结束后并行扇出到多岗,聚合三式(first/all/judge),环以**有界轮次**(rounds ≤3)合法化——裁决者判完可再打一轮,超界如实留痕拒绝。执行零新协调:**并行波=既有 manual 车道,裁决=delegation 聚合器原样复用**(全部终态→自动注入回合并切回 initiatorPreset)。

## What Changes

- **边类型 `fanout`**:`{kind:"fanout", from, targets:[ref…](≥2), aggregate?:{kind:"first"|"all"|"judge", judge?:ref}(默认 all), rounds?:1-3(默认 1)}`。图校验:targets 全存在且无重复、from 不得在 targets、judge 存在且非 from 非 targets、rounds ≤3 硬界、**tool 岗不可为 fanout 目标**(其参数是 per-hop args,扇出语义不适配;handoff+args 仍可用)、fanout 边**不入 DAG 环检测**(其环由 rounds 有界,深度仍受 maxChainDepth 全局界)。
- **运行期(收口缝扩展)**:上游回合结束后,每条出边 fanout 以 `wave+1` 计数(记 origin.fleet.wave),超 rounds 落 O1 事件拒绝不建任务;波内为**每个目标建 manual 回合**(depth+1,上游摘要转述,同 handoff);**聚合**:无 judge→目标组 initiator=上游会话(聚合器把全组结果注入上游岗下一回合);有 judge→initiator=`fleet:<fleetId>:<judgeRef>`、initiatorPreset=judge roster(聚合器自动起裁决回合,读全组产出)。judge 回合结束再查其出边——声明 judge→targets 回边即辩论环,wave 递增至 rounds 界止。
- **mode 预制图不变**;cockpit 边视图透传(既有 generic 渲染)。

## Capabilities

### New Capabilities

(无)

### Modified Capabilities

- `agent-fleet-orchestration`: MODIFIED——边文法从四種扩为五种(+fanout,含 targets/aggregate/rounds 形状与校验规则);ADDED——fanout 运行期(并行波/聚合三式/有界轮次环/超界留痕)。

## Impact

- **代码**:`server/fleet-orchestration.js`(校验+出边查询扩展)、`server.js` triggerFleetHandoffs 扩 fanout 波(judge initiator 接线)、fleet-architect 虚拟终态校验自动随动(复用同一函数)。
- **测试**:`test-fleet-orchestration.mjs` 补 fanout 矩阵(形状/目标/judge/rounds/环界/超界事件/裁决 initiator 接线);十三套回归零新增红。
- **兼容性**:既有四类边行为逐字节不变;DAG 检测仍只走 handoff(不变);出片随攒车列车。
- **非目标**:event 边(下一刀 bot 入站);first 聚合的提前取消(全组照跑,first 仅语义标注);不做 fanout 到 cluster/tool;不做自动收敛判定(轮次由声明界)。
