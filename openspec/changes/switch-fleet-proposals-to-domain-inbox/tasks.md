# 任务：switch-fleet-proposals-to-domain-inbox

> 依赖：law-bench `add-domain-first-workbench`（C5）已验收（2026-11-08）。本 change 在 paas 根。
> 先取证再改代码：§1 不完成，不得动出口函数。

## 1. 取证（先钉事实）

- [x] 1.1 定位提案岗今天的**全部**提交出口：生产里草案从哪条路径进柏讯动作审批队列（MCP 工具 / HTTP 客户端 / 岗位脚本），列出每个调用点文件与函数；把结论写进 `design.md` 的「切换点」一节（覆盖「不止一个调用点」的情形）
- [x] 1.2 记录切换前基线（2026-11-08 实测，`fd-prod`/`fd-wire-api` 直查库）：
  `domain_action_instances` 共 11 条、**全部**本体类（-1 `entity-declare` 5 + -2 `entity-relation-declare` 6），
  全 executed、无 pending；零条客户侧业务动作。左值 = 11（详见 `design.md`「切换前基线」）

## 2. 客户端

- [x] 2.1 客户端单函数命令式：`lib/bench-proposal-client.js` `submitProposal()`（目标 URL / 凭据 / 域 key 全来自 env，`transport=` 注入缝；refusal 分类 evidence / vocabulary / needs_evidence / forbidden / auth / server / timeout / unreachable，`retryable` 只对后三类为真）
- [x] 2.2 token 脱敏：`redact()` 覆盖异常消息与 detail（对端回显也遮），min-length=8 守卫防「短凭据被当普通词碎掉」；断言见 `scripts/test-bench-proposal-client.mjs`
- [x] 2.3 缺凭据/缺域 key/缺草案字段：`BenchProposalError(kind=config)` 报明缺失项，**不发任何请求**；无任何缺省域

## 3. 切换

- [x] 3.1 出口函数已建（`server/bench-proposal-mcp.js` 的 `bench_proposal_submit`，按 D2 组装 `source/kind/external_key/evidence/submitted_by`，无目标账号字段；`source` 必填 `fleet:<fleet>/<post>`，不发明任何 env 兜底）。**未落**：岗位提示词仍指旧出口（见 3.3 的前置）
- [x] 3.2 岗位配置新增 `BENCH_PROPOSAL_DOMAIN`（与岗位 `target` 同源）。**repo**：`mcp.example.json` 增 `bench-proposal` 条目；三项一律 `envRefs` 转发——dsh 子进程会擦除形似凭据的环境名（含 `*TOKEN*`），只写环境变量的 token 过不了这一跳（真缺陷，已加漂移测试）。**生产**：`fd-infra-deploy` `all-services/prod/platform.yaml` 增 mcp.json 行 + `BENCH_URL`/`BENCH_PROPOSAL_DOMAIN` env + `platform-secrets.BENCH_CONSUMER_TOKEN`；聚焦层 keep 集 = `mcp.json` 全部 server，无需改 `PACK_BASELINE_MCP`。**实证**：pod 内 stdio 探针 `initialize`+`tools/list` → `['bench_proposal_submit']`；`tools/call` → `{"id":1,"created":false,"result":"幂等命中"}`（复用探针键，零新增行）
- [x] 3.3 柏讯侧本体类提案写入关停；客户侧域动作语义零变化。**已上产**：pack `YT87-2Axuu49I123zVYyhA` v9（2026-11-08 上架，市场回读确认）——提案员改 `bench_proposal_submit`，`wire-ops` 的 `wire_action_list/propose/status` 三工具摘除（只余 7 个只读），新增 `bench-proposal:["bench_proposal_submit"]`；词表纪律写进岗位（law/clause + cites_law/superseded_by/belongs_to_contract_type），`created=false` 记「幂等命中」，语义拒绝不重试；**出口未接线时停在本岗、不退回客户动作闸**（公开包在未接线的实例上不得悄悄把权威挪回租户）。客户侧内置域动作 `entity-declare`/`entity-relation-declare` 本体未改
- [ ] 3.4 本轮报告字段：每条一条结果（新增 / 幂等命中 / 失败 + 对端语义），失败项标明草案仍保留

> 上产顺序提醒：本 change 依赖 law-bench 的提交面返回 `created`（law-bench `525db08`，**需下一次出片才在线上**；
> 未出片前客户端按「无该字段=新增」保守处理，不会把新增误报成幂等命中）。

## 4. 测试

- [ ] 4.1 契约测试（注入 transport）：一条成功、四类错误（缺依据 / 出表 kind / 跨域 / 凭据）、幂等命中、超时
- [ ] 4.2 纪律测试：被驳回后同依据不再自动重试、换依据可重提
- [ ] 4.3 报告测试：失败不得渲染为成功；token 零出现
- [ ] 4.4 全量既有测试零回归

## 5. 收口

- [ ] 5.1 `openspec validate switch-fleet-proposals-to-domain-inbox --strict` 绿
- [ ] 5.2 一轮真跑两侧对照：知验台域提案箱 +N 且控制台可见；柏讯队列本体类 +0（与 1.2 基线比）
- [ ] 5.3 真确认一跳：域负责人在 `/d/{key}/inbox` 确认一条舰队草案 → `knowledge_units` 出现该键 + `authoring_events` 一行（复用 C5 验收 §5.3 的判据）
