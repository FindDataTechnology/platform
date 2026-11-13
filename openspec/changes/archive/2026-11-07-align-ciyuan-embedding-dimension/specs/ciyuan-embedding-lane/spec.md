# ciyuan-embedding-lane 维度契约改写

## MODIFIED Requirements

### Requirement: 嵌入模型与维度为显式契约

词元对内供给的嵌入契约 SHALL 为单一模型 `Qwen/Qwen3-Embedding-8B`，其向量维度由调用方请求体的 `dimensions` 字段决定：显式传入 `dimensions=N`（如 1024 截断）时 SHALL 返回 N 维向量；未传时 SHALL 返回账号钉扎 provider 的原生维度（当前 Nebius 钉扎下生产实证为 4096），跨 provider 的向量空间一致性由账号级 provider 钉扎保证。词元 SHALL 拒绝维度不符的响应而不向调用方返回：请求声明了 `dimensions=N` 而任一响应向量不是 N 维、或同一批次内向量长度不一致时，SHALL 按上游异常口径处理并如实标注，不写入「长度正确的假向量」冒充成功；`encoding_format=base64` 的字符串向量与不含 `data` 数组的错误形状不在本守卫判定范围内。上游账号的模型名白名单 SHALL 放行该契约模型；SHALL NOT 因白名单过窄而使契约模型在生产不可达。本 capability 的范围 SHALL 限于经词元入口消费嵌入的调用方；不要求既有的非词元直连消费方改换上游或模型（其契约由各自 capability 规定）。

#### Scenario: 契约模型可路由且维度正确

- **WHEN** 调用方以契约模型名请求嵌入，显式带 `dimensions=1024`
- **THEN** 返回 1024 维向量，且该请求在词元侧可路由到至少一个已配置的上游账号
- **AND** 未传 `dimensions` 时返回钉扎 provider 的原生维度向量，SHALL NOT 被误判为漂移

#### Scenario: 维度不符被拒绝而非静默返回

- **WHEN** 上游返回的向量维度与请求声明的 `dimensions` 不符，或同批次向量长度不一致
- **THEN** 词元不向调用方返回该向量，按上游异常口径处理并如实标注，不写入「长度正确的假向量」冒充成功
- **AND** 该笔 SHALL NOT 计入调用方用量

#### Scenario: 同文本重复调用向量一致

- **WHEN** 对同一文本连续多次请求嵌入
- **THEN** 返回向量一致（词元 SHALL 保证该契约模型的候选不会落在不同向量空间
  的上游之间——多 provider 聚合渠道时由账号级 provider 钉扎实现，见
  「上游 provider 钉扎由词元侧账号级收口」）
