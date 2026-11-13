## Why

2026-10-04：演示 cell 的子代理稳定死在运行中途——平台全部内部 LLM 流量共用部署者的单一 sub2api 账号，sub2api 按账号并发准入拒绝（"Concurrency limit exceeded for user"），而 dsh 适配器按报错文案做正则分类，该措辞落入不可重试的兜底桶 `PI_AI_ERROR`，运行时已加载的重试机器（dsh-llm-retry）正确地拒绝重试，回合死亡且 UI 只显示裸的 "subagent run failed"。机器各层都按设计工作，设计没有闭环（根因链与定案见 docs/adr/0016）。恢复成本随每次演示、每次并行委派反复发生。

## What Changes

- dsh-profile 生成的每个 provider profile（volces 路由 + Models 页用户自建路由）携带 `retryPolicy`：normal 模式、5 次、1s→15s 指数退避 + 20% 抖动，可重试集合纳入兜底桶 `PI_AI_ERROR`——瞬时错误不再杀死回合；settings 热重载，无需 dsh 重启。
- 子代理失败卡片显示子回合的真实终态原因（错误消息 + 错误码），替代裸的 "subagent run failed"。
- 会话流消费 dsh-llm-retry 的 `llm/retry` / `llm/retry-started` 持久事件，显示"网关限流，重试中 (n/5)"类进度。
- 运维项：活体探查 sub2api 并发准入上限（面板/管理面/上游文档），可调则按平台真实并发调定并追记 DEPLOY.md runbook；查实硬编码则在 runbook 记录顶内生存策略。
- 上游动作：向 deepseek-ai/dsh 报分类缺陷（应按响应状态码/语义分类，"Concurrency limit exceeded" 至少应归 `RATE_LIMIT`）。
- 验收：并发 chaos 探针——在制造限流碰撞的条件下，父回合 + 并行子代理全部存活，重试进度在会话流可见。

明确不做（ADR-0016 已裁决）：按租户拆 sub2api 账号（套餐层）、平台出口代理、always 无限重试、压低 cell 并行度。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `dsh-llm-providers`: 生成的 provider profile 携带瞬时错误重试策略（含不可识别错误的兜底码），随 settings 热重载生效。
- `tool-use-rendering`: 子代理工具失败卡片携带子回合真实终态原因。
- `chat-streaming`: 重试调度/启动事件作为会话流可见进度透出。
