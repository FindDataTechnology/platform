# 统一记忆面×消耗统计面 调研底稿（壹座×谦面×萬星 agent 规模线）

> **2026-10-22 更新**：记忆面的长期真源已移交 `docs/memory-architecture-v2.md`（ADR-0030）；本文
> 保留为 D1-D6 / S1-S5 / Q1-Q12 决策出处与四切片（10-19 全上产）的历史记录。统计面仍以本文 S 节为准。

> 2026-10-19 `/opsx:explore` + grill（两轮十二问）收口，用户确认共享理解后落档。**状态：调研完成、
> 未立项**——本文是后续 change 的单一事实源，切片序列见文末。伞文档关系：多 harness 运行层归
> `docs/wanxing-multi-harness-runtime-explore.md`（五切片已全部完结 = 本线底座）；产品计划归
> `docs/facet-wanxing-roadmap.md`；领域词汇见根 `CONTEXT.md`（本线新增「工作记忆」「交接」两词条）。
> 调研基线：ai-memory 上游六题实证（license/支持矩阵/handoff 协议/多用户/数据格式/捕获脱敏）+
> token-monitor README + finddata `lex-temporal-kg-lane`（graphiti 试点）+ 本仓生产代码
> （agent-runner/harness、manager `tokensOf`、sub2api 计费链、registry Logto 铸币先例）。

## 命题（用户原话拆解）

