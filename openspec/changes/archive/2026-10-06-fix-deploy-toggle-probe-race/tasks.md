## 1. 诊断

- [x] 1.1 诊断（比预案更强：直接读本地 fork 源码 `~/code/mcp-gateway-registry`，零副作用）：registry 侧 toggle 路由**每次调用**都跑 `_refresh_agent_health`（探针=抓后端卡片期望 200，持久化 health_status）+ `mark_dirty` 刷 nginx；`enable_agent` 已在启用态早退但**不影响探针执行**；周期健康循环只覆盖 MCP servers（源码 docstring 明说）——故「重发即自愈」。**早退判据不需要**（重发无副作用），盲重发梯即为正解。原诊断任务：按 `docs/registry-maintenance.md` §6 写通道实锤 toggle 探针语义——POST `/api/agents/<path>/toggle?enabled=true` 的响应形状、GET 条目的健康字段名、重发幂等性；产出：design.md D1/D3 参数注记（早退判据字段名 + 是否需降级为条件重发）

## 2. 实现

- [x] 2.1 `lib/agent-serving.js`：新增 `scheduleDeployReassurance`（+90s/+210s/+330s 三档**无条件重发** toggle?enabled=true，timer unref、失败只记日志）+ deployToRegistry 尾部接线（含 `reassuranceDelays` 测试缝）。验证：伪 fetch 单测 2 条——三档时序（1 即时+2 梯）、失败不抛不阻塞 ✓
- [x] 2.2 回归：`node --test scripts/test-agent-serving.mjs` 34/34（32 既有 + 2 新）✓

## 3. 上线与验收

- [x] 3.1 上线（sha-b5f920f）：platform/platform-demo 先滚；**验收途中发现漏滚 facet**——facet-proxy 模式下 /api/packs 全前缀在 facet 进程侧，部署路由的代码载体是 facet 而非 platform，遂补滚 facet.yaml → b5f920f。三清单同 sha 后 B 才真 LIVE
- [x] 3.2 活链验收（PASS，2026-10-06）：新 facet 进程内长命后台部署 `probe-b4-a`（新入口）——入场即 unhealthy（竞态复现）；**+90s 档梯子自动重探实锤**（facet 日志 `deploy reassurance re-toggle ok (+90s)`）→ health=healthy；随后门面路径 `POST /api/../agent/packs/probe-b4-a/probe-agent/` 200，agent 回「探针正常。」——全程零人工干预。-32033 不复现。对照组另证：一次性 exec 进程（梯子随进程亡）与旧 facet（无该代码）的两个入口均钉死 unhealthy、路由缺席（SPA 回落）。验收后 4 个 probe 条目全删（204）、探针包 unpublish（200，按设计包行只撤不删）
- [x] 3.3 finddata `MCP-REGISTRY.md` §3 新增「agent 部署 toggle 探针竞态」销账行（含验收时间线与 facet 漏滚实录）；归档（本提交）：MODIFIED requirement 并入 `openspec/specs/a2a-agent-serving`，change 移入 archive/2026-10-06-
