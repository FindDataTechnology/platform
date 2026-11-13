## Why

寻数 CRM 板块的自托管 Chatwoot 客服台已上产（cheap 集群，https://desk.finddatatech.cloud，Account 1「寻数 FindData」），finddata 根 change `crm-board-adoption` 任务 4.1/4.2/4.3 把 AI 接待的 paas 侧实施交付到本仓：把验真过的 fazer-ai/mcp-chatwoot（MIT，npm `@fazer-ai/mcp-chatwoot@1.1.0`，实测 123 工具中标准可用 100）接入壹座运行时，配一稿「默认只草不发、发送走动作闸」的客服接待技能，并验证失败口径（凭据无效/网络不可达时 agent 带原因上报，会话不丢）。零自研裁决：不改 mcp-chatwoot 源码，不依赖 Chatwoot 付费 AI。

## What Changes

- **chatwoot MCP server 接入**：依赖钉 `@fazer-ai/mcp-chatwoot@1.1.0`（其 npm dist 即 bun `--target node` 单文件 bundle，node 直接跑）；`platform.bundle.json` 增 stdio 条目（`envRefs: [CHATWOOT_BASE_URL, CHATWOOT_API_TOKEN]`，websearch 同款 BYOK 通道——名字进 git、值从部署 env 在 patch 写入时解析）。BASE_URL 用公网 `https://desk.finddatatech.cloud`（活体已证：mcp-chatwoot 原生 `Api-Access-Token` 连字符头打公网 200，需求文档中的集群内直连/Bearer 兜底分支不触发）。
- **env 缺失时省略服务器条目**（小缝一，通用语义）：stdio 条目声明所需 env 全缺时整个条目不出现在 MCP patch（而非死条目），platform-demo / agent-runner-serving / fd-memory 等未配 env 的部署零污染。
- **操作员级工具面**（小缝二）：full-mode 工具面并集之上加操作员声明的 per-server 工具面上界（git 内名单，经既有 tool-filter GUARD 三层硬执行）。chatwoot 的面 = 标准 100 − fork 专属 23（kanban_\*/scheduled_messages_\*，标准实例实测 404）− 发送类 2（messages_create / messages_delete，转动作闸）= 98 读/流程工具。
- **动作闸 crm 线**：注册 `crm.message.send`（write 档 → 行内确认，propose_action 通道，ActionCard 主对话确认卡）；执行器补 stdio 分支（action 的 server 解析到 bundled stdio 配置时 spawn StdioClientTransport，env 同源 envRefs 解析）。发送类工具不进 agent 可见面（闸的牙齿）；`messages_delete` 不注册亦不进面 = 如实不可达。A 租户为部署级共享 token（寻数自用，全体平台用户共享同一收件箱属预期），B 面商家化再换 per-tenant BYOK。
- **客服接待技能**：仓根 `skills/crm-desk-reception/SKILL.md`（镜像内置）。工作流=读未处理会话→读消息→在壹座对话出草稿→人工确认→`propose_action("crm.message.send")` 发送→`messages_list` 复核送达；钉 `account_id=1`（mcp-chatwoot 的 server 不读 `ACCOUNT_ID` env，逐工具显式参数）；错误纪律=任何工具失败原样上报+四分类（凭据无效/网络不可达/上游错误/参数被拒），禁止假报发送成功、禁止编造会话状态。
- **失败口径验证**：token 改错、BASE_URL 改错两轮人为故障，验证收件箱会话原状、agent 输出带原因分类而非空列表/静默成功，证据落 change reports/。

非目标（finddata 侧不做清单 + 本 change 守界）：不动 Chatwoot 部署与 fd-infra-deploy 清单；不做企微/公众号进箱桥、浏览器态聊天渠道；不引 Chatwoot 付费功能（Captain 等）；B 面 pack 化（crm-board-adoption 6.1）与外部应用反代嵌入（6.3）另起 change；不接 fork 专属 Kanban/定时消息能力。

## Capabilities

### New Capabilities

- `crm-desk-bridge`: CRM 客服台 agent 桥的纵向契约——chatwoot MCP server 的 A 租户接线（钉版本、BYOK env、标准子集面）、客服接待技能的行为口径（草拟优先、发送走闸、错误如实分类）、失败口径的验收场景。

### Modified Capabilities

- `action-gate`: ADDED——受闸动作可落在 stdio 操作服务器上（执行器 stdio 分支 + 部署 env 凭据语义），CRM 发送动作注册（`crm.message.send`，write 档）。
- `pack-agent-scoping`: MODIFIED——full-mode 工具面并集之上叠加操作员声明的 per-server 工具面上界（与 pack 声明求交，全模式生效），focused 模式同样以操作员面为上界。
- `mcp-integration`: ADDED——声明所需 env 全缺的 stdio 服务器条目在 MCP patch 中整体省略（而非以死条目降级）。

## Impact

- **依赖**：`package.json` + lockfile 增 `@fazer-ai/mcp-chatwoot@1.1.0`（npm dist 自包含，镜像构建零额外步骤）。
- **代码**：`platform.bundle.json`（chatwoot 条目）；`dsh-profile.js` / `lib/full-mode-tool-scope.js`（操作员工具面 + env 缺失省略）；`lib/action-registry.js`（crm.message.send）、`lib/action-executor.js`（stdio 分支）、`lib/action-preflight.js`（chatwoot env 检查）；`skills/crm-desk-reception/SKILL.md`；操作员 98-leaf 名单（可测常量）。
- **部署**：platform 部署 GitOps env 增 `CHATWOOT_BASE_URL` / `CHATWOOT_API_TOKEN`（值来自 finddata docs/TEST-ACCOUNTS.md §七，只进 env 不进仓）。出片走 GHA → hkccr → relay → ccr 既有链。
- **上下文成本**：平台部署每个 full-mode 用户每回合多吃 ~98 个工具 schema；用户可经已安装面板自行禁用（availability overlay 既有）。
- **验收**：四链路（列未处理会话/读消息/发测试回复且收件箱可见/读联系人）+ 两轮失败口径，对生产 desk.finddatatech.cloud 实测；完成后回 finddata `crm-board-adoption` 勾 4.1/4.2/4.3。
