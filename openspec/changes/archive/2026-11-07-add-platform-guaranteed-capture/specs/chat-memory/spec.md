# chat-memory Specification（delta）

## MODIFIED Requirements

### Requirement: note 写纪律单一来源

MEMORY_DISCIPLINE（SDK `@finddatatechnology/yongyi-client` 纪律文本单一来源）SHALL 含 note 触发纪律：用户明示记住某事、或 agent 学到跨会话有价值的偏好/事实时，调用 `memory_write_page` 记 note。该文本 SHALL 经既有双面（fleet runner persona / cell preset suffix）生效，且挂载关闭时输出字节等同。fd-memory note 工具描述 SHALL 携带同义触发提示。

note 写纪律的定位 SHALL 是 L1 观点层补充而非记忆成立的前提：web chat、社交 bot、智语房间的回合 L0 底座由平台担保捕获（`platform-turn-capture`）兑现，agent 未主动写 note 的回合仍 SHALL 有 L0 落底。纪律文本中「会话收尾调 memory_handoff_begin」条款保留（handoff 属 L1 观点层，平台 tap 不可替代其意图传达价值）。

#### Scenario: 纪律行双面生效

- **WHEN** cell 记忆开启时生成 preset patch，或 runner 在挂载存在时物化 persona
- **THEN** persona 文本含 note 触发行；`CELL_MEMORY_ENABLED=0` 时不含且其余输出字节等同

#### Scenario: agent 不写 note 仍有记忆底座

- **WHEN** 一个回合中 agent 未调用任何 memory 写工具（纪律未被遵循）
- **THEN** 平台捕获仍落一条回合 L0（`platform-turn-capture`），下一回合的 digest 注入含其过程叙事——记忆成立不依赖模型自觉
