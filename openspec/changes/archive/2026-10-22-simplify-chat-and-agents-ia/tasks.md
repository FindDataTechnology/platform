# tasks — simplify-chat-and-agents-ia

> 任务序按 design D4：第 1 组（安装→对话直通）可独立上产、独立回滚；
> 第 2-6 组按依赖排；第 7 组整体验证。i18n 五语随各组走（zh-CN 先行）。

## 1. 核对映射 + 安装→对话带参直通（可独立上产）

- [x] 1.1 核对物化 persona preset id ↔ agent id 的映射规则：读 `catalog.js` pack source → `dsh-profile.writeCatalogAgentPresets` 写入路径，确认同一功能集角色在 preset roster 与 agent roster 中的 id 是否一致，把去重键（agent id 或 packId 关联）结论补记到 design.md 的 D6 段
- [x] 1.2 `ChatPage.tsx` 放宽 `?preset` 门至普通导航（非 `embed=copilot` 也生效）：沿用既有 set_agent + configErrorSeq 失败处理；目标 agent 不在 roster 时显示原因提示不阻断对话；参数一次消费（切换完成或明确失败后从 URL 清除）；单测/组件测试覆盖直通、卸载降级、参数清除三路径
- [x] 1.3 `PackMarketView.tsx` NextStepsFooter 带参直通：单角色功能集 → `/chat?preset=<默认角色 agentId>`；多角色集群包 → 主按钮「去对话并载入整组」，携带 lead 角色与 `cluster=<packId>` 意图，ChatPage 落地后按既有 `POST /api/clusters/dynamic` bindToSession 路径绑定并切 lead；无角色条目（纯技能包）→ 保持裸「打开对话」；facet shell（onOpenChat=null）不渲染不变
- [x] 1.4 zh-CN 文案：`packs.report.nextHint` 不再指示用户手动去「上方选择框」选人，改为直通说明；补 en/es/fr/ja 键；e2e `pack-install-next` 断言更新为带参跳转

## 2. 统一选人器（与谁对话）

- [x] 2.1 新建合并选人组件（承接 `agent-preset-picker` testid 契约）：数据源 = agent roster 主源 + preset roster 仅组合模式；按 1.1 结论去重 pack 角色；分组呈现（标准助手 / 功能集角色按功能集分组 / 我的专家）；集群元数据功能集渲染「整组载入」条目（复用 ControlStrip 现有 loadCluster 路径）
- [x] 2.2 欢迎态接入：`ChatWelcome` 用合并选人器替换 `AgentPresetPicker`；出厂组合模式默认过滤（仅 standard；layout 谓词放行钩子留接口）
- [x] 2.3 会话内接入：`ChatHeader` 标签保留只读呈现 + 打开统一选人器入口；组合模式在会话产生回合后仍不可换（dsh 约束），persona 切换沿用 set_agent/pendingConfig；流式中拒绝并显性报错
- [x] 2.4 `ControlStrip` ⋯ 菜单移除 agent 区（含 cluster load 按钮随迁）；权限/模型/思考强度/工作目录区不动
- [x] 2.5 突变测试闭环：禁用 D1 过滤 → welcome 断言红 → 复原 → 绿（补了「种入退役模式行」断言使客户端过滤可测——hermetic 服务端 roster 本就只剩 standard，不补则突变不可达）；同一角色去重由 agent-presets/agent-control 用例覆盖（角色行 data-preset-id 唯一）

## 3. 项目名词统一

- [x] 3.1 `ControlStrip` 工作目录区改「会话项目」语义：默认显示项目名（复用 sidebar-workspaces 的项目名解析，无解析时取路径末段），完整路径/路径输入/浏览收进「高级」展开；切换契约（校验/确认/重启/recents）不变
- [x] 3.2 权限 chip 文案三档口语化：仅对话 / 可读写项目文件 / 完全访问（i18n key 更新，danger-full-access 风险闸不动）
- [x] 3.3 五语补齐 + e2e 断言更新（strip-workspace 默认只见项目名、权限 chip 文案）

## 4. 智能体页 tabs 收敛

- [x] 4.1 `packages/core` `AGENTS_TAB_SURFACES` 与 `server/layout.js`：market tab 标签改「功能集」（agentsPage.market 文案）；apps slug 保留注册表、退出工厂预设 agentsTabs 序列（standard-snapshot = agents|market）；存量 stored preset 含 apps 时解析不报错、深链回落（既有行为验证）
- [x] 4.2 `AgentsPage.tsx`：移除 apps tab 渲染与 nango connect 逻辑（连接动作迁至 5.1）；`?tab=apps` 走既有回落；专家 tab 集群管理区不动
- [x] 4.3 e2e 更新：agents 页断言 2 个 tab、无 app-row；`?tab=apps` 回落断言

## 5. 应用中心承接应用条目

- [x] 5.1 `appCatalog.ts` 网格条目扩 `nango-connect` kind（归属品牌沿用前缀推断）；`AppCenterPage` AppCard 为 nango 条目渲染「连接」主行动（`POST /api/apps/:id/connect` 铸会话跳转，失败显性报错）
- [x] 5.2 e2e 更新：nango 条目连接动作 + 失败显性；原 agents 页 app 断言迁移

## 6. 功能集子 tab 合并

- [x] 6.1 `PacksPage.tsx`：三子 tab 收为 市场|我的；「我的」内分「已安装」「我的创作」两段（MyPacksView/PackDraftsView 内容为段渲染）；preset 转换 handoff（hasBridgeHandoff）落点改到「我的·我的创作」段
- [x] 6.2 i18n：`packs.tabs.*` 收敛 + 五语；e2e `packs-tab-*` 断言更新

## 7. 整体验证与收尾

- [x] 7.1 web typecheck 绿 / biome 净（改动文件）/ check-locales 5/5 / **单测 1783/1783 全绿**（layout 44/44 含工厂预设新契约 + 存量 apps 引用降级安全两新测）
- [x] 7.2 涉改 e2e 定向全绿（chat-deeplink/agent-presets/agent-control/composer-controls/workspace-picker/agents-tabs/app-center/packs/facet-shell/preset-pack-bridge/packaged-skills/focus-overlay/custom-presets/agent-serving/copilot-dock）；突变闭环（D1 拆过滤器→红→复原→绿）。全量 fast：527 过 10 红 9 未跑——10 红逐一对账为**在册基线/环境族**（full-mode-tool-scope=HEAD 同红、chat-polish 8.3=死 LLM 族 HEAD 同类红、composer-stop×2=main 固有 flaky 台账、sso/session-navigation/projects-automation/registry-connect=环境与顺序 flaky 各自单跑绿、agent-control streaming 与 focus-overlay=共享态广播竞态定向跑绿），无本刀确定性回归
- [x] 7.3 真机走查（aloadtree，2026-10-22，生产 sha-0768448）：单角色重装→CTA 直通→pending 条→自动选中「柏讯助手」→URL 消费 ✓；投研三镜头重装→整组 CTA→带头「宏观经济研究员」自动选中 ✓；会话中途换人 pending→绿+组合行中途禁用 ✓；⋯ 菜单默认只见项目名（runtime）+高级折叠 ✓；智能体页 专家|功能集 两 tab、?tab=apps 回落专家 ✓；我的=已安装+我的创作 ✓；应用中心网格全量（本部署无 nango 条目，该行为由 e2e 覆盖）✓；走查后人格还原。台账 §15.5 已记
