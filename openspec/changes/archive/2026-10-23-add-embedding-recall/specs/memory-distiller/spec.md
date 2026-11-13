## MODIFIED Requirements

### Requirement: 引擎 #1 是受 pin 的开源 sidecar，三集成条件生效

引擎 #1 SHALL 为独立 sidecar 服务（与 fd-memory 同 namespace 部署），pin 开源 Hy-Memory 版本、仅取其纯函数面（抽取 / reconcile / 提示词 / 解析器）， Chroma / Kuzu 等存储依赖装而不用；LLM 调用仅经词元车道（不直连任何第三方端点）。S1 裁决的三条集成条件 MUST 生效：C1——模型原文先经 json_repair 再解析（解析失败不得静默丢段）；C2——`task` / `search_keys` 与会话同语言（提示词钉 + 产物后检）；C3——每次 LLM 调用记录在案（`llm_calls` / `tokens` / `errors` 上报，引擎吞掉的失败由 sidecar 显性化）。

sidecar SHALL 另暴露 `POST /embed`（与 /distill 同一共享令牌互信）：批量输入（上限 64 条文本）返回向量数组，调用记入调用方的 `llm_calls`（stage=`embed`）、tokens 计入 distill 预算口径；嵌入模型 SHALL 钉扎（env 配置，当前 `Qwen/Qwen3-Embedding-8B`，dim 4096），响应携带模型名。

#### Scenario: json 损坏段不丢

- **WHEN** 模型输出含未转义引号等可修复的 JSON 损坏（S1 遍 1 s02 形状）
- **THEN** json_repair 后解析成功，该段经验不丢失

#### Scenario: task 语言与会话一致

- **WHEN** 中文会话被蒸馏
- **THEN** 产出的 experience.task 与 search_keys 为中文（评测以「task 语言 = 会话语言」断言钉住）

#### Scenario: 网关抖动显性化

- **WHEN** 词元车道超时连续失败（S1 遍 1 s08 形状）
- **THEN** DistillResult.errors 记录失败、cursor 保留，而非静默返回空产出

#### Scenario: 批量嵌入留痕计费

- **WHEN** 调度器以 5 条文本调用 /embed
- **THEN** 返回 5 条向量（带模型名），调用方 llm_calls 出现 stage=embed 的行，tokens 计入当日预算

## ADDED Requirements

### Requirement: 候选检索向量优先、关键词兜底、模型钉扎

蒸馏候选检索 SHALL 优先向量余弦：查询文本（近期观测摘要）经 sidecar 嵌入后，与既有候选的伴随向量（蒸馏落库时由 sidecar 随 DistillResult 产出、fd-memory 存 SQLite 伴随表——markdown 真源与派生索引不变）计算余弦取 top-8；无向量的候选（历史页 / 嵌入失败）MUST 按现有关键词路径并入兜底，两条路径的结果合并去重。向量 MUST 带模型标注：候选向量与查询向量的模型或维度不一致时该候选 MUST 落关键词兜底并记 gap，MUST NOT 跨模型比余弦。重嵌 SHALL 经提供的一次性脚本按模型过滤执行，MUST NOT 自动全量重嵌。

#### Scenario: 同义不同词命中向量检索

- **WHEN** 新观测的任务描述与既有经验语义相同但关键词不重叠（如「推镜像失败」vs「registry 上传被拒」）
- **THEN** 向量路径将该经验排入候选集，reconcile 得以判 UPDATE 而非重复 ADD

#### Scenario: 无向量候选走关键词兜底

- **WHEN** 候选集中部分页无伴随向量（v2.2 之前的存量页）
- **THEN** 这些页经关键词路径参与候选，与向量结果合并去重，检索不因向量缺席而漏召回

#### Scenario: 模型不一致不比余弦

- **WHEN** 查询嵌入模型与某候选的伴随向量模型不同（换模后）
- **THEN** 该候选落关键词兜底并记 gap，绝不跨模型计算余弦
