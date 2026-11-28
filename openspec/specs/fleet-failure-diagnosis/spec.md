# fleet-failure-diagnosis Specification

## Purpose
把「回合为什么失败」从一句归类代号变成属主能立刻行动的一句话：每类失败给出人读结论、证据和一条指向既有写面的动作，使红色岗位卡不再是终点。

## Requirements

### Requirement: 每类失败给出人读结论与动作
系统 SHALL 对失败回合按 `error_kind` 产出诊断，至少覆盖 `budget`、`timeout`、`model_upstream` 三类。每条诊断 SHALL 含：人读结论、触发该类判定的证据字段、以及一条可执行动作。未覆盖的 `error_kind` SHALL 如实呈现为「无诊断」，MUST NOT 套用最近的一类。

#### Scenario: 预算耗尽的诊断
- **WHEN** 某岗位存在 `error_kind=budget` 的失败回合
- **THEN** 诊断结论说明「所有候选模型都超出日/月额度」，证据给出当前主模型与其额度占用率，动作为「为这些岗位配置备选模型」

#### Scenario: 未知类别不猜测
- **WHEN** 某失败回合的 `error_kind` 不在已覆盖集合内
- **THEN** 该回合显示「无诊断」并原样呈现 errorKind，不冒充任何已知类别

### Requirement: 诊断必须来自已落库事实
诊断的证据字段 SHALL 派生自既有记录（回合事件的 `error_kind`、模型额度表的占用、岗位声明的模型与备选模型），MUST NOT 由诊断层新起判据或写入新状态。取不到证据时 SHALL 显示「未取得 + 原因」。

#### Scenario: 额度表读不到
- **WHEN** 模型额度表不可读
- **THEN** 预算类诊断的额度占用率显示「未取得：额度表不可用」，而不是 0%

### Requirement: 备选模型缺口可被看见
当存在失败原因为 `budget` 的岗位且这些岗位未声明备选模型时，诊断 SHALL 同时报告「有健康备选但未声明 fallback 的岗位数」。存在已声明备选时不报告该缺口。

#### Scenario: 有备选但没人声明
- **WHEN** 主力模型额度高占用、另有可选模型额度充裕，而失败岗位均未声明 fallback
- **THEN** 诊断给出「N 个岗位未声明备选模型」，N 为实际未声明数

### Requirement: 三类失败的舰队级分组计数
舰队读面 SHALL 按 `budget` / `timeout` / `model_upstream` / 其它 分组呈现窗口内的失败计数，四类之和 SHALL 等于该窗口失败回合总数——不允许有失败落进没有名字的桶。

#### Scenario: 分组之和等于总数
- **WHEN** 窗口内有 100 个失败回合
- **THEN** 四组计数之和为 100，且「其它」组的计数不为负
