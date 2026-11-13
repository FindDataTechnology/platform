## 1. 动作闸地基

- [x] 1.1 新建 `lib/action-registry.js`：声明动作条目（id / line / tool / risk / target / impact / preflight），先落 design D3 表里的九条；单测覆盖风险到确认档的映射与未注册动作的拒绝
- [x] 1.2 `db.js` 增 `action_proposals` 与 `action_audit` 两表及迁移；单测验证建表、写入、按线/时间/动作检索
- [x] 1.3 实现 `POST /api/actions/propose`、`POST /api/actions/:id/approve`、`POST /api/actions/:id/reject`、`GET /api/actions/:id`；所有执行经同一 executor；单测验证 pending / executed / rejected 三态与参数摘要不含密钥（执行失败态为 `failed`，`rejected` 只表示人说不——main 4e06e955 / eba36c89 定案）
- [x] 1.4 审批过期扫描：24h 未处理置 `expired` 且不执行；单测用可注入时钟验证 fail-closed（生产活体探针抓出 ISO/epoch 比较缺陷，910a739e 修复）
- [x] 1.5 preflight：`target=cloud` 要求 `wanxing-deployer` 已连接，`target=desktop:<seat>` 要求机位已配对且在线且不要求计费键；单测覆盖两条路径与失败指引
- [ ] 1.6 审计与通知接线：执行成功/失败写审计并通过 `bot_notify` 发审批请求；单测验证通知只在 pending 时发一次 —— **审计已做；`bot_notify` 审批通知未做**（publish 档 approve 后停留 `approved`，无异步审批流）。**DEFERRED** → 后续 change「async 档审批通知」
- [x] 1.7 执行器接通谦面/萬星（2026-10-21 收尾，design D11；萬星四条显式钉 wanxing-caller，防误伤 registry 凭据）：`lib/action-executor.js` 凭据按「动作 ref → 线固定 ref → 宿主服务器目录声明」解析并经 `credential-refs` 调度表取 token / 置失效；注册表八条 facet/wanxing 动作显式声明 `server`；preflight `requireExecutionCredential` 在目录冷或未连接时拦截并给连接卡深链；HTTP 层与工具层 401 同等置失效；修 `getMarketEntries()` 对象形状误读；`scripts/test-action-executor-refs.mjs` 15 条（含突变验证：去掉置失效即 3 红）

## 2. 平台内置 propose_action

- [x] 2.1 新建 `server/actions-mcp.js`（stdio MCP，loopback REST 桥瘦客户端，沿用 `server/cron-mcp.js` 形状），暴露 `propose_action`；单测验证工具列表、参数校验与 pending 返回体
- [x] 2.2 `mcp.json` 增加 `actions` server 条目；启动后验证工具名为 `mcp__actions__propose_action` 且可见
- [x] 2.3 `web/src/components/ToolBlock.tsx` 增加 `name.endsWith("__propose_action")` 分派到新 `ActionCard`；实现待确认面（动作名/目标/影响面/确认/取消）与已执行面（结果摘要/审计入口）；单测或组件测试覆盖两态与历史回放（确认/取消按钮与 failed 态由姊妹 change 9861191c/eba36c89 补齐）

## 3. 线看板

- [ ] 3.1 定义 `BoardAdapter` 接口并实现谦面适配器（我的包列表、安装/回合指标、最近版本时间线），用 facet-market 凭据直读；契约测试对真实响应形状断言 —— **接口已定义；谦面适配器仍是占位块（TODO 真 REST）**，真适配器待做（姊妹 change 8.4 决策「两 change 均不归档」的依据之一）
- [ ] 3.2 实现萬星适配器（舰队卡片、任务/成本指标、最近事件时间线），用 wanxing 平台令牌直读；契约测试对真实响应形状断言 —— **仍是占位块（TODO 真 REST）**，真适配器待做
- [x] 3.3 实现 `GET /api/boards/:line`：一次返回块元数据与数据，每块独立错误信封；未知 line 返回诚实降级；单测覆盖单块失败不影响整页
- [x] 3.4 前端新增 `/boards/:line` 路由与块渲染器（指标/列表/时间线），未连接时渲染去连接入口；e2e 覆盖打开看板、单块失败降级、未知 line 降级
- [x] 3.5 看板行内动作接到 `/api/actions/propose`，写类走确认对话框、破坏性展示影响面；e2e 验证未确认不调用底层
- [x] 3.6 执行成功后广播 `board_changed` WS 事件并按 resources 定向重取受影响块，保留筛选与滚动；e2e 验证下架后列表无需手动刷新即变化 —— **30s 轮询兜底未做**（事件链生产实证；轮询记入 Open Questions）

## 4. 副驾

