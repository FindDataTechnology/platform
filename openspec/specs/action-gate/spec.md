## Purpose

动作闸把「AI 提议、人确认、系统执行」变成平台原语：让副驾与自主 agent 都能提出动作，但任何重要动作都必须经过明确确认、可追溯执行与事后审计。

## Requirements

### Requirement: 动作注册表声明风险与影响面

每个受闸动作 SHALL 在注册表中声明：动作 id、底层工具、风险等级（read / write / destructive / cost / publish）、影响面模板与目标类型（cloud / desktop / any）。风险等级 SHALL 决定确认档位。未在注册表声明的动作 MUST NOT 由副驾执行。

#### Scenario: 未注册动作被拒绝

- **WHEN** 副驾提议一个不在注册表中的写动作
- **THEN** 闸拒绝执行并返回动作未注册，不调用底层工具

### Requirement: 写工具不进入副驾可见面

副驾的可见工具面 SHALL 只含读工具与平台提供的 `propose_action`。副驾所使用的 pack 工具白名单 MUST NOT 含任何写类工具；`propose_action` 由平台提供，不计入 pack 声明。副驾 MUST 通过提议通道发起写操作，MUST NOT 直接调用写工具。

#### Scenario: 副驾工具面只含读与提议

- **WHEN** 检查副驾会话的可见工具面
- **THEN** 不含任何写类工具，含读工具与平台提供的 `propose_action`；副驾 pack 的白名单本身不含写工具

### Requirement: 三级确认档位

闸 SHALL 按风险等级选择确认档位：`read` 直接执行并记录；`write` 在执行前呈现行内确认（含动作名、目标与影响面）；`destructive` 与 `cost` SHALL 二次确认并展示影响面摘要（受影响对象数量、可逆性、费用或资源占用）；`publish`（对外发布或可见性变更）SHALL 进入异步审批。任何档位 MUST NOT 在用户未确认时执行。

当提议方持有生效中的委托状时，闸 SHALL 按该委托状在**该域**内声明的决策模式确定放行路径，但 SHALL NOT 突破风险下限：`destructive` 与 `publish` 两类动作 SHALL 恒走既有最严档位，委托状对其的任何下调 SHALL 被拒绝。`cost` 类动作经委托状放行时 SHALL 仍受该域额度上限约束，超出即回落既有确认档位。未持有委托状或所在域未配置时，闸 SHALL 按风险等级选择确认档位，行为与未引入委托状前一致。

#### Scenario: 写动作行内确认

- **WHEN** 副驾提议一个 write 动作，且该动作所在域未配置委托状
- **THEN** 用户看到确认卡，只有点击确认后才调用底层工具

#### Scenario: 破坏性动作展示影响面

- **WHEN** 副驾提议一个 destructive 动作
- **THEN** 确认卡显示将受影响的对象数量与是否可逆，用户确认后才执行

#### Scenario: 委托状不放宽破坏性动作

- **WHEN** 提议方持有某域 `act-silent` 的委托状，提议一个 `destructive` 动作
- **THEN** 闸忽略委托状，仍要求二次确认与影响面展示

### Requirement: 异步审批仅限 owner 且失败关闭

`publish` 与需要离线处理的动作 SHALL 进入审批队列，审批人 SHALL 仅限资源 owner。审批请求 SHALL 在 24 小时内有效；超时未处理 SHALL 自动拒绝（fail-closed），MUST NOT 自动执行。审批请求 SHALL 通过现有通知通道触达用户。

#### Scenario: 超时自动拒绝

- **WHEN** 一个审批请求 24 小时内未被处理
- **THEN** 该动作被拒绝，底层工具未被调用，审计记录标记为 expired

#### Scenario: 非 owner 不能批准

- **WHEN** 非资源 owner 尝试批准该请求
- **THEN** 闸拒绝并返回 403

### Requirement: 单一执行路径与审计台账

所有受闸动作 SHALL 经同一条执行路径调用底层工具。执行记录 SHALL 至少包含：动作 id、提议者（会话与用户）、批准者、批准时间、参数摘要、执行结果与耗时。审计记录 MUST NOT 含凭据明文。记录 SHALL 可按线、按时间与按动作检索。

受委托状驱动的执行记录 SHALL 额外包含：命中的委托状引用与域、决策模式、披露层级、可撤销截止时间；对外发言类记录 SHALL 保存内容摘要与目标标识。审计记录 SHALL 可按域与按可撤销状态检索。

