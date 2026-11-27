# memory-portal-ui Specification

## Purpose

人类可读的记忆浏览统一面：壹座 web 新增「记忆」面板供用户浏览自己的 owner 记忆，萬星 console 新增部署者对自部署 agent/舰队记忆根（d/）的浏览入口；两面共用同一份 visibility 读取 API、同一筛选语义与同族空态，并让「人类/AI 勘探器的标签与分层修正」从界面写回记忆。

## Requirements

### Requirement: 壹座 web 记忆面板（owner u/）

壹座 web SHALL 提供「记忆」面板（侧边导航一项），登录即落到本人 owner 范围的读取面。面板 SHALL 支持按 scope（project）/ 层（L0 观测 / L1 交接与笔记 / L2 事实与经验）/ tier（草稿草稿/成果/正典）/ tag / 时间区间筛选，列表条目 SHALL 显示类型、title、时间、layer、tier 徽章与来源摘要；reference 类条目 SHALL 渲染「在名份引用与可跳源」式样（跳资料库或成果原位），不展示文件本体。分页 SHALL 延续既有 visibility 面行为；空库 SHALL 渲染解释性空态；筛选组合无命中 SHALL 渲染解释性无命中态并保留筛选条件。

#### Scenario: 用户按 tier=正典 筛出自己的高价值记忆

- **WHEN** 用户进入记忆面板并勾选 tier=canonical
- **THEN** 只列出 canonical 条目，含 type/title/time/tier 与来源；无条时无命中态提示

### Requirement: 萬星 console 部署者记忆浏览

萬星 console（fleet/agent 相关界面）SHALL 为部署者提供浏览其自部署根（`d/<packId>/<agentId>`）记忆内容的入口，经 platform/runner 族受信 lane 调用 visibility 读面（rootKey 语义跟 fd-memory 侧现状一致）；部署者 SHALL 能用与壹座面板同族的筛选条件（scope/layer/tier/tags/time）修走记忆内容，并区分「AI 提议」与「人类确认」的 tag/tier 来源。agent 本身在此面零扩权——它经各 MCP 面访记，不因本浏览面获得 owner 级枚举。

#### Scenario: 部署者筛某 agent 的 L2 主干经验

- **WHEN** 部署者在 agent 详情入口筛 scope=<project>&layer=L2
- **THEN** 只见到该 agent 记忆根下的 fact/experience 摘要，不见其它根任何内容

### Requirement: 浏览面修正手势写回记忆

记忆浏览面 SHALL 提供 tag 与 tier 的修正手势（改、删、增 tag；升降 tier），修正动作 SHALL 以 correction note 写回 fd-memory（带 origin 与 human/AI 身份标签），并即时补齐表行。被 forget 的条目 SHALL 不再出现在任何结果，forget 动作走显式确认流，与 memory-visibility 的 forget 语义同源。

#### Scenario: 改 tag 后筛选立即生效

- **WHEN** 用户把条条目 tag 「合同」改为「章程」，随后按「章程」筛选
- **THEN** 该条目命中，且 reference 页/镜像行同步

### Requirement: 无配置优雅降级

壹座 web 与萬星 console 的记忆领域读取面失效（服务未配置或遭遇超时）时，面板 SHALL 显示可重读的解释性降级态而非空白；修正手势 SHALL 在降级态下不可用并说明原因，不得出现一步操作后立即数据回滚的假象。成果页的记忆手势 SHALL 以服务端 503（memory_unavailable）为降级判据：一旦收到即全部置灰并给出原因，任一手势成功后恢复可用。

#### Scenario: fd-memory 未接记忆面板的姿态

- **WHEN** 未配置记忆服务的部署中用户打开记忆面板
- **THEN** 展示「尚未接入记忆服务」的解释态与操作引导，列表不空转

#### Scenario: 未接记忆服务的成果页手势

- **WHEN** 未配置记忆服务的部署中用户点击成果页的记忆手势
- **THEN** 该次请求以 503 失败，三个手势随即置灰并在悬停时说明「此部署尚未接入记忆服务」，不再对后续点击弹错

### Requirement: 壹座 web 面板以蒸馏漏斗为主视图
壹座 web 记忆面板 SHALL 以蒸馏漏斗为主视图：L0/L1/L2 三层的条数与占比、tier 分布一眼可见，漏斗各段可点入并沿用既有筛选语义（落点=当前列表查询的预置筛选）；晋升提议箱（已在产的 accept/ignore 手势）SHALL 呈现为面板第一区块；条目源跳转沿用现链（跳资料库或成果原位）。漏斗 SHALL 是同一 visibility 读取 API 的展示层——不新增后端枚举面；读取失效时漏斗与列表同走既有解释性降级条款，不空转。

#### Scenario: 漏斗分段可点入
- **WHEN** 用户点击漏斗的 L2 段
- **THEN** 列表落到 layer=L2 的筛选结果，计数与漏斗段一致

#### Scenario: 晋升箱置于第一区块
- **WHEN** 存在待确认晋升提议
- **THEN** 面板首屏先见晋升箱（提议 + accept/ignore 手势），列表区在其下

#### Scenario: 漏斗读取失效同降级
- **WHEN** 记忆服务读取失败（如 memory_unavailable）
- **THEN** 漏斗渲染为解释性降级态（不空转不假数），修正/晋升手势按既有条款置灰并说明

#### Scenario: 分层占比与列表口径一致
- **WHEN** 当前筛选下 L0=30、L1=12、L2=8
- **THEN** 漏斗三段计数为 30/12/8，占比按该口径渲染，切换筛选后两区同步刷新

### Requirement: 记忆浏览的分层与节奏

记忆面板 SHALL 以分层结构呈现：持久记忆（durable）与情景记忆（episodic）分组呈现，各组有可读分组标题与层级徽章（状态词表或中性徽章），MUST NOT 以同一节奏的等高卡片瀑布穷举全部记忆；时间信息 SHALL 可扫读（时间戳分档：今日/本周/更早）；标签 MUST NOT 使用词表之外的即兴色（如紫色）。

#### Scenario: 分层可辨

- WHEN 面板同时存在持久与情景记忆
- THEN 两类记忆以分组标题分隔，且每个条目的层级徽章说明其归属

#### Scenario: 标签不越词表

- WHEN 任意记忆条目渲染标签
- THEN 标签颜色来自既有中性/状态词表，无第二强调色

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
