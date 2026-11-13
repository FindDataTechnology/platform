# Proposal: layout-configuration

## Why

页面结构散落在三处硬编码（`Sidebar.tsx` 的 `NAV_BASE`、`settings/sections.ts` 分节注册表、`AgentsPage` 的子页签数组），无法按客户/角色/用户配置——"不同客户切换软件的整体布局"是本版点名的头牌能力（ADR-0026），也是非技术用户重排（藏技术面）与技术用户专门模块（后置）的共同机制底座。以 `role-system` 为前置：三层解析链的角色层需要业务角色存在。

## What Changes

- **统一页面注册表（surfaces registry）**：一级导航、设置分节、智能体页子页签三个容器收进单一注册表，以现有路由 slug 为键（沿用"slug 即公开 API"承诺）；平台谓词（桌面专属、市场开关、文档开关、adminOnly）从硬编码过滤迁入注册表项。
- **布局预设（versioned schema）**：按容器声明可见 slug 的有序清单；`version` 字段为将来扩作用面（聊天内面板、交互模式）留位，v1 只管显隐+排序。
- **三层解析链（ADR-0026）**：出厂预设 → 部署默认（admin 可配，**隐藏终局**）→ 业务角色预设 → 用户微调（仅显隐+排序，只能更少不能更多）。平台谓词永远优先——预设救不回谓词不满足的页面（web 上显不出舰队）。
- **出厂预设两套**：`standard-snapshot`（默认，等于今天的导航/分节/页签现状快照，存量 e2e 零改动）与 `simple`（非技术简洁骨架：导航=对话/资料库/成果/智能体，藏应用与自动化；设置只留常规组四节）。
- **部署管理面**：设置→管理组新增 `layout`（工作面布局）分节（adminOnly）：选部署默认预设、按业务角色指定预设、页面级部署隐藏开关。
- **用户微调面**：侧边栏底部新增"定制工作面"入口：在自己可见范围内做显隐与排序，存 per-user 偏好。
- **服务端解析**：解析在服务端完成（角色+部署+用户偏好都在服务端），`GET /api/config` 下发当前用户的已解析布局——终局规则在服务端可执行，不靠前端自觉。

## Capabilities

### New Capabilities

- `layout-configuration`: 页面注册表、预设 schema 与出厂预设、三层解析链与终局语义、部署管理面与用户微调面、REST 与 config 下发、无配置基线等价。

### Modified Capabilities

- `app-navigation`: 侧边栏导航从注册表+解析结果渲染（规范文本同步补齐代码现实：Apps 与 Fleet[桌面谓词] 两项）；新增"定制工作面"入口 requirement。
- `settings-surface`: 管理组新增 `layout` 分节（承接 `role-system` 已加的 `roles` 之后的清单）。
- `agent-catalog`: `/agents` 子页签集从注册表解析（Market 的 packMarketplace 门控迁为注册表平台谓词）。

## Impact

- **共享层**：注册表落 `packages/core`（web 与 server 共用；预设校验与解析在 server）。
- **前端**：`Sidebar.tsx`（NAV_BASE → 注册表消费 + 定制入口）、`settings/sections.ts`（注册表消费）、`AgentsPage`（页签解析）、`useAppConfig`（`resolvedLayout`）。
- **服务端**：布局存储双层（托管 gateway 侧 + 本地 `deployment_config`，同 role-system D1 形态）；用户微调入既有 `user_preferences`；`PUT /api/layout/config`（admin）、`GET/PUT /api/layout/preferences`（self）。
- **依赖**：apply 顺序在 `role-system` 之后（角色层解析消费其角色数据；`settings-surface` delta 的重述文本包含 `roles` 分节）。
- **兼容**：无任何布局配置时解析结果与今天的硬编码逐一相同（验收线：存量 e2e 零改动全绿）；路由 slug、testid 均不变。