#### Scenario: 执行留痕

- **WHEN** 一个动作被批准并执行
- **THEN** 审计台账新增一条记录，含提议者、批准者、参数摘要与结果

#### Scenario: 审计不含密钥

- **WHEN** 查询任意审计记录
- **THEN** 响应不含 token、sk- 或其片段

#### Scenario: 委托状驱动的记录可回溯授权

- **WHEN** 查询一条由委托状放行的执行记录
- **THEN** 记录含委托状引用、域、模式、披露层级与可撤销截止时间

### Requirement: 谦面与萬星动作以用户自己的凭据执行

被批准的谦面/萬星动作 SHALL 经统一执行路径、以**该用户自己的**凭据调用宿主操作 MCP 的写工具，MUST NOT 使用平台凭据或他人凭据。执行所用的凭据引用 SHALL 与该用户的 cell 调用同一服务器时所呈现的凭据一致：`facet-market-mcp` 取宿主服务器目录声明的 `facet-market`（设备 token）；`facet-ops-mcp` 目录未声明，取 `registry` 令牌；萬星四条操作动作在注册表显式钉 `wanxing-caller`（运营基线向 `wanxing-ops-mcp` 呈现該用户键，萬星平台令牌即 sub2api 键）——呈现错误的凭据不仅会 401，还会错误置失效该凭据（如误伤 `registry`）。宿主服务器未进入市场目录、或该用户未连接所需凭据时，提议 SHALL 在 preflight 阶段被拦截并给出去连接指引，MUST NOT 进入确认档位。执行中上游在 HTTP 层或工具层返回 401 时，SHALL 使该用户的该凭据失效（ID-token 清除 / 粘贴键与 registry 令牌置 stale）、将提案标记为执行失败并提示重新连接。上游尚不存在的工具（`wanxing_agent_deploy`）MUST 以「不可路由」失败，MUST NOT 伪装成功。

#### Scenario: 谦面市场动作以设备 token 执行

- **WHEN** 已连接谦面市场的用户批准「将包可见性改为 private」
- **THEN** 闸以该用户的 `facet-market` 设备 token 调用 `facet-market-mcp` 的 `facet_market_pack_visibility`，审计台账新增一条记录

#### Scenario: 萬星动作以用户 caller 键执行

- **WHEN** 已连接词元账号（wanxing-caller）的用户批准「暂停 agent」
- **THEN** 闸以该用户的 caller 键调用 `wanxing-ops-mcp` 的 `wanxing_agent_pause`，且绝不以 `registry` 令牌试探

#### Scenario: 未连接谦面市场时提议被拦截

- **WHEN** 未连接谦面市场的用户让副驾修改包可见性
- **THEN** preflight 失败，指引指向 `/settings/connections?panel=facet-market`，不调用任何工具

#### Scenario: 鉴权门 401 使凭据失效

- **WHEN** 已批准的萬星动作在 HTTP 层收到 401
- **THEN** 该用户的 `registry` 凭据置 stale，提案标记为执行失败，审计保留失败原因

#### Scenario: 尚不存在的部署工具不可路由

- **WHEN** 批准 `wanxing.agent.deploy`
- **THEN** 执行以不可路由失败，不调用任何服务器，提案标记为执行失败

### Requirement: 部署无关的 preflight

动作的目标 SHALL 在确认前完成 preflight：`target=cloud` SHALL 要求该用户已连接部署者凭据（`wanxing-deployer`）；`target=desktop:<seat>` SHALL 要求该机位已配对且在线，MUST NOT 要求计费键。preflight 失败 SHALL 阻止动作进入确认档位，并给出可操作的修复指引。

#### Scenario: 桌面部署不需要计费键

- **WHEN** 用户提议把 agent 部署到已配对的桌面机位
- **THEN** preflight 通过，确认卡不要求计费键

#### Scenario: 云端部署缺凭据被拦截

- **WHEN** 用户提议云端部署但未连接 wanxing-deployer
- **THEN** preflight 失败，动作不进入确认档位，提示去连接

### Requirement: 回执不冒充结果

闸 SHALL 区分已接受、已执行与执行失败三种状态，并向用户如实呈现。提议被接受但尚未执行时 MUST NOT 显示为成功；执行失败 SHALL 保留原动作与失败原因，允许重试或取消。

