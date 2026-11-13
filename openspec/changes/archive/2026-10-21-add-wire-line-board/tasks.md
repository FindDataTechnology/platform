## 1. 地基修补：执行器（design D3）

- [x] 1.1 新建 `lib/action-executor.js`：按 `action.tool` 查快照得所属 server，endpoint 沿 registry-bridge 推导 `{REGISTRY_URL}/{entry_path}/mcp`，一次性 `Client` + `StreamableHTTPClientTransport`（`Authorization: Bearer <liveToken(email,"wire-customer")>`，20s 超时）→ `callTool` → `close`；单测用 sdk 内存/本地 HTTP 假 server 断言工具名、参数、Bearer 头原样、超时抛错、无 token 时拒绝执行
- [x] 1.2 `server/routes/actions.js` 的 `executeAction` 改调执行器：上游 422 → `result_summary` 携带逐字段错误（不改写）；401 → `markInvalid(email,"wire-customer")` + 提案 `rejected`（`execution failed:` 前缀）+ 广播 `line_credential_stale`；成功 → `executed` + `board_changed {line:"wire"}`；单测覆盖成功 / 422 / 401 三态，且 facet / wanxing 既有条目因 tool 不可达返回明确错误而非假成功
- [x] 1.3 审计写入 `action_audit`（提议者、批准者、最终 args digest、结果、耗时）；单测断言记录不含 token / `sk-` / Bearer 片段，且可按 line=wire 检索

## 2. 地基修补：提议身份链（design D4）

- [x] 2.1 `dsh-profile.js` 为 `actions` stdio server 注入 per-user env `ACTIONS_MCP_PROPOSER_EMAIL`（`resolveCredentials` 同位置）；单测断言两个不同 email 的 effective profile 各自带正确值且不互串
- [x] 2.2 `server/actions-mcp.js` 调 loopback 时 body 带 `proposerEmail`（及可得时的 `proposerSession`）；`server/auth.js` 增 `isInternalActionsBridge`（仅 `POST /api/actions/propose` 且 loopback）入豁免家族；单测：loopback propose 落 `proposer_email`、非 loopback 匿名 propose 401、approve / reject / GET 不受豁免（匿名 401）
- [x] 2.3 新增 preflight 原语 `requireLineCredential("wire-customer")` 并挂到柏讯八条；单测：未连接 → preflight 失败且 `details` 含 `connectPath=/settings/connections?panel=line-wire-customer`；已连接 → 通过

## 3. 地基修补：用户补填参数 + 回滚杆（design D5 / D8）

- [x] 3.1 `lib/action-registry.js` 条目支持可选 `userFilledArgs`；`proposeAction` 剥除这些键后落库并在返回体携带 `userFilledArgs`；单测：模型传 `source_urls` → `args_json` 不含该键、返回体含字段 schema
- [x] 3.2 `approveAction` 接收 `{userArgs}`：required 缺失 → 400、键不在声明集合 → 400、合并后执行且审计 digest 取最终 args；单测覆盖三条
- [x] 3.3 `web/src/components/ActionCard.tsx` 按 `userFilledArgs.kind`（`url[]` / `text` / `boolean`）渲染空输入，任一 required 未填确认钮 disabled，确认时随 approve 提交 `userArgs`；组件测试覆盖禁用 → 填齐可点 → 提交体形状
- [x] 3.4 `LINE_BOARDS_ENABLED`（默认关）：`GET /api/boards/:line` 关门时 404 `line_boards_disabled`；`GET /api/config` 增 `lineBoardsEnabled`；前端经 `useAppConfig()` 关门时不渲染 `/boards/:line` 内容与应用中心看板主行动；测试：env 未设时路由 404 + `app-card-*-board` 不存在，设 `1` 时恢复

## 4. 风险真源与注册表（design D2）

