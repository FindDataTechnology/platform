## Context

见 `proposal.md`（Why 与 What）与本次 delta 规格（行为契约）。这里只记实现约束。

现状事实（本次勘察，均为读码所得）：

- 导航与设置**都由同一张注册表驱动**：`packages/core/src/lib/surfaces.ts` 的 `NAV_SURFACES` / `SETTINGS_SURFACES` / `AGENTS_TAB_SURFACES`，经 `resolveLayout()` 三层收窄后由服务端下发给 `useAppConfig().resolvedLayout`。侧边栏（`web/src/components/Sidebar.tsx`）与设置弹窗（`web/src/components/settings/SettingsDialog.tsx`）都**只渲染解析结果**，不自己拼列表。
- 侧边栏家族是纯呈现层：`NAV_FAMILIES`，`navRender` 在 `Sidebar.tsx` 内按"家族首个在场成员的位置"落位，单成员家族拍平成普通条目。
- 设置弹窗的节定义在 `sections.ts`（15 条），**注册表只有 14 条**，`delegation` 只存在于前者 → 弹窗永不渲染它。分组标题靠"与前一条 group 不同"推断。
- `/agents` 当前渲染 `AgentMarketPage`（市场门面 + 我的包），`pages/AgentsPage.tsx`（四区 hub）0 引用；`agentsTabs` 里的 `build/supply/creations/tuning/apps` 是死 hub 遗留。
- `/packs`、`/tuning` 只有路由没有链接；`FleetsPage/MachinesPage/FleetPage` 是三套不同层级的舰队面。
- 约束：slug 是公开 API（`layout-configuration` R1）；`e2e/layout.spec.js`、`nav-persistence.spec.js`、`agents-tabs.spec.js`、`app.spec.js` 钉了 nav 断言；`social-bot-channels` 原文明文要求渠道面必须在设置里。

## Goals / Non-Goals

**Goals**

- 每个能力只剩一个门口（市场、渠道、调优、配对），且没有"只能靠 URL"的面。
- 导航从 11 项平铺变成 6 顶层 / 4 家族，家族成员与用户心智的三层（组织/设备/运行时）对齐。
- 设置回归配置职责：12 节、分组连续、节内可搜、连接区可扫读。
- 全部改动只走注册表 + 呈现层，不动解析算法与既有路由语义。

**Non-Goals**

- 不把构建面收回壹座（Studio 仍在 facet；本次只把出口写清楚）。
- 不改三层解析链的算法、优先级、服务端下发协议。
- 不动线路由骨架、凭据模块的存储/铸造/注入、`e2e` 的业务断言（只改 nav 结构断言）。
- 不做设置弹窗的全屏化/多窗口，不改小程序命令中心与桌面壳自身导航。
- 不新增 `/boards` 索引页（看板仍从「应用」卡片进）。

## Decisions

### D1 家族是呈现层，不新增"分组"数据模型

沿用 `NAV_FAMILIES`（`packages/core`），只改成员表：`knowledge / build / run / access`。解析链、预设、绑定都不感知家族。

- 为什么：用户级布局微调（`WorkbenchPanel`）与部署级 `LayoutSection` 已经在操作 slug 集合；把家族塞进解析链会让"用户重排"和"家族顺序"打架，且要为存储预设加版本迁移。
- 替代：把家族写进 preset schema（被否，代价是 stored preset 迁移）；在客户端硬编码家族（被否，注册表是唯一权威）。

### D2 `channels` 换容器，不改 slug

渠道面从 `SETTINGS_SURFACES` 移到 `NAV_SURFACES`，slug 仍是 `channels`，路由从 `/settings/channels` 变成 `/channels`，两处旧地址重定向。

- 为什么：slug 是公开 API，且 `social-bot-channels` 的行为条款（图标网格、卡片、webhook 复制、QR、凭据脱敏、热生效）一条都不用改——只有"容器"这一句要改。
- 替代：保留设置节、在 nav 加一个跳设置的入口（被否，"设置里管对外沟通"正是本次要修的错位）。

