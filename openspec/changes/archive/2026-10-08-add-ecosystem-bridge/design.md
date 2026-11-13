# add-ecosystem-bridge — Design

## Context

谦面今天的现实：注册处 7 servers / 152 skills / 5 agents 全部自有；facet CLI 已能往 claude-code/cursor 落技能但刻意不写 MCP 配置（CLI 不持凭证）；wgk- 调用键机制已上线（SHA-256 落库、Bearer 进 MCP 代理路径、随用户组继承 scope、上限 20/人）；额度预检已上线（不足 402、断连 503 fail-closed），客户真回合经 wire 门面全链已通；Logto 与注册处共享租户。缺的是：入向内容治理、出向连接与计费闭环、外部身份面。设计树经三轮 grill 定案（本档 D 编号即定案编号）。

## Goals / Non-Goals

**Goals**
- 开源素材以「精选」入场且治理姿态可审计（安全/许可证/质量三轴）。
- 任意主流 harness 用户从发现到可用 ≤ 三步（发现 → connect 铸键 → install/写配置）。
- 出向 MCP 消费账实闭环：计量、免费额度、超额硬挡全部落在 wire 线单一账本。

**Non-Goals**
- 不做社区提交面、不做自动审校（素材量上来再议）。
- 不做 creator 注册外部 MCP 端点（v2 议题，本版不动 pack「MCP 条目只引注册处」边界）。
- 萬星 A2A 计费不并轨——外部回合按分结算维持 ADR-0014 双轨，本版只补文档与示例。
- 不重写注册处（ADR-0015 推迟条款继续有效）。

## Decisions

### D1 定位：双向桥（窄腰），不赢市场品类
分发层（包格式+市场 UX）已是 Anthropic 主导的商品。谦面的差异化 = 独占数据 MCP + 托管运行 + 计费闭环；开源素材是填充与引流，不是对手。所有后续决策服从此定位。

### D2 入向托管：v1 平台托管精选白名单，creator 注册留 v2
开源 server 像现有 6 个自有 server 一样在我们基础设施上托管（cheap 节点容器 + tailnet NodePort + 注册处代理）。pack「MCP 条目只引注册处」的安全边界零改动；开放注册是 v2 议题，等审校标准成型。
*备选弃项*：直接开 creator 外部端点注册——安全审校管线未建，攻击面（SSRF/凭据外发）不可控。

### D3 隔离姿态：每 server 独立容器 + 逐个 egress 白名单 + 零平台凭据
fetch/浏览类 server 允许宽出网；其余默认断。任何精选容器环境不含平台凭据材料（registry admin token、sub2api key、relay secret）。容器编排复用现有 server 托管模式，不新增架构层。

### D4 审校：人工 + runbook checklist，三轴（安全/许可证/质量）
checklist 落 `docs/`（随 A 切片交付）。许可证轴明确拦截 AGPL 托管与非商用条款；MIT/Apache 放行。首批规模上限 10-15 server + 30-50 技能——**上限而非目标**，数量服从审校吞吐（用户定案：成色优先）。

### D5 生态技能走注册处技能目录既有渠道，带来源标记
不另建渠道：单装、pack 引用、Store 安装全部复用现有机制。来源标记（上游仓库+许可证+生态/官方区分）落在目录条目上。壹座侧近零改动。

### D6 出向 target 矩阵：五 CLI + Claude 市场端点
claude-code / cursor（已有）+ zcode / codex / gemini-cli（新增，只差技能目录约定）。marketplace.json 端点由 facet 生成：仅公开精选 pack、技能可直接装、MCP 只做连接指引（plugin 本体不携带 server 配置——否则用户没有 key 时安装即坏）。

### D7 connect 走查：粘贴起步 → device flow 免粘贴
v1：CLI 打开网页铸造面 → 用户 Logto 登录 → 粘贴 wgk- key → CLI 验活 → 本地存键 → install 时征得同意写各 target 的 MCP 配置（端点+Authorization 头）。device flow 作为同一条 CLI 命令的升级形态（谱系侧暴露设备授权端点后自动切换）。key 落本地 CLI 配置文件，权限 0600。

