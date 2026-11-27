# bench-fleet-proposal-identity Specification

## Purpose

舰队岗位向知验台提交提案时，提交方身份 SHALL 来自对端认的凭据，而不是岗位在请求体里的自称。
本能力管的就是这条边界：走哪一张面、带哪一枚头、身份由谁派生、自称与令牌不符时怎么办，
以及「一台知验台只服务一支舰队」这个前提怎么被判成不变式，而不是靠人记着。

它存在的原因是两类静默故障。其一，会话面 `POST /api/d/{domain}/proposals` 的身份是 `source`
自称，岗位写什么就是什么——写错一个 ref 也照样成功，账上留下一行假的提交方。其二，机器面与
会话面同时在用、却没有任何东西记录「今天到底哪一张面在被用」，于是退役会话面的动作要么太早
（打断尚未迁移的调用方）要么永远不做（凭据永久在册）。

判据落在两处：客户端本地先校验再发（`lib/bench-proposal-client.js` 的 `assertOwnSource`，
不一致时零请求、且不自动纠偏），以及一个可重复跑的闸
（`scripts/check-bench-proposal-declaration.mjs`）把「至多一份 pack 声明该面、令牌登记行与
声明舰队一致」判成绿/红/判不出三档。判不出绝不退绿——那是这条能力唯一不能省的纪律。

## Requirements

### Requirement: 提案身份来自凭据，不来自请求体

舰队向知验台提交提案 SHALL 使用机器面 `POST {BENCH_URL}/api/v1/distribution/{domain}/proposals`，
并以 `X-Consumer-Token` 承载 `BENCH_FLEET_TOKEN`。客户端 MUST NOT 在该请求上同时发送
`x-api-key` 或 `Authorization`。

提案的提交方身份 SHALL 由对端从令牌对应的登记行派生；客户端 MUST NOT 依赖请求体里的
`source` 自称来确立身份。

#### Scenario: 只发机器面那一枚头

- **WHEN** 舰队提交一张提案
- **THEN** 该请求携带 `X-Consumer-Token`，且不含 `x-api-key` 与 `Authorization`

#### Scenario: 身份由对端派生

- **WHEN** 提交成功且对端返回该提案
- **THEN** 提案的 `submitted_by` 等于令牌所登记的那支艦队的 `fleet_ref` 加岗位后缀，
  而不是客户端在请求体里另外写的一个字符串

### Requirement: 令牌只能替自己的登记说话

客户端 MUST 在发请求之前校验 `source` 的 `fleet:` 前缀与 `BENCH_FLEET_REF` 一致；
不一致时 MUST 在本地拒绝并给出「你自己的 ref 是什么」，MUST NOT 发出请求，也 MUST NOT
自动把 `source` 改写成合并规则下的值。

#### Scenario: 自称与令牌不符时零请求

- **WHEN** `BENCH_FLEET_REF=fleet_A` 而 `source` 写的是 `fleet:fleet_B/post`
- **THEN** 调用在本地失败，错误消息包含 `fleet_A` 与被拒的 `source`，且传输层调用计数为 0

#### Scenario: 不自动纠偏

- **WHEN** 上述不一致发生
- **THEN** 客户端不把 `source` 改成 `fleet:fleet_A/…` 继续提交，而是把「岗位搞错了自己的身份」
  如实报给调用方

### Requirement: 单舰队前提必须是可判的不变式

只要本平台以单枚 `BENCH_FLEET_TOKEN` 供所有 profile 使用，系统 SHALL 保证「声明
`bench-proposal` 面的 pack 至多一份」。该保证 MUST 由一条只读判据执行，MUST NOT 只写在注释、
岗位提示词或本设计里。

判据 SHALL 在读不到 pack 声明、取不到令牌或对端不可达时报告「判不出」，MUST NOT 报告通过。

#### Scenario: 第二份 pack 声明该面时变红

- **WHEN** pack 声明快照里出现两份及以上声明 `bench-proposal` 的 pack，而它们未各自持有独立令牌
- **THEN** 判据以非零退出并点名这些 pack

#### Scenario: 判不出不退绿

- **WHEN** 判据读不到 pack 声明快照，或用令牌问不到对端
- **THEN** 退出码表示「判不出」，而不是表示「通过」

### Requirement: 失败形状沿用既有分类

客户端 SHALL 区分四类失败：缺凭据（配置类、零请求）、面未上线（对端 404 ⇒ `not_deployed`）、
身份或词表被拒（403/422 ⇒ 原样透传 detail、`retryable=false`）、对端不可用（5xx/超时 ⇒
`retryable=true`）。MUST NOT 把任一类报成成功，也 MUST NOT 把幂等命中报成新增。

#### Scenario: 404 不等于成功

- **WHEN** 机器面尚未在该环境上线，对端点名的提案路径返回 404
- **THEN** 调用失败并报 `not_deployed`，消息里点名 `BENCH_URL` 与确认动作

#### Scenario: 403 原文透传给岗位

- **WHEN** 对端因 source 前缀或登记状态返回 403
- **THEN** 返回的错误文本包含对端 detail 的原文，且标为不可重试
