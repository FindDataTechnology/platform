# fleet-memory Specification

## Purpose

舰队级工作记忆服务：为萬星 runner 上的部署 agent（及后续壹座 cell 与本地节点）提供跨会话的任务状态、交接与沉淀事实存取——namespace 隔离、令牌鉴权、OKF 兼容存储；L0/L1 零 LLM，L2 经 memory-distiller 契约在预算内后台蒸馏。

> 实现归属：fd-memory 服务仓（本仓仅消费端缝）——本 spec 为跨仓行为契约，审计时按文件间一致性核对。

## Requirements

### Requirement: 人令牌经 /hook 写入其 namespace，platform 族边界如联邦契约

fleet-memory 服务的人令牌（u/ 族）SHALL 同时被 `/hook` 兼容端点与 MCP 面接受，两者写入同一 namespace 语义（互见）；`platform` 族令牌为纯铸造面（铸造 person 令牌 **与 deployment 令牌（add-agent-memory-foundation：绑定 `d/<packId>/<agentId>`，铸造时落 root_owner 绑定记录，供 oversight 判定）**；capture//hook/MCP 全拒），权限矩阵为：deployment=`d/<packId>/<agentId>` 成员读写（agent + 所属 pack Scope）；pod=`d/<packId>` 集群共享区读写；person=`u/` root 读写（MCP+/hook）**＋对自己名下部署根的审计式只读监督（add-agent-memory-foundation：可读监督面列分区/读页/digest 含成员私有分区，零写权，逐读审计；实现契约见 openspec: agent-memory-foundation）**；runner=任意 `d/` capture-only + 代铸 deployment 与 pod；platform=代铸 person 与 deployment only；local collector 令牌族（fsc_）仅 stats 面，与记忆令牌族互不相通。

#### Scenario: 令牌族权限矩阵全覆盖

- **WHEN** 以五种令牌族（deployment、pod、person、runner、platform）分别请求 capture、/hook、MCP、project 读写面、铸造面
- **THEN** 每格结果与矩阵一致（拒绝均 403 结构化），无越界写入

#### Scenario: owner 监督只读落入矩阵

- **WHEN** person 令牌对自己名下部署根发起列分区与读页请求，并对同一根发起写入
- **THEN** 读成功且逐次落审计行；写 403 结构化拒绝（矩阵其余格不变）

#### Scenario: platform 代铸 deployment 令牌且绑定 owner

- **WHEN** platform 令牌调用铸造面请求 deployment 令牌（`d/<packId>/<agentId>`），再以该 deployment 令牌写 own 分区
- **THEN** 铸造成功且 root_owner 绑定落库；写入落该成员私有分区（platform 自身碰数据面仍全拒）

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

### Requirement: 零 LLM 边界

fd-memory 服务进程 MUST NOT 直连任何外部 LLM 或嵌入端点；L0（观测）与 L1（交接 / 笔记）的全部写入、衰减位标记与索引 SHALL 保持确定性零 LLM。捕获内容 MUST NOT 外发到本服务进程之外（备份通道除外，走既有运维面）；唯一例外是 L2 蒸馏——原文仅经既定蒸馏契约（memory-distiller 能力）流向受 pin 的 sidecar 与词元车道，在每 owner 日预算内后台进行，且 L2 停摆 MUST NOT 影响 L0/L1。

#### Scenario: 断外网仍全功能

- **WHEN** 服务运行环境无外网出口
- **THEN** capture、MCP 面、查询、交接全部功能正常；L2 蒸馏暂停并记录缺口，恢复后自动续跑

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

### Requirement: 平台缝 digest 读面——服务端单源渲染

fd-memory SHALL 在平台缝暴露 digest 读面 `GET /digest?project=<name>&k=&budget=`：以请求令牌自身 root 内该 project 为范围，经与蒸馏候选检索同一条代码路径（向量优先、关键词兜底）按 query 文本（请求参数 `q`）召回 top-k 条 L2 页，并追加该 project 的近期 note 页为 L1 条目（按更新时间新近排序、至多 5 条、行级 gist：标题+摘录前约 100 字），交 digest 渲染器（预算硬顶、每条 layer/confidence/日期标注与行级 gist——L2 条目摘录约 150 字、L1 note 约 100 字，块承载约 8-10 行、open handoffs 通知段、forget 与 expired 条目排除）产出注入块——open handoffs 通知段同受预算硬顶约束（保先位不保特权：单条超预算即整条让位，防巨型轮报交接淹没整块），返回 `{digest: string, items: number, notes: number, truncated: boolean, model_note?: string}`。渲染顺序 SHALL 为：L2 条目（召回秩）最先、L1 近期 notes 次之、open handoffs 通知段殿后（行级通知语义、各段同受预算硬顶）——记忆内容占注意力首位，交接通知不与任务背景争抢注入块的头部位（LLM 首位注意力偏置，run12 微验证实锤：handoffs 段在先时 agent 每回合优先认领陈旧轮报交接而非当前任务）——预算不足时按此逆序截断，但 L1 notes SHALL 有保底份额（约 400 token、不超预算三分之一）：L2 候选占满预算时最近 notes 不得被挤到零；无 L1 条目时行为不变。

