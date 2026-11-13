## ADDED Requirements

### Requirement: 舰队名册读面每请求只合并一次目录

舰队名册类读面（`GET /api/fleets`、`/api/fleets/overview`、`/api/fleets/owner/board`、`/api/fleets/:id`、`/:id/cockpit`，以及编排草稿校验与 apply、catalog 变更后的对账）SHALL 在同一请求（或同一对账轮次）内对合并目录取一次快照，并以该快照解析全部岗位目标；SHALL NOT 逐岗位重新合并目录。cron 任务表 SHALL 每请求列取一次并在各舰队之间复用。

合并目录的成本来自重读注册表快照、已装包清单与用户预设（生产实测单次约 30ms）。逐岗位合并使名册读成为 cell 事件循环上的秒级同步阻塞，而同一进程同时服务聊天 WebSocket，因此该阻塞会推迟会话首帧。

#### Scenario: 六十岗位的名册读只付一次合并

- **WHEN** 某舱主有 21 支舰队、60 个岗位，请求 `GET /api/fleets`
- **THEN** 该请求内的目录合并次数为 1，且不随岗位数增长

#### Scenario: 快照不改变在岗判定

- **WHEN** 同一请求内解析多个岗位的目标
- **THEN** 每个岗位的 `alive`/标签与逐岗位合并时一致（同一份目录快照）

### Requirement: 节奏周期计算按 (cron, 时区) 记忆化

`cronPeriodMs`（以及其上的 `staleWindowMs`）SHALL 对同一 `(cron, 时区)` 复用记忆化结果，SHALL NOT 每次读取重新解析表达式。实测发现这才是名册读的真凶：带时区的解析为每次解析构造时区对象并迭代（生产实测单次约 40ms，无时区 9ms），名册读对每个岗位推导容忍窗口、在岗派生再问一次，60 岗位即数秒纯日历运算——比目录合并更重。

记忆化的键 SHALL 含日期（夏令时切换次日读取即被采纳，不被进程生命周期冻结）；无时区与带时区 SHALL 是不同的键；SHALL NOT 改变返回值语义（含不可解析表达式的 null）。

#### Scenario: 同一节奏重复推导只解析一次

- **WHEN** 一支舰队的多个岗位共用同一 `cron` 与 `tz`，一次名册读为每个岗位推导容忍窗口
- **THEN** 该 `(cron, tz)` 只解析一次，其余岗位复用同一周期值

#### Scenario: 记忆化不改变判定

- **WHEN** 同一 `(cron, tz)` 在记忆化前后分别求周期
- **THEN** 两次结果相同；不可解析的表达式两次都返回 null

### Requirement: 舰队名册行携带待拍板计数

舰队名册行 SHALL 携带 `openDecisions`（该舰队 `state='open'` 的拍板条数）。侧栏角标以名册行该字段为唯一来源；缺该字段时角标永远不会出现，故服务端 SHALL 在名册读面提供。

#### Scenario: 有待拍板时名册行可见

- **WHEN** 某舰队存在 1 条 open 决策，请求 `GET /api/fleets`
- **THEN** 该舰队行的 `openDecisions` 为 1

#### Scenario: 无待拍板时为 0

- **WHEN** 某舰队没有任何 open 决策
- **THEN** 该舰队行的 `openDecisions` 为 0（不是缺字段）