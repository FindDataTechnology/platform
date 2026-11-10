# fleet-blueprint-studio

## Purpose

垂直蓝图（vertical blueprint）从内部手艺变客户面产品的契约面：蓝图是与活集群独立的资产对象，
经「编辑→校验→批准→铸造→上架→试跑」六段走完一条可审计的产线。本规格钉三件事——
① 校验链复用（不立第二套校验器/第二上架通道/第二调度器）；
② 批准分两段（对话级显式批准 + apply 重校验兜底），未经批准零落地；
③ 试跑断言全绿是「可售态」的唯一真源。

边界：本能力治「包」（蓝图→集群模板→上架），活集群的现场编排归 `agent-fleet-core` /
architect 面——两处共享 fleet 段校验函数与起草批准纪律，但互不引写路径。

## Requirements

### Requirement: 蓝图是独立资产对象，fleet 段过既有模板校验

平台 SHALL 提供蓝图（blueprint）实体作为与活舰队独立的资产对象，承载垂直包的自描述内容：板块边界（名称/一句话用途/不做什么）、数据来源引用（仅 registry 在册 server 名或内部库逻辑名，**不得含端点/token/secret 任何凭据**）、岗位编制（岗位名、职责一句话、纪律 pack 引用、KPI 槽位、节奏声明、编导边）、看板与产物骨架、监控判据与 escalate 阈值、验收断言清单。蓝图的 fleet 段字段形状 SHALL 与既有舰队模板逐字段同源，SHALL 能直接通过既有 `parseFleetTemplate` 校验——**零翻译层**。

#### Scenario: fleet 段零翻译过校验

- **WHEN** 取任一蓝图 fleet 段提交既有 parseFleetTemplate
- **THEN** 校验通过且无格式改写；失败报错来自既有校验器原文

#### Scenario: 蓝图不含凭据

- **WHEN** 审阅任一新存储的蓝图
- **THEN** 数据来源引用行只出现在册 server 名或内部库逻辑名，无端点与凭据键

### Requirement: 工作室提供编辑→校验→diff 的工作面，草稿不落库

平台 SHALL 在 owner 面提供蓝图创作工作面，由 **智能体构建器工作区**统一承载（工作室的独立「团队结构」页签与独立蓝图构造间页面均退役，不再设第二编辑宿主）：蓝图创建与编辑（表单与 JSON 双轨，互相只读同步，不绕校验；三桶段经三桶卡编辑，蓝图专属段经表单编辑作为画布一等区块）、以自然语言生成蓝图草稿（**承袭构造师 pack 的编译能力**，仅作为草拟输入渠道，不引入第二个编译源）、草稿先经完整校验链与归一化 diff 再呈现给主人。工作文档 SHALL 自动保存为草稿池记录（乐观版本）；草稿池记录是创作面自身的存储，不属于下列禁落实体。**未经主人明确批准前，经面不得将草稿落地为任何实体**：市场上不出现新包、市场与铸造仓不出现新 manifest、实例化路径不出现新集群。

#### Scenario: 草稿先行、批准未至零落地

- **WHEN** 主人提交 NL 场景并产出的蓝图草稿尚未批准
- **THEN** 市场条目、铸造仓与集群库无任何新增；工作台只显示草稿与 diff

#### Scenario: 双轨编辑不绕校验

- **WHEN** 主人以 JSON 轨直接改岗位编制
- **THEN** 提交前该字段仍跑全套既有校验；直写不得绕过校验闸

#### Scenario: 团队模式承载蓝图专属段

- **WHEN** 主人在工作区编辑一份 team kind 文档的 boundary/dataSources/判据模型
- **THEN** 这些蓝图专属段在工作区画布内可编辑并随文档一起过完整校验链，且三桶段仍经共享三桶卡编辑

#### Scenario: 自动保存只落草稿池

- **WHEN** 主人编辑文档触发自动保存
- **THEN** 仅草稿池记录版本递增；市场/铸造仓/集群库零新增

