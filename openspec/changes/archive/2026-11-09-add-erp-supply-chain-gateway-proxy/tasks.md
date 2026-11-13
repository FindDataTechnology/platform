# tasks — add-erp-supply-chain-gateway-proxy

> 承 finddata 根 `serve-erp-vertical-api` §3。上游服务已上产（ClusterIP，无对外端口），本单只做平台侧同源入口与身份收口。

## 1. 实现

- [x] 1.1 新增 `server/routes/erp-proxy.js`：`createErpProxy`（剥离客户端 `X-ERP-*` → 按会话注入 → 无会话 401 → 原始字节转发 → 统一错误壳）＋ `loadIdentityBindings`（缺失/损坏 → 空表）＋ `resolveIdentityHeaders`（租户常量 / staff=会话账号 / 客户·供应商·承运商只认绑定表）＋ `registerErpProxyRoutes`（`ERP_API_PROXY_ENABLED=0` 可关）
- [x] 1.2 `server.js` 两处接线：①body parser 跳过 `/erp/supply-chain/v1` 前缀（否则代理只能拿到重新序列化的对象，丢字节）；②`registerErpProxyRoutes(ctx)` 挂在 `registerMiscRoutes`（静态 + SPA 深链兜底）**之前**（否则 `GET /erp/...` 被 fallback 抢走返回 index.html）
- [x] 1.3 单测 `scripts/test-erp-proxy.mjs` 十例：无会话 401 / 伪造 `X-ERP-Supplier|Carrier|Customer` 被剥离 / 改名租户头被覆盖 / staff 取会话账号 / 绑定表注入（邮箱大小写不敏感）/ 绑定表缺失与损坏 fail-closed / 未绑定角色不注入 / POST 原始字节 + 全前缀路径不重写 / 鉴权关闭不拦 / 上游不可达 502 / 开关可关 / **网关形态 resolveUser→req.user（下游 SPA 兜底不抢）** —— `node --test` **10 passed**
- [x] 1.4 `node --check`、`biome check`（gateway/index.js、server/routes/erp-proxy.js）干净
- [x] 1.5 **挂载点纠偏（首轮上产实测）**：manifest 里 platform 容器 `command: ["node","gateway/index.js"]` —— 产上 origin 端口 3100 由**网关**持有，`server.js` 只是网关派生的 cell 子进程。**3100 的监听 inode 归属 `pid=1 cmd=node gateway/index.js env=PORT=3100`**（pod 内 `/proc/*/fd` 反查），而 SPA 兜底在 `gateway/index.js:322`。首轮把代理只挂在 server.js ⇒ `GET /erp/supply-chain/v1/pagesets` 200 `text/html` 1298 字节（与 `/index.html` 逐字节相同）、POST 302。修法：`registerErpProxyRoutes` 接受可选 `resolveUser`（网关的会话只在路由里解）先落成 `req.user`，网关在 WEB_DIST 静态之前挂同一份实现；server.js 的挂载保留给自托管单进程形态。教训：**单测绿 + 镜像里有文件 ≠ 在请求路径上**，验证要打到 origin 端口本身

## 2. 部署与上产

- [x] 2.1 平台镜像出片（新 tag）并换片：`fd-infra-deploy/all-services/prod/platform.yaml`（image tag + 带外 env）
- [x] 2.2 带外 env：`ERP_API_UPSTREAM`（**实为 ClusterIP `10.43.153.194`**，不是 `<svc>.<ns>.svc.cluster.local`——网关 pod 是 `dnsPolicy: Default` 走 mesh DNS，解析不了集群服务名，实测 000）、`ERP_TENANT_ID=acme`；键值不进 git（这两项无凭证，写进 manifest 并在注释里说明理由）。Service 侧显式 `clusterIP: 10.43.153.194` 钉死，避免 ArgoCD 重排后代理静默 502
- [x] 2.3 上产验收（对应 finddata `serve-erp-vertical-api` 3.2，负向用例是硬门）：①带会话 `GET /erp/supply-chain/v1/pagesets` → **200 `ok` + 四 key**；②伪造 `X-ERP-Supplier` → 经代理 **401 “缺少供应商身份头”**（已剥离），同一伪造直连上游 **404 供应商档案不存在**（对照证明伪造本会生效）；改名租户：经代理 200（被覆盖）、直连 403 `TENANT_DENIED`；③无 cookie → **401 `AUTH_REQUIRED`**（GET/POST 皆拦）；④grant 闸 → 同镜像一次性 pod 收窄授权后 **403 `GRANT_REQUIRED` / 403 `PAGESET_FORBIDDEN`**（产上授权表全量授权走不到，故用收窄 pod 验同一张闸，探针已删）；⑤`se/leads` → **501 `NOT_IMPLEMENTED`**。出片链路：快照 `d546bfd` → hkccr → relay `OK law-bench/platform:sha-d546bfd` → ccr digest `sha256:857e33d0` → platform/facet 双滚 1/1。**出片两个坑**：私源→公开仓被 `fd-build-snapshot` 正当拒绝（须走 `make-public-snapshot`）；快照不携带 `image-publish.yml`，`--init` 后不手工拷回就只跑 build-check、**不出片**（DEPLOY.md 早有记载，本次仍踩）

## 3. 归档前门

- [ ] 3.1 `openspec validate add-erp-supply-chain-gateway-proxy --strict` 绿
- [ ] 3.2 归档时把 `erp-gateway-proxy` 能力合入 `openspec/specs/`
