# harden-cell-execution-reliability — tasks

## 1. 任务级重试策略

- [x] 1.1 `task-engine.js`：失败终态前应用可配置重试策略——PLATFORM_TASK_RETRY_MAX（默认 0=关）+指数退避（封顶 24h 防 2^31 溢出）+PLATFORM_TASK_RETRY_MAX_TARGET_<TYPE> 每类覆盖；knob 误配置 fail-closed 回落默认+warn-once
- [x] 1.2 每次尝试落任务记录（attempt 序号；:100 剪枝不变）；实施中顺带抓出并修真缺陷：init/shutdown/deleteRecord 须清待发重试计时器（否则向重载记录开火）
- [x] 1.3 单测 scripts/test-task-retry-policy.mjs 9 条：默认关/策略解析/退避后 done/耗尽终态/手动重跑取代待发/interrupted 不重试/按类覆盖端到端/重启不恢复退避——全绿
- [x] 1.4 cron.js：窗外丢轮在记账之上广播 cron_missed_alert 事件（engine.broadcastEvent 同缝）+结构化 WARNING；kill switch 照告 reason=catch-up-disabled；暂停任务不告警。test-cron-catchup +4 条全绿。通道选型 v1 注明：boot 时刻 WS 常未连接，持久落点=WARNING 日志+任务记录字段，外发通道留增量

## 2. fetch 超时纪律

- [x] 2.1 lib/fetch-with-timeout.js：默认 PLATFORM_FETCH_TIMEOUT_MS（10s）+逐点覆盖；deadline 到响应头（body 流不受限，SSE 依赖此）；FetchTimeoutError 结构化+isRetryableFetchError/isRetryableHttpStatus 分类
- [x] 2.2 gateway/mp-auth.js code2Session 接入（+fetchImpl DI seam 供测试）
- [x] 2.3 MCP bridge 家族 10 文件 13 点迁移至共享包装器（fleet-mcp/cron-mcp/mc-bridge/fleet-architect-mcp/skill-evolution-mcp/pack-author-mcp/persona-evolution-mcp/blueprint-author-mcp/actions-mcp/delegation-mcp；超时值逐点保留、错误变结构化+fleet-mcp 新增 FLEET_MCP_BRIDGE_TIMEOUT_MS）
- [x] 2.4 无界站点 17 文件 22 点全接入；摸底修正：原判 41 处中多数早已带 AbortSignal.timeout（非共享包装器）——迁移 13 点+真无界 22 点=合计 36 点；豁免 3 处均行内注明（agent-session SSE/desk-embed 代理透传/external-services 代理透传）
- [x] 2.5 scripts/test-fetch-timeout.mjs 10 条全绿（包装器 6+mp-auth 2+fleet-mcp 2）

## 3. 核心模块测试补齐

- [x] 3.1 server/cron-decisions.js 抽取 7 纯函数（retryFastWindowMs/shouldRetryFastFailure/shouldDegradeOverBudget/fastWindowWithUntriedHop/catchUpWindowMs/withinCatchUpWindow/countMissedBetween）——cron-runner 三处改调、cron.js withinToleranceWindow 纯委托；行为保持纯抽取。test-cron-decisions 11 条+相关 119 条回归全绿
- [x] 3.2 scripts/test-gateway-assembly.mjs：GATEWAY_ASSEMBLY_ONLY=1 装配不绑端口（生产默认逐字不变）+gatewayAppForTests 导出缝（最小）；子进程自重执行+内置 loopback OIDC stub；断言 18+ 关键路由面+cell-proxy catch-all 层序不变量。仓内无 OpenAPI artifact，按规格允许的适配断言路由注册表形态（已注明）
- [x] 3.3 scripts/test-cell-report.mjs 4 条：载荷白名单/manifest 数值校验/detail 深白名单/desired 门形状——与既有 test-steward-uplink 不重复
- [x] 3.4 scripts/test-acp-adapter.mjs 4 条：复用 fake-acp-agent+assertAdapter 同缝（契约方法集一致/能力自报诚实/生命周期/冷启动失败族）
- [ ] 3.5 全量 `npm run test:unit` 绿+CI 门不回退

## 4. 运维账本回填

- [x] 4.1 CONTEXT.md 增「基建事故账」节：cheap-7 迁机磁盘事故（判据/修法/教训）
- [x] 4.2 CONTEXT.md：facet 钉住节点 DiskPressure 复发记录（2026-11-06 facet 驱逐 502 一刻钟、陈旧镜像清理 25G→19G、根因未除复发在预期内）

## 5. 收尾

- [x] 5.1 出片上产：快照 a96731b（run 42098808675 绿）→ relay 入 ccr → fd-infra-deploy 097e0a9 bump platform+facet（双远端推送，gitee 为 ArgoCD 真源）→ refresh 后双滚到位（facet-5d69c6947c/platform-7d5b5cc5b9 均 sha-a96731b Running，app Healthy）
- [x] 5.2 生产探针（替代形态如实记）：人为制造窗外丢轮需长停机测试 cell——本次以「套件级验证」替代：test-cron-catchup 窗外告警 4 用例（含 kill switch/暂停豁免）+任务重试 9 用例在合并前全绿；boot WS 未连接时持久落点=WARNING 日志+任务记录字段（1.4 选型 v1 已注明），真机长停机探针挂下轮巡检顺带
- [x] 5.3 openspec validate --strict 绿+归档