### Requirement: 校验链复用，禁新立第二套

蓝图草稿与铸造前的全部校验 SHALL 复用既有校验链：`parseFleetTemplate`（fleet 段）→ 既有 `validatePackManifest`（manifest 段）→ 发布门 `allowTools ⊆ 商业集`（可携依赖声明复核）。错误回报 SHALL 逐字段指名并使用既有校验器原文语义——SHALL NOT 在该面另起第二套校验器或改写错误格式。每条 finding SHALL 在原文之外**附加**稳定机器码 `code`（新增字段，原文语义与格式不变），供展示面做本地化摘要；code 的生成 SHALL 与校验器同源，SHALL NOT 由展示面猜测。

#### Scenario: 非法蓝图逐字段拒绝

- **WHEN** 草稿含成环 handoff 边或含未备案 MCP 引用
- **THEN** 回报指名违规字段与所在行，错误文本与既有校验器生成件同源

#### Scenario: 校验不过的批准短路

- **WHEN** 主人对一份校验未通过的草稿点批准
- **THEN** 批准动作被拒并指名未过项；铸造/上架一律不发生

#### Scenario: 错误码供本地化摘要

- **WHEN** 展示面收到一条 finding
- **THEN** 其 `code` 稳定可映射为界面语言摘要；无 code 的存量件回落原文

### Requirement: 主人批准闸分两段纪律

批准 SHALL 按两段纪律执行：① 对话级纪律——主人对校验结果与 diff 的显式批准动作才可推进铸造；② apply 重校验兜底——铸造/上架动作在服务端对**批准时的同一草稿**重跑全套校验，且草稿与库状态漂移（如依赖 pack 已下架、蓝图草案被并发改写）时如实报错并拒绝执行。批准凭据（批准人、批准时间、diff 摘要）SHALL 记录为铸造追溯件。

#### Scenario: 批准走同一草稿再校验

- **WHEN** 批准后到铸造间隔中依赖 pack 被下架
- **THEN** apply 重校验发现漂移、报错拒绝，且不产生新的铸造或上架动作

### Requirement: 铸造与上架走既有发行通道，产物带追溯

铸造 SHALL 按既有形态产出集群模板 manifest：依赖占位 `{{PACK_ID:*}}` 补齐、`_casting` 段记录来源蓝图路径/草案版本/主取凭据与批准时间；上架 SHALL 只经既有市场发行通道（pack 发行门），市场条目标注模板归位（「集群模板」专辑/类目）。上架 SHALL NOT 引入与既有 pack 发行不同的第二上架路径；铸造产物在人工后续改写时按既有「用—养—传」纪律与构造链不冲突共存。

#### Scenario: 铸造产物的 `_casting` 完整

- **WHEN** 检查新上架模板的 manifest
- **THEN** `_casting` 段含来源蓝图路径、批准凭据与批准时间，依赖占位已逐项落实 packId

#### Scenario: 走市场同一门道

- **WHEN** 上架一封集群模板 pack
- **THEN** 该条目过既有发布门（工具面声明闭包与商业集闸），在集群模板专辑可见；未发现走另一通道的条目

### Requirement: 试跑验收为可售态的真源

模板首跑 SHALL 以蓝图验收段的断言清单执行「装一台跑一轮」试跑：机器断言按既有闭集判绿，模型断言按三态判决，报告逐断言记录证据（首回合标识、读数快照、产物 source_ref）与判决审计件，全量落盘可查。**可售态 SHALL 同时满足：机器断言全绿 + 所有 `llm-judged` 断言判 `pass` + 主人对该报告已签字。** 任一条件缺位，模板 SHALL NOT 进入可对外呈现/可售态；vendor（第三方）上架的模板 SHALL 强制带有可验收的试跑报告位（与供给开放单的 vendor 统计/分成字段对账）。

#### Scenario: 试跑断言全绿才可售

