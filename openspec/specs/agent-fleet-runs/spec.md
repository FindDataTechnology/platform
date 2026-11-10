# agent-fleet-runs Specification

## Purpose

一次点火到收束的「执行实例」(run)是舰队可观测的一等对象:同源回合串成一串、链位成边、回合明细可回放、变化按舰队实时推送——它是驾驶舱活画布与回放时间线的数据骨架,补上 v1 只有「声明」与「节点态」而没有「实例」的缺口。

## Requirements

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

### Requirement: 执行实例可查询且含明细链

系统 SHALL 提供 run 读面:按舰队分页列出 run(可按状态、根来源、时段过滤;每行含 runId、根来源、根岗位、起止时刻、时长、回合数、token 合计、状态),与单 run 详情(按时间有序的回合列表,每回合含岗位标识、source、status、errorKind、起止时刻、执行模型、usage、来源会话、parentTurnId、edgeKind、trace 关联键)。读面 SHALL 仅暴露舰队域字段,不携带凭据与会话正文;owner 作用域 SHALL 与舰队读面一致;分页 SHALL 有界(默认页大小与上限由服务端定)。

#### Scenario: 列表按状态与时段过滤

- **WHEN** 请求某舰队 status=failed 且近 24 小时的 run 列表
- **THEN** 仅返回同时满足两条件的 run 行,每行含 token 合计与时长

#### Scenario: 详情可还原链位

- **WHEN** 请求某 run 的详情
- **THEN** 回合按开始时刻有序返回,流转/派发/扇出的父子关系可自 parentTurnId×edgeKind 完整还原

#### Scenario: 越权与此前读面一致地拒绝

- **WHEN** 非 owner 请求某舰队的 run 读面
- **THEN** 与舰队管理面同一规则拒绝,不泄露 run 是否存在

### Requirement: 舰队回合与运行时事件流可关联

回合结果事件 SHALL 携带 trace 关联键 traceTurnId;舰队回合(定时/派发/流转/扇出/事件唤醒)的运行时事件 SHALL 与网页会话同样被记录进既有 trace 存储并以 traceTurnId 为键,记录内容范围与保留策略沿用既有 trace 面(含去 delta、按天保留)。无法记录的回合 SHALL 将 traceTurnId 置空而非虚构;run 详情读面 SHALL 如实呈现该缺失。

#### Scenario: 工具调用序列可取回

- **WHEN** 某舰队回合内发生两次工具调用
- **THEN** 以该回合事件的 traceTurnId 可自 trace 读面取回这两次调用的起止与名称

#### Scenario: 不虚构关联

- **WHEN** 某回合因运行时约束未产生可记录的事件流
- **THEN** 其回合事件 traceTurnId 为空,run 详情中该回合标注无 trace,不报错

### Requirement: 舰队实时事件推送

系统 SHALL 于舰队回合开始与结束时各广播一条舰队事件(含舰队标识、岗位标识、runId、回合标识、parentTurnId、edgeKind、状态、起止时刻),并于 run 头表创建与收口时广播 run 更新事件。事件 SHALL 经既有广播通道投递、仅含舰队域字段、不含凭据与会话正文。驾驶舱客户端 SHALL 可仅凭事件流增量更新节点与边的在途态;事件丢失时 SHALL 可由整体读面的下一次拉取自愈,不产生永久错显。

#### Scenario: 回合开始即点亮

- **WHEN** 某岗位回合开始
- **THEN** 已打开该舰队驾驶舱的客户端收到开始事件,该岗位节点与其入边切换为在途态

#### Scenario: 回合结束即收束

- **WHEN** 该回合结束
- **THEN** 客户端收到结束事件(含 status 与 errorKind),节点退出在途态并呈现本回合结果

#### Scenario: 断流自愈

- **WHEN** 客户端错过了若干条事件后重新拉取整体读面
- **THEN** 节点与边的状态与服务端收敛一致,不残留虚假在途态

### Requirement: 执行实例有界保留

run 头表与其回合明细 SHALL 以同一时间窗(默认 30 天)裁剪,与回合结果事件的「时间 + 每岗下限」双条件保留协同:仅当 run 闭合且早于保留窗时头表才可被裁剪;裁剪 SHALL 只删最旧、不影响产出与审批历史;单侧残留(头表已裁而明细因每岗下限仍在,或反之)SHALL 不产生错误——明细读面照常可读,run 列表不呈现已裁头表。

#### Scenario: 过窗裁剪

- **WHEN** 某 run 闭合已超过保留窗
- **THEN** 其头表被裁剪,产出与审批历史不受影响

#### Scenario: 单侧残留无错

- **WHEN** 某岗位的回合明细因每岗下限仍被保留而其所属 run 头表已被裁剪
- **THEN** 该岗位回合时间线照常返回这些明细,run 列表不含该 run,无错误

### Requirement: Trace 读面标注舰队归属

Trace 回合列表 SHALL 对可关联的舰队回合(回合事件的 trace 关联键命中执行实例账本)标注其岗位名,并提供进入所属舰队驾驶舱的入口;标注 SHALL 服务端一次批量查询完成,不增加逐行往返。不可关联的回合(网页会话回合、关联键已被裁剪)SHALL 照旧呈现,不虚构归属。