### D3 `pairing` 是合并后的新 slug，旧的两个走 aliases

`devices` 与 `wechat-app` 共用一个 5 分钟一次性码池，合为一节三 tab（小程序 / 桌面应用 / 机器）。旧 slug 作为 alias 打开对应 tab，`?bindcode=` 保留。

- 为什么：alias 是项目既有的兼容机制（`SURFACE_SLUG_ALIASES`、`settings-surface` 已有 `skills`→`mcp` 先例），不引入新的兼容层；二维码里编码的地址（`<origin>/settings/devices?bindcode=` 与 `.../settings/wechat-app?bindcode=`）已在用户手机上，必须继续可用。
- 替代：保留两节（被否，同一码池两个门）；只留一节、另一节废弃（被否，会打断已扫码的绑定流程）。

### D4 `delegation` 进注册表，并把"注册表↔节定义双向一致"写成不变式

- 为什么：这次的根因不是"某个节没加"，而是两份清单可以各走各的。加一条单测断言（`sections.ts` 的 canonical slug 集合 === `SETTINGS_SURFACES` 的 slug 集合）比修一条数据更值。
- 同时重写分组标题规则：由"与前一条 group 不同"改为"按 group 分组后逐组渲染"，这样 `delegation` 归位（管理组）不会渲染出交错标题。

### D5 `/packs` 收进 `/agents`，`agentsTabs` 容器改用真实的两个 tab

`/agents` 的 tab 集变成 `market` / `mine`；`/packs` 连同 `?tab=`、`?deployCastPack=` 重定向到对应 tab。市场谓词从"整页"降到"市场 tab"。

- 为什么：`/packs` 今天零链接（创作/发布流程点不到），而 `/agents` 已经有"我的包"——两个面在讲同一件事。合并后既消灭无门面，也满足"一个能力一个门"。
- 替代：给 `/packs` 补一个 nav 入口（被否，导航会变 13+ 项，且市场门面重复）；把 `/agents` 整个改成市场、删 `/packs`（被否，会丢草稿/发布的深链）。

### D6 调优独立成 nav 面，不回到 `/agents` 的 tab

- 为什么：`/tuning` 的内容（技能候选审核、人格修订）是"迭代已有资产"，与"获取资产"（市场）不是同一动作；塞回市场页会重演四区 hub 的解体。
- 代价：构建家族多一个成员，家族成员从 1 个（agents）变 2 个——正好让"构建"成为真正的家族。

### D7 `connections` 改网格，排序与深链不变

连接器绑定账本（binding-first）保持全宽置顶，其余 8 张卡进网格；`?panel=<id>` 仍滚动+聚焦+高亮。节内搜索只过滤卡片，且**有未保存输入的卡不被卸载**（标"保留：有未保存输入"），被 `?panel=` 点名的卡即使在过滤中也强制显示。

- 为什么：九张卡单列长滚是这一节最大的交互成本；但凭据输入是"打字到一半不能丢"的敏感状态，过滤不能以丢输入为代价。
- 替代：把 connections 拆成三个设置节（被否，节数反弹且"连接"作为一个心智单元被拆散）；改成独立页面（被否，超出弹窗职责边界，但见 Open Questions）。

### D8 项目切换器放在会话区顶部，只影响新会话

- 为什么：`project-container` 里项目已是一等容器，但 web 上只能通过"分组标题"间接感知；升为切换器不改变"会话归属在首个镜像回合固定"的既有规则。
- 替代：新增 `/projects` 面（被否，与本次"减面"方向相反）；把项目塞进设置（被否，用户每天都要切）。

## Risks / Trade-offs