- **WHEN** 试跑中任一机器断言失败、任一模型断言非 `pass`、或签名缺位
- **THEN** 报告如实标出不绿，模板条目不进入可售态，市场不在「集群模板」专辑呈现对外购买路径

#### Scenario: vendor 模板带试跑位

- **WHEN** 某第三方提交一则模板欲上架
- **THEN** 上架前该模板携带可验收的经营报告位；缺位的上架在结构性闸被拒

#### Scenario: 全绿且已签字才放行收费上架

- **WHEN** 机器断言全绿、模型断言全部 `pass`、且 owner 已签该报告
- **THEN** 收费上架通过可售闸；三者缺一即 400 指名缺哪一项

### Requirement: 试跑收证窗口对在途回合自适应

试跑的收证等待 SHALL 在被点火岗位的回合**仍在队列中排队或执行中**时自适应顺延 deadline（按轮询
步进）——cell 的执行主链是全舰队共享的串行队列，繁忙 cell 上队列延迟可超过固定窗口；回合未得到
执行机会即判超时红是误判。顺延 SHALL 有**绝对封顶**（总窗不超过基础窗口的 2 倍）——卡死任务不得
把 trial 挂成无限等。发生顺延时 SHALL 在证据面如实记录顺延总量（`windowExtendedMs`）。回合真正
执行后（无论成败）SHALL 停止顺延——执行后的失败证据（车道熔断/上游 503 等）照常如实落红，窗口
顺延 MUST NOT 掩盖回合的真实失败。

#### Scenario: 深队列中回合在途而基础窗口到期

- **WHEN** fireRound 点火后基础窗口（10 分钟）到期，但该岗位的任务仍处于 queued/running
- **THEN** deadline 按轮询步进顺延，trial 不在回合获得执行机会前判红；证据面携带 windowExtendedMs

#### Scenario: 绝对封顶

- **WHEN** 在途回合持续超过基础窗口的 2 倍总时长仍未产出报告
- **THEN** trial 按诚实超时收证判红（不再顺延），不无限等待

#### Scenario: 回合执行后即停顺延

- **WHEN** 在途回合实际执行并失败（如车道上游 503）
- **THEN** 顺延立即停止，失败证据照常落红——窗口顺延不重试、不掩盖回合的真实失败

### Requirement: v1 方言如实拒绝，不归一化兼容

平台 SHALL 只接受蓝图格式 v2（`boundary` / `dataSources` / `board` / `acceptance` 结构化条目）。收到 v1 方言（出现 `vertical` / `sources` / `boards` 独有键，而对应 v2 键 `boundary` / `dataSources` / `board` 缺位）时，平台 SHALL 落一条指名 v1→v2 的错误并拒绝，SHALL NOT 归一化改写成 v2 形状后接受。

该拒绝 SHALL 分两处生效：
- **写入层**：v1 形状的 content 在任何写路径（创建/编辑，及未来写入方）上结构性不可存储，与「蓝图不含凭据」同级处理——拒绝且不落库。
- **校验链**：校验/批准/铸造入口同样拒绝；且该拒绝 SHALL **短路**后续校验链，只报这一条根因错误，SHALL NOT 叠加由方言错位派生的形状错（如逐条 acceptance 形状错与无字段归属的包级错）。

错误文案 SHALL 指名：本平台只接受 v2、v2 各段字段形状、格式真源位置、以及 v1→v2 的逐项迁移指引（`vertical{name,tagline,non_goals[]}` → `boundary{name,oneLine,outOfScope}`、`sources[].registryName` → `dataSources[].ref`、`boards` → `board`、自由文本断言 → 结构化断言条目）。

这与「未知断言 kind 拒绝而非猜测」同族：错方言必须被如实指名，不得静默猜测或静默转换。

#### Scenario: v1 蓝图写入被指名拒绝

