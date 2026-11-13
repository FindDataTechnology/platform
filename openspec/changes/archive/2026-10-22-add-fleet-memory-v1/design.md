## Context

动机见 proposal.md，契约见 specs/。约束要点：多 harness 底线五切片已完结（HarnessAdapter/ACP 驾驶面/pod/物化器/管理面），manager 已在回合缝上看得到 usage（`tokensOf`）；切片 1 试点实证三条定设计输入——dsh=MCP-only 零 observations（代采必然）、token 注入两档（stdio-bridge 文件读 / http 直连字面量）、ai-memory 单租户不能当舰队服务器但 OKF 格式可对齐。调研底稿 `docs/memory-and-stats-plane-explore.md`（D1-D6/S1-S5/Q1-Q12 决策）与试点报告 `docs/memory-pilot-local-report.md`。

## Goals / Non-Goals

**Goals:**

- fd-memory 服务 v1 全量落地（双 namespace、令牌两族、MCP 面、capture API、OKF 存储与派生索引重建）。
- paas runner 侧接入：manager 代采（dsh+ACP 同缝）、部署组合自动注入记忆 MCP 挂载与 persona 纪律、停机降级开放。
- 生产验证：一个真实部署 agent 跨会话 handoff 接力 + 观测落库可检索。

**Non-Goals（设计级，不重述 proposal 边界）:**

- 不做 Logto 自助铸币与部署时自动铸造（v1 admin CLI 铸，接线点预留）。
- 不做衰减/合并/矛盾标记的执行引擎（spec 只留衰减位；执行留 v2）。
- 不做高可用（单实例+PV+备份快照起步，HA 形态在底稿未决表）。
- 不做多语言客户端 SDK——MCP 与 HTTP 面即接口。

## Decisions

**D1 服务形态：单进程多 store-root 路由，不是单库多租户，也不是每 owner 一进程。**
一个 fd-memory 进程持有 store-root 目录（`<data>/owners/<ownerId>/`），每 root 内是独立 OKF wiki 树 + 独立 SQLite 派生库；请求令牌解析出 owner → 路由到 root。理由：跨 owner 物理隔离是 spec 硬要求（单库多租户被否——一次查询 bug 就是跨租户泄漏）；每 owner 一进程运维爆炸（百 owner=百进程）。备选「每 owner 一个 stock ai-memory 实例、fd-memory 只做路由」被否：Rust 进程群管理+协议转译层比自建 TS store 复杂，且 format 层我们本就要持有（D3 底稿）。

**D2 存储实现：TS 自写 OKF 层，钉 ai-memory 3.0.0 的磁盘格式为兼容目标。**
wiki 页面（frontmatter：type/kind/title/tags/generated/sources/status + 扩展键原样保留）、按类型目录、月度 ledger `log-YYYY-MM.md`、`sessions/<id>.md` 会话页；SQLite 派生（FTS5 虚表 + 观测表 + 交接表），`reindex` 全量重建。兼容性 fixture 用切片 1 试点仓的真实数据目录录制（双源：`docs/okf.md` 上游文档 + 实测），防上游格式漂移。备选「嵌入 ai-memory 二进制当存储引擎」被否：Rust 依赖进舰队服务族交付链、patch 成本高（fork 纪律同 sub2api 先例——只在格式层对齐，不在代码层耦合）。

**D3 令牌：自铸 `fdm_` 前缀随机令牌，SHA-256(token‖pepper) 落库，无过期、可吊销。**
两族：deployment（scope=恰一个 d/ namespace）与 person（scope=一个 u/ root）。v1 admin CLI 铸造（`fd-memory token mint --kind deployment --namespace d/<packId>/<agentId>`）；部署时自动铸造以最小形态提前落地：fd-memory 暴露 runner-only `POST /admin/mint`（runner 令牌可为其观察到的部署代铸 deployment 令牌，其余 scope 拒绝），manager 首次 spawn 时代铸并缓存——agent 侧挂载用部署令牌，manager 代采用 runner 令牌（capture-only），两族各得其所；「部署面声明式绑定」仍留后续。v1 边界：pod 共宿部署的 MCP patch 是整 pod 共享而令牌 scope 单部署——pod 成员 v1 只有平台代采、无 agent 侧挂载，按成员挂载留后续。备选 JWT 被否：吊销要即时（spec 要求无缓存宽限），自铸令牌查表天然即时。

