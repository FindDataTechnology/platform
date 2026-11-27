# erp-gateway-proxy Specification

## Purpose
ERP 纵向 REST 服务面（`/erp/supply-chain/v1/*`）在平台 origin 下的同源入口契约。该服务以「一进程一租户」形态独立部署、只暴露集群内 ClusterIP，身份头此前为客户端自带（演示形态）；本能力把入口收敛为**服务端授信**：转发前缀不变、客户端身份头一律剥离、服务端按会话注入、无会话 fail-closed、未绑定角色不注入。

## Requirements

### Requirement: 同源前缀转发

平台 SHALL 把 `/erp/supply-chain/v1/*` 的全部方法（GET/POST/PUT/DELETE，含查询串）转发到**该会话租户对应的**上游服务，**路径与请求体保持原样**：不做路径前缀重写，请求体按原始字节转发（该前缀在全局 JSON body parser 之前被跳过）。代理 SHALL 挂在**持有平台 origin 端口的那个进程**里，并早于该进程的静态资源与 SPA 深链兜底。

上游 SHALL 按租户解析：命中该租户的配置则发往它，否则回落到部署缺省上游（`ERP_API_UPSTREAM`）。**该租户无对应上游且无缺省时 MUST 拒绝（503 `UPSTREAM_NOT_CONFIGURED`）并点名该租户**，MUST NOT 回落到别的租户的上游——那会把 A 的单据发给 B 的实例。上游选择与租户解析 SHALL 同源（同一个解析结果），MUST NOT 出现「身份头写租户 A、请求发给租户 B 的实例」。

#### Scenario: GET 页面集清单

- **WHEN** 已登录用户请求 `GET /erp/supply-chain/v1/pagesets`
- **THEN** 平台把该请求原样转发到上游，并把上游状态码与响应体返回给客户端

#### Scenario: POST 请求体原样到达

- **WHEN** 客户端 `POST /erp/supply-chain/v1/ue/cart/lines?x=1` 携带 JSON 请求体
- **THEN** 上游收到的路径仍含完整前缀与查询串，且请求体字节与客户端发送的一致

#### Scenario: 未命中的前端路由不被抢占

- **WHEN** 浏览器直接访问一个 `/erp/supply-chain/v1/...` 路径
- **THEN** 该请求由代理处理，MUST NOT 返回前端 `index.html`

#### Scenario: 挂错进程即视为未实现

- **WHEN** 部署以多租户网关形态运行（origin 端口由网关进程持有，业务进程只是其派生的 cell 子进程）
- **THEN** 代理 MUST 挂在该网关进程内；仅挂在 cell 进程内不构成实现（首轮上产实测：`/erp/*` 返回 SPA `index.html` 1298 字节、POST 302）

#### Scenario: 两个租户各发各的上游

- **WHEN** 会话 A 绑定租户 `a`、会话 B 绑定租户 `b`，且部署为该两个租户各配了一个上游
- **THEN** A 的请求发往 a 的上游、B 的请求发往 b 的上游
- **THEN** 任一租户的请求 MUST NOT 到达另一个租户的上游实例

#### Scenario: 只配了一份上游时行为不变

- **WHEN** 部署没有按租户配上游，只设了 `ERP_API_UPSTREAM`
- **THEN** 所有租户的请求都发往那一份，行为与本次变更前逐字节相同

#### Scenario: 该租户没配上游就拒绝，不借用别人的

- **WHEN** 某租户既没有自己的上游配置，部署也没有缺省上游
- **THEN** 请求被拒绝并返回 503 `UPSTREAM_NOT_CONFIGURED`，消息点名该租户
- **THEN** 请求 MUST NOT 被发往任何其它租户的上游

### Requirement: 身份头剥离与服务端注入

代理 SHALL 丢弃客户端送来的全部 `X-ERP-*` 请求头（`X-ERP-Tenant`、`X-ERP-Customer`、`X-ERP-Staff`、`X-ERP-Supplier`、`X-ERP-Carrier`），MUST NOT 转发给上游；并根据平台会话重新注入：

- **租户** SHALL 按会话解析，MUST NOT 取进程级全局值作为唯一来源。解析顺序：会话绑定表（归一化小写邮箱 → 租户标识）→ 部署级缺省（`ERP_TENANT_ID`）。两者皆无时 MUST 拒绝请求并说明缺少哪一项，MUST NOT 以空租户或猜测值放行。
- **`X-ERP-Staff`** 取会话账号（可用绑定表覆盖）。
- **客户/供应商/承运商** 只认绑定表（`ERP_IDENTITY_BINDINGS_FILE`），单客户演示形态可另设 `ERP_DEFAULT_CUSTOMER`。