#### Scenario: 舰队回合带岗位标注

- **WHEN** 某舰队岗位回合的 trace 关联键命中账本
- **THEN** Trace 列表该行呈现岗位名徽章,并可进入所属舰队驾驶舱

#### Scenario: 网页回合不虚构归属

- **WHEN** 一条网页会话回合出现在 Trace 列表
- **THEN** 该行无舰队标注,呈现与现状一致

### Requirement: 孤儿执行实例头表被收口

系统 SHALL 清扫「孤儿」执行实例头表:状态为 open、开立时刻早于宽限期(默认 30 分钟)、且该实例不存在任何回合明细行。此类头表 SHALL 被收口为 failed,结束时刻取其开立时刻,回合数保持 0——如实表达「已开立但无任何回合完成」。清扫 SHALL 在进程启动时执行一次,并随既有每小时保洁重复执行。存在回合明细的 open 实例 SHALL NOT 被**本孤儿清扫**改动:其收口归「泄漏执行实例头表被收口」判定。

#### Scenario: 丢失回合的孤儿被收口

- **WHEN** 某实例开立后其回合未落任何明细,且已超过宽限期
- **THEN** 该实例转为 failed、回合数 0、结束时刻为其开立时刻,不再出现在进行中

#### Scenario: 在途实例不受影响

- **WHEN** 某实例开立不足宽限期,或已有回合明细仍在执行
- **THEN** 清扫不改动它,状态保持 open

#### Scenario: 启动即收敛

- **WHEN** 进程重启后加载了上一个进程遗留的孤儿实例
- **THEN** 启动时的首次清扫即将其收口,无需等待下一小时

### Requirement: 泄漏执行实例头表被收口

系统 SHALL 收口「泄漏」执行实例头表:状态为 open、开立时刻早于宽限期(默认 30 分钟)、其回合明细已全部结束,
且**没有在飞行的回合句柄、没有排队或运行中的引擎任务**携带该实例。收口后的状态 SHALL 由该实例的回合明细
算出(全部成功为 ok、全部失败为 failed、其余为 partial),结束时刻取其最后一条明细的结束时刻——
如实表达「回合已完成但收口未执行」,SHALL NOT 判为失败。

判定 SHALL 由**掌握在飞行情形的执行账本**作出(其知道在飞行的回合句柄与引擎任务状态),
SHALL NOT 仅凭回合明细判定:「上游回合已结束、下游回合尚未起」的协作链与「无人再来收口」的泄漏
仅凭明细无法区分。库层 SHALL 只提供仍为 open 的实例清单,不参与判定。

零回合明细的实例 SHALL NOT 由本判定收口——其归「孤儿执行实例头表被收口」处理(判 failed),
两套判定 SHALL NOT 互相抢判。收口 SHALL 在进程启动时执行一次,并随既有每小时保洁重复执行,
从而在进程重启后自愈上一个进程遗留的泄漏头。

#### Scenario: 回合已完成但收口未到的实例被收口

- **WHEN** 某实例的回合明细已全部结束、无在飞行句柄、无排队任务,且已超过宽限期
- **THEN** 该实例按其明细算出的状态收口(ok/partial/failed),结束时刻取最后一条明细的结束时刻,不再显示为进行中

#### Scenario: 协作链的下游尚未起时不被误收

- **WHEN** 某实例的上游回合已结束、下游回合尚未开始(仍有句柄在飞行或有引擎任务排队)
- **THEN** 判定跳过它,状态保持 open,待其自身收口或下一轮判定

#### Scenario: 零明细实例让位给孤儿判定

- **WHEN** 某 open 实例超过宽限期但一条回合明细都没有
- **THEN** 泄漏判定跳过它,交由孤儿清扫判为 failed,两套判定不互相覆盖

#### Scenario: 进程重启后自愈存量泄漏

- **WHEN** 进程重启后加载了上一个进程遗留的泄漏实例(回合行已落、头仍 open)
- **THEN** 启动时的首次判定即将其收口,无需等待下一小时

### Requirement: 打断回合的容差补拍

启动清扫 SHALL 把被进程终止打断的 open run（sweepOpenRuns 判定孤儿）按停机补拍的同一容差规则
处置：该 run 对应岗位节拍在容差窗内（2× 周期、地板 6h，`PLATFORM_CRON_CATCHUP=0` 杀开关沿用）
SHALL 补一拍（一次 make-up run，与既有停机补拍同源合流，不双发）；窗外 SHALL 如实记 missed
不补。补拍与不补拍 SHALL 都留可观测痕迹（makeup 标记/missed 记账），不得静默。

#### Scenario: 容差窗内打断补一拍

- **WHEN** 一次滚版打断某岗位在途回合，该节拍距其计划触发的偏移仍在容差窗内
- **THEN** 启动清扫后该岗位补跑一拍（makeup 标记在案），该节拍不因滚版丢失

#### Scenario: 窗外打断如实不补

- **WHEN** 被打断节拍的偏移已超出容差窗（或杀开关关闭）
- **THEN** 该节拍记 missed 不补跑，痕迹与既有停机补拍的窗外行为一致

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