- **WHEN** 主人把一份按 v1 字段名写的蓝图（`vertical` / `sources` / `boards` / 自由文本 `acceptance`）粘贴提交创建或编辑
- **THEN** 请求被拒（422），返回**一条**指名「蓝图格式为 v1，本平台只接受 v2」的错误，含 v2 字段清单与逐项迁移指引；库中不新增/不改写该蓝图

#### Scenario: 校验链只报根因，不报派生散错

- **WHEN** 对一份 v1 形状的蓝图执行校验、批准或铸造
- **THEN** 回报中只有这一条 v1→v2 错误；不出现逐条 `acceptance[N]` 形状错，也不出现无字段归属的包级错误

#### Scenario: v2 蓝图不受影响

- **WHEN** 提交一份按 v2 字段名写的蓝图（含 `boundary` / `dataSources` / `board` / 结构化 `acceptance`）
- **THEN** 创建、校验、批准、铸造全链行为与本变更前一致；即便该文档另带一个无害的旧键也不触发 v1 拒绝（判别要求 v1 独有键存在**且**对应 v2 键缺位）

### Requirement: 模型判据断言为三态，只有 pass 计入绿

断言闭集 SHALL 增加 `llm-judged` 一类：条目携带 `rubric`（自由文本判据）。模型判决 SHALL 为三态之一——`pass`（判据满足）/ `fail`（判据不满足）/ `insufficient-evidence`（证据不足以判断）。SHALL NOT 存在第四态或隐含通过：解析不出的输出、模型不可达、超时、选定模型不在册一律归 `insufficient-evidence` 并如实记入报告，该断言不计绿。

**判据没跑成与证据不足 SHALL 在审计件上可区分**。判决值不变（两者都是 `insufficient-evidence`、都不计绿、都绝不判红），但审计件 SHALL 在车道故障时记 `laneError = { status, kind }`，`kind` 取 `rate-limited`（429）/ `upstream`（5xx）/ `unreachable`（网络不可达）。反向约束同样成立：模型真判证据不足时审计件 SHALL NOT 带 `laneError`。二者处置方向相反——前者重跑即可恢复，后者要改证据或判据，混为一谈会把基础设施故障当成产品判定。

判决所用的模型解析 SHALL 按蓝图内容字段 `judgeModel` → 部署默认（`BLUEPRINT_JUDGE_MODEL`）→ 模型名册首个逐级进行；报告 SHALL 记录实际使用的模型与来源（`judgeSource`），不得静默换用而不留痕。

`judgeSource` SHALL 按**最终真正用于调用的模型**判定，而非按「是否命中了本 cell 的名册」判定：取到蓝图指定模型记 `blueprint`；取到部署默认模型记 `deployment`（**包括本 cell 名册为空、经部署 env 路由使用该默认模型的情形**——这是生产常态，不是回落）；只有在名册可见且确实不含部署默认、从而改用了名册首个时，才记 `fallback` 并写明实际使用的模型。来源为 `deployment`/`fallback` 而路径与常规不同时，SHALL 附 `judgeFallbackReason` 说明路由方式。

#### Scenario: 证据不足不判绿

- **WHEN** 某 `llm-judged` 断言的证据（回合/报数/看板产物）为空、或模型回答无法解析、或选定模型不可达
- **THEN** 该断言记为 `insufficient-evidence`，试跑不绿，报告写明原因，不重试到「判绿为止」

#### Scenario: 判据只能看到已收证据

- **WHEN** 组装判定输入
- **THEN** 输入只含已收证据（回合标识、报数原文、决策项、看板产物）与 rubric，不含蓝图的自述段落——模型不得靠复读断言得分

#### Scenario: 试跑证据点名集群身份

- **WHEN** 组装判定输入
- **THEN** 证据 SHALL 含本次试跑所用集群的名称与 id；判据原文提及「试跑集群」时模型能据以判断，不得因为证据从不点名集群而使此类断言恒判证据不足

#### Scenario: 模型输出带尾随噪声仍解析

