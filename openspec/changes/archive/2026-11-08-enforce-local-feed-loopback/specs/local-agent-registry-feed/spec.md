## MODIFIED Requirements

### Requirement: 本机 feed 端点形状与鉴权

cell SHALL 在回环地址上透出 registry 兼容读面：`GET /api/agents?limit&offset` 返回
`{ agents, total_count, has_next }`（分页语义与 agent-runner 的 `registry.js`
消费一致——`has_next=true` 时客户端续页，`false` 为止），以及 agent card 与 skill
body 的既有 GET 端点形状。feed SHALL 校验 `Authorization: Bearer <本机令牌>`：
令牌由 first-run 幂等 mint（与机位 seat id 同批）、存 settings 注入 runner 子进程，
不引入新凭据类型、不上报任何云端。令牌不正 SHALL 返回 401。

鉴权 SHALL 按令牌是否存在分两档，且两档都不得把读面放到回环之外：

- 令牌已 mint：任意来源的请求 SHALL 携带该令牌，缺失或不符 SHALL 返回 401。
- 令牌未 mint（从未 first-run 的 dev/headless cell）：feed SHALL 只对回环来源
  （`127.0.0.1`/`::1`/`::ffff:127.0.0.1`）放行，非回环来源 SHALL 返回 401；
  cell SHALL 在启动日志中点名这一开放档，而不是沉默。

地址判据 SHALL 在 feed 路由内部执行，因为 auth 门对该前缀整体豁免（路由自称鉴权）
——把边界挂在 `HOST` 的绑定值上不算实现，容器以 `0.0.0.0` 绑定时会把本机 roster
（pack 身份、seat 标、每 agent 拓扑）零凭据地透给整个 pod 网络。

#### Scenario: runner 客户端逐页读全编目

- **WHEN** 本机部署条目超过单页 limit
- **THEN** feed 按 `total_count`/`has_next` 正确分页，agent-runner 的多页循环能读全，无尾部静默截断

#### Scenario: 无令牌请求被拒

- **WHEN** 不带或带错 Bearer 令牌请求 feed 任意端点，且该 cell 已 mint 令牌
- **THEN** 返回 401，且 feed 只绑定 127.0.0.1

#### Scenario: 未 mint 令牌时只开放回环

- **WHEN** cell 从未 mint 令牌（dev/headless）且请求来自非回环地址
- **THEN** feed SHALL 返回 401，且启动日志已点名该开放档
- **AND** 同一 cell 的回环调用（`127.0.0.1`/`::1`/`::ffff:127.0.0.1`）SHALL 正常放行
