## Purpose

舰队级工作记忆服务：为萬星 runner 上的部署 agent（及后续壹座 cell 与本地节点）提供跨会话的任务状态、交接与沉淀事实存取——namespace 隔离、令牌鉴权、OKF 兼容存储、零 LLM。

## ADDED Requirements

### Requirement: 记忆按 namespace 寻址且跨 owner 永不共库

记忆条目（页面、观测、交接）SHALL 按 namespace 寻址：人的记忆 `u/<user>/p/<project>`，部署的记忆 `d/<packId>/<agentId>`。不同 owner 的数据 MUST 存于物理隔离的 store root（独立目录树与独立数据库文件），任何 API、查询或派生索引都 MUST NOT 跨 owner 合并数据。

#### Scenario: 部署记忆自动建 namespace

- **WHEN** 一个尚未有 namespace 的部署令牌首次写入记忆
- **THEN** 该部署的 `d/<packId>/<agentId>` store root 被创建，此后该部署的全部记忆落此

#### Scenario: 跨 owner 读取被拒

- **WHEN** 持有 owner A 部署令牌的请求试图以路径或参数指向 owner B 的 namespace
- **THEN** 请求被拒绝且不返回任何 owner B 的内容

### Requirement: 令牌两族且每请求鉴权

服务 SHALL 接受两类令牌：**部署令牌**（绑定恰一个 `d/` namespace，可写该 namespace 的 capture 与 MCP 面）与**人令牌**（绑定一个 `u/` root）。无令牌或无效令牌的请求 MUST 收到结构化拒绝；令牌 MUST 可独立吊销且吊销即时生效（无缓存宽限）。

#### Scenario: 部署令牌越界被拒

- **WHEN** 部署令牌请求的操作目标不是其绑定的 namespace
- **THEN** 拒绝并指明令牌 scope

#### Scenario: 吊销即时生效

- **WHEN** admin 吊销一枚令牌后，该令牌立即再次请求
- **THEN** 请求被拒绝

### Requirement: 交接是类型化且恰被认领一次的协议

`memory_handoff_begin/accept/cancel/list` 工具 SHALL 可用：交接记录含 summary、开放问题、下一步、涉及文件与归属者；`accept` MUST 恰成功一次（重复认领返回已认领状态而非再认领），认领方跨 agent/harness 生效；交接在会话启动时以通知形式可见、不自动消费。

#### Scenario: 跨 harness 认领一次

- **WHEN** harness A 的会话写出交接，harness B 的会话以正确 id 认领后，harness C 再以同 id 认领
- **THEN** B 认领成功并收到完整交接内容，C 收到已认领状态且不改变归属

#### Scenario: 交接内容自足

- **WHEN** 一个会话认领交接并续作
- **THEN** 交接内容包含续作所需的最小充分信息（已完成、接口形状、下一步、坑），不要求回读原会话全文

### Requirement: capture API 接受平台缝与本地节点的事件投递

服务 SHALL 暴露 HTTP capture API，接受 hooks 形状事件（session-start、user-prompt-submit、pre/post-tool-use、stop、session-end）；事件 MUST 携带投递身份（令牌解析）与项目坐标（cwd 派生），落为对应 namespace 的会话页与观测。无法解析身份的投递 MUST 被拒绝。

#### Scenario: manager 代采落库

- **WHEN** runner manager 以部署令牌投递一组回合观测（工具调用、回合边界）
- **THEN** 观测按会话归并落库，可在该 namespace 的 query/recent 面检索

#### Scenario: 身份缺失的投递被拒

- **WHEN** capture 投递不带有效令牌
- **THEN** 结构化拒绝，事件不入库

### Requirement: 存储为 OKF 兼容真源且派生索引可重建

持久层 SHALL 以 markdown 文件树为真源（页面带类型/frontmatter、按 namespace 分目录、git 版本化），全文索引 SHALL 为派生物、可从真源完整重建；重建 MUST NOT 丢失或改写任何真源内容。

#### Scenario: 派生索引损毁可重建

- **WHEN** 派生索引文件被删除后执行重建
- **THEN** 索引恢复且 markdown 真源与重建前逐字节一致

#### Scenario: 与 stock ai-memory 本地节点格式互读

- **WHEN** 一个 stock ai-memory 数据目录的 wiki 树被导出为 OKF bundle 并导入本服务
- **THEN** 页面、交接与月度 ledger 语义保留，可被 query 检索

### Requirement: 零 LLM 边界

v1 服务 MUST NOT 发起任何外部 LLM 或嵌入调用；全部写入、衰减位标记与索引 SHALL 为确定性规则操作。捕获内容 MUST NOT 外发到本服务进程之外（备份通道除外，走既有运维面）。

#### Scenario: 断外网仍全功能

- **WHEN** 服务运行环境无外网出口
- **THEN** capture、MCP 面、查询、交接全部功能正常

### Requirement: MCP 工具面按 namespace 收窄

MCP 面（streamable-http，鉴权头）SHALL 暴露 handoff 四件套与 query/recent/read_page/write_page；一切工具的操作范围 MUST 收窄到请求令牌绑定的 namespace，工具面 MUST NOT 暴露跨 namespace 枚举能力。

#### Scenario: 工具面 scope 收窄

- **WHEN** 部署令牌的 MCP 会话调用 recent 或 query
- **THEN** 结果只含该部署 namespace 的内容
