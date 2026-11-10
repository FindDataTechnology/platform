# cell-lifecycle Specification

## Purpose
定义 cell 生命周期的跨拓扑词汇与裁决规则：状态机、居住策略、持久注册表、需求驱动的
唤醒/挂起、销毁协议与上行白名单。云端网关与桌面管家两个执行体都引用本词汇——词汇单源，
执行分离。

## Requirements

### Requirement: Cell 生命周期状态机

每个 cell SHALL 在任意时刻处于且仅处于以下状态之一：`unbound`（已登记、从未绑定或已解绑
运行时）、`starting`、`running`、`suspending`、`suspended`（进程不在、数据根与需求绑定
保留）、`destroyed`（身份吊销、注册行转为墓碑）。状态迁移 SHALL 由该 cell 的执行体
（云端网关或桌面管家）写入注册表落账；进程实况与注册状态不一致时，执行体 SHALL 以注册表
为准重建（进程多余即停、需求缺口即武装），而不是以进程实况倒改注册表。

#### Scenario: unbound cell 无进程但可枚举

- **WHEN** 一个 cell 已登记但从未绑定运行时（账号新建、尚无需求）
- **THEN** 它以 `unbound` 状态存在于注册表并可被管理面枚举，但不占有任何进程资源

#### Scenario: suspended cell 保留一切现场

- **WHEN** 一个 cell 被挂起（静默期后排干停止）
- **THEN** 其状态为 `suspended`，数据根、需求绑定与工作负载摘要全部保留，且注册表可见

#### Scenario: destroyed cell 授权即刻作废

- **WHEN** 一个 cell 经任一销毁通道销毁
- **THEN** 其配对/访问授权立即作废，注册行转为墓碑保留审计，墓碑永不复活（重装=新身份）

### Requirement: 居住策略（residency policy）

每个 cell SHALL 携带三档之一的居住策略：`always`（执行体在线则运行时保持存活）、
`on_demand`（有需求才绑定：用户流量或定时到期触发拉起，静默期排干挂起）、`ephemeral`
（有界生命，到期即销毁，demo 语义是其特例）。新登记的云端账号 cell SHALL 默认
`on_demand`——创建即 `unbound`，等待首个需求完成绑定。居住策略是用户/订阅层的决定，
平台 SHALL NOT 自动改档；平台仅得建言（例如占空比护栏观察到高频冷启时提示升档）。

#### Scenario: 新建账号 cell 默认 unbound + on_demand

- **WHEN** 一个云端账号完成开户但尚无流量与定时需求
- **THEN** 其 cell 以 `unbound`/`on_demand` 登记，不拉起进程

#### Scenario: on_demand cell 静默挂起

- **WHEN** 一个 `on_demand` cell 在静默期内无流量且无在跑定时任务
- **THEN** 执行体排干后将其挂起，状态落账为 `suspended`

#### Scenario: 平台建言不改档

- **WHEN** 一个 `on_demand` cell 的冷启频率越过占空比护栏
- **THEN** 管理面出现升档建言（文案注明建议 `always`），注册行与运行行为均不自动变更

### Requirement: 持久注册表与执行体重建

cell 注册表 SHALL 持久化于执行体本地的持久存储（执行体重启后仍在），每行至少承载：
稳定 cellId、属主身份、状态、居住策略、工作负载摘要（启用任务/机器人/舰队计数与最近
到期时刻）、关键时间戳（最近用户流量、最近履约）、销毁原因。执行体重启 SHALL 枚举注册表
重建需求面：`always` cell 立即拉起，`on_demand` cell 按其时刻表重新武装唤醒，
过期/到期 cell 进入销毁流程——不得依赖用户流量作为唯一重建触发。

#### Scenario: 网关重启后需求面自愈

- **WHEN** 云端网关进程被滚动重启（发布或运维操作），其下存在持有启用定时任务的 cell
- **THEN** 网关启动后不等任何用户回访，按注册表重建：该拉起的拉起、该武装的唤醒时刻
  重新武装，fleet 巡航不因滚版静默停摆

#### Scenario: 注册表行先于进程存在

- **WHEN** 管理面查询一个 `unbound` cell
- **THEN** 注册表返回完整行（身份/策略/状态），尽管该 cell 从未有过进程

### Requirement: 需求驱动的唤醒与挂起

