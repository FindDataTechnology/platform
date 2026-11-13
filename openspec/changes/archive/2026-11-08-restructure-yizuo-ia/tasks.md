# Tasks — restructure-yizuo-ia

> 执行约定：注册表（1）是 2–8 的前置；2–8 中除 2 外互不写同一文件，可并行子代理；9 依赖 1–8；10 收口归主代理。
> 每个任务自带验证方式。`openspec validate restructure-yizuo-ia --strict` 在每个里程碑跑一次。

## 1. 注册表（单一权威，先做）

- [x] 1.1 `packages/core/src/lib/surfaces.ts`：`NAV_SURFACES` 改为 chat, knowledge, resources, memory, agents, tuning, fleets, machines, fleet(desktopOnly), tasks, apps, channels, zhiyu（新增 `tuning`、`channels`，`fleet` 的 i18nKey/icon/testid 不变）；验证：`grep` 出 13 条且顺序一致，`npm test --workspace @platform/core` 绿
- [x] 1.2 同文件：`SETTINGS_SURFACES` 改为 general, account, pairing, connections, mcp, plugins, models, roles, layout, delegation, branding, status（+`pairing` +`delegation`，−`channels` −`diagnostics`）；验证：条数 = 12 且与 `sections.ts` 的 canonical slug 集合逐项相等（1.9 的单测会钉住）
- [x] 1.3 同文件：`AGENTS_TAB_SURFACES` 改为 `market` / `mine`；`SURFACE_SLUG_ALIASES.agentsTabs` 补 `agents→mine, creations→mine, supply→market, apps→market, build→market`，`settings` 补 `devices→pairing, wechat-app→pairing, diagnostics→status`；验证：`validatePreset()` 对 `{agentsTabs:["agents","market"]}` 返回 ok 且已归一为 `["mine","market"]`
- [x] 1.4 同文件：`NAV_FAMILIES` 改为 knowledge / build / run / access 四族（成员按 3.1 的表）；验证：单测断言四族 id 顺序与成员，且 `fleets` 不在 build
- [x] 1.5 同文件：`FACTORY_PRESETS` 同步——`standard-snapshot` nav = 全部 nav slug − `blueprints`、settings = 全部 settings slug、agentsTabs = `["market","mine"]`；`simple` nav = chat/knowledge/resources/memory/agents/apps、settings = general/account/pairing/connections；验证：单测断言两个预设的完整数组内容
- [x] 1.6 新增不变式单测 `packages/core/test/surfaces-agreement.test.*`：`SETTINGS_SECTIONS` 的 canonical slug 集合 === `SETTINGS_SURFACES` 的 slug 集合；验证：故意从注册表删 `delegation` 时该测试必须变红（先红后绿各跑一次）

## 2. 路由与重定向（`web/src/App.tsx`）

- [x] 2.1 `/channels` 挂 `BotsPage`；`/bots`、`/settings/channels` 重定向到 `/channels`；验证：`/bots` 与 `/settings/channels` 都落到 `/channels` 且不残留遮罩
- [x] 2.2 `/agents` 挂合并后的市场面（`?tab=market|mine`）；`/packs` 重定向到 `/agents?tab=<同值>` 并透传 `deployCastPack=` 与其余查询参数；验证：`/packs?tab=mine&deployCastPack=X` 落到 `/agents?tab=mine&deployCastPack=X`
- [x] 2.3 `/settings/devices`、`/settings/wechat-app`、`/settings/diagnostics` 保留可达（由 alias 解析，不改 URL）；验证：三条地址各自打开 `pairing`/`pairing`/`status` 的正确 tab
- [x] 2.4 `/tuning` 保持路由不变（本次只加门，不改路径）；验证：侧边栏点入后 URL 仍是 `/tuning`
- [x] 2.5 `gTargets`/`gMap`（`g` 前缀快捷键）改用新注册表，新增 slug 自动入表；既有策略是「首字母 + 最短 slug 胜出」，因此 `g`+`c` 仍是 `/chat`、`g`+`t` 仍是 `/tasks`（`tuning` 与 `tasks` 撞首字母，按原策略让位），新增的 `/channels`、`/tuning` 不改变任何既有弦；验证：`g`+`c` 跳 `/chat` 的既有单测（`scripts/test-ui-core.mjs`）仍绿

## 3. 侧边栏呈现（`web/src/components/Sidebar.tsx`）

- [x] 3.1 家族渲染沿用 `navRender`，确认四族落位与单成员拍平；验证：`e2e/layout.spec.js` 断言渲染顺序为 对话 → 知识 → 构建 → 运行 → 自动化 → 接入
- [x] 3.2 构建家族底部渲染三条设置快捷行（工具/MCP、插件、模型），点击打开设置模态且当前工作面保持挂载；验证：点「模型」后 URL 为 `/settings/models`，关闭后回到原工作面
- [x] 3.3 快捷行跟随解析结果：设置节被隐藏则对应行不渲染；验证：用 `simple` 预设（不含插件/模型）时两行消失
- [x] 3.4 徽标/标签来源改为 i18n key（新增 `nav.tuning`、`nav.channels`），`fleet` 标签改「本机运行时」；验证：切到 en 后分别显示 Tuning / Channels / Local Runtime

## 4. 智能体市场合并（`AgentMarketPage` + `PacksPage`）