- **WHEN** 模型返回的 JSON 对象之后跟有多余字符（如多一个引号或一句解释）
- **THEN** 判定 SHALL 从尾部向前尝试各个右大括号位置，取第一个可解析的对象作为判决；全部解析不出才归 `insufficient-evidence`

#### Scenario: 车道故障与证据不足可区分

- **WHEN** 判定调用因车道 429 / 5xx / 网络不可达而失败
- **THEN** 判决仍为 `insufficient-evidence`（不判绿不判红），审计件带 `laneError = { status, kind }`，界面显示「模型：未跑成（车道不可用）」而非「证据不足」

#### Scenario: 真判不足不带车道故障标记

- **WHEN** 模型正常返回并判定证据不足以支撑判据
- **THEN** 审计件 SHALL NOT 带 `laneError`，界面显示证据不足

#### Scenario: 蓝图自选评审模型

- **WHEN** 蓝图内容声明 `judgeModel: "<在册模型 id>"`
- **THEN** 判定用该模型，报告审计件的 `judgeSource` 记为 `blueprint`

#### Scenario: 未指定时逐级回落且留痕

- **WHEN** 蓝图未声明 `judgeModel`
- **THEN** 判定用部署默认模型（`judgeSource: "deployment"`）；部署默认也不可用时退到名册首个（`judgeSource: "fallback"`），并在报告里写明落级原因

#### Scenario: 名册为空走部署路由不算回落

- **WHEN** 本 cell 的模型名册为空（生产常态），部署默认已配
- **THEN** 判定经部署 env 路由使用该默认模型，`judgeSource` 记 `deployment`，`judgeFallbackReason` 说明「未列于本 cell 名册、经部署路由」，SHALL NOT 记 `fallback`、SHALL NOT 声称「回落到名册首个」

#### Scenario: 指定了不在册的模型

- **WHEN** 蓝图的 `judgeModel` 不在本部署的模型名册里
- **THEN** 校验面（`/validate`）逐字段指名拒绝该蓝图；试跑若被强行触发，该断言记 `insufficient-evidence` 并写明「所选模型不在册」，不静默换模型

### Requirement: 模型判绿是证据，主人签字是终审（双钥匙）

`llm-judged` 断言的绿 SHALL 需要两把钥匙同时在场：① 模型判 `pass`；② owner 对**该份试跑报告**显式签字（记录签字人与时间）。仅模型判绿而无签字的报告 SHALL NOT 计为可售；仅签字而模型未判绿同样不计。

#### Scenario: 只模型判绿未签字不可售

- **WHEN** 试跑报告机器断言全绿、`llm-judged` 断言模型均判 `pass`，但 owner 未签字
- **THEN** 该报告不是可售态；收费上架按可售闸被拒

#### Scenario: 签字后改报告即失效

- **WHEN** 已签字的报告被重新试跑覆盖
- **THEN** 新报告视为未签字，须重新由 owner 签

### Requirement: 判决可审计，原件随报告存档

每一条 `llm-judged` 判决 SHALL 在报告中留可复核的审计件：判据原文、所用模型标识、端点摘要、提示词摘要、证据摘要、模型原始输出、三态结论与判定时间。SHALL NOT 只存一个布尔结论。审计件 SHALL 随报告一同可读（与既有试跑报告同一存储位）。

#### Scenario: 复核一条判决

- **WHEN** 审阅任一已判过的 `llm-judged` 断言
- **THEN** 能读到当时的 rubric、模型、证据摘要与模型原始输出，并据此复算结论

### Requirement: 判据不得自证（禁自我评分）

判定 SHALL NOT 由该蓝图自身编制里使用的模型执行——已导出劳作的那条车道不得给自己打分。判定 SHALL 取与产出不同的模型（provider+model 不相同；同名模型即便来自不同 provider 亦视为相同）；当无法区分二者时 SHALL 拒判并把该断言记为 `insufficient-evidence`，绝不静默自评。**该判定 SHALL 在蓝图级进行**：若蓝图显式指定的 `judgeModel` 与其产出岗位模型相同，SHALL 拒绝判定并在报告里指名冲突，SHALL NOT 自动改用别的模型（自动改会掩盖用户的选择错误）。

