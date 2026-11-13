## MODIFIED Requirements

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

## ADDED Requirements

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