#### Scenario: 接受不等于成功

- **WHEN** 异步审批请求刚被创建
- **THEN** 看板与副驾显示等待批准，不显示已执行

### Requirement: 柏讯动作注册与风险三方一致

动作注册表 SHALL 登记柏讯八条动作：`wire.demand.submit`（write）、`wire.market.subscribe`（cost）、`wire.market.unsubscribe`（write）、`wire.dataset.create`（write）、`wire.artifact.publish`（write）、`wire.artifact.archive`（write）、`wire.dataset.correct`（write）、`wire.dataset.correction.revert`（write）。动作 id SHALL 与柏讯侧动作闸的登记逐字一致；每条的风险等级 SHALL 与其底层工具在柏讯两个操作 MCP 的工具面声明（`tool_risk`）一致。壹座 SHALL 维护一份该工具面风险声明的本地快照，并以自动化测试断言注册表与快照一致、快照覆盖全部写工具；任一不一致 SHALL 使测试失败并指明条目。柏讯侧存在但未在注册表登记的能力（如删除数据集、草稿创建、转正、对外分享）MUST NOT 经副驾执行。

#### Scenario: 风险漂移被对拍拦住

- **WHEN** 任一柏讯操作 MCP 的工具面把某写工具的风险从 `write` 改为 `cost`，而壹座注册表未同步
- **THEN** 快照刷新后对拍测试失败，输出中指明该工具名、工具面值与注册表值

#### Scenario: 未登记的柏讯动作被拒

- **WHEN** 副驾提议「删除数据集」
- **THEN** 闸以动作未注册拒绝，不调用任何柏讯工具

### Requirement: 柏讯写动作经用户凭据的单一执行路径执行

被批准的柏讯动作 SHALL 经壹座的统一执行路径、以**该用户自己的**柏讯凭据调用对应的操作 MCP 写工具，MUST NOT 使用平台凭据或他人凭据。该用户未连接柏讯凭据时，提议 SHALL 在 preflight 阶段被拦截并给出去连接指引，MUST NOT 进入确认档位。上游以 422 拒绝时，SHALL 将其逐字段错误原样呈现给用户，MUST NOT 改写、补全或代为勾选任何字段。执行中上游返回 401 时，SHALL 清除该用户的柏讯凭据缓存、将该提案标记为执行失败并提示重新授权。每次执行 SHALL 在壹座审计台账留痕，记录 MUST NOT 含凭据明文。

#### Scenario: 未连接时提议被拦截

- **WHEN** 未连接柏讯凭据的用户让副驾提交需求单
- **THEN** preflight 失败，提议不进入确认档位，用户看到「去连接柏讯」指引，未调用任何柏讯工具

#### Scenario: 订阅市场数据集二次确认并展示费用

- **WHEN** 用户让副驾订阅某市场数据集
- **THEN** 确认卡以二次确认档位呈现并显示费用影响面，用户确认后才以其柏讯凭据执行订阅，审计台账新增一条记录

#### Scenario: 上游 422 逐字段呈现

- **WHEN** 已批准的需求单提交被柏讯以 422 拒绝（含字段级错误）
- **THEN** 用户看到的失败原因与柏讯返回的字段级错误逐字一致，提案状态为执行失败，不自动重试

#### Scenario: 执行中凭据失效

- **WHEN** 已批准的柏讯动作在执行时收到上游 401
- **THEN** 该用户的柏讯凭据缓存被清除，提案标记为执行失败并提示重新授权，审计记录保留失败原因

### Requirement: 提议携带真实提议者身份

副驾经 `propose_action` 发起的提议 SHALL 以当前会话用户为提议者落账，使提议随后可被该用户（且仅该用户）批准或拒绝；preflight SHALL 以该用户身份判断线凭据连接态。壹座 SHALL 仅对「创建提议」接受来自本机内部通道的身份声明；批准、拒绝与查询 MUST 经完整的用户认证，MUST NOT 接受内部通道的身份声明。

#### Scenario: 副驾提议后 owner 可批准

- **WHEN** 用户在副驾中让模型提议一个柏讯写动作
- **THEN** 提议以该用户为提议者落账，该用户在确认卡上批准成功，另一用户尝试批准得到 403

