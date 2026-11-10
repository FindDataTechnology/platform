# agent-fleet-cockpit-projection Specification

## Purpose

萬星半边的舰队投影：cell 把主人视角下的全部舰队快照压缩为一个有界聚合端点
（`GET /api/fleets/overview`），网关的 fleet-cells 采样器经身份信道取样并
relay 到观察板（OpsView）——远端一面镜子就能看见每支团队此刻的运转
（健康六态分布、待拍板题面、各岗最新报数一行）。纯读投影，不另造状态机：
全部语义复用驾驶舱的既有派生，硬界截断保证 payload 恒定。

## Requirements

### Requirement: 壹座提供有界的舰队投影聚合端点

壹座 cell SHALL 提供 `GET /api/fleets/overview`，一次调用返回归属本舱主（或 admin）视角下全部舰队的紧凑投影：state、健康计数（onDuty/paused/missing/vacant/passive/failing）、待拍板计数与最多 3 条题面（题面 ≤80 字、含 severity 与 policy 过期时刻）、各岗最新报数一行（at/source/摘要 ≤120 字、指标 ≤4 槽）。payload SHALL 硬界：至多 50 支舰队，且带 `v`（版本，v:1）与 `sampledAt`。非本舱主且非 admin SHALL 403。读面 SHALL 复用既有派生（deriveMemberStatus/报数/拍板排序 helper），不另造排序或健康语义。

#### Scenario: 舱主全景一往返

- **WHEN** 网关以身份信道（x-forwarded-email+secret）调用 `/api/fleets/overview`
- **THEN** 单往返回该舱主全部舰队的 compact 快照，含 v:1 与 sampledAt，字段界内截断

#### Scenario: 非舱主拒绝

- **WHEN** 以另一用户邮箱调用该端点
- **THEN** 403

### Requirement: 壹座 cell-sampler 沿既有缝上报舰队快照

cell fleet reporter SHALL 扩展第二路 tick：在与 `cell_stats` 相同的身份信道与容错律（失败 log-only、不重试不重放、只采活 cell）下，按独立间隔（env `FLEET_CELL_FLEETS_SAMPLE_SECS`，默认 60s，可用 `FLEET_CELL_FLEETS_ENABLE=0` 关断）调用 `/api/fleets/overview` 并为每活 cell 发一条 `cell_fleets` 事件（agent=`cell:<email>`，payload=(+1)overview 原样）。

#### Scenario: 上报新事件品种

- **WHEN** 观察面 `FLEET_INGEST_URL/TOKEN` 已配置且某 cell 存活
- **THEN** tick 内以 `cell_fleets` 品种投出该 cell 的 overview payload（同 id 每 tick 一条）

#### Scenario: 候选 cell 缺席不发

- **WHEN** 某 cell 停止或端口空
- **THEN** 不为其发事件；柏留错位性不告警不写一次错本

#### Scenario: 品种降级容错

- **WHEN** ingest 因品种未注册而 400/因网络失败
- **THEN** log-only，下 tick 再试，无重放

### Requirement: 萬星观察商店接受细胞舰队品种

fleet-observer SHALL 在 EVENT_KINDS 枚举注册 `cell_fleets`（未注册前 ingest 对它是 400——部署先位）。payload SHALL 透传存储。

#### Scenario: 新品质过闸

- **WHEN** `cell_fleets` 事件带合法四元组到达 `/ingest`
- **THEN** 201 落库非 400

### Requirement: 萬星提供细胞舰队最新快照读点

fleet-observer SHALL 提供 `GET /api/fleet/v1/cell-fleets`（ops Bearer gate 与 board 同构），以 raw kind 窗（默认 6h）逐 agent 合成「最新一份 cell_fleets 快照」；响应含每 cell 的 sampledAt 与 staleness 判定（样龄 > 3×tick→stale 标识）。

#### Scenario: 最新快照逐舱者一一立位

- **WHEN** 某 cell 在窗内发了 3 份快照、另一 cell 在 10h 前发过一份
- **THEN** 前者呈窗内最新份、后者呈其 10h 前那份并标 stale

### Requirement: 萬星控制台 OpsView 增壹座舰队镜像段

OpsView SHALL 新增「壹座舰队镜像」段，随 board 刷新周期（30s）刷新：每舰队一卡（名/状态/健康 chips/待拍板 N 件 top3/各岗 latest 一行/样龄或 stale 徽）+深链 paas `/fleets/:id`。observer 未升级（端点 404/空数据）时该段 SHALL 隐去不渲染，避免误读「下入锅」。UI SHALL 只读：不提供任何写动作。

#### Scenario: 镜像段看到活舰

- **WHEN** 一支舰队 30s 前被采样
- **THEN** 段内卡片呈其健康 chips 与「待拍板 N 件」的敞题面

#### Scenario: observer 缺席段隐去

- **WHEN** `/api/fleet/v1/cell-fleets` 不存在
- **THEN** OpsView 不渲染该段（同短期执行段降级律）

#### Scenario: 深链回壹座

- **WHEN** 主人点舰队卡深链
- **THEN** 打开 paas 驾驶舱原页对应舰队（动作一律在该页完成，镜像面保持只读）
