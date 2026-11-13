# agent-turn-contract Delta — add-fleet-orchestration

## MODIFIED Requirements

### Requirement: 契约取值受界且保留位结构化拒绝

`source` 现行取值 SHALL 为 cron|manual|delegation;peer 与 event 为派发(O3)与事件(O4)的保留位,当前构造 SHALL 以结构化错误拒绝并说明保留去向。`resultSink` 现行取值 SHALL 为 report|caller;blackboard 为黑板(O5)保留位,同样结构化拒绝。深度上限 SHALL 按**道**分界:dispatch 道(运行期临时派发)SHALL 界 1;handoff 道(经图校验的声明链)SHALL 界为该舰队声明的 maxChainDepth(缺省默认 8)。超界 SHALL 结构化拒绝——防链式放大的语义保留,边界来源从全局常量改为声明约束。取值集合与各界 SHALL 以常量导出,派生与校验共用一份真源。

#### Scenario: 保留源拒绝

- **WHEN** 以 source=peer 构造契约
- **THEN** 结构化错误指明 peer 为派发保留位、当前不可构造

#### Scenario: 深度超界拒绝

- **WHEN** 以 depth=2 构造 dispatch 道契约
- **THEN** 结构化错误拒绝并指明该道上限

#### Scenario: 派发道深度拒绝

- **WHEN** 以 source=delegation、depth=2 构造契约(无声明链背书)
- **THEN** 结构化错误拒绝并指明 dispatch 道上限 1

#### Scenario: 声明链内深度放行

- **WHEN** 一支舰队声明 maxChainDepth=5,以 handoff 链位 3 构造契约
- **THEN** 校验通过;链位 6 被拒