- [家族折叠状态迁移] 用户本地 `localStorage` 里存着 `["knowledge","build"]` 之类的折叠集；`fleets` 从 build 移到 run 后，旧的 build 折叠不会带到 run。→ 新家族默认展开；不做迁移（已写进 spec 场景）。
- [nav 结构 e2e 全红] `layout.spec.js` 等直接断言 tab 数量与顺序。→ 与实现同 commit 更新断言；先跑 `e2e/layout.spec.js` 单文件确认新结构，再跑全量。
- [`/packs` 深链语义丢失] facet studio 的 `deployCastPack=` handoff 参数必须原样透传，否则"部署后装包"链断。→ 重定向实现按参数白名单透传并补 e2e（已有 handoff 用例可扩）。
- [`channels` 换容器后老书签] `/settings/channels` 与 `/bots` 两条都要重定向；`BotsPage` 目前在设置里由 `SettingsDialog` 挂载，搬家时要确认它不再依赖模态的 focus trap。→ 走 nav 路由挂载 + 单独 e2e。
- [设置搜索与深链冲突] 过滤态下点深链可能看不到目标节。→ spec 已规定"被点名节强制显示 + 保留查询串 + 一键清除"。
- [注册表单测基线漂移] `packages/core` 的 surfaces 单测断言了容器成员与预设内容。→ 与注册表改动同批更新，作为"双向一致"不变式的落点。
- [范围] 本次只做布局与交互，用户可能期望"交互也重做"（聊天区、产物区）。→ 明确 Non-Goals；如需，另开 change。
- [短视口的导航容量] 13 个入口 + 4 家族 + 3 条快捷行约需 550px；1440×900、1024×768 下无法与会话区同时完全展开。取舍：**家族保持默认展开**（默认折叠会重新制造"看不见的面"，正是本单要修的病），导航区自限 52% 高度并独立滚动（带 thin scrollbar / overscroll-contain）。真机截图确认六顶层在 1440×900 与 1024×768 均可见，家族成员需滚动。若后续要"一眼全见"，正解是默认折叠 + 显式"展开全部"，需另行拍板。
- [会话区被挤压的回归] 首版把导航设为无上限增长，`flex-1` 的会话区基数 0 被压到 0，会话行落到页脚下方、点击被劫持（`sidebar-workspaces` 3 条 e2e 实证）。→ 导航 `max-h-[52%]` + 会话区 `overflow-hidden`，修复后 6/6 绿。
- [连接卡状态徽标] 原规格要求网格里每卡再加一枚状态徽标；实现改为**沿用各卡自带的行内状态**（面板内部即状态唯一来源），规格已同步改写——重复徽标会与行内状态形成第二处真相。

## Migration Plan

1. 注册表先行（`surfaces.ts`）：容器成员、家族、预设、aliases 一次改完，跑 `packages/core` 单测与 `openspec validate --strict`。
2. 路由与重定向（`App.tsx`）：新 slug 挂载、旧地址重定向、`/packs` 参数透传；此时 nav 仍渲染旧列表也不会崩（未知 slug 被忽略）。
3. 呈现层（`Sidebar.tsx`）：家族渲染、设置快捷行、项目切换器。
4. 设置（`sections.ts` + `SettingsDialog` + 新 `PairingSection` + `ConnectionsSection` 网格 + 搜索）。
5. 清理：删 `pages/AgentsPage.tsx`；`TuningPage` 挂进 nav；`PacksPage` 并入市场面后退役。
6. e2e 与 i18n 同批更新；六语词条以 zh-CN 为源。

回滚：注册表与呈现层同 commit（单点回滚）；服务端下发的 `resolvedLayout` 是白名单式窄化，回滚后旧客户端仍只渲染它认识的 slug，未知 slug 被忽略，不会白屏。

## Open Questions

- `connections` 长期是否该从弹窗升级为独立「连接」页（9 个模块已是页面体量）？本次只做网格 + 搜索，升级留待观察使用数据后再定。
- 设置弹窗宽度（`max-w-4xl`）是否随网格放宽：先按现有宽度做响应式列数，真实截图走查后再调。