**D4 MCP 面：streamable-http 单端点 + Authorization 头，协议版本 2025-03-26。**
工具八件：handoff begin/accept/cancel/list + query/recent + read_page/write_page。会话按令牌 scope 绑定 namespace（连接期解析一次，工具调用不再重复鉴权但吊销查表每调用命中）。对 http-直连客户端（zcode/ACP/droid 族）这是唯一形态；对 stdio-bridge 客户端（claude/gemini 本地节点）后续联邦切片提供 bridge，v1 不做。

**D5 capture API：hooks 事件形状对齐上游，身份=令牌，项目坐标=cwd 派生 basename（v1）。**
事件体兼容 ai-memory hooks 的 payload 形状（agent/event/session_id/cwd/tool_name/tool_input 摘要），使本地节点 `.ai-memory.toml server=` 直投成为可能（切片 4 验证）。观测入库前过与上游同族的静态脱敏（PEM/已知 token 格式/bearer/带标签 secret 四类，试点报告判据②同款）。

**D6 manager 代采：复用回合缝，逐回合批量投递，不进 adapter 契约。**
manager 在既有 turn 完成路径上（usage 归集处同点）组 observation 批（工具调用摘要+回合边界+会话边界），以部署令牌 POST capture；失败退避重试、连续失败转静默缺口记录（spec 降级开放）。dsh 与 ACP 同一路径（观测源=manager 视角，与 harness 无关——这正是 MCP-only harness 也能有记忆的原因）。批大小与节流参数进 runner env（`AGENT_RUNNER_MEMORY_*`）。

**D7 记忆挂载注入：dsh=compose 既有 mcp.patch 追加一条；ACP=spawnSpec.mcpServers 追加一条。**
fd-memory 端点+部署令牌经部署 secrets 通道解析（与 mcpEntry token 解析同源同纪律，materializer 先例）。persona 纪律：dsh 侧 persona 后缀一段固定文案（会话终局写交接的指引），ACP 侧工作区 CLAUDE.md 追加同文——文案常量单点维护（`agent-runner/memory-discipline.js`），两路引用同一字符串。

**D8 部署形态：k8s 单实例 + 单 PV（store-roots 目录）+ 每日 git commit 快照。**
镜像走 GHA→TCR 链（出片前 `fd-build-channel` 判路，纪律照旧）；服务无状态化程度=除 store-roots 外全可弃。备份=wiki 真源 git 远端镜像（派生库可重建，不入备份）。

## Risks / Trade-offs

- [上游 OKF 格式漂移破坏互读] → 兼容 fixture 钉 3.0.0 实测行为；上游大版本变更视为新变更评估。
- [manager 代采放大回合延迟] → 投递异步（队列+批），失败不阻塞回合主路径；试点数据（事件量极小）支持。
- [观测含敏感内容（试点判据②同族风险）] → 入库前静态脱敏四类 + per-namespace `ignore` 配置位预留；报告在案。
- [单实例停机=全舰队记忆缺口] → spec 已定降级开放；缺口恢复后续投；HA 留未决表。
- [部署令牌经 secrets 通道的面扩大] → 令牌 scope 单 namespace、可独立吊销；不与计费键复用同一凭据。

## Migration Plan

fd-memory 仓脚手架 → 服务核心（store/MCP/capture/令牌）+ 单测 + OKF 兼容 fixture → paas 侧 manager 代采与挂载注入 + 合同测试 → 本地 docker-compose 联调（runner 模拟）→ 出片（fd-build-channel 判路）→ 生产单实例部署 + 真实部署 agent 验收（切片 1 三判据的生产复演）→ 台账与底稿更新。回滚：runner 侧 env 开关（`AGENT_RUNNER_MEMORY_ENABLED=0`）即回到无记忆行为；服务下线不影响任何回合。

## Open Questions

- capture 事件的保留窗口（全量 vs 按会话页衰减）——v1 全量，量级数据出来再定。
- person 令牌与 Logto 身份的映射键（email vs sub）——接线 Logto 时定，v1 admin 铸造不受影响。
- fd-memory 上舰队的具体节点与命名空间（cheap-1 vs 独立）——部署任务时按 INFRA-NOTES 现状定。
