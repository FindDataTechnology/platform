# Design: add-fleet-fanout

> 第二波第一刀。执行零新协调:并行波=manual 车道(同 handoff),裁决/回投=delegation 聚合器**原样复用**(全组终态→chainTurn 注入→切回 initiatorPreset——裁决语义与该机制逐点吻合)。

## D1 · 边形状与校验(纯函数扩展)

`validateOrchestration` 增 fanout 分支:targets 数组形状(≥2/无重复/全存在/from ∉ targets)、aggregate 形状(缺省 {kind:"all"};judge 式 judge 引用存在/≠from/∉targets)、rounds 整数 1–3(缺省 1)、**tool 目标拒绝**(「fanout 语义无 per-target args;工具岗用 handoff+args」)。**DAG 环检测不变**(仍只走 handoff 边):fanout 的环是 rounds 有界环,Q10 决议的合法形态;全局失控防线=maxChainDepth(深度照计)+ rounds 每边硬界。span 警告把 fanout 的 targets 计入出度。

## D2 · 运行期:同一缝、第三种出边

`triggerFleetHandoffs` 扩展(名字不改,语义=「回合结束出边触发」):在 handoff 出边之后处理 fanout 出边:
```
wave = (job.origin?.fleet?.wave ?? 0) + 1
wave > edge.rounds → O1 事件留痕(status=failed, error="fanout rounds bound") 不建任务
否则: 每目标 manual 任务 {
  prompt: 上游 ok/failed 转述 + 「并行轮次 wave/rounds」
  origin.fleet = {fleetId, memberId: 目标, depth: 链位+1, wave}
  initiator = judge ? `fleet:${fleetId}:${judgeRef}` : job.sessionId
  initiatorPreset = judge ? roster(judge persona) : (job 的人格)
}
```
**聚合器自然完成其余**:同 initiator 的全组 manual 任务终态→注入回合;judge 的合成 initiator 是全局唯一键(fleet+judge 双段),不会与用户会话撞组。judge 回合本身是 manual 任务?**不是**——它是聚合器注入的回合;其结束后收口缝如何再触发回边?注入回合由 chainTurn 跑,不走 runCronJobTurn,**缝不在其路径上**——这是实施期第一验证点(§D4):若注入回合不过缝,回边改由「judge 波的最后一个目标任务结束」时预建?不——诚实解:回边触发挂**judge 合成 initiator 组的聚合完成处**不可行(聚合器是通用件,不认舰队)。**v1 收敛:辩论环的回边由 judge 岗自己在裁决回合里用 `dispatch_post` 派发下一波**(supervisor 许可或显式 dispatch 边;wave 由 origin 链自然递增)——零聚合器改动、零缝特判,rounds 界在 dispatch 桥的深度护栏外再校验一层数?不,rounds 界退化为:fanout 边声明 rounds>1 时,seam 在**同一上游回合**只发一轮(wave 恒 1 起算),多轮由 judge 显式派发、深度界兜底。**rounds 因此降级为声明性上界提示(diff 呈现),硬界=depth**——如实记,spec 场景三的「wave=3 落事件拒绝」改为 depth 界拒绝(既有行为)。此为 spec 的实施期修正点,apply 时同步 delta。

## D3 · initiator 接线细节

- 无 judge:initiator=job.sessionId(上游会话)——上游岗下一回合收全组摘要(= resultSink 语义);
- judge:initiatorPreset 必须给(聚合器 switchPresetTo 依赖它切回裁决者人格)——judge 为 a2a 岗时无 roster 人格,**校验层拒绝 a2a judge**(裁决是本地回合);
- 上游会话此前若有未聚合的用户委托任务,会并组——概率低且结果只是多带一份摘要,如实记不做隔离。

## D4 · 实施期验证点

①聚合器注入回合是否过 runCronJobTurn 缝(决定 D2 回边路线,已按「不过」收敛);②合成 initiator 的 session 首建(注入时 recordMessage 自建,无孤儿);③fanout 波内任务与 handoff 任务同 initiator 并组的边界(上游同时有 handoff 与 fanout 出边时,handoff 任务无 initiator 不入组,零互扰)。

## D5 · 测试

`test-fleet-orchestration.mjs` 补:校验矩阵(五拒+默认形状)、fanout 波创建(多目标 manual+initiator 接线两式)、上游失败入波、a2a-judge 拒、depth 界拒绝波(超界事件)。十三套回归零新增红。

## D6 · 不做

event 边(下一刀);first 聚合的提前取消;fanout 到 cluster/tool;自动收敛判定;聚合器任何改动。