未绑定某角色 = 不注入该头 = 服务侧如实 401/404。

#### Scenario: 伪造供应商身份不生效

- **WHEN** 已登录用户带着自填的 `X-ERP-Supplier: evil-supplier` 请求任一接口
- **THEN** 上游收到的请求中不存在 `x-erp-supplier`（或仅存在绑定表为该会话解析出的值），伪造值 MUST NOT 到达上游

#### Scenario: 改名租户头被覆盖

- **WHEN** 客户端带 `X-ERP-Tenant: other-tenant` 请求
- **THEN** 上游收到的租户头是服务端按会话解析出的值，客户端的值 MUST NOT 生效

#### Scenario: 伪造租户身份不生效

- **WHEN** 已登录用户带着自填的 `X-ERP-Tenant: other-tenant` 请求任一接口
- **THEN** 上游收到的 `x-erp-tenant` 是该会话绑定的租户（或部署缺省），MUST NOT 是客户端声明的值

#### Scenario: 未绑定角色不注入

- **WHEN** 会话账号在绑定表中没有任何客户/供应商/承运商绑定
- **THEN** 对应头不被注入（服务侧如实返回 401/404），代理 MUST NOT 用猜测值兜底

#### Scenario: 绑定表损坏时 fail-closed

- **WHEN** 绑定表文件缺失或不是合法 JSON
- **THEN** 代理按空表运行（所有角色头不注入、租户回落部署缺省或拒绝），MUST NOT 因解析失败而放行猜出来的身份

#### Scenario: 两个会话得到不同租户

- **WHEN** 会话 A 的邮箱绑定租户 `a`、会话 B 的邮箱绑定 `b`，两人请求同一接口
- **THEN** 上游分别收到 `x-erp-tenant: a` 与 `x-erp-tenant: b`
- **THEN** 任一方的响应 MUST NOT 含对方的数据

#### Scenario: 会话无租户绑定时回落部署缺省

- **WHEN** 某会话的邮箱未出现在绑定表中，且部署设了 `ERP_TENANT_ID`
- **THEN** 上游收到该部署缺省租户，行为与本次变更前逐字节一致

#### Scenario: 既无绑定也无缺省则拒绝

- **WHEN** 某会话的邮箱无租户绑定，且部署未设 `ERP_TENANT_ID`
- **THEN** 请求被拒绝并说明「缺少租户绑定」，MUST NOT 以空值或默认值放行

### Requirement: 无会话 fail-closed

开启会话鉴权的部署中，缺少有效会话的 `/erp/*` 请求 SHALL 返回 401 且响应体为统一错误壳（`{ok:false,error:{code:"AUTH_REQUIRED",...}}`）；MUST NOT 匿名兜底、MUST NOT 把请求转给上游。该判断 MUST 在代理内独立完成（全局闸对非 `/api` 前缀的 GET 视为公开）。

#### Scenario: 无 cookie 被拦

- **WHEN** 未登录客户端 `GET /erp/supply-chain/v1/pagesets`（即使自带头 `X-ERP-Tenant`）
- **THEN** 返回 401 `AUTH_REQUIRED`，上游未收到请求

### Requirement: 上游故障如实回显

上游不可达 SHALL 返回 502 `UPSTREAM_UNREACHABLE`，超过时限 SHALL 返回 504 `UPSTREAM_TIMEOUT`，两者均使用统一错误壳；MUST NOT 返回 200 或前端页面掩盖故障。上游地址未配置 SHALL 返回 503 `UPSTREAM_NOT_CONFIGURED`。

#### Scenario: 上游 Pod 未就绪

- **WHEN** ERP 服务实例不可达
- **THEN** 客户端收到 502 与 `UPSTREAM_UNREACHABLE` 错误码（而非空响应或成功态）

### Requirement: 可显式关闭与可观测

代理 SHALL 支持 `ERP_API_PROXY_ENABLED=0|false` 显式不挂载（其它部署形态），缺省挂载；代理 MUST NOT 记录或回显任何请求体内容与身份头原值到错误响应中。

#### Scenario: 开关关闭

- **WHEN** 部署设置 `ERP_API_PROXY_ENABLED=0`
- **THEN** `/erp/*` 不由代理处理（该前缀回到部署原行为）