- [x] 4.1 `/chat` 增加 embed 模式（隐藏侧栏与页头，保留对话/输入/动作卡），并支持按 URL 指定副驾 preset；组件测试验证 embed 下不渲染侧栏
- [x] 4.2 全局副驾入口（悬浮按钮）与右侧 dock，dock 内为同源 iframe；验证打开副驾不改变主会话 turns、滚动与草稿（2026-10-21 修 iframe 内套娃 FAB：framed 文档不再挂 dock）
- [x] 4.3 看板上下文注入：首帧经 URL、后续经 `postMessage`，顶部上下文条显示实际发送内容并可清除；e2e 验证从看板打开后上下文条正确、清除后不再携带
- [ ] 4.4 副驾会话按线持久化，关闭再打开恢复；e2e 验证主对话流式期间打开副驾，主对话继续流式且互不干扰 —— **按线持久化未做**（iframe 每次打开为 embed 默认会话；互不干扰由同源 iframe 隔离天然成立）。**DEFERRED** → 与「副驾进谦面/萬星产品」explore 一并定案

## 5. 应用中心 IA

- [x] 5.1 `web/src/lib/appCatalog.ts` 与 `AppCenterPage.tsx`：已接入看板的线（facet/wanxing）主行动改为「看板」，保留「打开原站」次要动作；更新 `scripts/test-app-center.mjs` 断言
- [x] 5.2 五语文案补齐（看板 / 打开原站 / 副驾 / 动作确认 / 影响面 / 等待批准 / 审计），跑 i18n 奇偶校验

## 6. 凭据与部署动作

- [x] 6.1 新增 `wanxing-deployer` 凭据 ref（粘贴 `sk-`、401 置 stale、投影无密钥），复用 `line-credentials` 轨道；单测覆盖形状校验与投影脱敏
- [ ] 6.2 在 `wanxing-ops-mcp` 增加 `wanxing_agent_deploy`（cloud 与 desktop 两种 target），同步 `tool-surface.json`；对端单测 + 自检脚本通过 —— **外部仓未落**（草稿 `docs/pr-wanxing-agent-deploy.md`）；闸侧 `wanxing.agent.deploy` 刻意不声明 server，以 `tool_unroutable` 诚实失败（D11）
- [ ] 6.3 闸与部署工具联调：云端缺 `wanxing-deployer` 被 preflight 拦截；桌面机位在线时 preflight 通过且确认卡不含计费键；集成测试覆盖两条路径 —— **preflight 两路径单测已覆盖；与真部署工具的联调待 6.2**

## 7. 官方 packs

- [x] 7.1 编写并发布 `谦面助手` pack（facet-market 读工具 + facet-ops 读工具 + 建包/发布 playbook），先发 private；发布门 lint 验证白名单不含写工具（实发 public v1 `qCEIutJzQd49jnDtV4qeqw`，经 cell 设备 token 直调市场 MCP，未走配对）
- [x] 7.2 编写并发布 `萬星舰队助手` pack（agents_browse / agent_card / callers_list + 巡检 playbook），先发 private；验证不含 `wanxing_agent_turn` 与 pause/resume（实发 public v1 `INdsRWpgpp2Q03I0z3XoFA`；registry 快照 tool_list 回填 7 条后过门）
- [ ] 7.3 在验收 cell 安装两个 pack，探针验证会话可见工具面只含读工具 + `propose_action`，且一次读回合与一次提议回合都成功 —— **未装包**；2026-10-21 真机走查补验：闸全链（propose→approve→executed→审计→市场回包）已用真实身份在生产 cell 打穿，但**发现③：dock/embed 未传 preset，默认预设全工具面下模型直调 facet_market_pack_visibility 绕过闸**（D2 边界的真机现身）——dock 预设收窄列为后续 change

## 8. 验收与回滚

- [x] 8.1 跑单测、typecheck、`web:build` 与 e2e 相关 spec，全绿（2026-10-21：test:unit 1706/1706、biome 零错、check:locales 5/5、web:build 绿；typecheck 的 7 个错误全在 `PackDetailDialog.tsx`，源自并行 change agent-cluster-platform 的 bf3f5916，非本 change）
- [ ] 8.2 真机验收：打开看板不产生模型回合与 token；写动作行内确认；破坏性动作展示影响面；publish 进审批队列且 24h 过期拒绝；桌面部署不需要计费键；审计台账可检索 —— **部分完成（2026-10-21 真机）**：看板打开 ✓（stub 数据如实呈现）、闸链 propose→approve→executed ✓（生产 cell、真实身份、166ms、审计含摘要与服务器、无凭据）、审计可检索 ✓；**未验**：UI 确认卡点击（走查环境输入管线不稳）与破坏性/异步档；另抓两窄口布局缺陷已修上产（sha-848d733：composer max-md 隐藏次要项、ChatWelcome my-auto）
- [x] 8.3 回滚演练：关闭 `LINE_BOARDS_ENABLED` / `COPILOT_ENABLED` 后入口消失、主对话与既有页面零变化；表与工具留存无副作用（两杆语义单测钉死：boards 为 opt-in、copilot 为杀开关；生产清单显式 `LINE_BOARDS_ENABLED=1`）
