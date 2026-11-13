# Design: layout-configuration

## D1 — 注册表落点与形状

注册表放 `packages/core`（web 与 server 共用；解析在服务端，渲染在客户端）。条目形状最小化：`{ container, slug, i18nKey, icon, testId, predicates: {desktopOnly?, packMarketplace?, documentsEnabled?, adminOnly?} }`。三容器：`nav`（7 项，含 fleet.desktopOnly、apps 无谓词）、`settings`（节 slug 清单，与 `sections.ts` 现状一一对应）、`agentsTabs`（3 项，market 带 packMarketplate 谓词）。`Sidebar.tsx` 的 NAV_BASE、`sections.ts` 的清单、`AgentsPage` 的 Tab 数组全部改为注册表消费——**注册表是唯一权威，三处硬编码退役**。

## D2 — 预设 schema 与解析算法

```jsonc
{ "version": 1,
  "nav":         ["chat", "knowledge", "resources", "agents", "apps", "tasks", "fleet"],
  "settings":    ["general", "account", "wechat-app", "devices", "mcp", "websearch",
                  "models", "roles", "layout", "channels", "diagnostics", "status", "branding"],
  "agentsTabs":  ["agents", "market", "apps"] }
```

有序可见清单，缺席即该层隐藏。**解析（逐容器）**：`factory ⊕ deployment ⊕ role ⊕ user`，自顶向下收窄——每层只能从上一层的幸存集里**再隐藏或重排**，不能复活；最后套平台谓词与 adminOnly（谓词不满足/adminOnly 未命中即剔除，任何层都无法覆盖）。顺序取最具体层的相对序。部署层隐藏写独立字段 `deploymentHidden: []`（与预设选择分离，语义即"终局"）。`simple` 出厂预设：nav=[chat, knowledge, resources, agents]，settings=[general, account, wechat-app, devices]，agentsTabs=[agents, market]。

## D3 — 存储与 REST（镜像 role-system D1/D2）

- 部署层（默认预设、角色→预设映射、deploymentHidden）：托管 gateway 侧 store，本地 `deployment_config` 键；env 种子（`LAYOUT_DEFAULT_PRESET`、`LAYOUT_ROLE_PRESETS`、`LAYOUT_DEPLOYMENT_HIDDEN`），stored 胜 env。
- 用户微调：既有 `user_preferences` 表键（`layout.tweaks`，逐容器有序可见清单），随登录身份走。
- REST：`GET /api/layout/config`（admin 读部署层）、`PUT /api/layout/config`（admin 写部署层；校验预设名与 slug 合法）、`GET/PUT/DELETE /api/layout/preferences`（self，DELETE 即恢复继承布局）。`GET /api/config` 增 `resolvedLayout`（当前用户解析结果：逐容器有序 slug 清单）——**服务端一次算清，客户端零层逻辑**。

## D4 — 前端消费

- `useAppConfig.resolvedLayout` 驱动三处渲染：Sidebar 过滤+排序、SettingsDialog 分节过滤（`sections.ts` 顺序以解析结果为准）、AgentsPage 页签。
- "工作面定制"面板：侧边栏底部入口（齿轮旁），列解析后可见面，开关+拖序，写 `PUT /api/layout/preferences`；面板只显示用户可动项（部署/角色藏的不列）——终局性由服务端保证，前端只是诚实呈现。
- 预设切换即时生效：改 `resolvedLayout` 后本地 store 更新触发重渲染，无需刷新。

## D5 — 校验与降级

- 预设名未知/slug 不在注册表/容器错位 → 4xx 拒写；存量脏数据（升级路径）→ 忽略未知 slug、缺失层视为不收窄，解析永不抛错。
- `resolvedLayout` 缺失（旧客户端缓存的 config）→ 前端回落工厂预设渲染，等价于今天的硬编码。

## D6 — 测试

- 单测：解析算法全矩阵（层组合、终局、谓词、顺序、脏数据）。
- e2e：工厂基线快照（存量零改动）；simple 预设（部署默认切 simple → 导航 4 项+设置 4 节）；终局（部署藏 tasks → 用户定制面板无此开关）；用户微调持久化与恢复；非 admin PUT 布局 403。
