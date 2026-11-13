# add-connector-account-picker

## Why

壹座接入萬星连接器后，用户侧的凭据管理有两处结构性问题：

1. **必须手工粘贴，且只能有一个账号。** 现在用户要去连接器的「我的连接」页面铸一枚 PAT，复制，回到壹座粘贴（`connector-credentials`）。壹座侧 `user_connector_credentials` 以 email 为主键，**一个用户只能存一条凭据**——想同时用两个连接器账号（个人号 + 工作号、或不同数据源归属的不同账号）在模型上就不可能。
2. **粘贴这一步是可以省掉的。** 壹座侧已有完全同构的零粘贴先例：registry 的连接流程（`web/src/lib/registry-mint.ts`）开登录弹窗 → 轮询会话 → 在浏览器里凭会话 cookie 铸令牌 → 交后端落库。连接器侧同样有 OIDC 会话（cookie `oomol_connect_tenant_session`）与 PAT 铸造接口（`POST /api/tenant/pats`），缺的只是一个允许跨域调用的铸牌端点。

用户明确要的是**同一人的多个连接器账号，在壹座里可选**（多账号），并且**最好零操作**（免粘贴）。本 change 交付这两件事。

## What Changes

**连接器侧（open-connector-mt）**

- 新增跨域铸牌端点：`GET /api/tenant/cross-mint/probe`（会话存活探测；200 时回传登录身份的 email/displayName，供壹座自动命名）与 `POST /api/tenant/cross-mint`（铸一枚新 PAT，明文只在此响应返回一次，同时返回 PAT id 供日后吊销）。两者：
  - 校验 `Origin` 请求头是否在部署配置的允许列表内（`OOMOL_CONNECT_CROSS_MINT_ORIGINS`，逗号分隔），命中才回 `Access-Control-Allow-Origin`（回显具体 origin，不用 `*`，因为要带凭据）；非命中直接 403 且不回 CORS 头。
  - 要求已登录的 OIDC 会话（复用 `requireUser`）；未登录 401。端点**只铸不读**：不回传任何既有 token。
  - 响应带 `Vary: Origin`；预检 `OPTIONS` 单独处理；probe 虽是简单 GET 不触发预检，响应同样要带 CORS 头（否则浏览器读不到状态码）。
- 会话 cookie 增加部署开关 `OOMOL_CONNECT_CROSS_SITE_COOKIE`：开启时租户会话 cookie 用 `SameSite=None; Secure`（跨站 fetch 才带得上）。默认关闭，`TENANCY=off` 与上游行为不受影响。**开启的同时**，所有 `/api/tenant/*` 变更类请求（POST/DELETE）额外要求 `Origin` 同源或在白名单内——把 SameSite=None 顺带敞开的控制台盲打面一并关死（浏览器对非 GET/HEAD 请求必带 Origin；PAT/管理员走 Authorization 头不受影响）。
- PAT **不新增任何字段**：账号名写进既有 `name`（形如 `壹座 · <slot>`），用户在连接器 `/me` 的 PAT 列表能认出归属。fd-prod 白名单只放壹座生产域名 `https://platform.finddatatech.cloud`。

**壹座侧（paas）**

- `user_connector_credentials` 从「email 主键」重建为「(email, slot) 复合主键」（迁移 25）：一个用户可存多条连接器凭据，每条含 token、pat_id、stale、active、updatedAt。**零粘贴账号自动按连接器身份命名**（email → displayName → 「身份N」），同一身份重连即同名替换；手工粘贴路径维持用户输入名/`default`。
- 断开账号或同账号重连替换旧 token 时，壹座后端用所存 token+id 调连接器**既有** `DELETE /api/tenant/pats/:id` 做 best-effort 吊销（服务端到服务端，连接器侧零改动；粘贴路径无 id、不吊销）。
- 删除活跃账号后**不自动改选**：回到无活跃状态（connector 服务从有效 profile 省略），面板提示显式选择；「设为活跃」是独立的一键切换操作。失效（stale）账号行只提供「重连」，不提供「设为活跃」。
- 新增 API：`POST /api/connector/credential` 接受可选 `slot` 与 `patId`；`GET /api/connector/connections` 列出该用户全部连接器账号（投影不含 token）；`DELETE /api/connector/connection?slot=` 断开（含 best-effort 吊销）；`PUT /api/connector/connection/active` 切换活跃。
- 新增**零粘贴连接流**（前端）：点「连接新账号」→ 弹窗打开连接器 OIDC 登录 URL（回调必重发新 cookie，规避存量 Lax cookie 的死锁）→ 轮询 probe（200 即拿到身份并定账号名）→ 铸牌 → 交后端按 slot 落库 → 刷新 profile。全程无需用户复制粘贴，也无需用户输入账号名。
- 连接器凭据面板（`ConnectorConnectPanel`）从「单账号状态卡」改为「账号列表」：每行名称/状态/更新时间/活跃标记 + 按行操作（断开/设为活跃/重连），底部「连接新账号」；手工粘贴常驻为折叠的次级入口（浏览器环境特殊时的逃生门）。
- 六语言词条补齐。

## Capabilities

### New Capabilities

（无——本 change 的行为都落在既有能力的既有面上）

### Modified Capabilities

- `connector-credentials`: 从「每用户单份 PAT」改为「每用户多份（按账号名区分）+ 断开/替换即 best-effort 吊销 + 零粘贴跨域铸牌连接流（账号按连接器身份自动命名）」；新增跨域铸牌端点的行为契约（Origin 白名单、会话要求、一次性明文返回）。

## Impact

**连接器仓（open-connector-mt）**
- 修改：`src/server/tenancy/tenant-routes.ts`（cross-mint 两条路由 + probe 身份回显 + 变更类路由的 Origin 守卫中间件）、`src/server/tenancy/tenant-auth.ts`（会话 cookie 的 SameSite 开关）、`src/server/tenancy/constants.ts` 或 config 读取（新增两个环境变量）
- 不改：`src/providers/**`（硬约束）、上游文件保持最小触碰；PAT 存储零 schema 变更
- 安全面：新增一个跨域可调端点，是本 change 的主要风险点——必须白名单 Origin、必须要求会话、必须只铸不读；SameSite=None 的波及面由 Origin 守卫收口
- 部署：fd-prod 需要设置 `OOMOL_CONNECT_CROSS_MINT_ORIGINS=https://platform.finddatatech.cloud` 与 `OOMOL_CONNECT_CROSS_SITE_COOKIE=1`

**壹座仓（paas）**
- 修改：`db.js`（迁移 25：重建 `user_connector_credentials` 为复合主键 + pat_id 列）、`connector-credentials.js`（多账号 + 吊销）、`server/routes/connector.js`（slot/patId 参数 + 列表/切换端点）、`web/src/components/extensions/ConnectorConnectPanel.tsx`（账号列表 UI）、`web/src/hooks/useExtensionsStore.ts`、`web/src/lib/`（新增 connector-mint 模块，对齐 registry-mint）、`web/src/locales/*/common.json`（六语言）
- 迁移注意：现有单行数据平滑迁到 `slot = 'default'`、`active = 1`（不丢已连接的凭据）；迁移遗留的 `default` 行与后续零粘贴身份行**不自动合并**（生产库尚无任何粘贴用户，近乎空集）
- 不改：`credential-refs.js` 的分派形状（仍按 ref 名分派，只是 connector 的 resolver 内部支持多账号）