- [x] 4.1 `AgentMarketPage` 改成双 tab 外壳（`market` / `mine`），`market` 挂 `PackMarketView`、`mine` 挂 `MyPacksView` + `PackDraftsView`；验证：两个 tab 各自渲染且 `?tab=` 深链直达
- [x] 4.2 市场谓词下移到 tab：`packMarketplace === false` 时只渲染 `mine`，`/agents?tab=market` 回落首个可见 tab；验证：用 `packMarketplace:false` 的配置启动，页面无空市场壳
- [x] 4.3 保留外部 facet 市场出口与 `deployCastPack` handoff 消费逻辑；验证：`?deployCastPack=` 落地时自动打开装包面板（沿用 `hasBridgeHandoff` 用例）
- [x] 4.4 退役 `PacksPage` 的独立页面职责（组件复用，路由删除）；验证：全仓 `grep PacksPage` 只剩合并后的引用，`/packs` 仍有重定向

## 5. 调优挂门与死代码清理

- [x] 5.1 `TuningPage` 增加与其它工作面一致的 `PageShell` 顶栏（标题/副标题已存在）；验证：`/tuning` 从侧边栏进入后顶栏与 `应用`/`渠道` 视觉一致
- [x] 5.2 删除 `web/src/pages/AgentsPage.tsx`（669 行，0 引用）与随之无用的 import；验证：`grep -rn "AgentsPage" web/src` 为空，typecheck 与 lint 绿
- [x] 5.3 复核 `TuningPage` 头注释里"侧边栏入口在 workspace 家族下"的错误描述；验证：注释与实现一致（指向 build 家族）

## 6. 设置重排（`sections.ts` / `SettingsDialog` / `PairingSection` / `ConnectionsSection`）

- [x] 6.1 `sections.ts`：删 `channels` 节，加 `delegation`（管理组）、加 `pairing`（常规组，alias 指向 `devices`/`wechat-app`），`diagnostics` 并入 `status`；验证：节数 = 12，`openspec` 1.6 的单测绿
- [x] 6.2 分组标题按"分组后逐组渲染"重写（不再用 `i-1.group` 推断）；验证：管理组标题出现且仅出现一次，`delegation` 位置正确
- [x] 6.3 新建 `PairingSection.tsx`：三 tab（小程序/桌面应用/机器），复用 `WeChatAppSection` 与 `DevicesSection` 的既有内容与降级态；验证：`/settings/devices?bindcode=123456` 打开桌面应用 tab 且码被预填
- [x] 6.4 设置节内搜索：按当前 locale 的标签过滤已解析列表，无结果渲染空态行；验证：输入"模型"只剩模型节，清空恢复；搜索不得显示被布局隐藏的节
- [x] 6.5 `ConnectionsSection` 改网格：连接器绑定账本全宽置顶，其余卡片多列；每卡带状态徽标；`?panel=` 仍滚动+聚焦+高亮；验证：`?panel=ciyuan-account` 定位到该卡并高亮
- [x] 6.6 连接区筛选：过滤卡片文案，被 `?panel=` 点名的卡强制显示，带未保存输入的卡不被卸载（渲染保留提示）；验证：在词元卡输入密码后筛选到"连接器"，词元卡仍在并显示保留提示

## 7. 项目切换器（会话区顶部）

- [x] 7.1 在 Workspaces 头部加项目切换器（web 显示项目名/默认项目，desktop 显示路径），复用 `useProjectsStore` 与既有 set_workspace 新项目流程；验证：切换项目后新建会话落在该项目，历史分组不动
- [x] 7.2 读失败降级为「默认项目」且控件可用；验证：断掉 `/api/projects` 时头部仍有可点控件、无空白
- [x] 7.3 切换器与分组不得对"当前项目"给出不同答案；验证：单测或 e2e 断言头部标签与置顶分组一致

## 8. 渠道搬迁（`BotsPage`）

- [x] 8.1 `BotsPage` 从设置模态内挂载改为 nav 路由页挂载，去掉对模态 focus trap 的依赖；验证：`/channels` 可 Tab 遍历、Esc 不关闭整页
- [x] 8.2 图标网格 / 机器人卡 / webhook 复制 / QR / 凭据脱敏 / 热生效零改动；验证：`e2e/bots-surface.spec.js` 原断言全绿（仅改入口路径）

## 9. i18n 六语

- [x] 9.1 `common.json`（zh-CN/en/ja/es/fr/de 或现有六语）：新增 `nav.tuning`、`nav.channels`，改 `nav.fleet`、家族标签 `knowledge/build/run/access`、设置节 `pairing`/`delegation`、分组名；验证：六语键集合一致（缺键脚本或现有 i18n 检查绿）
- [x] 9.2 家族标签与设置快捷行文案走 i18n，不出现硬编码中文；验证：切 en 后侧边栏与设置列表无中文残留

## 10. 测试与收口

- [x] 10.1 更新 nav 结构断言：`e2e/layout.spec.js`、`e2e/nav-persistence.spec.js`、`e2e/agents-tabs.spec.js`、`e2e/app.spec.js`；验证：这四个文件全绿
- [x] 10.2 新增 e2e：无门面回归（`/tuning`、`/packs`、`/channels`、`/settings/delegation` 均可从 UI 到达）；验证：新用例绿
- [x] 10.3 新增 e2e：`/packs` 参数透传与 `deployCastPack` handoff；验证：handoff 链走通
- [x] 10.4 跑 `packages/core` 单测 + `npm run typecheck` + `npm run lint`；验证：全绿
- [x] 10.5 `openspec validate restructure-yizuo-ia --strict` 复跑；验证：valid
- [x] 10.6 web 走查（截图留档 `test-results/ia-shots/`）：1440×900 与 1024×768 下六顶层均可见、设置 12 节分组连续、连接区网格与筛选、配对三 tab、状态+追踪双 tab、项目切换合并为一行；桌面壳属独立发布面，本次未走（见 design 风险条）
- [ ] 10.7 归档前 `openspec archive restructure-yizuo-ia` 预演（非 TTY 需 `--yes`）；验证：archive 后 `openspec validate --specs --strict` 无新增红