- [x] 4.1 新建 `scripts/refresh-wire-tool-surface.mjs`（读 `WIRE_OPS_MCP_DIR` / `WIRE_BUILD_MCP_DIR`，默认 `~/finddata/wire-ops-mcp` / `~/finddata/wire-build-mcp`）生成 `lib/wire-tool-risk.js` 快照：12 个写工具 → 风险 + server 归属，8 条动作 → 工具（含 `wire.dataset.create → wire_dataset_create`）；本地跑一次生成并提交快照，脚本有 diff 时非零退出并打印差异
- [x] 4.2 `lib/action-registry.js` 增柏讯八条（id / line=wire / tool / risk / target=cloud / impact 文案 / preflight=requireLineCredential；`wire.demand.submit` 带 `userFilledArgs`，`wire.artifact.archive` 影响面标注可逆）；对拍测试 A（CI）：八条 `{tool,risk}` == 快照、快照键集恰为 12；测试 B（本地）：两仓源文件存在时 `tool_risk` == 快照，否则 skip 并打印；突变验证：手改一条风险 → A 红并指明条目
- [x] 4.3 对 fd-wire `POST /api/v1/demands` 的请求 schema 核实合规两字段的真实字段名与类型，定稿 `wire.demand.submit.userFilledArgs`；在任务记录里附字段名出处（文件:行）——**已核实**：`fd-wire/api/fd_wire_api/demands/schemas.py:84-85`（`DemandCreate.source_urls: list[SourceUrl] = Field(min_length=1)`；`public_data_asserted: bool`，`:111-113` validator 要求为 True）→ 定稿 `userFilledArgs = [source_urls:url[] required, public_data_asserted:boolean required]`

## 5. 柏讯看板（design D1 / D9）

- [x] 5.1 `lib/board-adapters.js` 新增 `WireBoardAdapter`（连接判据 = `liveToken` 非空；四块各自 try/catch；任一 401 → `markInvalid` + 停发其余块 + 返回未连接块；深链 `originUrl/#/console/*`）并注册 `wire`；契约测试三态：真实响应形状 fixture 渲染四块、假 token 401 → 凭据被清且返回未连接、未连接 → 零上游请求
- [x] 5.2 `web/src/pages/BoardsPage.tsx` 渲染 wire 四块与行级深链，未连接态渲染「去连接」（`/settings/connections?panel=line-wire-customer`），收到 `line_credential_stale {line:"wire-customer"}` 时重取看板并提示重新授权；e2e 覆盖已连接四块、未连接去连接、单块失败降级
- [x] 5.3 看板行内动作（需求单「提交」、产物「归档」等）接 `POST /api/actions/propose` 并复用 ActionCard；e2e 验证未确认不调用底层、`wire.market.subscribe` 走二次确认并显示费用影响面

## 6. 官方 pack「柏讯助手」（design D6）

- [x] 6.1 编写 `docs/official-packs/wire-assistant-manifest.json`：`mcpServers` = wire-ops-mcp 7 读 + wire-build-mcp 4 读（含 `wire_dataset_corrections_list`）；persona 沿谦面助手句式并加「需求单合规字段绝不代填」「越界动作说明边界并指向 `/boards/wire`」；skills 一条控制台 playbook（建台账 → 表单 → 扫码页 → 确认发布 → 改错 + 能力边界表）；`requiredGroup: wire-customers`；`visibility: private`；用 `/api/packs/validate` 预校验通过
- [x] 6.2 仓库级 lint 测试：`docs/official-packs/*.json` 全部 `allowTools` ∩ `lib/wire-tool-risk.js` 12 键 = ∅；突变验证：临时加入 `wire_demand_submit` → 红并指明工具名
- [x] 6.3 private 发布并安装到验收 cell；探针断言该 preset 会话可见工具面 == 11 读工具 + `propose_action`，一次读回合（「我有哪些数据集」→ `wire_datasets_list` 真实列表）成功——**待真环境**：manifest 已过 `validatePackManifest` 与 lint；private 发布 + 装验收 cell + 工具面探针需 facet 市场与验收 cell 在线——**2026-10-21 真机推进**：private 发布 ✓（`ALuUIiL23WP5OqLIgSRX1g` v1）、验收 cell 真安装链 ✓（MCP/persona 全 installed）、propose_action stdio ✓、全量面真握手 wire 10/15+actions 1 ✓；**10-21 深夜收口**：聚焦面以 `tool-filter.json` 实证（11 读+零写，actions 不收窄）、一次读回合会话层真跑通（柏讯助手调 wire 工具返回与看板一致列表）——期间修注入凭据错位（wgk→wire-customer，`9d87ae1d`）

