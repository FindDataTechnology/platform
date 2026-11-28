# bench-ops-tools Specification

## Purpose
TBD - created by archiving change add-bench-ops-tools. Update Purpose after archive.

## Requirements

### Requirement: 舰队能看见自己的工单

系统 SHALL 提供一个只读工具 `bench_work_order_list`，返回**本舰队在本域**的
`pending` / `in_progress` 工单，并带上对端给出的 `fleet_ref`。

该调用 MUST NOT 产生副作用：不改工单状态、不写事件、不记拉取足迹。
它 MUST NOT 返回别的舰队的工单，也 MUST NOT 返回已关闭的工单。

#### Scenario: 只看见自己的活

- **WHEN** 同域内另有一张派给别的舰队的工单
- **THEN** 本舰队的列表里没有它，且 `count` 与实际返回的条目数一致

#### Scenario: 空队列不是错误

- **WHEN** 本舰队在本域没有待办
- **THEN** 返回 `count: 0` 与空数组，且 `fleet_ref` 仍然给出（身份来自响应，不依赖是否有活）

### Requirement: 身份取自对端而不是配置

`fleet_ref` SHALL 取自 `list` 的响应；`runner_ref` SHALL 由
`fleet:<fleet_ref>/<post>#<round>` 拼出，其中 `post` 与 `round` 来自本回合的身份行。

客户端 MUST NOT 接受调用方手写 `fleet:` 前缀的 `source` / `runner_ref`。
响应缺少 `fleet_ref` 时 MUST 报错并拒绝继续，不得猜一个。

#### Scenario: 缺 fleet_ref 就停

- **WHEN** 对端返回的列表缺少 `fleet_ref`
- **THEN** 客户端抛配置类错误，且没有任何回写请求被发出

#### Scenario: post 含空白即拒

- **WHEN** 调用方给的 `post` 含空白字符
- **THEN** 客户端在发出任何请求之前就拒绝

### Requirement: 四种 4xx 处置互不混淆

客户端 SHALL 把对端的拒绝分成可区分的类别，且每类对应**不同的处置**：

- 裸 404（正文不点名域或工单）→ `not_deployed`：该面未上线。处置＝等对端滚版或改 `BENCH_URL`，
  MUST NOT 被读成「凭据不对」；
- 点名域或工单的 404 → `not_found`：请求的东西不存在；
- 403 → `forbidden`：该工单不是本舰队的，或凭据的登记不拥有该来源；
- 409 → `conflict`：别人已认领，或尚未认领就关单；
- 422/400 → `invalid`：报送体不在四态内，改内容重试；
- 5xx / 超时 / 网络 → 可重试。

语义类拒绝 MUST NOT 标记为可重试（机器重试一个需要人判断的拒绝只会放大问题）。

#### Scenario: 未上线与凭据错分开

- **WHEN** 对端对 `GET work-orders` 返回 404 且正文是泛化的 `Not Found`
- **THEN** 报 `not_deployed`，消息里给出「确认对端已滚到含机器面的片 / 确认 BENCH_URL 不是公开 pod」

#### Scenario: 别人的单子是 403 不是空列表

- **WHEN** 认领一张派给别的舰队的工单
- **THEN** 报 `forbidden` 并带对端原话，而不是返回「没有这张单」

### Requirement: 幂等命中与新增必须可区分

`claim` / `complete` / `run` 的返回值 SHALL 保留对端的 `created` 标志；
`created: false` 表示同一动作的重放（幂等命中），MUST NOT 被报告成新发生的事。

#### Scenario: 重放不冒充进展

- **WHEN** 同一 `runner_ref` 的报送被重放
- **THEN** 返回 `created: false`，工具输出说明这是「幂等命中」

### Requirement: 凭据不入日志与错误文本

客户端 MUST NOT 把 token 插入任何消息；可能携带对端回声的文本 MUST 先经脱敏。

机器面（`/api/v1/distribution/*`）MUST 只发 `X-Consumer-Token` 一条认证头，取自
`BENCH_FLEET_TOKEN`；MUST NOT 发送 `X-API-Key` 或 `Authorization`。
`BENCH_CONSUMER_TOKEN` 属提案面（`lbk_` api key 走 `X-API-Key`、Logto JWT 走 `Bearer`），
两者 MUST NOT 互相顶替，MUST NOT 设回退——用错那枚的响应是 403「未登记」，
读起来像舰队被删了，而真因是接错了面。

#### Scenario: 对端把凭据写进错误正文

- **WHEN** 对端 403 的正文里包含这枚凭据
- **THEN** 客户端抛出的错误文本里它被替换掉，逐字不再出现

#### Scenario: 只有提案面的凭据时零请求失败

- **WHEN** 环境里有 `BENCH_URL` / `BENCH_PROPOSAL_DOMAIN` / `BENCH_CONSUMER_TOKEN`，但没有 `BENCH_FLEET_TOKEN`
- **THEN** 抛配置类错误，消息点名 `BENCH_FLEET_TOKEN` 并说明两枚不可互换，
  且 MUST NOT 发出任何网络请求

#### Scenario: 形似 api key 的值也走机器面

- **WHEN** `BENCH_FLEET_TOKEN` 的值恰好以 `lbk_` 开头
- **THEN** 仍作为 `X-Consumer-Token` 发出（不按前缀分支到 `X-API-Key`）
