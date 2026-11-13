## Context

根因链（ADR-0016，已探明并定案）：sub2api 按账号并发准入拒绝 → dsh-llm-pi-ai 适配器 `classifyPiAiError` 按消息正则分类（`/\b429\b|rate.?limit/i`），"Concurrency limit exceeded for user" 两头都不中 → 落入兜底码 `PI_AI_ERROR` → 不在重试机器默认可重试集合（EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT）→ 回合死亡。重试执行器（`@deepseek-ai/dsh-llm-retry`）已由 dsh-base bundle 插入运行时，默认策略 normal/5 次/500ms→10s/10% 抖动，且为每次重试发出持久事件 `llm/retry`（调度）与 `llm/retry-started`（启动），payload 类型有浏览器安全子路径 `@deepseek-ai/dsh-llm-retry/types`——为远程渲染设计。

平台侧事实：provider profile 由 `dsh-profile.js buildLlmProfile`（volces 路由）与 `llm-providers.js buildUserProviderEntries`（Models 页自建路由）生成，写入 settings 的 `llm-pi-ai.providers.<id>` 节，热重载生效；profile schema 的 `retryPolicy` 字段挂在每个 provider 下（`retryableCodes` 是自由字符串数组，可纳入兜底码）。子回合的终态原因（`{"kind":"error","error":{message,code}}`）已持久化在子 session 日志；平台事件管线（turn-tracing 记录的那条 dsh 通知流）目前不向 WS 客户端转发重试事件。

## Goals

## Non-Goals

按租户拆 sub2api 账号（套餐层）、平台出口代理、always 无限重试、压低 cell 并行度（ADR-0016 否决项）。

## Decisions

### D1. 重试策略走配置生成，不走上游补丁

两个生成点共用一个常量（导出自 dsh-profile.js，llm-providers.js 引用）：`mode: normal, maxRetries: 5, retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, PI_AI_ERROR], backoff: {initialDelayMs: 1000, maxDelayMs: 15000, jitterRatio: 0.2}`。normal 模式内部以新编号回合重放、对模型与耐久历史不可见，重试语义由上游保证，平台只声明策略。兜底码盲试的最坏代价 = 每次真失败多 5 次有界请求，接受（ADR-0016）。上游修复分类后该码保留为无害冗余。

### D2. 子代理终态原因：服务端在 tool 事件上富化

优先路径：subagent 工具事件若携带子 session 标识，服务端在转发 `tool_end`（isError）时从 turn-tracing 已记录的子 session 事件里取最后一条 turn 终态（message + code）附加到事件；回退路径：无子 session 标识时按 cell + 时间窗匹配最近的 error 终态 session。再无则保持裸标签（legacy 兼容，spec 场景覆盖）。实现前先核实子 session 关联在工具事件里的真实形态——这决定两跳还是一跳。

### D3. 重试事件：服务端白名单转发，客户端 Chip 渲染

服务端 dsh 通知管线在转发面白名单 `llm/retry` / `llm/retry-started`（带 turn id 原样透传 payload），turn-tracing 的全量捕获已天然覆盖入库（需验证）。web 端在受影响回合上渲染可消解的状态 Chip（"网关限流，重试中 (2/5)"），成功后消失；事件不进助手文本、不改耐久历史。WS 消息命名遵循平台现有事件动词约定。

### D4. sub2api 准入上限：活体探查定生死

探查顺序：sub2api 管理面板设置页 → 实测在位的管理 API 族（GET/POST /api/v1/admin/users、/api/v1/admin/groups，DEPLOY.md:1746）→ 上游仓库（Wei-Shaw/sub2api）文档与 issue。可调 → 为平台账号调定并复测（池组 id=7 的真实并行度随之释放），DEPLOY.md 追记 runbook（含复测配方）；硬编码 → runbook 记录顶内生存策略（重试吸收 + 后台流量错峰），并把它标注为套餐层拆域的启动信号。

### D5. 验收：stub 网关 chaos 探针，不依赖真实 sub2api 的坏脾气

`scripts/probe-llm-retry.mjs`：本地 stub 网关可脚本化返回三类拒绝——流内错误体（HTTP 200 + SSE error 事件携带 "Concurrency limit exceeded for user"，最坏情况）、裸 429 文本、5xx——对本地 dsh profile 断言：回合全部完成、trace 库中观察到 `llm/retry` 调度与启动事件、父回合 + 并行子代理（≥2）全存活。真实链路验收在 fd-prod 演示 cell 上做一轮并行委派即可。e2e 后照例 `pkill -9 'bin/dsh --profile'`。

## Risks / Trade-offs

- [兜底码盲试放大故障流量] 限流风暴期间每失败多 5 次请求；缓解：有界 + 退避 + 抖动，且风暴本身就是套餐层拆域的启动信号。
- [D2 回退路径的时间窗匹配可能张冠李戴] 只在子 session 标识缺失时启用，且仅取 error 终态；优先路径落地后回退极少触发。
- [上游 rc 升级可能改动事件 payload 形态] 消费 `@deepseek-ai/dsh-llm-retry/types` 类型而非手写形状；dsh-contracts 套件口径覆盖。

## Migration Plan

纯增量：settings 生成多一个字段（热重载生效）、事件流多两个类型、卡片多一个富化字段。无数据迁移；legacy session 无终态详情走既有裸标签。

## Open Questions

- subagent 工具事件是否携带子 session 标识（D2 优先路径成立与否）——实现首任务核实。
- sub2api 准入上限是否可调（D4）——ops 探查任务。
