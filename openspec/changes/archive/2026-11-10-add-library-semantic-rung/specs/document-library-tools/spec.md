## ADDED Requirements

### Requirement: search_library 标注档位并区分三态

在既有「返回排好序的切块、带文档名与定位、每次调用有上限」的检索契约之上，`search_library` SHALL 在结果中标注本次实际使用的检索档位，取值至少覆盖 `vector`、`hybrid`、`keyword`，且该标注 MUST 反映真实执行路径而非配置值。

`search_library` 的结果 SHALL 可归入且仅归入三态：命中、有效但无匹配、因嵌入通道不可用而降级。后两者 MUST 可被程序化区分——无匹配 SHALL 是成功状态下的空结果，降级 SHALL 以可判别的元数据呈现，MUST NOT 与无匹配共用同一形状。

档位与三态的定义 SHALL 援引根仓契约 `knowledge-surface-integrity`；错误分类 SHALL 沿用 `mcp-error-semantics` 的四类码，MUST NOT 另立同义词汇。

#### Scenario: 结果携带档位

- **WHEN** agent 调用 `search_library` 且语义档已开启、嵌入通道正常
- **THEN** 结果 SHALL 标注为 `hybrid`（或融合实际所用档位），且命中项仍带文档名与定位

#### Scenario: 通道故障时标注降级而非无匹配

- **WHEN** 嵌入通道不可用，检索退化为词法
- **THEN** 结果 SHALL 标注为 `keyword` 并说明已降级，MUST NOT 仅返回空结果让调用方以为库中没有内容

#### Scenario: 空结果与降级可区分

- **WHEN** 一次检索既无匹配又发生了降级
- **THEN** 调用方 SHALL 能从结果元数据同时读出「无匹配」与「已降级」，两者不互相掩盖

#### Scenario: 语义档关闭时行为不变

- **WHEN** 语义档关闭
- **THEN** `search_library` 的检索行为与返回内容 SHALL 与改造前一致，档位标注为 `keyword`
