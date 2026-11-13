# agent-memory-foundation Specification (Delta)

## ADDED Requirements

### Requirement: 页面携带一等 metadata 且可索引

记忆页面 SHALL 支持一等 `metadata` 字段：写面（/pages POST 与 MCP `memory_write_page`）接受可选的
结构化 JSON metadata（键值对，值限标量与标量数组），落库为可索引列并对其高频键建索引；metadata
MUST NOT 参与摘要预算渲染正文，但 SHALL 驱动读面筛选。未携带 metadata 的写入行为 SHALL 与本单之前
逐字节等价；metadata 形状非法（非对象、值越界）SHALL 结构化拒绝（400），MUST NOT 静默丢弃或截断。
标题 SHALL 恢复纯人类语义——机器寻址信息 MUST NOT 再依赖标题字符串编码。

#### Scenario: 带 metadata 写入可按键检索

- **WHEN** 一条页面以 `{"kind":"decision","memberId":"clerk"}` 的 metadata 写入
- **THEN** 按 `kind=decision` 或 `memberId=clerk` 的结构化查询可命中该页，且标题中不要求任何前缀标记

#### Scenario: 非法 metadata 结构化拒绝

- **WHEN** 写入携带 `metadata: {"tags": {"a": 1}}`（嵌套对象值）
- **THEN** 返回 400 结构化错误，页面不落库

#### Scenario: 无 metadata 写入逐字节等价

- **WHEN** 既有调用方不带 metadata 写入一条 note
- **THEN** 落库结果、digest 渲染与迁移前一致

### Requirement: 读面支持结构化筛选并与相关性召回正交

`/digest`、`/pages`（GET 列表）与 MCP `memory_query`/`memory_recent` SHALL 支持可选筛选参数：
按 metadata 键值（如 `kind`、`memberId`）、时间范围（写入时间上下界）、layer 过滤；筛选 SHALL 与
既有相关性查询（q + k + budget）正交组合——既有调用缺省所有筛选参数时行为逐字节等价。被 forget
或 superseded 的条目在筛选结果中 SHALL 沿用既有排除纪律。筛选参数 SHALL 下推到查询层（利用
metadata 索引），MUST NOT 在渲染层全量拉取后过滤。

#### Scenario: 按岗位取最近拍板

- **WHEN** 以 `kind=decision&memberId=clerk` 筛选并按时间排序查询团队记忆
- **THEN** 仅返回该成员的拍板条目，其他成员与其他 kind 的事实不出现

#### Scenario: 缺省筛选行为等价

- **WHEN** 既有调用方不带任何筛选参数调用 /digest 与 memory_query
- **THEN** 返回内容与排序与本单之前一致

#### Scenario: 筛选与相关性组合

- **WHEN** 以 `q=换防&kind=swap` 组合查询
- **THEN** 结果既满足相关性排序又满足 kind 过滤，两者交集为空时返回空集而非报错

### Requirement: 存量标题前缀回填为 metadata

对存量页面中以 `[kind][memberId] ` 前缀编码的标题（舰队事实五类写法），SHALL 提供一次性回填：
解析出 `kind` 与 `memberId` 写入 metadata，标题 SHALL 保留原前缀不变（回填不改写存量文本，读面
双轨——带 metadata 走索引筛选、不带前缀的旧调用走标题匹配——迁移期并存）。回填 SHALL 幂等（重跑
不产生重复页或重复元数据），SHALL 提供独立命令触发且不阻塞服务；回填后新写入 MUST NOT 再产生
前缀编码（写面改为 metadata 字段承载）。

#### Scenario: 回填幂等

- **WHEN** 同一批存量页面回填执行两次
- **THEN** 第二次为零变更，页面数与 metadata 值不变

#### Scenario: 双轨过渡可检索

- **WHEN** 回填完成但壹座侧仍有旧格式写入
- **THEN** 旧格式页（标题前缀）与新格式页（metadata）在同一结构化筛选下均可命中

### Requirement: owner 对自有部署根的审计式只读监督

person 令牌 SHALL 对**自己名下**的部署根（该 owner 发起的部署所产生的 `d/<packId>` 根）获得只读权：
可列分区、读页面、读 digest——含成员私有分区；写权不变（成员私有分区仍仅成员部署令牌可写，person
对 d/ 根 MUST 保持零写权）。每次 owner 监督读取 SHALL 落一条审计行（谁、何时、读了哪个根/分区、
命中条数），审计行 SHALL 可经既有 admin 面查询。非本 owner 的部署根 SHALL 不可见（403，不泄存在性）。
ownership 判定 SHALL 结构性锚定（部署铸造时的 owner 绑定记录），MUST NOT 依赖名称约定。

#### Scenario: owner 监督读取成员私有记忆

- **WHEN** owner 以 person 令牌读取自己某部署根内某成员私有分区的 digest
- **THEN** 读取成功，审计面新增一条该次读取的审计行，成员令牌的写权边界不受影响

#### Scenario: 越权 owner 不可见

- **WHEN** owner A 的 person 令牌读取 owner B 名下的部署根
- **THEN** 403 结构化拒绝，响应不泄露该根是否存在

#### Scenario: person 仍无 d/ 写权

- **WHEN** owner 以 person 令牌对自己部署根的任何分区发起写入
- **THEN** 403 结构化拒绝（与既有矩阵一致）

### Requirement: agent 自我认知读面 memory_overview

MCP 面 SHALL 新增 `memory_overview` 工具：按调用者令牌的可达分区返回概览——各分区标识、页数、
最近写入时间与最近 N 条标题（N 有上限）；工具 SHALL 复用既有授权判定（deployment 见 own+shared、
pod 见 shared、person 见自有根，叠加 oversight 只读权），MUST NOT 越权披露不可达分区。工具 SHALL
零写副作用、遵守既有预算纪律（返回体有硬上限），不可达时按既有 fail-open 姿态返回结构化空集或错误。

#### Scenario: 部署成员查看自己的记忆概览

- **WHEN** 以 `d/<packId>/<agentId>` 部署令牌调用 memory_overview
- **THEN** 返回 own 与 shared 两个分区的页数与最近条目，不含其他成员的私有分区

#### Scenario: pod 令牌无 own 分区

- **WHEN** 以 pod 令牌调用 memory_overview
- **THEN** 仅返回 shared 分区概览，无 own 字段（与既有分区语义一致）
