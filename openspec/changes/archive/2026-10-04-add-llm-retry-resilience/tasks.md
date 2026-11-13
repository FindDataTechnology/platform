## 1. 重试策略配置生成（D1）

- [x] 1.1 dsh-profile.js：导出共享 `RETRY_POLICY` 常量（normal/5/retryableCodes 纳入 PI_AI_ERROR/1s→15s/0.2 抖动），`buildLlmProfile` 给 volces 路由 profile 附加 `retryPolicy`
- [x] 1.2 llm-providers.js：`buildUserProviderEntries` 给全部用户自建路由附加同一策略（引用 1.1 常量，不复制）
- [x] 1.3 单测：生成的 settings `llm-pi-ai.providers.*` 每个节点携带 retryPolicy 且字段值符合 D1；volces 与自建路由一致
- [x] 1.4 热重载验证：改生成的 settings 节 → 不重启 dsh → 本地 dsh 对 stub 网关的失败请求按新策略重试（可并入 1.3 的探针断言）

## 2. 重试事件透出（D3）

- [x] 2.1 核实 turn-tracing 已捕获 `llm/retry` / `llm/retry-started` 通知（跑一轮 stub 失败即知）；缺口则修捕获白名单
- [x] 2.2 服务端 WS 转发面白名单两类重试事件，原样透传 payload + turn id，WS 消息命名遵循平台事件约定
- [x] 2.3 web：受影响回合渲染重试状态 Chip（n/5 预算），成功消解、预算耗尽转错误终态；事件不进助手文本
- [x] 2.4 组件级测试：调度→启动→成功三事件序列的 Chip 状态机

## 3. 子代理失败卡片真实终态（D2）

- [x] 3.1 核实 subagent 工具事件是否携带子 session 标识（决定富化是一跳还是时间窗回退）
- [x] 3.2 服务端：subagent `tool_end`（isError）富化子回合终态 message + code（优先 turn-tracing 存量数据，回退时间窗）
- [x] 3.3 web：失败卡片渲染真实终态；无详情时回退裸标签（legacy 场景）
- [x] 3.4 e2e：stub 网关制造子代理限流死亡（策略关闭态）→ 卡片显示并发限额消息与错误码

## 4. chaos 探针（D5）

- [x] 4.1 `scripts/probe-llm-retry.mjs`：stub 网关三类拒绝（200 流内错误体 / 裸 429 / 5xx）× 本地 dsh；断言回合全存活 + trace 可见重试事件 + 并行子代理（≥2）全存活
- [x] 4.2 探针入 e2e 例行集；收尾 `pkill -9 'bin/dsh --profile'`（平台惯例）

## 5. 运维与上游（D4）

- [x] 5.1 sub2api 准入上限活体探查：面板 → 管理 API 族 → 上游仓库文档/issue；结论二选一记录
- [x] 5.2 DEPLOY.md 追记 runbook：可调 → 调定值 + 复测配方；硬编码 → 顶内生存策略 + 套餐层拆域启动信号标注
- [x] 5.3 上游报告：issue 草稿全文就绪（upstream-issue-draft.md，含探针复现）——上游仓库 deepseek-ai/deepseek-harness **关闭了 issues**（has_issues=false，2026-10-04 实测），无法投递；按 ADR-0007 跟随节奏，上游开渠道或换沟通面时直接取用草稿

## 6. 上线与收口

- [x] 6.1 fd-prod 滚动 + 演示 cell 并行委派实测 —— 全部完成：sha-f221a40 双滚（GitOps 510b053）+ 静态回测全绿 + **用户授权真回合 PASS**（2026-10-04，公网全链 WAF→网关→cell→sub2api→上游：2 并行子代理 isError=false 返 "one"/"two"，0 error，助手正常汇报；无需重试=并发 30 下无争用，符合预期）
- [x] 6.2 `openspec validate --specs` 全绿后按归档门规程收口（sync-before-archive）—— validate --specs 112/112 绿；随归档执行 delta 同步
