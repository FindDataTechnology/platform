# fleet-ops-manager Specification

## Purpose
把「诊断」推进成「修复闭环」：一个常驻岗位读既有诊断，按 `error_kind` 白名单把现役团队结构改成一份可批准的结构修复（差分），经既有草稿/批准/落地车道生效，落地后复验并如实回报——产物是修好的团队结构，不是又一条建议。

## Requirements

### Requirement: 修复必须由诊断按白名单动作派生且可复算

管理者 SHALL 从既有诊断（`fleet-failure-diagnosis` 的 `error_kind`/证据）与现役团队结构派生一份结构修复差分，修复的每个变更键 SHALL 落在该 `error_kind` 的允许动作白名单内（`budget`→`fallbackModel`/`effort`/`model`；`timeout`→`cadence.turnTimeoutMs`/`model`；`model_upstream`→`fallbackModel`/`model`），MUST NOT 引入白名单外的结构改动。修复的改动目标（哪一岗、换成哪个模型/值）SHALL 由诊断证据里的字段决定，MUST NOT 凭空填充。

同一份诊断输入与同一份现役结构，派生出的修复差分 SHALL 逐字段相同；把该差分应用于现役结构后 SHALL 等于派生的目标结构。

#### Scenario: 预算类失败只补备选

- **WHEN** 某岗位存在 `error_kind=budget` 失败且未声明备选模型、且存在额度充裕的候选
- **THEN** 修复差分只含该岗 `fallbackModel`（及允许的 `effort`/`model`）改动，不含任何其它结构键

#### Scenario: 两次派生逐字段相同

- **WHEN** 用同一诊断证据与同一现役结构连续派生两次修复
- **THEN** 两次差分逐字段相同，且应用后等于目标结构

#### Scenario: 越白名单的改动被拒

- **WHEN** 一份修复差分在 `timeout` 诊断下改动了白名单之外的键（例如删除岗位或改编导边）
- **THEN** 该修复不被采纳为来自诊断的修复，并按「非诊断派生」拒收

### Requirement: 证据不足不提案，且与「无需修复」可区分

当诊断缺少对应证据（无该类失败回合、额度表/模型册读不到、白名单动作无法确定目标）时，管理者 SHALL 输出「无可提案的修复」并给出缺失的证据项，MUST NOT 产出一份猜测的修复，MUST NOT 以空差分冒充。空差分（「诊断了、但无需修复」）与「证据不足」SHALL 呈现不同状态。

#### Scenario: 额度表读不到

- **WHEN** 失败为 `budget` 类但模型额度表不可读
- **THEN** 管理者报「证据不足：额度表不可用」，不产出 fallback 修复

#### Scenario: 空差分与无证据可区分

- **WHEN** 一份输入是「诊断了、结构已合规无需修复」，另一份是「无对应证据」
- **THEN** 前者呈现「无需修复」，后者呈现「证据不足」；两者文案不同，不得合并

#### Scenario: 未知类别不猜测

- **WHEN** 失败 `error_kind` 不在已覆盖三类内
- **THEN** 管理者不产出修复，原样转述该类别

### Requirement: 落地只走既有车道且管理者无落地写面

修复差分 SHALL 经既有 `fleet_draft` 通道校验并呈现 diff（含成本预估），主人批准后经既有 `fleet_apply` 落地（带 revalidate 与漂移拒绝）。管理者岗位的运行时工具面 MUST NOT 含 `fleet_apply`、发布、铸造或任何批准类写工具——「未批准不落库」SHALL 由工具面结构保证，而非由 persona 自述保证。

#### Scenario: 未批准零落地

- **WHEN** 管理者产出一份结构修复但主人未批准
- **THEN** 现役团队结构逐字段不变，成员库不出现该修复的任何改动

#### Scenario: 工具面不含落地写

- **WHEN** 检视管理者岗位的运行时工具面
- **THEN** 不含 `fleet_apply`、`facet_market_pack_publish`、任何 approve/cast 工具

#### Scenario: 漂移拒绝

- **WHEN** 修复草案基于的结构在批准前已漂移
- **THEN** 落地以 `fleet_apply` 的既有 revalidate 拒绝并如实报告，不静默部分应用

### Requirement: 落地后复验三态如实回报

一次修复落地后的下一复验窗口，管理者 SHALL 重读同一 `error_kind` 的失败分组计数并回报三态之一：`improved` / `unchanged` / `insufficient-evidence`，并附前后计数与窗口。三态 MUST NOT 合并；`unchanged` 与 `insufficient-evidence` 时 MUST NOT 报告「已修复」。

#### Scenario: 未见改善如实说

- **WHEN** 修复落地后下一窗口同类失败计数未下降
- **THEN** 复验报 `unchanged` 并给出前后计数，不写「已修复」

#### Scenario: 样本不足不冒充结论

- **WHEN** 复验窗口内同类失败回合样本过少不足以判定
- **THEN** 复验报 `insufficient-evidence`，不选 improved 也不选 unchanged

### Requirement: 一次修复一个可回滚点

一次修复落地 SHALL 产出可寻址的修复标识；回滚 SHALL 以修复前的团队结构为目标再走一次既有草稿/落地车道，MUST NOT 以手工改成员行达成。回滚前结构 SHALL 在落地时留存可读。

#### Scenario: 回滚即重发上一版结构

- **WHEN** 主人要求回滚某次修复
- **THEN** 系统以该次修复前的结构为目标，经既有 diff→draft→apply 落地，成员行恢复到前态，且过程可审计

#### Scenario: 不手工改行

- **WHEN** 任意回滚发生
- **THEN** 不存在绕过 draft/apply 的成员直接写入
