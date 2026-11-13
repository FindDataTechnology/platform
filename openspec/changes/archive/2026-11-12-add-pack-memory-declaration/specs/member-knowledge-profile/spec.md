## MODIFIED Requirements

### Requirement: knowledge profile 是 pack 到部署的一等设置

pack/蓝图 schema SHALL 增 `knowledge` 段：memory（开关、scope：own+shared|shared|off、注入预算）、文档集引用列表（`library:<collectionId>`）。蓝图作者定义默认值；部署级 SHALL 可覆盖（管理面读写，覆盖留痕）。profile 缺省时 SHALL 使用文档化默认（memory on、scope own+shared、预算取现行 fleetContext 记忆段默认、无文档集）。schema 校验、试跑、diff 三链 SHALL 识别该段；非法引用（悬空集合、越权集合）SHALL 校验期拒绝。

`knowledge.memory` 表达的是记忆四轴词汇中的 **read 轴**（可见性与注入预算），SHALL NOT 被理解为完整的记忆声明：存储归属、写面权威、处理策略分别由 `memory.store` / `memory.write` / `memory.process` 表达（见 `pack-memory-declaration`）。两者等价写法冲突时 SHALL 拒收并指名冲突键；等价时 SHALL 归一为同一份规范声明。

profile 的读写面 SHALL 对每个记忆轴给出四列：声明值、继承来源、生效值、是否已执行。某轴无法解析为有效值时表 MUST 报错并指名该轴，MUST NOT 以默认值呈现为正常。

#### Scenario: 蓝图默认加部署覆盖

- **WHEN** 蓝图声明某成员文档集 [lib_a, lib_b]，部署者在部署设置中追加 lib_c
- **THEN** 该成员物化后的文档工具边界为三集合 ∪ shared，覆盖记录可在管理面查看

#### Scenario: 缺省 profile 行为文档化

- **WHEN** 存量蓝图（无 knowledge 段）重新物化
- **THEN** 成员获得默认 profile（memory on、own+shared、无文档集），与文档化默认一致

#### Scenario: memory 段只答 read 轴

- **WHEN** 一个 pack 只声明 `knowledge.memory.scope: shared`
- **THEN** 该 pack 的存储归属、写面权威与处理策略仍按继承链解析，不因 memory 段的存在而获得默认值

#### Scenario: 四列在管理面可见

- **WHEN** 部署者查看某成员的记忆配置
- **THEN** 每个轴同时显示声明值、继承来源与生效值，未声明的轴与声明为默认值的轴可区分