## 7. 应用中心 IA 与 i18n（design D7）

- [x] 7.1 `web/src/lib/appCatalog.ts` 摘除 `wire.status: "early"`；`AppCenterPage.tsx` 的 `hasBoard` 加 `wire`，看板主行动条件改为「该看板所需凭据已连接」（facet → `facet-market`，wire → `line-wire-customer`，wanxing 恒可用），不看聚合态；更新 `scripts/test-app-center.mjs`：`line-wire-customer` connected + `paper-trading` disconnected 时 `app-card-wire-board` 存在且徽章 `partial`、`app-card-wire-early-badge` 不存在、关门时三卡无 `-board`
- [x] 7.2 五语文案（柏讯看板块标题 / 八条动作影响面 / 合规两字段 label 与提示 / 重新授权提示 / 能力边界）补齐，`check-locales` 门绿

## 8. 验收与回滚

- [x] 8.1 单测、typecheck、`web:build`、相关 e2e 全绿；对拍测试 A 在 CI 跑、B 在本地带两仓 checkout 跑一次并记录输出
- [x] 8.2 `docs/acceptance-criteria.md` 追加柏讯十场景（打开看板零 token / 未连接态 / 读回合 / 需求单合规两空字段 / 模型合规值被丢弃 / 订阅二次确认 / 未注册动作拒绝 / 风险对拍 / 应用中心看板主行动 / 工具面纯净）；在验收 cell 开 `LINE_BOARDS_ENABLED=1` 逐条真机跑并记录证据——前置：fd-wire 出片或本地 / 预发可用，且先跑一次读工具 `callTool` 探针确认 MCP endpoint 可达——**文档已追加**（`docs/acceptance-criteria.md` 柏讯十场景 + 回滚演练 + 本地已覆盖清单）；**真机跑待 fd-wire 出片 / 预发可用**——**2026-10-21 真机推进**：不依赖 wire 登录的场景全绿（未连接/诚实 404/开关双向=回滚演练实走/发布门/安装链）；**场景 1/3/4/5/6 阻塞于 wire 客户 Logto 凭据**（控制面仅认 ID token，无测试会话可用）——见 acceptance-criteria 实录待补节
- [x] 8.3 回滚演练：关 `LINE_BOARDS_ENABLED` → `/api/boards/wire` 404、`/boards/wire` 无内容、应用中心三卡无看板主行动、主对话与既有页面零变化；注册表 / 快照 / 执行器 / 身份注入留存无副作用
- [x] 8.4 归档顺序纪律：确认 `add-line-boards-and-action-gate` 先归档，再归档本 change（app-center 同需求叠加文本依赖此顺序）；发布后更新 `docs/registry-maintenance.md` §9——**发布后动作**：归档顺序先 `add-line-boards-and-action-gate` 再本 change；`docs/registry-maintenance.md` §9 发布后更新——**已执行（2026-10-21 深夜）：姊妹已归档（archive/2026-10-21-add-line-boards-and-action-gate，df1e1ec2），本 change 随即归档；原判断**：本 change 二十四/二十五——十场景真机全过（acceptance-criteria 四轮实录）+ prod go-live 完成（sha-848d733 复核绿），归档唯一前置是姊妹 change（23/31）先归档；其剩 8 条实质任务（facet/wanxing 真适配器、wanxing_agent_deploy 外部仓、副驾按线持久化、bot_notify 通知、谦面/萬星 pack 会话级 7.3、姊妹 8.2）归其推进会话；顺序纪律不变——app-center 同需求 MODIFIED 叠加文本，反序归档会用姊妹全文覆盖已合流的 wire 改动