执行体 SHALL 按需求绑定与解绑 cell：已验证用户流量立即拉起；`suspended`/`on_demand`
cell 的持久化任务时刻表到期 SHALL 唤醒 cell 履约。时刻表覆盖三类调度形态：cron 表达式
任务按表达式到期；interval 循环任务按锚点加周期的下次出现点到期（与 cron-module 的
interval 语义同口径）；未来触发的 one-shot 任务按其目标时刻判定——one-shot SHALL 提前
保持可唤醒（引擎 boot 会把已过点的 one-shot 标记 expired，事后唤醒无从履约）。跑满
run-count 的任务 SHALL NOT 参与唤醒；paused 任务 SHALL NOT 参与唤醒（既有语义）。
静默期（无流量且无在跑任务）后 SHALL 排干挂起。唤醒判决 SHALL 只读持久化数据
（注册表与数据根的任务记录），不依赖 cell 进程是否存在。唤醒后紧邻冷启动的运行时未就
绪窗口 SHALL 由 cell 内的就绪等待语义吸收；吸收失败按未执行如实记录，不得制造假成功。

#### Scenario: 定时到期唤醒履约再挂起

- **WHEN** 一个 `suspended` cell 的持久化时刻表到达到期点
- **THEN** 执行体拉起该 cell，其任务引擎按既有规则履约（含停机补跑），静默期后再次挂起

#### Scenario: 纯 interval 任务的 cell 到期唤醒

- **WHEN** 一个 `suspended` cell 只持有 interval 循环任务（无 cron 表达式）且其下次出现点已到
- **THEN** 值班环 SHALL 唤醒该 cell 履约，而不是因「无 cron 表达式」静默跳过

#### Scenario: 未来 one-shot 任务提前可唤醒

- **WHEN** 一个 `on_demand` cell 只持有一个未来触发的 one-shot 任务
- **THEN** 该 cell SHALL 在可运行状态以等待触发时刻，而不是被回收后错过履约

#### Scenario: 跑满与暂停的任务不参与唤醒

- **WHEN** 一个 cell 的任务全部跑满 run-count 或处于 paused
- **THEN** 值班环 SHALL NOT 因它们唤醒该 cell

#### Scenario: 唤醒判决零进程依赖

- **WHEN** 执行体的值班环评估一个无进程的 `suspended` cell 是否到期
- **THEN** 判决完全来自注册表与数据根的持久化时刻表，不需要也不尝试拉起该 cell 来询问

### Requirement: 销毁三路协议与数据红线

cell 销毁 SHALL 有三条通道，全部落注册表墓碑：① 本机卸载钩子尽力发出销毁意图（离线可
丢，由兜底接管）；② console 侧吊销配对——执行体下次上行收到 401 后自毁（吊销身份、
按策略停止运行时）；③ 沉默超窗（默认 30 天，可配置）兜底转墓碑。任一通道生效时配对
授权 SHALL 即刻作废。平台能力面 SHALL NOT 包含远程删除本机数据的动作：销毁只吊销身份与
注册，本机数据根的处置是用户本机自决。

#### Scenario: console 吊销触发自毁

- **WHEN** 一个已配对桌面 cell 的配对被 console 撤销
- **THEN** 其管家下次上行收到 401，随即吊销本地配对凭据并按策略停止运行时

#### Scenario: 沉默超窗转墓碑

- **WHEN** 一个已注册 cell 沉默超过配置的窗口
- **THEN** 注册行转为墓碑，配对授权即刻作废；墓碑行保留供审计，不提供复活路径

#### Scenario: 吊销后本机数据原样保留

- **WHEN** 销毁经 console 吊销通道生效
- **THEN** 该设备的数据根（会话、舰队定义、资源库、凭据）全部原样保留在机器上，
  平台侧没有任何动作触碰它

### Requirement: 明确不做（防漂移边界）

cell 注册与需求清单 SHALL NOT 构成云端接管执行的通道：不存在让平台代跑某桌面 cell 需求的
端到端语义（无 standby 接管）。cell 数据根 SHALL 不出机：上行内容以白名单为限（见
presence/manifest 要求），会话内容、prompt、工具参数、文件永不上行。

#### Scenario: 无接管语义可调用

- **WHEN** 任何调用方请求平台代跑一个桌面 cell 的定时需求
- **THEN** 不存在接受该语义的端点；该请求无可寻址的接收面

### Requirement: presence 与需求清单上行

已配对的桌面 cell SHALL 可上行三类事件：`cell_presence`（在线/离线、OS 形态、app 版本、
控制面 protocolVersion）、`cell_manifest`（舰队数、岗位数、启用任务数与名称标签）与
`cell_detail`（per-cell 五态、部署条目名/包名/版本/启用态、运行时组占用，及期望态合并
结果与拒绝原因的回写）。三类事件 SHALL 全部为纯元数据：prompt、会话内容、工具结果、
文件内容 SHALL NEVER 上行。桌面侧上行 SHALL 默认关闭、经明式开关开启；开启动作的同意
文案 SHALL 逐条列出白名单字段（含 cell_detail 新增字段在内）。上行 SHALL degrade-open：
平台不可达时本地缓冲或丢弃，绝不阻塞 cell 的本地职责。

