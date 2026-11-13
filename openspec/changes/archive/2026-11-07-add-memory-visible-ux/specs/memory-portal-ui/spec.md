# memory-portal-ui Specification（delta）

## ADDED Requirements

### Requirement: 本周节奏条

记忆面板 SHALL 在漏斗区块呈现本周节奏条：本周捕获（L0 observation 计数）、本周 note 写入数、本周更正数、待晋升数四个计数（口径=同一 visibility 读取 API 的时间窗聚合，不新增后端枚举面）；计数 SHALL 可点入并沿用既有筛选语义（落点=时间窗预置筛选）。读取失效时节奏条走既有解释性降级条款。

#### Scenario: 节奏计数可点入
- **WHEN** 用户点击「本周捕获」计数
- **THEN** 列表落到本周时间窗 + layer=L0 的筛选结果，计数与列表一致

### Requirement: 时间线叙述视图

记忆面板 SHALL 提供时间线视图：按时间倒序把回合捕获（L0，带 harness 来源徽标）与 note/L2 事实混排为单条叙述流，与既有分层浏览视图可切换；时间线 SHALL 沿用同一 visibility 读取 API 与分页语义，不另造后端面。

#### Scenario: 混排叙述
- **WHEN** 本周既有平台捕获的回合 L0 又有 agent 写的更正 note
- **THEN** 时间线按时间倒序混排两类条目，L0 条目带来源徽标

### Requirement: 智语房间记忆面板（房主）

房间页房主侧 SHALL 提供「这个房间记住了什么」折叠区：呈现房主根 `room-<id>` project 的记忆条目（走既有 entries 读取代理的 project 参数化），仅房主可见；成员与访客 SHALL NOT 见该区，房间未捕获任何记忆时呈现空态说明。读取失效走解释性降级。

#### Scenario: 房主可见房间记忆
- **WHEN** 房主打开自己房间的页面且该房间已有捕获
- **THEN** 折叠区呈现 room-<id> project 的条目（含 lane=zhiyu 来源）

#### Scenario: 成员与访客不可见
- **WHEN** 非房主成员或访客打开同一房间页
- **THEN** 无该折叠区（不渲染，非置灰）
