# Proposal: fix-turn-token-attribution — tokens 字段名错配修复（700/700 null 真因）

## Why

生产 runner 计量 700/700 条 `ok:true` 行 `tokens` 全 null。溯源（dsh 源码三证）：

1. **dsh-llm pi-ai 适配器**在每个终态事件（done **与** error）都发 `{type:"usage"}` chunk
   （`mapUsage`：`{inputTokens, outputTokens[, cacheRead/WriteTokens]}`——camelCase 分列）；
2. **dsh-agent-loop** 把 `assembler.usage` 挂到 assistant/message 事件的 `data.usage`；
3. **runner 采集器**（child.js）读 `event.data.usage` 的位置**正确**，`lastUsage` 一直有值。

杀它的是 **manager.js `tokensOf`**：只认 `total_tokens ?? totalTokens ?? tokens`——
OpenAI 风格的总数命名；dsh harness 形状是 camelCase 分列（无总数字段），名字永不匹配
→ 每回合 tokens 落 null。既有 spec 需求「turn_ended 在 usage 可得时携带 tokens」
（input/output 合计）因此从未真正成立；mission 归属戳（add-mission-runner-attribution）
的 tokens 半边一直空转。

## What Changes

- **agent-runner/manager.js `tokensOf`**（唯一代码改动）：总数命名（total_tokens/
  totalTokens/tokens，OpenAI 形状）保持优先；新增 harness 形状回退——
  `inputTokens/input_tokens + outputTokens/output_tokens` 求和（cache 不计入合计，
  口径=输入+输出）。两形状都不匹配时维持 null（不猜）。
- **测试**：fakeHarnessClient 的 assistant/message 事件补挂 `usage`（镜像 dsh 真实
  形状——此前假件从不带 usage，正是缺陷漏网原因）；计量断言 tokens 数值 + 无 usage
  回合仍 null 的回归钉。

## Impact

- 受影响 spec：agent-runner——MODIFIED「Turn events carry session and token
  attribution」（需求文本不变语义、补 harness 形状场景钉死）。
- 下游自动受益（零改动）：计量行 tokens、turn_ended fleet 事件 tokens、mission
  归属观测。生产验证依赖上游恢复（当前 503 窗），按 error-class 迁移+自然流量前例。
