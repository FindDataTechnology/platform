## Context

首链实录三缺陷的定位已到行级（proposal 引）：三处修法共同点是**只动判定/注入点，不动存储、不新增边类型、不改协议**。

## Goals / Non-Goals

- Goals: 流水线舰队的移交/退回不依赖退化路径；岗位报数用对声明键；慢上游场景回合预算可调。
- Non-Goals: 不做 fanout 边的 dispatch 授权（spec 明文要求裁决岗声明派发许可）；不做 supervisor 语义改动；不新增边类型；不解决上游本身抖动（车道熔断已有 spec）；pack prompt 幂等改稿归 fleet-packs 仓。

## Decisions

### D1 handoff 成对双向授权（而非单向或环声明）

- 正向=移交：上游回合完成后接棒下游是声明意图；中途显式派活给下游是同一意图的运行期表达，应当被同一许可覆盖。
- 反向=退回：校验闸把拦截件退回建模腿是流水线的内在环节；pack 发布门禁 handoff 环，导致「declare 反向边」结构性不可用。双向授权让单条声明边承载两个方向，且不会引入未声明的环许可（成对授权只作用于该边的两端点之间）。
- 备选否决：只授正向 → 退回仍要退化路径；放开环声明 → 破坏发布门防环裁决；全对全 → 就是 supervisor，否。

### D2 槽位键注入本岗块（而非改工具 schema）

- renderSelfBlock 已有 member.kpiSlots 现成在参；加一行零协议变化。`/report` 响应补 `declaredSlots` 让错误提示闭环（agent 收到的文本里直接带正确键）。
- 不动 report_status inputSchema：键是开放 metrics 面派生值（插件可自定义槽位），schema 收紧会破坏既有包。

### D3 回合预算挂 cadence（有界钳制）

- `cadence.turnTimeoutMs`：成员节奏已是最自然的 per-post 配置面（blueprint cadence 段直通物化）。钳制 [2min, 30min]：下界防误配 0/负值把回合变瞬死，上界防一个岗位独占共享子进程半小时（mcp-integration 凭据交付硬顶按最长预算口径仍成立，30min 是声明的最坏情况）。
- 解析点在 runCronJobTurn（task 已带 sourceTag.memberId），读 member 行，读失败/越界 degrade 到默认——预算解析失败绝不影响回合启动。

## Risks / Trade-offs

- 双向授权放宽了派活面：护栏（跨舰队/自派/深度/频次）全部保留，风险限于「同舰队声明过的两岗」内部。
- declaredSlots 响应体加列：消费方是 fleet-mcp 的文本拼装，加列向后兼容。
- turnTimeoutMs 生效于所有舰队成员回合路径（节奏/委托唤醒/事件唤醒同一执行缝）：语义一致，30min 上界约束了凭据交付等待的最坏情况。

## Migration Plan

无迁移。三处行为增列，revert 即回旧口径。

## Open Questions

无。
