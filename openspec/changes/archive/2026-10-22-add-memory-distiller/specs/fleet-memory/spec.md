## MODIFIED Requirements

### Requirement: 零 LLM 边界

fd-memory 服务进程 MUST NOT 直连任何外部 LLM 或嵌入端点；L0（观测）与 L1（交接 / 笔记）的全部写入、衰减位标记与索引 SHALL 保持确定性零 LLM。捕获内容 MUST NOT 外发到本服务进程之外（备份通道除外，走既有运维面）；唯一例外是 L2 蒸馏——原文仅经既定蒸馏契约（memory-distiller 能力）流向受 pin 的 sidecar 与词元车道，在每 owner 日预算内后台进行，且 L2 停摆 MUST NOT 影响 L0/L1。

#### Scenario: 断外网仍全功能

- **WHEN** 服务运行环境无外网出口
- **THEN** capture、MCP 面、查询、交接全部功能正常；L2 蒸馏暂停并记录缺口，恢复后自动续跑

### Requirement: 存储为 OKF 兼容真源且派生索引可重建

持久层 SHALL 以 markdown 文件树为真源（页面带类型/frontmatter、按 namespace 分目录、git 版本化），全文索引 SHALL 为派生物、可从真源完整重建；重建 MUST NOT 丢失或改写任何真源内容。页型 SHALL 覆盖 L0-L2 全层：观测（session 页）、交接（handoff）、笔记（note）与蒸馏产物——`fact`（statement / subject / files / details≤4000 / sources / supersedes / confidence）与 `experience`（task / search_keys / solution / boundary_envs / confidence / sources / supersedes）——reindex MUST 识别全部页型。

#### Scenario: 派生索引损毁可重建

- **WHEN** 派生索引文件被删除后执行重建
- **THEN** 索引恢复且 markdown 真源与重建前逐字节一致

#### Scenario: 与 stock ai-memory 本地节点格式互读

- **WHEN** 一个 stock ai-memory 数据目录的 wiki 树被导出为 OKF bundle 并导入本服务
- **THEN** 页面、交接与月度 ledger 语义保留，可被 query 检索

#### Scenario: 蒸馏页型可重建且被检索

- **WHEN** 含 fact / experience 页的 root 执行 reindex 后查询其任务关键词
- **THEN** 两类页型的 frontmatter（supersedes / sources / generated.by）完整保留并可被检索命中

### Requirement: MCP 工具面按 namespace 收窄

MCP 面（streamable-http，鉴权头）SHALL 暴露 handoff 四件套与 query/recent/read_page/write_page，并接受可选相对选择器 `target: "own" | "shared"`；线协议 MUST NOT 出现 namespace 名。工具操作范围 MUST 经请求令牌的 Grant 判定：读工具（memory_query / memory_recent / memory_handoff_list）默认返回 own 与 shared 的并集、每条结果携带 `source`（own|shared）与 `layer`（L0 观测 / L1 交接与笔记 / L2 事实与经验，页面按页型推导、观测恒为 L0），L2 条目另携带 `sources[]` 溯源；显式 target 时只返回该侧；写工具（memory_write_page / memory_handoff_begin）默认写 own，`target: "shared"` 写共享区；`memory_handoff_begin` 写共享区时可携带 `to_agent`（agent→agent 交接的定向归属），accept 恰认领一次的协议不变。pod 令牌无 own——默认即 shared，显式 `target: "own"` MUST 拒绝并说明原因。按名字寻址的工具（memory_read_page 按 path、handoff accept/cancel 按 id）MUST 校验目标 project 在该令牌 Grant 覆盖内，越项目 MUST 拒绝。工具面 MUST NOT 暴露跨 namespace 枚举能力。

#### Scenario: 工具面 scope 收窄

- **WHEN** 部署令牌的 MCP 会话调用 recent 或 query
- **THEN** 结果只含该令牌 Grant 覆盖的内容，绝无同根其他成员私有 project 的条目

#### Scenario: 成员读 own 与 shared 并集带来源

- **WHEN** 成员令牌调用 memory_recent 或 memory_query，own 与 shared 两侧都有内容
- **THEN** 结果同时含两侧条目，每条携带 source 字段标明 own 或 shared

#### Scenario: 成员写共享区与定向交接

- **WHEN** 成员令牌以 `target: "shared"` 调用 memory_write_page，另一成员以 `target: "shared"` + `to_agent` 调用 memory_handoff_begin 后认领
- **THEN** 页面与交接都落 shared project；交接带 to_agent 归属，accept 恰成功一次

#### Scenario: pod 令牌默认共享且 own 被拒

- **WHEN** pod 令牌不带 target 调用读写工具，再显式 `target: "own"`
- **THEN** 不带 target 时读写都落共享区；显式 own 收到拒绝性结果并说明 pod 令牌无私有区

#### Scenario: 越项目读取被拒

- **WHEN** 成员令牌以 memory_read_page 请求同根下另一成员私有 project 的页面路径
- **THEN** 拒绝且不返回该页面内容

#### Scenario: 读结果带层与溯源

- **WHEN** 一个 project 同时含观测、交接与蒸馏产出的经验，成员查询命中多层
- **THEN** 每条结果带 layer（观测 L0、交接 L1、经验 L2），L2 条目携带 sources[] 指向其产出来源