### D8 计费：wire 线唯一账本 + key 月度免费额度 5k
计量、额度、超额预检、账本硬停全落 wire 线（fd 谱系）；facet/市场面只透传不自记。免费额度挂 key 的月历窗口，默认 5,000 次/月（偏低起步，好调难收）。收尾两件并入本版：sub2api 入账管道、账本硬停（wire-platform-v1 遗留 4.x）。**实现归属**：fd 谱系侧改动走独立谱系纪律（`docs/registry-fork-patches/` 台账 + 两套测试绿门槛）。

### D9 准入：公开注册 → community 组 → 组即档位
Logto 开公开注册；community 组默认只挂 fd-open-data-mcp + fd-cn-report（读类）。law-bench 归付费档组。升降档 = 组分配，既有 key 无需重铸（scope 随组走）。滥用护栏 = 免费额度 + key 上限 20/人 + 预检 fail-closed。

### D10 词表（已落 CONTEXT.md）
官方功能集（Official Pack）、生态技能（Ecosystem Skill）两词条已写入 CONTEXT.md；「谦面预设」口语指官方功能集，不用「预设」词根。

## Risks / Trade-offs

- [ADR-0017 生态漂移条款被触发：fd-1.32 代理行为对当下主流 streamable-HTTP server 未核] → A 切片首个任务即兼容性核查；不兼容项要么钉版本要么出局，核查结论记入谱系台账。
- [AGPL/非商用许可证地雷混入白名单] → 审校许可证轴一票否决 + 台账记录；调研报告（进行中）给首批候选附许可证列。
- [Logto 公开注册开放滥用面（批量注册刷额度）] → community 免费额度挂 key 月窗 + 每人 key 上限 + 预检 fail-closed；注册风控（验证码/邀请码）留观察后决策。
- [CLI 本地存键的泄漏面] → 文件 0600 + `connect --clear` 一键清除 + key 可在网页侧即时吊销；不进任何 shell 历史。
- [wire 线收尾跨谱系改动风险] → 走 fd 谱系既定流程（镜像钉版、两套测试绿、安全单行道台账），不夹带平台线。

## Migration Plan

四切片独立可上线，依赖序 A → (B ∥ C) → D：

1. **A 入向**：兼容性核查 → 审校 runbook → 首批 server 托管+注册 → 生态技能入库带标记。
2. **B 出向**：CLI targets 扩展 → connect 粘贴流 → MCP 配置写入 → marketplace.json 端点。B 不依赖 C（没有计费也能连，走免费额度前置默认）。
3. **C 计费收口**：wire 线 sub2api 入账 + 账本硬停 → 免费额度窗口 → community/付费组与公开注册。
4. **D 文档**：出向指南（各 harness 接入文档）、A2A 调用示例、ADR-0017 追记。
每片上线走当日 canonical 部署路径；回滚：CLI 新 target/端点为增量（摘除即回）；注册处谱系改动按 fd 线钉版回退。

## Open Questions

- ~~MCP OAuth 发现进 v1 还是 v2~~ **已定档（2026-10-07 生产探针）→ 抬进 v1（小补丁档）**。探针实锤：零输入链的机器上游 1.32 已全套带入——MCP 代理 401 已带 `WWW-Authenticate: Bearer ... resource_metadata=/.well-known/oauth-protected-resource`（live）；`/.well-known/oauth-protected-resource` + `/oauth-authorization-server` 路由与 RFC 9728/8414 文档构建在 fd 谱系代码中齐备（`registry/api/wellknown_routes.py` + `registry/auth/oauth_metadata.py` + logto provider `authorization_server_metadata()` 全量 passthrough 含 registration/device 端点重写）。缺口三件：① live registry 两路由 500 "Auth provider not configured"——部署配置未激活 provider，非代码缺口；② Logto 发现文档无 `registration_endpoint`（DCR 不支持）——需 registry 侧 DCR shim（registration_endpoint 指向自有端点、代理静态预注册 Logto app，带限速防滥用），小补丁非架构；③ 401 响应带**两条** WWW-Authenticate 头（裸 `Bearer` + 完整），部分客户端会困惑，顺手修。红利：Logto 原生支持 device flow（`device_authorization_endpoint` + `urn:...:device_code` grant 都在），facet CLI 的 device flow 分支可接真端点（wgk 铸键映射到 `POST /api/patch-keys`，Logto JWT 鉴权即可，或注册处代发）。
- **首批白名单具体条目**：许可证调研进行中，产出按 D4 上限裁剪后作为 A 切片任务的输入，不改变任务结构。
