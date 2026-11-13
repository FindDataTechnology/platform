## Purpose

定义 cell 生命周期的跨拓扑词汇与裁决规则：状态机、居住策略、持久注册表、需求驱动的
唤醒/挂起、销毁协议与上行白名单。云端网关与桌面管家两个执行体都引用本词汇——词汇单源，
执行分离。

## ADDED Requirements

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
cell 的持久化任务时刻表（数据根任务记录中的 cron 表达式与时区）到期 SHALL 唤醒 cell
履约；静默期（无流量且无在跑任务）后 SHALL 排干挂起。唤醒判决 SHALL 只读持久化数据
（注册表与数据根的任务记录），不依赖 cell 进程是否存在。唤醒后紧邻冷启动的运行时未就
绪窗口 SHALL 由 cell 内的就绪等待语义吸收；吸收失败按未执行如实记录，不得制造假成功。

#### Scenario: 定时到期唤醒履约再挂起

- **WHEN** 一个 `suspended` cell 的持久化时刻表到达到期点
- **THEN** 执行体拉起该 cell，其任务引擎按既有规则履约（含停机补跑），静默期后再次挂起

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

已配对的桌面 cell SHALL 可上行两类事件：`cell_presence`（在线/离线、OS 形态、app 版本、
控制面 protocolVersion）与 `cell_manifest`（舰队数、岗位数、启用任务数与名称标签）。
prompt、会话内容、工具结果、文件内容 SHALL NEVER 上行。桌面侧上行 SHALL 默认关闭、经
明式开关开启；开启动作的同意文案 SHALL 逐条列出白名单字段。上行 SHALL degrade-open：
平台不可达时本地缓冲或丢弃，绝不阻塞 cell 的本地职责。

#### Scenario: 开关关闭即零上行

- **WHEN** 桌面 cell 的上行开关从未被用户打开
- **THEN** 该 cell 不产生任何到平台的注册或遥测流量；平台侧对该 cell 无状态可读

#### Scenario: 同意文案逐条列出白名单

- **WHEN** 用户打开上行开关
- **THEN** 确认界面上逐条列出将上行的字段（含名称标签在内），确认后才发生首次上行

#### Scenario: 上行失败不阻塞本务

- **WHEN** 平台上行端点不可达
- **THEN** 该 cell 的巡航、会话与本地功能照常，上行数据本地缓冲或丢弃，无错误弹窗

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