#### Scenario: 非本机匿名调用创建提议被拒

- **WHEN** 非本机来源、不带用户认证的请求尝试创建提议
- **THEN** 请求被认证门拒绝，不落任何提议

### Requirement: 执行前用户补填参数且模型值一律丢弃

注册表条目 SHALL 可声明「须由用户亲填」的参数集合。对此类参数，闸在接受提议时 SHALL 丢弃模型提供的任何取值、确认卡 SHALL 以空输入呈现这些字段、全部必填字段填齐前确认操作 MUST 不可用；批准时 SHALL 仅接受声明集合内的键，并以用户填值合并后执行。`wire.demand.submit` 的「公开源 URL」与「公开数据声明」SHALL 属于此集合——壹座 MUST NOT 代填、代勾或采纳模型给出的合规取值。

#### Scenario: 需求单合规字段用户亲填

- **WHEN** 用户让副驾提交需求单
- **THEN** 确认卡含「公开源 URL」「公开数据声明」两个空字段，未填齐时确认钮不可点；填齐并确认后以用户填值执行提交

#### Scenario: 模型给的合规取值被丢弃

- **WHEN** 模型在提议参数中携带了 `source_urls` 与公开数据声明的取值
- **THEN** 确认卡上这两个字段仍为空，落账的提议参数不含模型给出的取值

#### Scenario: 批准携带未声明的键被拒

- **WHEN** 批准请求携带了不在「须由用户亲填」集合内的参数键
- **THEN** 批准被拒绝（400），提案保持待确认状态，不执行

### Requirement: 副驾 pack 不含柏讯写工具

官方「柏讯助手」pack 的工具白名单 SHALL 只含柏讯两个操作 MCP 的读工具；壹座 SHALL 以自动化测试断言官方 pack 的白名单与柏讯工具面声明的全部写工具无交集。使用该 pack 的副驾会话，其可见工具面 SHALL 恰为「pack 读工具 + 平台提供的 `propose_action`」。

#### Scenario: 柏讯助手工具面纯净

- **WHEN** 检查以「柏讯助手」为预设的副驾会话可见工具面
- **THEN** 只含该 pack 声明的柏讯读工具与 `propose_action`，不含任何柏讯写工具

#### Scenario: 向白名单加入写工具被 lint 拦住

- **WHEN** 有人把 `wire_demand_submit` 加入「柏讯助手」的工具白名单
- **THEN** 仓库测试失败并指明该工具名

### Requirement: 受闸动作可执行于 stdio 操作服务器

动作注册表中的动作 SHALL 能把其宿主 server 声明为一个 stdio MCP 服务器（操作员基线条目，含 env 声明）。执行器在批准后 SHALL 以 stdio 子进程方式连接该 server 执行底层工具：每次执行一个连接（initialize → callTool → close），子进程 env 由该 server 条目声明的 env 名单从部署环境变量解析（与 cell patch 同一解析口径）。执行所遇失败 SHALL 如实分类（凭据无效 / 网络不可达 / 上游错误 / 参数被拒 / 不可路由），MUST NOT 伪装成功。宿主 server 条目所需 env 缺失时，preflight SHALL 拒绝提议并给出可读原因（未配置），MUST NOT 进入确认档位。

#### Scenario: 批准后在 stdio 服务器上执行工具

- **WHEN** 用户批准一个宿主为 stdio 操作服务器的受闸动作
- **THEN** 执行器拉起该 server 子进程（env 按声明注入）、调用底层工具、关闭连接，审计台账新增执行记录

#### Scenario: 宿主 env 缺失时提议被拦截

- **WHEN** 某 stdio 宿主 server 的声明 env 在部署中缺失时提议其动作
- **THEN** preflight 失败并提示该服务器未配置，动作不进入确认档位，不拉起子进程

#### Scenario: stdio 执行失败如实分类

- **WHEN** 批准的 stdio 动作执行中子进程退出、连接失败或工具报错
- **THEN** 提案标记为执行失败并带原因分类，不出现假成功，审计保留失败原因

### Requirement: CRM 客服台发送动作注册

