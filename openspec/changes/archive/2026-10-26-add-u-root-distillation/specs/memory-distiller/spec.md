# memory-distiller Specification

## MODIFIED Requirements

### Requirement: 调度按会话边界触发且去抖，预算按 owner 限额

调度器 SHALL 在会话边界（session-end / stop 批末）标记待蒸馏 scope 并去抖合并，辅以定时批兜底扫描 cursor 落后的 scope；同一 scope MUST NOT 并发蒸馏。每 owner 的蒸馏用量 SHALL 按日限额（可经部署配置调整），用量按 owner 归因入账；超限即停、记录缺口，次日自动续。计费真源不变（sub2api / 词元车道账单），本预算为护栏非对账。

蒸馏范围 SHALL 覆盖包根（`d-`）与人根（`u-`）：人根受部署级开关 `FD_MEMORY_DISTILL_U`（`=0` 时完全不进触发与扫描，行为与未启用字节等同，默认启用）。蒸馏原料 SHALL 含会话观测、handoff、以及人根的 note 页（以 observation 形状合成条目，`tool=memory_write_page`，含标题与正文摘录），note 游标随蒸馏推进、不重蒸馏。兜底扫描对无观测的人根 SHALL 经页索引发现 project。

#### Scenario: 会话结束去抖触发

- **WHEN** 同一 scope 短时间内多个会话相继结束
- **THEN** 去抖窗口内的会话合并为一次蒸馏，cursor 一次前进

#### Scenario: 日预算超限即停次日续

- **WHEN** 某 owner 当日蒸馏用量达到限额
- **THEN** 该 owner 的蒸馏停止并记录缺口，L0/L1 不受影响，次日从保留的 cursor 自动继续

#### Scenario: 人根 note 进蒸馏且不重蒸馏

- **WHEN** 某人根 project 存在 note 页（含蒸馏后新写的 note）且兜底扫描周期到达
- **THEN** 新 note 以 observation 形状条目进入蒸馏原料，产出 L2 后 note_cursor 前进；再次扫描不重复提交已游标过的 note

#### Scenario: 部署开关关闭零行为

- **WHEN** `FD_MEMORY_DISTILL_U=0` 时兜底扫描与触发到达
- **THEN** 人根不进入待蒸馏集合（无蒸馏调用、无 token 消耗），包根蒸馏行为不变
