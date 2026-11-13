# add-studio-ai-drafting

## Why

Studio 画布的「AI 起草」在 add-agent-studio 4.x 挂账：pack-author / fleet-architect 两个 builder 工具面只有 MCP（cell 内），没有 HTTP 面——画布是浏览器，够不着。本单补桥并接起草动作。

## What Changes

- **桥**：为 pack-author / fleet-architect 的既有工具面开一条鉴权 HTTP 桥（server 侧代理到 cell MCP 调用，复用既有鉴权与 tool_risk 语义；不新造第二套起草逻辑）。
- **画布动作**：「AI 起草」按钮 → 桥调用 → 产物**只落为画布可编辑草稿**（三桶字段逐项填充），**不写任何发射口**（预设/pack 草稿/舰队/蓝图零调用，测试断言无写调用）。
- **人批准边界**：未点「采用」前不覆盖现有三桶内容；取消采用后文档逐字段不变（4.2）。
- **草稿可追溯**：AI 起草产物带 provenance 标记（drafted-by），人工编辑后标记如实演变。

## Capabilities

### New Capabilities

- `studio-ai-drafting`：AI 起草桥 + 画布动作 + 人批准边界。

## Impact

- web：AgentStudioPage 起草动作 + 草稿态。
- server：一条鉴权 HTTP 桥（复用 cell MCP 客户端）。
- 不动：四发射口写面、发布门、校验器。