动作注册表 SHALL 注册 `crm.message.send`（底层工具 `messages_create`，宿主 server `chatwoot`，write 档 → 行内确认，target=cloud）：参数含会话 id 与消息内容，影响面模板呈现会话号与内容摘要。CRM 发送动作 SHALL 以**双凭据模式**执行：动作声明 `credentialRef: "chatwoot"`——已连接 chatwoot 凭据的用户以其**自己的**凭据执行（逐租户 BYOK，嵌入多租户形态）；未连接凭据的机器 owner（寻数 A 租户自用/自部署形态）SHALL 显式回落到部署级共享凭据（部署 env 注入）执行——回落是第一方例外，SHALL 在注册表声明中显式标注；已认证但未连接凭据的用户 MUST NOT 回落共享凭据，SHALL 在 preflight 被拦截并给出去连接指引。B 面（商家多租户）的用户凭据语义由此承接，A 租户共享语义保持向后兼容。发送类工具（`messages_create` / `messages_delete`）MUST NOT 进入 agent 可见工具面，agent 只能经 `propose_action` 提议发送；`messages_delete` 不注册受闸动作，MUST 以「不可达/未注册」如实失败。

#### Scenario: 发送提议走行内确认

- **WHEN** agent 经 `propose_action` 提议 `crm.message.send`（含会话 id 与内容）
- **THEN** 用户看到行内确认卡（含会话号与内容摘要），确认后才执行发送

#### Scenario: 共享凭据执行且审计无凭据

- **WHEN** 已连接凭据的用户批准一条 CRM 发送
- **THEN** 执行以该用户自己的 chatwoot 凭据调用 `messages_create`（写入其自己的租户）；未连接凭据的机器 owner 批准时以部署配置的共享凭据执行（写入 A 租户）；两条路径的审计记录均含提议者、批准者与参数摘要，不含任何凭据明文

#### Scenario: 未注册的删除动作不可达

- **WHEN** 提议 `messages_delete` 类动作
- **THEN** 闸以动作未注册拒绝，不调用任何工具、不进入确认档位

#### Scenario: 已认证未连接的用户被拦截而非回落

- **WHEN** 已认证但未连接 chatwoot 凭据的用户批准 `crm.message.send`
- **THEN** preflight 失败并给出去连接指引，不以其身份动用部署共享凭据

### Requirement: 提议参数按注册表声明校验与归一

注册表每个受闸动作 SHALL 逐字声明底层工具接受的参数名集合（`argKeys`）与其中的必填子集（`requiredArgs`），以工具源码签名为唯一真源；动作 MAY 为某参数声明别名（`argAliases`）。闸在接受提议时 SHALL 把模型给出的键名归一到声明名（逐字 → 驼峰/下划线对偶 → 声明别名），丢弃声明之外的键；归一后仍缺必填键（空白字符串视同缺失）的提议 SHALL 以 400 拒绝、MUST NOT 落为 pending 行，拒绝体 SHALL 列出缺失键与该动作的完整期望键名，使模型可在同一回合自纠。该校验 SHALL 位于 preflight 之后：缺凭据的提议仍先得到连接指引。平台提供给副驾的 `propose_action` 工具 SHALL 在其参数描述中逐动作列出声明键名并标明必填，MUST NOT 把参数描述为对闸不透明。

#### Scenario: 模型按惯用拼写提议可见性变更

- **WHEN** 副驾对 `facet.pack.visibility` 提议 `{ packId, packName, visibility }`
- **THEN** 落账参数为 `{ id, visibility }`（`packId` 归一为 `id`，`packName` 丢弃），影响面文案含该包 id 而非「undefined」

#### Scenario: 缺必填键的提议不落库

- **WHEN** 副驾对 `facet.pack.visibility` 提议 `{ packName, visibility }`，不含任何可归一为 `id` 的键
- **THEN** 闸返回 400，拒绝体列出缺失的 `id` 与期望键 `id, visibility`；`action_proposals` 不新增行，副驾可见的工具结果含该键名清单

#### Scenario: 缺凭据先于缺参数

- **WHEN** 用户未连接该线凭据，且提议体同时缺必填键
- **THEN** 闸以 preflight 失败拒绝并给出连接指引，而非参数键名清单

#### Scenario: 萬星动作驼峰拼写落到上游下划线参数

- **WHEN** 副驾对 `wanxing.agent.pause` 提议 `{ packId, agentId }`
- **THEN** 落账参数为 `{ pack_id, agent_id }`，与 `wanxing_agent_pause(pack_id, agent_id)` 签名一致，影响面文案不含「undefined」
