## ADDED Requirements

### Requirement: The contracts index closes over all shipped contracts

套件 SHALL 维护一份合同索引，覆盖现役全部合同：①-⑯（v1 六条 + 活控制 ⑦⑧⑨ 与 advisory 行 ⑨b + 多 agent 能力面 ⑩-⑭ + 流通道 ⑮ + pod 形状 ⑯）、ACP adapter 映射面 ⑰、plugin-supply ⑱——索引 SHALL 与套件实际执行的合同清单一一对应、全量闭合：新增合同 SHALL 同时进入索引，退役合同 SHALL 同步移出，索引外 SHALL NOT 存在套件在跑的合同。合同⑱（plugin-supply：`plugins/list` 名册形状与未知名拒绝、`set_enabled` 持久化往返断言）虽由本套件执行，其能力归属 SHALL 记为 `dsh-plugin-supply` spec——该合同钉住 dsh 插件供给桥面，行为语义在彼处规定；索引 SHALL 在该条目标注跨能力归属，SHALL NOT 因归属在别的 capability 而把它从本套件索引中缺席。

#### Scenario: 索引闭合含合同⑱

- **WHEN** 列举套件实际执行的合同并与索引逐条核对
- **THEN** ①-⑱（含 ⑨b advisory 行）逐条在册，无索引外合同
- **AND** 合同⑱的索引条目 SHALL 标注其行为语义归属 `dsh-plugin-supply` capability spec
