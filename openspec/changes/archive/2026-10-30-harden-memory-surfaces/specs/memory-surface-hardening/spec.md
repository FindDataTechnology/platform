# memory-surface-hardening Specification

## Purpose

记忆读写面的输入边界契约与向量规模的观测口径：让非法/极端输入的行为被测试钉死而不是靠推理，让「向量规模是否仍在全表扫描的安全区」成为可观测事实而不是注释里的假设。

## ADDED Requirements

### Requirement: digest 读面的输入边界有明确且被测试钉住的契约

`/digest` SHALL 对下列输入给出确定响应，且每一类 MUST 有对应测试用例：
缺 `project` → 结构化 400 且错误码可辨识；非 person 令牌缺 `rootKey` → 结构化拒绝；空白 `q`（空字符串、纯空白、仅换行制表）→ **正常返回 200 且不判为向量车道降级**；`k` 越界 → clamp 到允许区间而非报错；`budget` 越界 → 同样 clamp。

#### Scenario: 空白 q 不判降级

- **WHEN** 请求 `/digest` 且 `q` 为空字符串、纯空白、或仅含换行制表
- **THEN** 返回 200，回包不含 `model_note`（不标记为向量车道不可用），且该次请求计入独立的「空查询」档而非关键词档

#### Scenario: 缺 project 结构化拒绝

- **WHEN** 请求 `/digest` 未带 `project`
- **THEN** 返回 400 且错误码为可辨识的缺参错误，不返回 200 空结果

#### Scenario: 越界参数被 clamp 而非报错

- **WHEN** `k` 传 0、负数、或大于上限；`budget` 传极小或极大值
- **THEN** 参数被 clamp 到允许区间，请求正常完成

### Requirement: tier/tag 手势写面的非法输入结构化拒绝

`/pages/mutate` 的 `set_tier` SHALL 只接受 `draft|stable|canonical`，其余值 MUST 返回 400 且不写盘；未知 `op` MUST 返回 400 并列出允许值。`/pages/write` 的非法 `tier` MUST 被拒绝或归一为 `draft`（行为须确定且被测试钉住，不得静默接受任意字符串）。

#### Scenario: 非法 tier 不落盘

- **WHEN** 以 `set_tier` 提交 `tier: "verified"` 这类不在取值集合内的值
- **THEN** 返回 400，目标页的 tier 保持原值不变

#### Scenario: 未知 op 列白名单

- **WHEN** 以未定义的 `op` 调用 `/pages/mutate`
- **THEN** 返回 400，响应中含允许的 op 列表

### Requirement: 向量规模可观测且带超阈值标记

系统 SHALL 在运维指标面暴露每个 root 的向量条数、全局向量总数、最大单根向量数，并 SHALL 在任一数值超过配置的告警阈值时给出可辨识标记。阈值 MUST 可配置，未配置时使用一个与当前实测规模相符的默认值。

#### Scenario: 规模指标可读

- **WHEN** 运维读取运维指标面
- **THEN** 能读到全局向量总数、最大单根条数、以及超阈值与否的标记

#### Scenario: 跨过阈值时亮灯

- **WHEN** 某 root 的向量条数超过配置阈值
- **THEN** 指标面出现明确的超阈标记，使「全表扫描是否还安全」不再依赖人去翻注释

### Requirement: 全表扫描的规模安全区有书面口径

项目文档 SHALL 记录当前向量检索采用全表扫描的规模安全区（含实测依据），以及跨过该区间时的处置方向；该口径 MUST 与指标面的阈值同源，避免文档与实现漂移。

#### Scenario: 文档与阈值同源

- **WHEN** 实施者调整告警阈值
- **THEN** 文档中的安全区口径随之更新，两者不出现「文档说 500、实现报 2000」的分歧