1. **通用记忆系统**：壹座、谦面、萬星的整体记忆解决方案，最好通用（参考
   [ai-memory](https://github.com/akitaonrails/ai-memory)）。
2. **萬星控多 harness**：通过萬星控制多个 AI harness 解决不同任务——重要目标。
3. **精确消耗统计**：session 级 token/费用/额度可见（参考
   [token-monitor](https://github.com/Javis603/token-monitor)）。
4. **终局**：让人们长期运行和迭代上百个 agents 的编排与运行层整体方案。

## 核心判断：三个参考项目是三层，不是竞品

| 层 | 项目 | 本质 | 对我们的成熟度 |
|---|---|---|---|
| L1 工作记忆/跨会话接力 | ai-memory（Rust，MIT 实证） | MCP server + 生命周期 hooks；wiki markdown+git 真源、SQLite 派生索引；零 LLM 默认；handoff 类型化协议 | 协议面（MCP）全现成；单租户设计 → 只能当本地节点 |
| L2 沉淀知识/领域图谱 | graphiti（finddata `fd-legal-kg` 试点在跑） | episode → LLM 抽取 → 双时态图 | 「助手会话记忆」= 其提案明文的分岔 B，未做 |
| L3 消耗统计 | token-monitor（MIT） | 本地日志解析（JSONL/SQLite）→ hub 聚合 → 多维看板 | fleet/cell 活数据只差聚合；本地订阅额度是唯一盲区 |

L1 沉淀页（durable facts）= L2 最干净的 episode 源，**L1 是 L2 的上游**；零 LLM 默认让 L1 的
衰减/合并/矛盾标记零成本，只有 L2 蒸馏花钱。finddata「分岔 B = 复用 graphiti 内核做会话记忆」
的伏笔与 L1 沉淀页在同一点会合。

## 现状地图

```
   谦面(facet/registry) --pack--> 壹座 cell(dsh) --部署--> 萬星 runner 舰队
   技能+MCP+persona 组装          chat-history / 资料库      HarnessAdapter 缝
                                  usage 事件带 sessionId      dsh.js(solo/pod) + acp.js
                                                              usage_update -> tokensOf -> sub2api

   本地开发机 harness（CC/ZCode/Codex...）：订阅额度消耗，平台零可见 = 统计唯一盲区
```

### 四条已验证的贴合缝

1. **HarnessAdapter 既是驾驶缝也是观测缝**（add-harness-adapter）：manager 本就看见每 turn
   （usage_update 同缝流出）——ai-memory 的 hooks 角色在舰队里由 manager 扮演，捕获不需要
   hook 进每个 harness。dsh 在 ai-memory 支持矩阵里是 MCP-only（无 hooks）反向印证：dsh 侧
   观测只能从平台缝来。
2. **MCP 挂载通道两线都通**：dsh 侧 MCP sidecar 是 pod 现成分摊结构（合同⑭：三消费一进程恒一）；
   ACP 侧 add-harness-materializer 已让 `session/new` 透传 streamable-http 形状的 mcpServers
   （token 解析与 dsh 侧 `mcpEntry` 同源同纪律）。
3. **令牌铸币先例**：registry 的 Logto 共享会话 → 7 天个人令牌流程原样复用于记忆面人令牌；
   部署令牌部署时自动铸（与计费键绑定形态同构）。
4. **编排与算术底座已在**：机群板统一（unify-wanxing-management-plane）+ pod 密度算术
   （300 agents ≈ 40 pods，warm-zone 更省，空闲会话边际内存 ≈ 0）——终局缺的只有记忆面与
   统计面两个新面。

## ai-memory 上游实证（2026-10-19 六题，全部有据）

| 题 | 结论 |
|---|---|
| license | MIT（Fabio Akita, 2026）确认 |
| 支持矩阵 | **ZCode 完整支持**（MCP 写 `~/.zcode/cli/config.json` 严格 schema + 6 hooks 事件）；CC/Codex/Gemini CLI/Cursor 完整；**DSH = MCP-only**；ZCode 无真会话终界（`Stop`=回合边界，收尾需手动 `ai-memory finalize-session --agent zcode`） |
| handoff 协议 | 类型化、有 owner、claim-once（两条 `state='open'` 守卫）；工具 `memory_handoff_begin/accept/cancel/list`；session-start 只渲染 notice 不自动认领（防 race）；`AI_MEMORY_PREVIOUS_SESSION_HISTORY` = 本机临时投影，跨机只带服务器 ledger/handoff |
| 多用户 | **单租户 wiki 数据 + 可选多人归因，无 per-page RBAC**；官方定位 single-tenant homelab，隔离 = 分实例分数据目录 → **不能当舰队服务器（自建 TS 从偏好变必然）**；本地单人节点恰好匹配 |
| 数据格式 | OKF v0.2 markdown bundle：页面类型目录（sessions/_rules/gotchas/decisions/procedures/concepts/notes/runbooks）+ 月度 hook ledger `log-YYYY-MM.md`；`db/` = SQLite 派生（FTS5×2、实体 V38 名词索引、wikilink 边、可选向量），`ai-memory reindex` 随时重建——文档齐全，fixture 有据可依 |
| 捕获与脱敏 | hooks 捕获 prompt / 工具调用 pre-post-failure / 会话边界 /（按 harness）subagent/compact；脱敏 = 四类静态规则（PEM 私钥/已知 token 格式/bearer/带标签 secret）+ extra_patterns + allowlist，**best-effort 非 guarantee；embedding 路径发全文不脱敏 → 一律禁用 embeddings**；助手回复捕获默认关（双重 opt-in，开后无 per-project 排除）；`.ai-memory.toml` 支持 `server=` 把 capture 路由到别台服务器 → 本地 stock 客户端未来可直指自建舰队服务 |

## 决策清单（grill 两轮全树定案，2026-10-19 用户确认）

### 记忆面

- **D1 L1 先行**：工作记忆/handoff 先做；L2 graphiti 蒸馏吃 L1 沉淀页，远期。
- **D2 拓扑 = fleet 级一等记忆服务**：双 namespace `u/<user>/p/<project>`（人，跟人走）与
  `d/<packId>/<agentId>`（部署，跟 agent 走）；runner 保持无状态；跨 owner 永不共库
  （与 pod 共宿铁律同构）。
- **D3 通用载体 = 格式+协议，不是单一服务器**：OKF v0.2 wiki 磁盘格式 + MCP 工具面 + capture
  API；本地节点 = stock ai-memory（钉版），舰队节点 = 自建 TS（单租户事实后为必然）；fork 纪律
  对齐 sub2api-fork-patches 先例——只取格式与协议，不取供应商关系。
- **D4 两步走**：先本地 stock 试点验证，再立项舰队自建。
- **D5 令牌**：人 = Logto 铸币（registry 先例复用），部署 = 部署时自动铸。
- **D6 L2 蒸馏排最后**：等 L1 沉淀页成规模再议（与 finddata 分岔 B 会合）。
- **受众（Q2）**：产品能力架构 + 内部狗粮先行——寻数团队是第一批 `u/`，我们的 pack 部署是
  第一批 `d/`；「让人们长期运行上百 agents」的「人们」终局指客户，但先自吃狗粮磨协议。
- **可见性（Q3）**：部署者可读自己部署的 `d/`（萬星 console，审计排障刚需）；agent 默认不读
  owner 的 `u/`，仅 pack 显式声明记忆挂载才可（后置）；团队共享 namespace 留 v2。
- **内容边界（Q4）**：v1 只记 handoff note + durable facts（零 LLM 规则压缩）；四概念正交
  （转录/轨迹/资料库/工作记忆，见 CONTEXT.md 词条），互不收编。
- **上游姿态（Q5）**：格式采纳后自立——舰队服务不依赖其代码，本地节点钉版用；fixture 双源
  录制（`docs/okf.md` + 实测行为）；`server=` 路由能力列进协议兼容面；季度评估上游演进。
- **挂载授权（Q10）**：部署者部署时指定（服务配置/计费键先例同构），pack manifest 声明后置
  （涉及客户对创作者的信任模型）；v1 = `d/` 自动随部署铸 + `u/` 挂载绑定为可选高级项。
- **handoff 责任（Q11）**：agent 自写（MCP 工具 + persona/CLAUDE.md 记忆纪律指引），平台只做
  会话边界事件触发（finalize）；零 LLM 纪律保持。代价：pack persona 文案要加记忆纪律——
  进切片 2 验收。
- **落仓（Q12）**：finddata 侧新仓 **`fd-memory`**（舰队服务族惯例，与 registry/sub2api/facet
  并列）；paas 侧只留挂载与消费适配（MCP 行注入、manager 代采客户端），registry-bridge 分工先例。

### 统计面

- **S1 范围含本地订阅额度消耗**（唯一数据盲区）；fleet/cell 侧是活数据只差聚合展示。
- **S2 本地采集 = 日志解析**（token-monitor/tokscale 思路，零侵入、46+ 工具实证含 ZCode/GLM），
  非 hooks；形态 = headless collector 常驻本机 POST 到舰队 hub。
- **S3 聚合贴舰队观测族**（fleet-observer 或姊妹，并入 vs 姊妹留 change 设计）；**sub2api 永远
  唯一计费真源**——统计面只做展示聚合，不做第二计费真源（防双真源漂移）。
- **S4 看板双落位**：萬星 console（运营维度：agent/pack/caller/model 下钻、趋势、活动热图）
  + 壹座（个人维度，随产品化阶段）。
- **S5 成本口径分账**：舰队/cell = 实计费（sub2api 真源）；本地订阅 = 额度窗 + 估算成本，
  估算永远不混进计费数字。
- **受众（Q1）**：内部先行、架构按产品预留（fleet 活数据聚合周级可交付；壹座个人页与记忆面
  租户模型一起设计，避免两套账号语义）。
- **第一落位（Q8）**：萬星 console 运营段扩展（机群板邻座）；不做内部独立页（第二个要维护的面）。
- **接入通道（Q9）**：内部阶段 collector 走 tailnet 直连 fleet hub（零公网暴露）；公网 endpoint
  随产品化再开（registry 先内后外节奏同款）。

### 自决默认（可推翻）

统计保留 13 个月滚动 + 每日聚合永久（对齐 token-monitor 370 天窗口先例）；记忆衰减采 ai-memory
默认档；`u/` 键 = Logto 身份、`d/` 键 = 部署实例 id。

## 切片序列（未立项，按序）

```
0  既有底座（零新工作）：多 harness 五切片全完结 + 机群板统一 + pod 算术已证
1  mem-pilot-local       stock ai-memory 本地试点（~1 天，零构建）
   ✅ 2026-10-19 完结（报告=docs/memory-pilot-local-report.md）：三判据全过——
   ① dsh↔ZCode 真实任务接力（CC/Gemini/Codex/Qwen 四 harness 环境阻断如实记录），
   handoff 认领 claim-once 实证；② 敏感抽查零命中（附两起 transcript 泄露处置与 token 轮换）；
   ③ ZCode 档位全实测（六事件 exec-form hooks + 严格 schema MCP + Stop=回合边界）。
   关键新证据：dsh 会话零 observations（MCP-only）= manager 代采必然性的活体证明；
   token 注入面分 stdio-bridge（文件读）与 http-直连（字面量）两档；headless dsh 组装配方在册。
2  fleet-memory-v1       fd-memory 新仓：服务 + runner MCP 挂载 + manager 代采
   ✅ 2026-10-19 全链上产（change add-fleet-memory-v1，生产验收三判据过）：
   服务=cheap-4 单实例+PVC（fd-memory sha-b2fc387）；runner-serving 滚 platform
   sha-54da09c + 记忆开门；验收记录=change reports/。as-built 边界与 v1.1 待办
   在案（namespace 用显示名/pod 成员无挂载/ACP 生产补验/7.2 B 向 spike）。
3  stats-plane-v1        三采集点 + 聚合 + 萬星 console 运营段（与 2 并行开线）
   ✅ 2026-10-19 全链上产（change add-stats-plane-v1@fd-wanxing，验收记录在 change reports/）：
   fleet 口径真数（回填+活体）/ collector 本机在流（launchd）/ console 消耗页签三口径分列；
   sub2api 首拉形状与 24h 浸润待复验。统计面自此与记忆面并列成形。
4  memory-federation     壹座 cell 挂载 + 本地 stock 节点与舰队互通（`server=` 直指）
   ✅ 2026-10-19 全链上产（change add-memory-federation-v1，验收记录在 change reports/）：
   /hook 兼容面（spike 协议钉死）+ platform 第四令牌族 + NodePort 31899 + cell 挂载开门
   （clusterIP 直连坑在案）；本地首投落库+幂等实证；cell 机制链活体过；真实会话眼见=复验项。
5  kg-distill（远期）    L1 沉淀页 -> episode -> graphiti 双时态图（分岔 B 会合）
```

切片 1 验收三判据（过门才进切片 2，不以「差不多」放行）：

1. 一条**真实工作任务**完成 CC↔ZCode 跨 harness 接力，新 harness 凭 handoff brief 不需重述
   背景即续作；动线含 `ai-memory finalize-session --agent zcode`（ZCode 无真会话终界）。
2. 试点配置**禁用 embeddings**（embedding 路径发全文不脱敏）+ 助手回复捕获保持默认关，
   然后做敏感信息抽查（key/密码/内部 URL 零入库；脱敏是 best-effort 非 guarantee）。
3. ZCode 支持档位与限制如实记录成档（MCP 写 config.json 严格 schema、六 hooks 事件、
   Stop=回合边界的运营含义）。

## 未决问题（留给各切片的 change 设计）

| # | 问题 | 归属 |
|---|---|---|
| 1 | 统计聚合存储并入 fleet-observer 还是姊妹服务 | stats-plane change |
| 2 | sub2api 用量读法（API vs 读库——倾向 API，防双真源） | stats-plane change |
| 3 | pack manifest 记忆挂载声明形态（涉及客户对创作者信任模型） | federation 之后 |
| 4 | 团队共享 namespace 模型（per-person attribution 借 ai-memory 先例） | v2 |
| 5 | L2 蒸馏的 episode 策略与成本（等 L1 沉淀页成规模） | 远期 |
| 6 | 记忆服务的高可用形态（单实例+备份起步 vs 直接双活） | fleet-memory change |