#### Scenario: 开关关闭即零上行

- **WHEN** 桌面 cell 的上行开关从未被用户打开
- **THEN** 该 cell 不产生任何到平台的注册或遥测流量；平台侧对该 cell 无状态可读

#### Scenario: 同意文案逐条列出白名单

- **WHEN** 用户打开上行开关
- **THEN** 确认界面上逐条列出将上行的字段（含名称标签与 cell_detail 的元数据字段在内），确认后才发生首次上行

#### Scenario: 上行失败不阻塞本务

- **WHEN** 平台上行端点不可达
- **THEN** 该 cell 的巡航、会话与本地功能照常，上行数据本地缓冲或丢弃，无错误弹窗

#### Scenario: 明细回写如实含拒绝原因

- **WHEN** 一次期望态合并有条目被拒（容量满或不可部署）
- **THEN** 后续 cell_detail 携带该拒绝的结构化计数与原因码，云端机器视图可读

### Requirement: owner-offline 语义（诚实命名）

已注册桌面 cell 的 presence SHALL 由管家定义：管家在线（含 UI 关闭）即在线；管家离线即
`owner offline`（电脑关机/休眠），且 SHALL NOT 被判作故障或失联。未安装管家、未开启
上行的 cell 在平台侧无状态——这是诚实的不存在，不得推断为异常。

#### Scenario: UI 关闭不影响 presence

- **WHEN** 用户关闭桌面 app 窗口并退出进程，管家仍在运行
- **THEN** 平台视图上该 cell 保持在线，其舰队巡航不间断

#### Scenario: 关机读作 owner offline

- **WHEN** 用户关闭电脑，管家随之下线
- **THEN** 平台视图读作 `owner offline` 并附最近在线时间，不进入任何异常/失联计数

### Requirement: 常驻恢复后的簇收敛

steward 被唤醒（开机登录、睡眠恢复、更新后重启、显式启动）拉起运行时栈时，
本地集群 SHALL 收敛到声明态：插件启用位与本机 feed 令牌来自 settings（幂等
铸造，缺失补铸不重置）；本地部署以部署表为真源——feed 声明即期望，runner 按
既有分片纪律领回，部署表中 enabled 的条目 SHALL 恢复运行时，已停用条目 SHALL
保持摘除，已卸载 pack 的孤儿记录 SHALL 被剔除。收敛 SHALL NOT 因外部网络不可达
而失败（feed 与运行时不依赖公网）；无可部署条目时 SHALL 呈现空编目的健康态
而非未健康。收敛结果 SHALL 在状态面可见（领回几条、剔除几条）。

#### Scenario: 重启后集群自行回来

- **WHEN** 用户在装有本地部署的机器上重启并登录（原 UI 未打开）
- **THEN** steward 拉起栈，enabled 部署全部恢复运行时，状态面报出领回计数

#### Scenario: 睡眠唤醒后收敛

- **WHEN** 机器睡眠期间部署表被外部修改（如 CLI 停用一个条目）后唤醒/登录
- **THEN** 收敛按最新声明执行：停用条目运行时排空、feed 摘除，状态面如实报告

#### Scenario: 断网不影响本地集群收敛

- **WHEN** 恢复时公网不可达但本地部署非空
- **THEN** 本地 feed 与运行时照常拉起（收敛不依赖公网），仅需要公网的旁路（如云席位桥）呈降级

#### Scenario: 空部署是健康态

- **WHEN** 恢复时部署表为空
- **THEN** 集群呈 `0` 数量的健康态，不显示为未健康、不触发崩溃环计数

### Requirement: 期望态拉取与合并

已配对且上行开启的桌面 supervisor SHALL 定期用其 steward 凭据拉取本机部署期望态，并
合并进本地部署表：合并 SHALL 遵循**本地手动赢**——本地表中经用户手动动作（部署/停止/
移除）确立的条目保持本地态，云端与之冲突的期望不覆写本地，差异经 cell_detail 回写；
云端新增且本地无冲突的条目 SHALL 经既有本地部署门（可部署性/幂等/容量）落地，容量或
可部署性不满足 SHALL 结构化拒绝并回写、不静默丢弃。拉取不可达 SHALL 降级：退回本地
期望集照常收敛，绝不阻塞巡航、会话与本地功能。上行未开启的机器 SHALL 不发生任何拉取。

