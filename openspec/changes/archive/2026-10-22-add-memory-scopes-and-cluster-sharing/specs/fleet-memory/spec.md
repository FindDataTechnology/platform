## MODIFIED Requirements

### Requirement: 人令牌经 /hook 写入其 namespace，platform 族边界如联邦契约

fleet-memory 服务的人令牌（u/ 族）SHALL 同时被 `/hook` 兼容端点与 MCP 面接受，两者写入同一 namespace 语义（互见）；`platform` 族令牌为纯铸造面（铸造 person 令牌；capture//hook/MCP 全拒），权限矩阵为：deployment=`d/<packId>/<agentId>` 成员读写（agent + 所属 pack Scope）；pod=`d/<packId>` 集群共享区读写；person=`u/` root 读写（MCP+/hook）；runner=任意 `d/` capture-only + 代铸 deployment 与 pod；platform=代铸 person only；local collector 令牌族（fsc_）仅 stats 面，与记忆令牌族互不相通。

#### Scenario: 令牌族权限矩阵全覆盖

- **WHEN** 以五种令牌族（deployment、pod、person、runner、platform）分别请求 capture、/hook、MCP、project 读写面、铸造面
- **THEN** 每格结果与矩阵一致（拒绝均 403 结构化），无越界写入

### Requirement: 记忆按 namespace 寻址且跨 owner 永不共库

记忆条目（页面、观测、交接）SHALL 按 namespace 寻址，寻址单位细化为三类 Scope：`agent`（成员私有，`d/<packId>/<agentId>`）、`pack`（集群共享，`d/<packId>`）、`owner`（部署者名下，`u/<user>`）。同一 pack 的全部成员与共享区 SHALL 共存于同一 store root——`d/<packId>` 一根多 project：每成员一个以 `metadata.agentId` 命名的 project、共享区一个 `shared` project；人的记忆 `u/<user>/p/<project>` 形状不变。不同 owner 的数据 MUST 存于物理隔离的 store root（独立目录树与独立数据库文件），任何 API、查询或派生索引都 MUST NOT 跨 owner 合并数据。`<packId>` 的每部署唯一性由 serving 面结构性保证：registry 部署条目按 packId 单例（重部署覆盖同一部署），因此 `d/<packId>` 永不混入第二个部署者的数据。

#### Scenario: 部署记忆自动建 namespace

- **WHEN** 一个尚未有 namespace 的部署令牌首次写入记忆
- **THEN** 该部署所在 pack 的 `d/<packId>` store root 被创建（或复用既有根），写入落该成员自己的 project，此后该成员的全部记忆落此

#### Scenario: 同 pack 成员共根分 project

- **WHEN** 同一 pack 的成员 A 与 B 各自产生回合观测，且一次经共享区的写入发生
- **THEN** 三者都在 `d/<packId>` 同一 store root 下——A 的观测只在 A 的 project、B 的只在 B 的 project、共享内容只在 `shared` project，互不混入

#### Scenario: 跨 owner 读取被拒

- **WHEN** 持有 owner A 部署令牌的请求试图以路径或参数指向 owner B 的 namespace
- **THEN** 请求被拒绝且不返回任何 owner B 的内容

### Requirement: 令牌两族且每请求鉴权

服务 SHALL 接受五类令牌：**部署令牌**（deployment，绑定 `d/<packId>/<agentId>`）、**pod 令牌**（绑定 `d/<packId>`）、**人令牌**（person，绑定一个 `u/` root）、**runner**（capture-only + 代铸）与 **platform**（纯铸造面）不变。授权 SHALL 由 Grant 表数据表达——`grants(token, scope_kind, scope_ref, mode)`，scope_kind ∈ agent|pack|owner，mode ∈ r|rw（rw 蕴含 r）：铸币时 MUST 写默认授予（成员令牌 = 自己 agent rw + 所属 pack rw；pod 令牌 = pack rw；person 令牌 = owner rw）；既有令牌 MUST 一次性回填默认授予（幂等）。数据面每次访问 MUST 经 Grant 判定，Grant 变更（收紧、撤销、补授）MUST 即时生效（无缓存宽限）。无令牌或无效令牌的请求 MUST 收到结构化拒绝；令牌 MUST 可独立吊销且吊销即时生效。

#### Scenario: 部署令牌越界被拒

- **WHEN** 部署令牌请求的操作目标不是其绑定的 namespace
- **THEN** 拒绝并指明令牌 scope

#### Scenario: 吊销即时生效

- **WHEN** admin 吊销一枚令牌后，该令牌立即再次请求
- **THEN** 请求被拒绝

#### Scenario: 铸币默认授予齐备

- **WHEN** 分别铸一枚成员令牌、一枚 pod 令牌、一枚 person 令牌后查 Grant 表
- **THEN** 成员令牌有 agent rw 与 pack rw 两条授予、pod 令牌恰有 pack rw 一条、person 令牌恰有 owner rw 一条

#### Scenario: 既有令牌回填默认授予

