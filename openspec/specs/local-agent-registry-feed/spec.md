# local-agent-registry-feed Specification

## Purpose
cell server 提供的本机 roster feed：把「已安装 pack 的 serving 声明 + 本机部署记录」
合成为 agent-runner registry 客户端已消费的条目形状透出，让本机 runner 在零公共
registry 依赖下获得编目。它是本地集群控制面的读真源——写面（deploy/stop/start/
remove）落在 cell 的舰队路由上，feed 在 runner 的轮询节拍内如实反映写结果。

## Requirements

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

### Requirement: 条目从安装态与部署记录合成

feed 的每个条目 SHALL 由 cell 从本机已安装 pack 的 manifest（serving 声明、
persona、skills、mcpServers）与该 agent 的本机部署记录合成，形状与
`lib/agent-serving.js` 写云 registry 的条目同构（protocol/packId/agentId/
persona/skills/mcpServers/runner_id/desktop_seat），保证 runner 端对云/本地条目
零分辨。条目 SHALL 打标 `runner_id=<本机 seat id>` 与 `desktop_seat=true`——本机
runner 按既有分片纪律恰好领回，云端任何 runner 永不匹配。**仅**「已安装且
`listServingAgents` 非空」的 pack 可出现在 feed；仅有部署记录而 pack 已卸载的
条目 SHALL 被剔除（挂在部署记录表上的孤儿不得透出）。

#### Scenario: 部署后节拍内可见

- **WHEN** 用户部署一个含 serving 声明的 pack agent
- **THEN** 部署记录落库后 feed 立即含该条目（不打标 enabled=false 的存活态除外），runner 下一次轮询领回并拉起运行时

#### Scenario: 卸载 pack 即摘除

- **WHEN** 用户卸载某 pack
- **THEN** 其全部条目从 feed 消失，runner 收敛对应运行时，部署记录表不留孤儿

#### Scenario: 停用保留身份

- **WHEN** 用户停用（stop）一个已部署 agent 但不移除
- **THEN** 条目从 feed 摘除、运行时排空，部署记录保留其称号与配置，重新启用（start）恢复原条目且端口/身份稳定

### Requirement: 写面与本机容量闸

cell SHALL 提供本机部署写面并在写时执行两类拒绝：(a) 不可部署——pack 未安装、
agent 无 serving 声明、或请求带外部 `runner_id`（v1 只服务本机 seat）；(b) 容量
超限——**按 runner 的运行时组计数**（spike 1.1 实测：判据是 child 进程数
`children.size < maxChildren`，pod 模式下同一 pack 的所有 agent 共宿一个 child，
solo 模式一 agent 一 child）达 `AGENT_RUNNER_MAX_CHILDREN` 时返回结构化
`capacity_exceeded`（含已用/上限/计数单位）， SHALL NOT 静默排队；写面的 used/cap
SHALL 以组为单位呈现，UI 文案须说明「1 组 = 1 个运行时进程（pod 下整包共宿）」。
同 (packId, agentId) 重复 deploy SHALL 幂等返回既有条目而非产生重复记录，
且同一 pack 的第二个 agent 部署 SHALL 不额外占用组容量（pod 已存在的组）。

#### Scenario: 容量打满如实拒（按组计）

- **WHEN** 运行时组数已达 `AGENT_RUNNER_MAX_CHILDREN`（pod 模式下同包共宿算 1 组）时再发起新组的 deploy
- **THEN** 返回 409 与 `capacity_exceeded` 结构（used/cap/unit），UI 可据此引导卸载

#### Scenario: 同包第二岗不吃组容量

- **WHEN** 一个 pack 已有运行时组，用户再部署该 pack 的第二个 agent
- **THEN** 部署成功且 used 组数不变（pod 共宿），响应指明复用了既有组

#### Scenario: 重复部署幂等

- **WHEN** 对已部署的同一 (packId, agentId) 再次 deploy
- **THEN** 返回既有部署记录，feed 与部署表各只有一份

### Requirement: 与云 registry 并存不混淆

配置 `AGENT_SERVING_REGISTRY_URL` 时 runner SHALL 继续指向外部 registry（既有行
为一个字节不变），本机 feed 仅供舰队页目录区与其他本机消费者读取；未配置时本机
feed 是 runner 的唯一编目。**BREAKING 不成立**：本能力不改变任何现存部署的
roster 来源。

#### Scenario: 外部 registry 优先生效

- **WHEN** settings 含外部 registry 配置
- **THEN** runner 注入保持外部地址，feed 不替代 roster；舰队页仍可并列展示本机部署区