#### Scenario: 云端新增条目落地

- **WHEN** 云端期望集新增一条目且本地无同路径冲突
- **THEN** supervisor 经既有部署门落地该条目，feed 与 live 端点节拍内可见，实况经 cell_detail 回写对齐

#### Scenario: 本地手动赢

- **WHEN** 用户在本机舰队页手动停止了某条目而云端期望态仍为启用
- **THEN** 本地保持停止态不被收敛环打回；cell_detail 回写使云端可见「期望=enabled、实况=stopped」的背离

#### Scenario: 容量拒绝回写不静默

- **WHEN** 期望态合并撞上容量上限
- **THEN** 该条目不落地，结构化拒绝（含原因码与已用/上限）经 cell_detail 回写，机器健康哨可见连续拒绝

#### Scenario: 断网降级

- **WHEN** 期望态拉取端点不可达
- **THEN** 巡航、会话与本地部署动作照常；本地按既有期望集收敛，无错误弹窗

#### Scenario: 上行未开启即零拉取

- **WHEN** 桌面机器从未开启上行
- **THEN** 该机器不发起期望态拉取，本地部署表完全由本机用户动作驱动

### Requirement: 崩溃与启动失败必须持久可查

非预期退出（进程在自己没被要求停下时退出）与启动失败（进程起来了但没能在超时内监听端口）
SHALL 各自在 cell 台账上累计计数并保存最近一次现场；现场 SHALL 至少包含退出码或信号、
发生时间与该次运行时长。只有运维或策略主动停止（`stopping`）与演示 cell 的清理 SHALL NOT
计入崩溃计数。台账 SHALL 在进程重启后仍能回答「这个 cell 崩过几次、最后一次因为什么」。

#### Scenario: 未预期退出被计数且保留现场

- **WHEN** 一个运行中的 cell 进程以非零退出码或信号退出，且它并未被要求停止
- **THEN** 该 cell 的崩溃计数加一，并保存含退出码/信号、时间与运行时长的最近现场
- **AND** 台账在 gateway 重启后仍能读出这两个值

#### Scenario: 主动停止不计入崩溃

- **WHEN** 运维驱逐、空闲回收或滚版导致 cell 以 `stopping` 状态退出
- **THEN** 崩溃计数保持不变

#### Scenario: 启动失败与跑着崩分开计

- **WHEN** 一个 cell 进程启动后在超时内没有监听端口
- **THEN** 启动失败计数加一，崩溃计数不因此增加
- **AND** 两者在观测面上分别可见

#### Scenario: 崩溃不改持有关系

- **WHEN** 一个 cell 崩溃
- **THEN** 该 cell 的 owner 绑定、策略与排期任务保持不变
- **AND** 不写入 destroy 墓碑，下一次需求仍可正常唤醒

### Requirement: 崩溃重试必须有界但不锁人

同一 cell 在短窗口内反复崩溃时，系统 SHALL 让后续唤醒的进程启动退避随崩溃次数增长，
并 SHALL 在观测面与日志上明确标注该 cell 处于反复崩溃状态。系统 SHALL NOT 因崩溃次数
而永久拒绝唤醒该 cell —— 拒绝会让用户失去自己的数据面，且无法自愈。

#### Scenario: 反复崩溃触发退避

- **WHEN** 同一 cell 在窗口内连续崩溃多次
- **THEN** 下一次唤醒的进程启动被延迟，且延迟随崩溃次数增长
- **AND** 日志与观测面标注该 cell 反复崩溃

#### Scenario: 退避不阻断恢复

- **WHEN** 用户在被退避的 cell 上再次发起请求
- **THEN** 该 cell 仍会被唤醒（在退避延迟之后），而不是被永久拒绝
- **AND** 一旦连续正常运行超过康复窗口，崩溃计数归零而最近现场保留

### Requirement: 崩溃与拒醒进既有观测面

内存面（`/api/monitoring/memory`）的 cell 行 SHALL 暴露崩溃计数与最近现场；健康面
（`/healthz`）SHALL 暴露处于错误态的 cell 数量。唤醒准入被拒的记录 SHALL 与崩溃信息
一样可从台账读出，使「拒醒了几次、之后有没有醒来」无需 grep 日志。

#### Scenario: 内存面带出崩溃字段

- **WHEN** 运维读取内存面
- **THEN** 每个 cell 行含崩溃计数与最近现场（无崩溃时缺省或为零）

#### Scenario: 健康面带出错误态计数

- **WHEN** 有 cell 处于错误态
- **THEN** `/healthz` 的返回里能看到该数量，且不影响健康面本身的 200
