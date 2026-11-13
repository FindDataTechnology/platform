# Proposal: intent-onboarding

## Why

终态愿景的最后一环：客户进门时选感兴趣的业务角色和要办的事，系统自动配页面、绑资源（agents/MCP/packs 随包进来）。角色体系（`role-system`）与布局机制（`layout-configuration`）就位后，独缺"意图采集→装配"的入口。四个垂直包（法律×2、数据×2）就是首配方案的手工原型（ADR-0027），本 change 把它结构化并接上自动装配。

## What Changes

- **欢迎页内嵌角色问卷**：首次进入（意图档案为空且未跳过）时，欢迎态顶部呈现角色卡片选择（1-3 枚，仅列**配方就绪**的业务角色）+ 可选一句"想用它办什么"（待办注记），可跳过；与首跑引导三步曲（选专家→说需求→收成果）同节奏融合，不阻塞对话。
- **意图档案**：per-user 存储（cell 内，跟随登录身份，换设备不丢）；跳过=空档案不猜默认；部署可预置默认档案（env 兜底，客户级"我们是律所"场景）；可重开重答。
- **首配方案（recipe，ADR-0027）**：平台策展静态数据（`packages/core`），业务角色 → 首装 pack 清单 + 默认专家 + 提示卡来源 + 布局预设键。v1 就绪配方：`legal`、`stock`、`economic`；`financial`/`screenplay`/`paper` 枚举先行（admin 分配面可见）、配方跟上后再进问卷。
- **一键确认清单**：提交问卷后呈现"为你准备了…"清单，只列当前账号**准入内实际可装**的项，不可装项静默省略+清单尾注；任何缺项不中断装配；市场关闭的部署退化为"仅布局+默认专家"。
- **装配动作（服务端）**：订阅 packs（复用既有订阅/安装路径与准入校验）+ 设初始默认专家 + 主/副角色落库（布局经角色联动自动生效）。**只加不减**：装配永不自动卸载用户已有资源；幂等（重复确认不重复订阅）。
- **改主意入口**：设置→常规新增"重新选择角色"（重开问卷）；重答触发重新装配仍只加不减。

## Capabilities

### New Capabilities

- `intent-onboarding`: 问卷面、意图档案、首配方案、一键确认清单、装配动作与幂等/只加不减、部署预置与改主意路径。

### Modified Capabilities

- `chat-welcome-state`: 欢迎态在意图档案为空且未跳过时承载角色问卷面板（其余欢迎元素与提示卡跟随语义不变）。

## Impact

- **前端**：`ChatWelcome.tsx`（问卷面板）、`OnboardingTour`（第一步与问卷融合）、设置 General 分节（重开入口）、五语言 locale。
- **服务端**：`POST /api/onboarding/answers`（self，原子：写档案+授主/副角色+返回装配清单）、`POST /api/onboarding/provision`（self，执行订阅+默认专家）、`GET /api/onboarding/profile`；角色写入复用 role-system 指派存储（self 通道仅许主/副角色，永不许 admin 位）。
- **共享层**：recipe 静态数据 + 就绪角色清单进 `packages/core`。
- **依赖**：apply 顺序在 `role-system`、`layout-configuration` 之后（消费角色指派与 resolvedLayout）。
- **兼容**：已有用户（档案为空且已跳过或非首入）零感知；跳过后不再打扰（重开仅经设置入口）；存量 e2e 零改动。
