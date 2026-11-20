# fleet-scoped-credentials Specification

## Purpose
让「一枚凭据服务几支舰队」这件事在平台侧可判、可存、可收敛：凭据按舰队行存放
（`fleet_credentials`，`(fleet_id, kind)` 唯一），解析按「恰一支持有」决定是否下发
给舰队成员，写路径拒绝幽灵舰队、读路径单独列出孤儿行。它存在的前提是一个已经咬人的
静默故障——`envRefs` 的取值面是 `scopedEnv?.[ref] ?? process.env[ref]`，于是任何挂在
`envRefs` 上的凭据都是**平台进程级单一值**，所有舰队在机器面上是同一个身份：谁的活
都能领、回写都记在同一支名下，而「不是本舰队的活」这条拒绝永远不会发生。第二支舰队
一出现就会静默共用身份，而两侧判据全绿。本能力把身份从「进程」挪到「舰队行」，并保证
令牌不出现在任何读面（只回尾 4 位指纹）。

## Requirements

### Requirement: 舰队凭据按舰队存，不按进程存

平台 SHALL 为每支舰队按 `kind` 维护至多一枚凭据（存储与该舰队的 `fleets` 行同库），
并 SHALL 提供管理写路径（写入与轮换）在平台侧完成。凭据 MUST NOT 以「平台进程级
单一值」的形态成为多支舰队的共同身份。

#### Scenario: 同一 cell 两支舰队各持凭据

- **WHEN** 同一 cell 里舰队 A 与舰队 B 各有一条 bench 凭据行
- **THEN** 两行的 token 值可以不同，且各自能被按成员的补丁组装读到

#### Scenario: 轮换

- **WHEN** 管理写路径更新某舰队的 bench 凭据值
- **THEN** 该 cell 的 MCP 补丁按既有重写链路拿到新值，正在忙的子进程在轮界投递，
  不凭 HMR 直接换凭据

### Requirement: 凭据只发给可唯一解析的成员

按成员组装 MCP 补丁时，平台 SHALL 先把「该成员」解析到唯一舰队；解析成功且该舰队
有对应凭据行时，bench 工具行的令牌与 ref SHALL 取自凭据行。解析失败（成员归属歧义、
无凭据行、凭据行指向不存在的舰队）时，平台 MUST 让 bench 工具行在补丁里缺席，
MUST NOT 回落到任何进程级共享值，也 MUST NOT 猜一个舰队。

#### Scenario: 岗位唯一对应一支舰队

- **WHEN** worker 车道为一个 persona 组装成员补丁，该 persona 唯一对应舰队 A 的一个岗位，
  且舰队 A 有 bench 凭据行
- **THEN** 该补丁里 bench 行的 `BENCH_FLEET_TOKEN` 等于舰队 A 的凭据值，
  `BENCH_FLEET_REF` 等于舰队 A 的 fleet id

#### Scenario: 岗位归属歧义

- **WHEN** 一个 persona 名对应多支舰队的岗位，无法唯一解析
- **THEN** 该成员补丁不带任何 bench 工具行，日志点名「归属歧义，bench 缺席」

#### Scenario: 凭据行是幽灵

- **WHEN** 凭据行的 fleet_id 在 `fleets` 表里不存在
- **THEN** 该行不参与解析，bench 行缺席，且判据闸报红点名该 fleet_id

### Requirement: 共享补丁携带 bench 凭据的前提是可判的

串行车道的共享 MCP 补丁 SHALL 只在「本 cell 恰有一支持有 bench 凭据的舰队」时携带
该舰队的那一枚凭据；持有 bench 凭据的舰队 ≥2 时，共享补丁 MUST NOT 携带任何 bench 行。
能力授予按成员，不按 cell。

#### Scenario: 恰一支

- **WHEN** 本 cell 的凭据存储里只有舰队 A 一条 bench 行
- **THEN** 共享补丁的 bench 行取舰队 A 的凭据（现状等价，身份无歧义）

#### Scenario: 第二支出现

- **WHEN** 舰队 B 也建了 bench 凭据行
- **THEN** 共享补丁不再携带 bench 行；要拿 bench 能力必须走按成员的补丁（worker 车道），
  共享 child 上的会话看不到 bench 工具

### Requirement: 判据闸把存储面与舰队名册对上

平台 SHALL 有一条可重复跑的只读判据：每条凭据行指向的 fleet 必须存在于同库 `fleets` 表；
判不出（读不到库/对端不可达）按 exit 2 处理，MUST NOT 当作通过。

#### Scenario: 行删舰队留

- **WHEN** 某凭据行的 fleet_id 在 `fleets` 表无对应行（舰队被删、行没跟着删）
- **THEN** 判据报红并点名该 fleet_id

#### Scenario: 一切健康

- **WHEN** 每条凭据行都有对应舰队、每支持凭据舰队都可唯一解析到成员
- **THEN** 判据绿并打印统计（行数/可解析数/缺席原因分布）
