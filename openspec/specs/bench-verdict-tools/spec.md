# bench-verdict-tools Specification

## Purpose
壹座侧访问知验台评测结论台账的只读工具与回写身份扩展：让主人和舰队读到「这次评测是什么、跟谁比、判成什么」，并把本地的「未评测」词汇统一到知验台的三态结局上。工具只读、不重算判定，`provisional` 由对端给出。

## Requirements

### Requirement: 三个只读工具与既有提案工具同源

系统 SHALL 在承载 `bench_proposal_submit` 的同一个 stdio MCP 服务器上提供三个只读工具：`bench_verdict_list`（按对象/门/结局筛选，返回结论摘要）、`bench_verdict_get`（取一条结论的逐条判据与原件引用）、`bench_ruler_list`（列出某域可用尺子及其 digest）。

工具 SHALL 复用同一套凭据（`BENCH_URL` / `BENCH_CONSUMER_TOKEN`）与同一套脱敏纪律，MUST NOT 新建第二个 MCP 入口或第二份凭据解析。缺凭据时 SHALL 启动不崩、调用时结构化报错并指名缺失的环境变量，MUST NOT 静默返回空结果。

#### Scenario: 列出对象结论

- **WHEN** 岗位以某对象地址调用 `bench_verdict_list`
- **THEN** 返回该对象的结论摘要（结局、门、尺子 digest、产生时间、`provisional`、基线引用），按时间倒序

#### Scenario: 缺凭据结构化报错

- **WHEN** `BENCH_CONSUMER_TOKEN` 未设置而调用任一读工具
- **THEN** 返回指名该环境变量的结构化错误，不返回空列表

#### Scenario: 对端未上线如实报错

- **WHEN** 对端返回 404（该读面尚未部署）
- **THEN** 工具如实报「该面未上线」，MUST NOT 当成「没有结论」的空列表

### Requirement: 三态结局原样透传，不在本地重算

工具 SHALL 原样返回对端的 `outcome`（`pass` / `fail` / `inconclusive`）与 `provisional` 标记。系统 MUST NOT 在本地重算判官可信度、MUST NOT 把 `inconclusive` 折叠成失败或通过、MUST NOT 用「未评测」等自造词汇替代三态。

`inconclusive` SHALL 在任何呈现面上与 `fail` 分列。

#### Scenario: 无结论不被当成失败

- **WHEN** 对端返回 `outcome="inconclusive"`
- **THEN** 工具与呈现面均标注为「无结论」并与失败分列

#### Scenario: provisional 由对端给

- **WHEN** 对端返回 `provisional=true`
- **THEN** 工具原样透传，本地校准库与配置不参与该判定

### Requirement: 回写通道携带结论身份

`bench_run_report` SHALL 接受可选的身份字段 `ruler_kind` / `ruler_key` / `ruler_digest` / `gate` / `outcome`。提供这些字段时 SHALL 把本次运行落成一条完整评测结论；不提供时行为 SHALL 与本次变更前逐字节一致。

`gate` SHALL 只接受 `no-worse` / `regression` / `all-pass` / `calibrated`，`outcome` SHALL 只接受 `pass` / `fail` / `inconclusive`；未知值 SHALL 被拒绝并列出闭集，MUST NOT 静默收下。

#### Scenario: 带身份的运行成为结论

- **WHEN** 一次运行回写携带尺子 digest、门与结局
- **THEN** 该运行在知验台落成一条可查询的结论

#### Scenario: 旧调用方零变化

- **WHEN** 一个既有调用方按旧签名回写（不传新字段）
- **THEN** 行为与本次变更前逐字节一致

#### Scenario: 未知门被拒

- **WHEN** 调用方传 `gate="better-than"`
- **THEN** 工具拒绝并列出四道门的合法取值

### Requirement: 记分卡读面是纯读

系统 SHALL 在调优面提供「对象记分卡」读区：呈现当前账号可见对象的最新结论、与基线的差、晋升资格与 `provisional` 明示。

打开该读区 MUST NOT 触发任何评测执行、MUST NOT 写入对端台账。无可见对象时 SHALL 呈现诚实空态并给出通往下一步的真实入口，MUST NOT 用「一切正常」代替。

#### Scenario: 打开记分卡不触发评测

- **WHEN** 主人打开调优面的记分卡区
- **THEN** 只发出读请求，对端无新增评测运行

#### Scenario: 零对象诚实空态

- **WHEN** 当前账号没有任何可评测对象
- **THEN** 呈现空态并给出可达的下一步入口，而不是一行「暂无数据」
