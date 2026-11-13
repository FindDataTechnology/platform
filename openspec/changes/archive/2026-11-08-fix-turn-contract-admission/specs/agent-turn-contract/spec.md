## MODIFIED Requirements

### Requirement: 契约取值受界且保留位结构化拒绝

`source` 现行取值 SHALL 为 cron|manual|delegation|event——event 为已绑定的第一信号源(bot 入站唤醒,派生自 evidence.origin.event);peer 仍为派发(O3)保留位,当前构造 SHALL 以结构化错误拒绝并说明保留去向。`resultSink` 现行取值 SHALL 为 report|caller;blackboard 为黑板(O5)保留位,同样结构化拒绝。深度上限 SHALL 按**道**分界:dispatch 道(运行期临时派发)SHALL 界 1;handoff 道(经图校验的声明链)SHALL 界为该舰队声明的 maxChainDepth(缺省默认 8);event 唤醒的回合 SHALL 深度 0(外部发起)。超界 SHALL 结构化拒绝——防链式放大的语义保留,边界来源从全局常量改为声明约束。该拒绝 SHALL 在**回合执行侧**再校验一次:舰队起轮前 SHALL 以当前声明的 maxChainDepth 校验派生出的 turnRequest，超界则本轮以结构化错误收口并落一条回合事件——声明在链位入队后被收紧时，已排队的超界回合 SHALL NOT 照常运行（校验常量与派生共用一份真源）。取值集合与各界 SHALL 以常量导出,派生与校验共用一份真源。

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

#### Scenario: 事件源派生

- **WHEN** 一条携带 origin.event {botId} 的 manual 任务被派生
- **THEN** source=event、depth=0;event 为合法值不再保留

#### Scenario: 声明收紧后已排队的超界回合被拒

- **WHEN** 一个 depth=4 的接棒回合已在队列中，其舰队把 maxChainDepth 收紧为 2
- **THEN** 该回合起轮前以结构化错误拒绝（错误指明该道上限），并落一条带该错误的回合事件，SHALL NOT 照常运行

#### Scenario: 声明内的回合照常运行

- **WHEN** 一个 depth=3 的回合与舰队声明的 maxChainDepth=5
- **THEN** 起轮不因本校验产生任何行为差异（校验通过为 null，不改变回合结果）