#### Scenario: 同车道拒判

- **WHEN** 解析出的 judge 模型与该蓝图产出岗位使用的是同一个模型
- **THEN** 该断言不判绿、记为 `insufficient-evidence`，报告写明「judge 与产出模型相同，拒绝自评」

#### Scenario: 用户选了与产出相同的模型

- **WHEN** 蓝图 `judgeModel` 恰是其产出岗位的模型
- **THEN** 判定被拒并指名这一冲突；校验面同时提示该选择会导致无法判定（不静默替换成别的模型）

### Requirement: 模型判据有成本闸

单次试跑的 `llm-judged` 条数与单条证据的字符量 SHALL 有上限；超限 SHALL 如实拒（报告写明超限项）而不是静默截断或跳过。判定调用 SHALL 走既有 LLM 车道（不新造 provider 通道），且判据模型固定为便宜的判定档。

判定结果 SHALL 可缓存以避免重复计费：缓存键由 provider、模型与提示词摘要决定，命中件审计件须标 `cached: true` 并保留原始判定时间，不得冒充本次新判。**仅 `pass` 与 `fail` 可入缓存**：基础设施失败（`laneError`）与 `insufficient-evidence` 一律 SHALL NOT 缓存——它们要么重跑可恢复，要么取决于当次证据，缓存会把一次性故障固化成永久结论。

判定调用 SHALL 另受每 owner 每日配额约束；配额超限 SHALL 如实拒绝并计入报告，不得静默降级为证据不足。配额消耗 SHALL 只计真实发生的模型调用（缓存命中不算消耗）。

#### Scenario: 超限如实拒

- **WHEN** 蓝图声明超过上限条数的 `llm-judged` 断言
- **THEN** 试跑在判定阶段如实报超限并停在未判状态，不产生半截判决

#### Scenario: 基础设施失败不入缓存

- **WHEN** 一次判定因车道故障失败
- **THEN** 该结果不写入缓存，下一次试跑会重新调用而非复用故障结论

#### Scenario: 缓存命中不消耗配额

- **WHEN** 同一提示词与模型的判决在缓存有效期（默认 7 天）内被再次请求
- **THEN** 直接复用缓存判决并在审计件标 `cached`，不发起模型调用、不计入每日配额

### Requirement: 判定模型在校验面即验在册

蓝图的 `judgeModel` SHALL 在校验链（`/validate`、批准、铸造前的重校验）与模型名册比对；不在册 SHALL 逐字段指名拒绝（含该 id 与「可选模型在模型设置页」的指引），SHALL NOT 留到试跑阶段才暴露。

#### Scenario: 校验面拦截错模型

- **WHEN** 蓝图声明了一个名册里没有的 `judgeModel`
- **THEN** `/validate` 返回该字段的错误（entry 指到 `judgeModel`），批准动作被同一条件短路

#### Scenario: 合法模型不打扰

- **WHEN** `judgeModel` 在册或未声明
- **THEN** 校验链行为与本变更前一致（未声明时不做任何额外校验）

### Requirement: NL 起草可经蓝图构造师工具面直通草稿池

自然语言起草 SHALL 支持两条等价通道，产物进**同一**草稿池、走**同一**校验链：
①既有复制粘贴通道（studio 提示词 → 外部会话 → 粘贴回池）保留不删；②**builder 直通通道**——
蓝图构造师官方 pack 经其 bundled 工具面（`blueprint_draft`/`blueprint_validate`/`blueprint_save`，
openspec: builder-team-templates）在对话内组稿、校验、落池。直通通道 SHALL 复用既有校验链与错误
原文语义（禁第二套校验），落池的草稿与粘贴草稿在构造间 SHALL 无差别可见、可继续编辑；未过校验
的草稿 SHALL 拒绝落池。直通通道 SHALL NOT 改变批准闸纪律：未经主人在构造间明确批准，草稿不落地
为任何实体（既有「草稿不落库」纪律原样覆盖工具面来稿）。

