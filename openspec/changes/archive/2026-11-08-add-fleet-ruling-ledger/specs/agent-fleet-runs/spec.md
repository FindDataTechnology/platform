## ADDED Requirements

### Requirement: 汇总回合以发起者身份执行并结束

聚合器注入的汇总/裁决回合 SHALL 在其 prompt 发出**之前**开启回合节点,使该回合在飞期间即可被下游引用(裁决回合内显式派发下一波时,该派发的链位 SHALL 指向本汇总回合)。回合 SHALL 在结束时(成功或失败)写入一条回合结果事件,携带 outcomes 的真实结论与运行时上报的 usage;运行时未上报 usage 时 SHALL 落空缺,SHALL NOT 以 0 冒充。回合开始/写入失败 SHALL 降级放行:汇总本身 SHALL NOT 因账本不可用而失败。

#### Scenario: 裁决回合内的派发链到裁决回合

- **WHEN** 裁决回合在其执行期间调用 dispatch_post 发起第二轮
- **THEN** 新建任务的链位 parentTurnId 为该裁决回合的回合标识,而 SHALL NOT 为该波更早的回合

#### Scenario: 失败也留痕

- **WHEN** 汇总回合的执行失败或被中断
- **THEN** 仍写入一条状态为失败的回合结果事件并携带错误摘要,该 run 的合计如实计入失败一个

#### Scenario: 账本不可用不拖倒汇总

- **WHEN** 运行账本未挂载或开启回合节点抛错
- **THEN** 汇总回合照常发出,错误只记警告,SHALL NOT 中断聚合

## MODIFIED Requirements

### Requirement: 执行实例以 runId 贯穿同源回合链

根回合(source 为 cron|event|manual 且不携带上游链位)SHALL 在其回合结果事件写入时铸造 runId;由派发(dispatch)、流转(handoff)、扇出(fanout)点火的下游回合 SHALL 沿任务携带的链位信息继承其发起回合的 runId,并记录 parentTurnId(发起回合标识)与 edgeKind(dispatch|handoff|fanout)。链位信息 SHALL 由点火侧在创建下游任务时写入任务记录,回合契约派生 SHALL 只读该信息、不产生副作用、不引入第二套身份判定。非舰队回合 SHALL 不产生 run。同一 run 的首个回合开始时 SHALL 落一条头表行(舰队标识、根来源、根岗位、开始时刻、状态 open);run 内最后一个回合结束后 SHALL 收口头表(结束时刻、状态 ok|failed|partial、合计:回合数/成功数/失败数/token 合计);收口 SHALL 幂等。

**汇总/裁决回合 SHALL 同为本 run 的节点**：聚合器在注入汇总回合前 SHALL 以发起者为岗位、以该波携带的链位(runId + 发起回合标识 + 边种类)开一个回合节点,并在回合结束(成功或失败)时写入其回合结果事件与 usage,随后收口该 run。聚合回合 SHALL NOT 被视为新 run 的根——它属于它正在汇总的那一波。回合的岗位归属 SHALL 由既有数据判定:裁决波取发起者标识中携带的裁决岗,无裁决波取该波点火侧记下的发起岗;两者皆无时 SHALL NOT 造节点(诚实空缺,不猜测归属)。

#### Scenario: 定时根回合铸造 run

- **WHEN** 一支舰队的定时运行触发某岗位的根回合并结束
- **THEN** 该回合事件携带新铸造的 runId、parentTurnId 为空、edgeKind 为空,头表出现一行根来源=cron、根岗位=该岗的 run

#### Scenario: 流转回合继承链位

- **WHEN** 一条 handoff 边在上游回合结束后点火下游岗位并完成回合
- **THEN** 下游回合事件的 runId 与上游相同、parentTurnId=上游回合标识、edgeKind=handoff

#### Scenario: 三跳同串成树

- **WHEN** 根回合派发岗位甲,甲流转岗位乙,乙扇出岗位丙与丁
- **THEN** 五个回合事件 runId 相同,以 parentTurnId×edgeKind 还原为一棵以根回合为根的链位树

#### Scenario: 非舰队回合零 run

- **WHEN** 一个无舰队归属的普通定时任务执行
- **THEN** 不产生任何 run 头表行,其记录不携带 runId

#### Scenario: 收口幂等且合计一致

- **WHEN** 一 run 的最后一个回合结束
- **THEN** 头表行闭合,合计与该 run 全部回合事件逐项一致;重复收口不改写已闭合的头表

#### Scenario: 裁决回合成为 run 的节点

- **WHEN** 一波扇出声明了 judge,全组终态后聚合器起裁决回合
- **THEN** 该 run 的回合列表里出现裁决回合行:岗位=裁决岗、runId 同波、parentTurnId=该波发起回合、edgeKind=fanout、source=delegation,且其 usage 计入该 run 合计

#### Scenario: 无裁决波的汇总同样入账

- **WHEN** 一波无 judge 的扇出全组终态,聚合器把结果汇总注入发起岗会话
- **THEN** 该 run 出现一条岗位=发起岗的汇总回合行(parentTurnId=该波发起回合),SHALL NOT 铸新 run

#### Scenario: 归属不可判则不造节点

- **WHEN** 一波的历史任务既没有裁决岗标识、也没有点火侧记下的发起岗(升级前入队)
- **THEN** 汇总照发,但不写回合节点;该 run 的合计不因这次汇总而改变
