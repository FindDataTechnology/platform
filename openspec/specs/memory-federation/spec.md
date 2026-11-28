# memory-federation Specification

## Purpose

记忆联邦：舰队记忆服务对壹座 cell 与本地 harness 节点开放——同一格式与协议下三类消费者（萬星部署 d/、壹座用户 u/、本地节点 u/ 经 /hook 直投）的接入契约。

## Requirements

### Requirement: /hook 兼容端点按上游实测协议接收投递

服务 SHALL 暴露 `POST /hook?event=<event>&agent=<agent>&cwd=<urlencoded>&ingest_key=<key>`：Bearer 人令牌鉴权；body 为 hook payload 原文（JSON）；事件落该令牌 owner 的 `u/<owner>/p/<cwd 的 basename>` namespace；agent/event 合法集合外的投递 MUST 结构化拒绝；同 `(ingest_key, session_id, event, ts)` 的重投 MUST 幂等（不双计）。

#### Scenario: 本地节点回合事件落库可检索

- **WHEN** 一台配置了 fleet profile 的本地 ai-memory 节点经 recover 排空投递一批 hook 事件
- **THEN** 事件落对应 u/ namespace，MCP query 面可检索到该会话的观测

#### Scenario: spool 重投不双计

- **WHEN** 同一 hook 事件因网络重试被投递两次
- **THEN** 仅计一次观测

### Requirement: platform 令牌是纯铸造面

fd-memory SHALL 支持 `platform` 族令牌：仅可调用铸造面为其用户代铸 person 令牌（绑定 `u/<user>`）；对 capture、/hook、MCP 数据面 MUST 全部拒绝。person 令牌经 /hook 与 MCP 写入自己的 u/ namespace，永不越界。

#### Scenario: platform 令牌碰数据面被拒

- **WHEN** platform 令牌调用 /hook、/capture 或 /mcp
- **THEN** 全部 403，无数据写入

#### Scenario: platform 代铸的 person 令牌全功能于自身 namespace

- **WHEN** platform 代铸 `u/alice` 的 person 令牌后，该令牌经 /hook 投事件、经 MCP 写 handoff
- **THEN** 两者都落 `u/alice` 名下且仅此 namespace

### Requirement: cell 记忆挂载遵守组合与凭据纪律

壹座 cell 的 dsh 组合 SHALL 注入 fd-memory MCP 行（工具名 `mcp__fd-memory__*`）：人令牌按 owner 由 cell 后端经 platform 令牌代铸并缓存，注入路径与既有 MCP 凭据引用纪律同源（值不落明文配置文件）；挂载开启时，cell 的每个 persona 预设 SHALL 同时携带记忆纪律文案（引导 agent 开场查交接、收尾写交接），文案与舰队部署的纪律文案 MUST 取自同一来源（单一模块，字节相同）；fd-memory 不可达时 cell 会话 MUST 降级开放（无记忆工具或工具报不可用，会话不因此失败）；挂载可经部署配置关闭，关闭时 MCP 行与纪律文案 MUST 一并消失。

集群回合的注入挂点（cron 引擎 fan-out 前）SHALL 优先注入 **digest 块**：以 person 令牌调平台缝 digest 读面（`q` = 本回合任务 prompt 原文，一次渲染全员注入），块替换既有标题列表进入每个成员的任务 prompt；k 与预算默认 k=5 / budget=1500，可经 cell 配置覆盖。注入 SHALL 遵守三档降级阶梯：digest 读面失败（含超时）→ 回退既有 `/pages` 标题列表注入 → 再失败 → 无块、任务照常；每档降级 MUST 落一行 warn 日志，MUST NOT 使回合失败。集群记忆开关关闭时，两档注入与写回 MUST 全部不发生（与无记忆行为字节等同）。写回挂点（聚合 digest 落 cluster project）不变。

digest 调用超时 SHALL 可配置（`CELL_MEMORY_DIGEST_TIMEOUT_MS`），未配置时 MUST 使用与 fd-memory embed 预算上限相匹配的默认值；生效超时 MUST 大于 fd-memory 侧 embed 预算上限，否则 digest 会在能返回结果前被放弃。原「paas 侧超时上限 5s」的固定上限取消——它与 fd-memory 的 embed 等待预算冲突（5s < 8000ms），使慢 embed 时 digest 整块丢失而非降级到关键词档。

#### Scenario: digest 块注入成员任务 prompt

- **WHEN** 挂载开启的一个集群回合 fan-out 前 digest 读面可用且该 cluster project 有记忆
- **THEN** 每个成员的任务 prompt 携带同一 digest 块（含 layer/置信标注条目与待认领交接段），而非标题列表

#### Scenario: digest 失败回退标题列表

- **WHEN** digest 读面超时或 5xx，而 /pages 面可用
- **THEN** 成员 prompt 收到既有形状的标题列表块，回合继续，落降级 warn 一行

#### Scenario: 慢 embed 不因调用方超时先弃

- **WHEN** fd-memory embed 预算上限 8000ms、调用方超时按默认 9s，某次 embed 耗时 6s
- **THEN** digest 在调用方放弃前完成并返回（向量档或带降级注记的关键词档），成员仍拿到 digest 块而非标题列表

#### Scenario: 调用方超时可配

- **WHEN** 部署侧设置 `CELL_MEMORY_DIGEST_TIMEOUT_MS`
- **THEN** 注入挂点使用该值作为 digest 调用超时，其余阶梯行为不变

#### Scenario: 两档全失败任务照常

- **WHEN** fd-memory 整体不可达
- **THEN** 成员 prompt 无任何记忆块，回合行为与无记忆一致，不失败

#### Scenario: 关闭开关回零

- **WHEN** 部署配置关闭 cell 记忆挂载
- **THEN** cell 组合输出与现状字节等同（无 MCP 行、无纪律文案、无代铸调用），集群回合两挂点也不读写记忆（digest 面与 /pages 面均不发起）

#### Scenario: cell 会话见记忆工具并写入落库

- **WHEN** 一个壹座 cell 会话运行并调用 memory_handoff_begin
- **THEN** handoff 落 `u/<owner>/p/cell` namespace，舰队侧可检索

#### Scenario: 挂载开启时 persona 携带纪律文案

- **WHEN** 部署配置开启 cell 记忆挂载并写出 preset 组合
- **THEN** 标准预设与每个目录 / 自定义预设的 persona 都含记忆纪律文案，且该文案与舰队部署 runner 注入的文案是同一字符串

#### Scenario: 集群 digest 经 person 令牌落 owner 根

- **WHEN** 一个集群任务在 cell 完成聚合且记忆联邦开启
- **THEN** digest 页面写入该 owner root 下以 cluster id 命名的 project，审计行的主体是该 owner 的 person 令牌
### Requirement: 本地节点接入是纯配置动作

接入舰队 SHALL 只需上游原生配置（`server add` profile + 仓内 `.ai-memory.toml` + 定时 `ai-memory recover`），不要求修改上游代码或 fork；接入配方文档随服务仓发布。

#### Scenario: 新机器 30 分钟接入

- **WHEN** 一台装了 stock ai-memory 的机器按配方配置 profile 并运行 recover
- **THEN** 其后该机各仓的 hook 事件持续落舰队对应 namespace