#### Scenario: 两条通道产物同池同权

- **WHEN** 同一场景分别经粘贴通道与构造师直通通道各产一份草稿
- **THEN** 两份草稿在构造间草稿池无差别呈现，编辑、校验、批准、铸造路径完全一致

#### Scenario: 直通来稿同受批准闸约束

- **WHEN** 构造师经工具面落池一份草稿，主人未批准
- **THEN** 市场、铸造仓与实例化路径零新增，与粘贴通道的未批准草稿纪律逐字相同

#### Scenario: 粘贴通道不删

- **WHEN** 用户在无蓝图构造师安装的 cell 打开蓝图构造间
- **THEN** 复制提示词→粘贴回池的既有通道照常可用

### Requirement: 部署默认判据车道可探测

系统 SHALL 提供只读探测端点，回报本次部署若现在做一次模型判定会实际使用的模型、来源与可用性，供构造间在「跟随部署默认」时显示真实生效的模型，并供运维排查判据车道。

该端点 SHALL 与判据调用共用同一套解析逻辑（同一份来源判定），不得另立一套口径；无法解析出任何判据车道时 SHALL 如实回报原因（判为不可用且说明缺失项），不得静默返回空。

#### Scenario: 构造间回显真实生效模型

- **WHEN** 蓝图未指定 `judgeModel`，部署默认已配但不在本 cell 名册
- **THEN** 探测端点回报该默认模型、`judgeSource: "deployment"`、`unavailable: false`，并说明经部署路由；界面「跟随部署默认」处显示该模型名而非「未知」

#### Scenario: 无可用判据车道时如实说明

- **WHEN** 部署未配默认判据模型且名册为空
- **THEN** 探测端点回报不可用并写明原因（缺 LLM 路由），构造间据此提示「带 llm-judged 的试跑会报证据不足」

#### Scenario: 探测端点不被蓝图 id 路由吞掉

- **WHEN** 客户端请求 `GET /api/blueprints/judge-default`
- **THEN** 命中该专用端点，不被 `GET /api/blueprints/:id` 当成一个名为 `judge-default` 的蓝图

### Requirement: dataSources 可钉知识库 collection，实化成员即为 KB 型岗位
蓝图 v2 的 `dataSources` 引用面 SHALL 接受知识库 collection 作为合法数据源（与 registry 服务名/internal store 逻辑名并列的第三种引用种类，指名 collection）。校验 SHALL 拒绝指向不存在或不可见 collection 的引用并指名之。经该蓝图铸造并实化的团队，其钉了库的成员 SHALL 获得限定到所钉 collection（∪ shared，按 document-library-tools 的边界条款）的 library 工具访问；未钉库的成员不因同队成员钉库而获得访问。试跑 SHALL 与实化同边界，绿报告如实反映"该岗位确实用上了库"。

#### Scenario: 钉库蓝图过校验
- **WHEN** 提交一份 `dataSources` 引用本人某 collection 的蓝图
- **THEN** 校验绿，引用种类被承认为库引用，草稿面显示被钉集合名

#### Scenario: 悬空引用指名拒绝
- **WHEN** 引用的 collection 不存在或不属于蓝图作者可见范围
- **THEN** 校验落一条指名该引用的错误，蓝图不落草稿

#### Scenario: 实化成员获得限定库访问
- **WHEN** 钉库蓝图铸造的团队被实化并开回合
- **THEN** 钉库成员的工具名册含 library 四件、检索只覆盖所钉集合∪shared；同队未钉库成员不含这些工具或不可见该集合

#### Scenario: 跨部署面同边界
- **WHEN** 该团队经一键召唤进入智语房间，或整包含库引用部署到萬星
- **THEN** 成员在两侧车道的库访问边界与站内实化一致，包不携带库内容本体（引用的是部署者账号内的集合）