- **WHEN** 服务升级到 Grant 模型后，一枚 v1 既有令牌首次接受鉴权
- **THEN** 其默认授予已按族幂等回填，数据面行为与同族新铸令牌一致

#### Scenario: 撤销共享授予后共享面拒绝

- **WHEN** 撤销某成员令牌的 pack 授予后，该令牌请求共享区读写
- **THEN** 共享区请求被拒绝，其 agent 私有区读写不受影响

### Requirement: MCP 工具面按 namespace 收窄

MCP 面（streamable-http，鉴权头）SHALL 暴露 handoff 四件套与 query/recent/read_page/write_page，并接受可选相对选择器 `target: "own" | "shared"`；线协议 MUST NOT 出现 namespace 名。工具操作范围 MUST 经请求令牌的 Grant 判定：读工具（memory_query / memory_recent / memory_handoff_list）默认返回 own 与 shared 的并集、每条结果携带 `source`（own|shared），显式 target 时只返回该侧；写工具（memory_write_page / memory_handoff_begin）默认写 own，`target: "shared"` 写共享区；`memory_handoff_begin` 写共享区时可携带 `to_agent`（agent→agent 交接的定向归属），accept 恰认领一次的协议不变。pod 令牌无 own——默认即 shared，显式 `target: "own"` MUST 拒绝并说明原因。按名字寻址的工具（memory_read_page 按 path、handoff accept/cancel 按 id）MUST 校验目标 project 在该令牌 Grant 覆盖内，越项目 MUST 拒绝。工具面 MUST NOT 暴露跨 namespace 枚举能力。

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

## ADDED Requirements

### Requirement: v2 磁盘布局与一次性迁移

`d/` 族磁盘布局 SHALL 镜像 `u/` 族的一根多 project 形状：`d/<packId>` 与 `d/<packId>/<agentId>` 都落根 `d-<packId>`，共享区 project 为 `shared`、成员 project 为 `<agentId>`（取部署描述符 metadata.agentId）。既有 v1 布局（每 agent 一根 `d-<packId>--<agentId>`、单 default project）SHALL 经一次性迁移脚本搬家至 v2 并重建派生索引：迁移 MUST 以令牌库登记的 namespace 为坐标源（不从目录名反解 packId 与 agentId）、MUST 幂等（重复执行零改动）、MUST NOT 改写或丢失任何 markdown 真源内容；旧目录 MUST 保留至迁移验收通过后才可清理。

#### Scenario: v1 目录搬家到 v2 并可检索

- **WHEN** 迁移脚本在一个 v1 数据目录（含 `d-<pack>--<agent>/wiki/default/*` 与对应令牌）上执行
- **THEN** 内容出现在 `d-<pack>/wiki/<agent>/*`，新根的 query/recent 可检索到原有页面与观测

#### Scenario: 迁移幂等且真源逐字节保真

- **WHEN** 迁移脚本对同一数据目录连续执行两次，并比对第二次前后 wiki 树
- **THEN** 第二次零改动，全部 markdown 文件与首次迁移后逐字节一致

#### Scenario: 显示名变更不换坐标

- **WHEN** 一个部署 agent 的显示名变更后重新部署并产生新观测
- **THEN** 其记忆坐标（namespace 与 project）仍由 metadata.agentId 决定，不因改名产生新 project 或断档

### Requirement: 每次写入可审计

每个 store root SHALL 记录写入审计——时间、主体（令牌 id 与族）、Scope、页面相对路径、操作；页面写入、交接开始/认领/取消与 capture 批次 MUST 各落审计行，审计为伴随记录 MUST NOT 阻断写入路径。管理面 SHALL 能按 root 列出令牌授予（scope/grant/mode）与最近写入。

#### Scenario: 写页面与交接各落审计行

- **WHEN** 一枚成员令牌写一页、开始一个交接并认领它
- **THEN** 审计记录含三次写入，各带时间、该令牌身份、scope 与操作名

#### Scenario: 管理面列出 scope / grant / 最近写入

- **WHEN** 管理面查询某 root 的记忆报告
- **THEN** 返回该 root 相关令牌的授予清单与最近写入审计行

### Requirement: 平台缝 project 读写面

服务 SHALL 暴露面向平台缝编排（cell 集群回合等）的 project 读写 HTTP 面：持有效令牌的调用方在自己 Grant 覆盖的 root 内按 project 名读取最近页面、写入页面；线协议 MUST NOT 携带 namespace/root 名（project 名在请求者自身 root 内解析，跨 root 不可寻址）；person 令牌经 owner 授予覆盖其 root 下全部 project（含集群共享 project）。无有效授予的 project MUST 结构化拒绝；写路径 MUST 落审计行。

#### Scenario: person 令牌读写 owner 根下指定 project

- **WHEN** cell 以 owner 的 person 令牌读写其 root 下某 clusterId project
- **THEN** 读返回该 project 的最近页面，写落一页并记审计行

#### Scenario: 越出授予的 project 被拒

- **WHEN** 一枚部署令牌经 project 面请求其 Grant 不覆盖的 project
- **THEN** 结构化拒绝，无任何内容返回或写入
