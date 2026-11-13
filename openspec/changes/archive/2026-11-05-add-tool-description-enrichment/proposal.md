## Why

上游 MCP 工具描述质量不可控（太薄、纯英文术语、缺失），模型侧全链上游原文直通（`parseToolSchema` 零改写）——这是「对智能体」一侧的空洞。用户裁定双向都做：`add-mcp-annotation-overlay` 已定稿注释数据契约（human 轨 + `canonical.brief`），本单把 canonical 轨接入运行时工具面，让智能体读到策展的精准 brief。纪律：**只增强不改名**——闭包闸与工具发现全部按名字校验，名字零动即零破坏。

## What Changes

- **工具描述增强接入运行时**：沿既有 patch 通道（同 `tool-filter.json` 机制）新增 tool-description overlay——profile 组装时从注释层取 canonical brief，dsh 运行时 `tools/list` 应用于模型可见工具描述。
- **增强策略**：默认**追加**（上游描述在前、brief 在后）；上游描述缺失时**替换**。仅当注释携带 `canonical.brief` 时生效；无注释工具逐字节不变。
- ** provenance 与可观测**：overlay 携带来源与注释更新时间；工具面快照（闭包闸既有读面）记录增强计数与来源，MUST NOT 改变快照的名字集合。
- **边界（不可违反）**：工具 callable 名、server 名、leaf 名、参数 schema 一个不动（闭包闸、tool-discovery 名字解析零影响）；publicFacing 生效面**跳过增强**（内部词汇防线 dsh-profile「不泄内部词汇」保持，brief 可能携带内部词汇）；platform 内置工具不增强。
- **开关**：per-owner 可关（默认开）；关闭时 overlay 不生成，行为回到纯上游。
- **一致面**：discovery 搜索索引（`tool-discovery`）反映同一增强后描述，索引与模型面不同文本。
- **明确 Non-goals**：不做运行时 LLM 改写（只消费人工策展 brief）；不增强 skill/persona 内容；不承诺描述热更（overlay 随 profile 组装再生，会话中途注释更新下个组装周期生效——与 tool-filter 同节奏）；不做人读渲染（change ② 管）。
- **非 BREAKING**：无注释/关闭开关时运行时行为与今天逐字节一致。

## Capabilities

### New Capabilities

- `tool-description-enrichment`: 运行时工具描述增强契约——overlay 生成与消费、追加/替换策略、只增强不改名不变式、publicFacing 跳过、per-owner 开关、provenance 记录。

### Modified Capabilities

<!-- 无：tool-discovery 的字面契约（名字精确、roster 生效面）不变；其索引反映增强描述以 ADDED 需求表达。 -->

## Impact

- **Server（壹座）**：profile 组装处（`dsh-profile.js` 既有 patch 写出序列）增 tool-description overlay 生成（读注释层 canonical，含 per-owner 开关与 publicFacing 判定）；工具面快照读面增增强计数/provenance 字段。
- **dsh 运行时**：`dsh-mcp-client` `tools/list` 应用的既有 tool-filter 消费点旁增 overlay 消费（追加/替换逻辑）；版本矩阵按 `dsh-version-matrix` 纪律登记。
- **发现一致性**：`server/tool-discovery.js` 索引描述取同一 overlay（ADDED 需求挂 `tool-discovery`）。
- **依赖**：`add-mcp-annotation-overlay` 的数据契约与读面（canonical 字段）先行。
- **测试**：名字集合零变化（增强前后闭包闸同结果）、追加/替换两策略、publicFacing 跳过、开关关闭回原、无注释不变五组。
