# Proposal: add-erp-supply-chain-gateway-proxy

## Why

ERP 纵向 REST 服务面（`fd-erp-vertical-api`）已上产为集群内 ClusterIP 服务（finddata 根 change `serve-erp-vertical-api` §2：Deployment 单副本 + PVC 事件档 + 只给 ClusterIP），但**没有任何同源入口**：小程序页面集打的 `ERP_API_BASE = "/erp/supply-chain/v1"`（`paas/miniapp/src/pagesets/erp-api.ts`）在生产 origin 下无处可去。

更要紧的是**身份面**：该服务当前的 `X-ERP-Tenant` / `X-ERP-Customer|Staff|Supplier|Carrier` 是「底座登录态落地前的演示形态」——客户端填什么就信什么。一旦开公网入口，任何登录用户都能自封供应商/承运商身份读他人单据。所以入口不能只是「端口转发」，必须是一次**身份边界收口**：客户端头一律剥离，服务端按会话重新注入，无会话 fail-closed。

## What Changes

- **同源反向代理**：平台把 `/erp/supply-chain/v1/*` 原样转发到集群内 `fd-erp-vertical-api`（ClusterIP，不开 NodePort）。路径不重写、请求体按原始字节转发（该前缀在全局 body parser 之前被跳过，避免重新序列化丢字节）。
- **身份头纪律（本单核心）**：
  1. 客户端送来的所有 `X-ERP-*` **一律剥离**，不转发；
  2. 服务端注入 `X-ERP-Tenant`（部署级常量 `ERP_TENANT_ID`）+ 该会话在绑定表里的角色标识；
  3. **无会话 → 401 `AUTH_REQUIRED`**，不做匿名兜底；
  4. 未绑定角色 = **不注入**（服务侧如实 401/404），不猜身份。SE 的 `X-ERP-Staff` 取会话账号本身（业务员就是登录人）；UE/SP/CP 的客户/供应商/承运商是**组织**，只认绑定表（`<data_dir>/erp-identities.json`），另留单客户演示开关 `ERP_DEFAULT_CUSTOMER`。
- **挂载顺序**：代理必须早于静态 SPA 兜底（否则 `GET /erp/...` 会被前端 fallback 抢走返回 `index.html`），且自带会话闸（全局闸对非 `/api` 前缀的 GET 判为公开，不能依赖它）。
- **统一错误壳**：代理自身错误也用服务侧同一封闭集形状（`{ok:false,error:{code,message,hint,detail}}`），上游不可达 502 `UPSTREAM_UNREACHABLE`、超时 504 `UPSTREAM_TIMEOUT`。

## Capabilities

### New Capabilities

- `erp-gateway-proxy`：ERP 服务面的同源入口契约——前缀转发、身份头剥离与服务端注入、无会话 fail-closed、未绑定角色不注入、统一错误壳与挂载顺序约束。

### Modified Capabilities

（无——既有 `miniprogram-client` / `mp-*` 行为不变；本单只新增一条 `/erp/*` 入口。）

## Impact

- **`paas/server.js`**：body parser 跳过 `/erp/` 前缀；在 `registerMiscRoutes`（静态兜底）之前挂 `registerErpProxyRoutes(ctx)`。
- **`paas/server/routes/erp-proxy.js`**（新）：代理实现 + 身份表加载 + 注入解析。
- **`paas/scripts/test-erp-proxy.mjs`**（新）：9 例单测（剥离/注入/401/原始字节/上游故障/开关）。
- **部署侧配置**（带外 env）：`ERP_API_UPSTREAM`（默认集群内 Service）、`ERP_TENANT_ID`（默认 `acme`）、可选 `ERP_IDENTITY_BINDINGS_FILE` / `ERP_DEFAULT_CUSTOMER`、应急开关 `ERP_API_PROXY_ENABLED=0`。
- **不触碰**：其它会话在改的 `lib/pack-manifest.js` / `pack-store.js` / `dsh-profile.js`（`add-connector-bindings`）、`server/routes/misc.js`、`extensions.js`。
- **验证**：`node --test scripts/test-erp-proxy.mjs` 9/9；`biome check` 干净；上产验收按 finddata `serve-erp-vertical-api` 3.2 的五条负向用例（伪造身份不生效 / 无 cookie 401 / 未授权 grant 403 / 501 如实 / 带会话 200）。
