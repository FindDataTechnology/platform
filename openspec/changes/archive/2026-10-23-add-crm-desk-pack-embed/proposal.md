## Why

CRM 客服台 agent 桥（add-crm-desk-bridge）已在生产验证通过，finddata 根 change `crm-board-adoption` 的 B 面（任务 6.1 pack 化 / 6.3 嵌入）按计划启动：把「CRM 客服套件」以 pack 形态上谦面市场，让商家自带 Chatwoot 凭据（BYOK）自助订阅安装到壹座运行时；并在壹座内提供客服台嵌入入口（服务端代登录注入，商家无需另记独立密码）。架构走路线 B（逐用户凭据缝）：零新基建、token 不在任何平台服务里聚合、动作闸回归「以用户自己的凭据执行」主条款——部署级共享凭据收窄为寻数 A 租户第一方回落。

## What Changes

- **chatwoot 逐用户凭据面**：连接中心新增 `chatwoot` 连接面板（粘贴 Chatwoot API token + 登录邮箱/密码[嵌入用]），保存时物化本地 stdio server 行（bundled 配置 + 逐用户凭据引用）；凭据轮换/清除联动本地行。
- **stdio env 逐用户凭据解析缝**：stdio 条目 env 值可声明解析自逐用户凭据（env 名 → credentialRef），MCP patch 组合时按 ownerEmail 从凭据库解析；无凭据 → 条目整体省略（与 requiresEnv 全缺省略同语义族）；凭据 401 失效与既有 ref 语义一致。
- **CRM 客服套件 pack**：manifest = 技能（客服接待商家变体：account_id 经 profile 发现而非钉 1 + BYOK 使用说明）+ MCP 引用 `registryName: "chatwoot"` 带 98-leaf allowTools（经既有本地绑定通道，allowTools 随绑定生效）；按 facet-pack-builder 配方上谦面市场，验证市场可搜到、订阅安装、连接→绑定激活全流程。
- **动作闸双凭据**：`crm.message.send` 声明 `credentialRef: "chatwoot"`——执行器 stdio 分支以该用户凭据注入子进程 env；无凭据用户 preflight 拦截给连接指引；无凭据的机器 owner（寻数 A 租户/自部署）回落部署 env（第一方例外收窄为显式回落，双模共存）。
- **壹座内嵌入客服台（6.3）**：应用中心商家入口 → 平台反代 desk.finddatatech.cloud → 服务端以该用户连接面凭据代登录（Chatwoot devise sign_in）注入会话，商家直达自家租户；不暴露其他租户数据。**前置事实**：devise 密码登录对 §七 账号实测 401（token 却有效），需 finddata 侧确认/重置演示账号密码后方可验收。
- **多租户隔离**：商家 = Chatwoot 独立 Account + 该账号 API token，隔离由 Chatwoot 账号作用域天然保证；建号沿用 finddata 侧 SuperAdmin 流程（试点人工）。

非目标：不做 Chatwoot 部署侧改动（fd-infra 管辖）；不做商家自助建号自动化（试点人工，运营负担记录在 B6.4）；不做企微/公众号进箱等不做清单项；不动 A 租户既有共享部署语义（回落路径保兼容）。

## Capabilities

### New Capabilities

- `crm-desk-pack`: 商家 CRM 客服套件 pack——chatwoot 连接面板与本地行物化、pack 形状（技能变体 + 98-leaf allowTools 引用）、本地绑定安装链路、多租户隔离与 BYOK 纪律。
- `crm-desk-embed`: 壹座内嵌入客服台——应用中心入口、平台反代、服务端代登录注入、租户直达与越权防护。

### Modified Capabilities

- `mcp-integration`: ADDED——stdio 条目 env 值可声明解析自逐用户凭据（credentialEnv），无凭据条目省略、401 失效联动。
- `action-gate`: MODIFIED——CRM 发送动作从「部署级共享凭据第一方例外」演进为「逐用户凭据优先 + 部署 env 显式回落」双模。
- `crm-desk-bridge`: MODIFIED——account_id 从钉 1 泛化为按租户发现（商家变体技能）；发送动作凭据语义随双模更新。

## Impact

- **代码**：`credential-refs.js`/连接中心（chatwoot ref + 物化本地行）；`dsh-profile.js` toMcpClientEntry（credentialEnv 解析）；`lib/action-registry.js`/`lib/action-executor.js`（双凭据）；pack 内容仓（技能变体 + manifest）；`skills/crm-desk-reception`（变体拆分）；应用中心 + 新反代路由（嵌入）。
- **外部协调**：finddata 侧①确认/重置 Chatwoot 演示账号密码（嵌入验收前置）②试点商家 Account 建号（B6.4 人工）。
- **spec 辐射**：pack-installation 本地绑定条款已覆盖安装链路（零 delta）；谦面市场上架走 facet-pack-builder 既有配方。
- **验收**：市场可搜→订阅安装→连接凭据→cell 组合出逐用户 chatwoot 面→草拟/发送走用户自己租户→嵌入页代登录直达自家租户、不可见他租户；证据落 change reports/，完成后回 finddata 勾 6.1/6.3。
