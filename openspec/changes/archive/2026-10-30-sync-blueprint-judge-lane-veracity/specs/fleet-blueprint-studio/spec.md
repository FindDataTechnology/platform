## MODIFIED Requirements

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

## ADDED Requirements

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