鉴权与寻址 SHALL 与 `/pages` 面同纪律：person 令牌读自己 root 下 project；platform / runner 族令牌 MUST 以显式 `rootKey` 参数指定目标 root（不带 rootKey 的非 person 调用结构化拒绝）；线协议 MUST NOT 出现 namespace/root 名于 person 路径（project 在请求者自身 root 内解析）；agent 族令牌（deployment / pod）MUST 结构化拒绝。embed 车道不可用或超时 SHALL 降级为关键词召回并在响应 `model_note` 注明，MUST NOT 失败整个请求。k 与 budget 参数 SHALL 有服务端上限（k ≤ 8、budget ≤ 2000），越界取上限。

embed 尝试 SHALL 受服务端内部 deadline 封顶（约 3.5s，取调用方预算余量与该值较小者）：deadline 内未返回即降级关键词召回——保证 /digest 总耗时存在上界，在调用方（cell 侧 5s AbortController）预算内必然返回 digest 块，而非整脸超时。服务端 SHALL 对每次 /digest 记一行 served-rung 日志（向量/关键词、items、notes、耗时），使命中率先天可观测。

#### Scenario: person 令牌取自家集群 digest

- **WHEN** cell 以 owner 的 person 令牌调 `/digest?project=<clusterId>&q=<回合任务文本>` 且该 project 有 L2 页与 open 交接
- **THEN** 返回渲染块含相关 L2 条目（带标注）与待认领交接段，items/notes/truncated 如实

#### Scenario: agent 令牌被拒

- **WHEN** 一枚 deployment 令牌调用 /digest（带或不带 rootKey）
- **THEN** 结构化拒绝，无内容返回

#### Scenario: embed 降级不失败

- **WHEN** sidecar embed 查询超时或失败时 person 令牌调用 /digest
- **THEN** 请求成功，返回关键词召回渲染的块，model_note 注明向量缺席

#### Scenario: 慢 embed 不拖垮整脸

- **WHEN** sidecar embed 迟迟不返回（超过服务端内部 deadline）
- **THEN** /digest 在 deadline 量级内返回关键词渲染块（model_note 注明），总耗时不超过调用方 5s 预算，调用方不再整脸超时降落到标题档

#### Scenario: 参数上限钳制

- **WHEN** 调用方传 k=50 与 budget=99999
- **THEN** 服务按 k=8、budget=2000 渲染，不报错

#### Scenario: 近期 note 进块且带 L1 标注

- **WHEN** 该 project 无 L2 页但存在近期 note（如集群回合写回的 digest 页）时调用 /digest
- **THEN** 渲染块的相关记忆段含这些 note 条目，每条标注 L1 层（〔L1·note〕）与日期，notes 计数如实

#### Scenario: 预算挤迫先截 notes

- **WHEN** L2 条目与 notes 总量超出预算
- **THEN** 截断顺序为 notes 先于 L2 条目、L2 先于 handoffs 通知段，truncated 如实为 true

#### Scenario: 被忘 note 不进块

- **WHEN** 一枚已被 forget 的 note 页存在于该 project
- **THEN** 该页不出现在渲染块中（忘页已在派生索引剔除，组装侧不复活）

### Requirement: reference 页型——大元物的薄索引名份

fd-memory SHALL 支持 `reference` 页型，面向不进本体的大元物（资料库文档、成果成品、URL 等）：每张 reference 页 MUST 携带 `title`、`summary`、≤5 个 `tags`、`tier`（draft|stable|canonical）与 `source_ref`（指向资料库存元行、成果项或外部 URL 的可解析指针）；MUST NOT 在页体内封存文件全部正文。reference 页与其它页同权参与 FTS 与向量索引，及 supersede/forgotten 语义。

#### Scenario: 成果文件在记忆里的呈现

- **WHEN** 一项成果经由 reference 页登记
- **THEN** 命中记忆查询时返回标题/摘要/tags/tier 与 source_ref，文件本体不进入结果

#### Scenario: reference 可被 supersede

- **WHEN** 同主题更高 tier 的 final 版 reference 登记
- **THEN** 草稿版本经 supersede 链被折收（链可查可撤销）

### Requirement: tier 三级分层语义（draft|stable|canonical）

fd-memory SHALL 为 reference 与产物类记忆条目提供三级分层：**draft**（草稿，默认自动捕获层）、**stable**（成果，用户开过/改过名/被对话引用过）、**canonical**（正典，钉住/被分享/被 prompt 召回引用/同题终审胜出）。晋级 SHALL 可由信号或手势触发；降级 SHALL 仅走 supersede 链并保留可下钻证据；任何 tier 变化都带来源（信号/人类手势/AI 提议）记录。digest 读缝与检索 SHALL 可按 tier 优先与过滤。

#### Scenario: 开过一次即晋级 stable

- **WHEN** 用户打开某 draft reference 的成果预览
- **THEN** 该页 tier 变为 stable，来源记为信号位

#### Scenario: 钉住上正典

- **WHEN** 用户执行「标为正典」手势
- **THEN** tier=canonical 带 human 用到来源；digest 召回正门优先呈现

### Requirement: digest 名份引用与 tier 优先

fd-memory 的 digest 读缝 SHALL 把 reference 类条目渲染为「名份+一句摘要」引用（如「见资料库《合同模板》」），不拖全文进 prompt；预算有限时 SHALL 优先 canonical，其次 stable，再 draft；tags SHALL 参与加权检索但不替罪主题词逾其作用；不可见与超时同既有降级纪律。

#### Scenario: 同题多版本下的 prompt 参考

- **WHEN** 同名题有 canonical 与多个 draft 版本
- **THEN** digest 注入青睐 canonical 名份一行，draft 默认不入
