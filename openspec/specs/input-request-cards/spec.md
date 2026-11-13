# input-request-cards Specification

## Purpose
把「AI 向人要一次输入」立为平台原语：任何 harness 上的 agent 都能提出一次结构化的填写或确认，请求以一行持久记录存在，由任意一个具备渲染能力的面呈现，并按明确的无人应答策略收尾，而不是把一个回合挂死在一张没人看的卡上。

## Requirements

### Requirement: 输入请求是一次普通工具调用，不依赖 harness 的问询能力

系统 SHALL 以一次 MCP 工具调用承载输入请求，调用方 SHALL 只观察到「工具挂起 → 返回答案或按策略收尾」这一形状。输入请求的能力 MUST NOT 依赖任何 harness 私有的问询或交互扩展：未提供此类扩展的运行时（含 ACP 系运行时）SHALL 仍能提出并完成一次输入请求。

挂起 SHALL 发生在平台侧，MUST NOT 依赖 harness 支持长时工具调用或会话内中断恢复。工具调用在等待期间 SHALL 可被取消，取消后 SHALL 以结构化结果返回而非超时错误。

#### Scenario: 无问询扩展的运行时也能问

- **WHEN** 一个运行在 ACP 系运行时上的 agent 调用输入请求工具，询问两个选项
- **THEN** 工具挂起并在任一具备渲染能力的面呈现该卡
- **AND** 用户作答后该工具返回答案，回合继续

#### Scenario: 取消不产生超时错误

- **WHEN** agent 在等待期间被取消或回合被中止
- **THEN** 输入请求以结构化「已取消」结果收尾，行状态标记为 cancelled
- **AND** 不产生超时类错误，也不把该卡留给下一个回合

### Requirement: 卡片声明受检且字段类型为封闭集合

每个输入请求 SHALL 声明卡类型（`form` / `confirm` / `choice`）、标题与字段列表。字段 SHALL 声明 key、label、类型与是否必填；字段类型 SHALL 限定为 `text` / `multiline` / `number` / `date` / `enum` / `boolean` / `file` 这一封闭集合。`enum` 字段 SHALL 同时声明可选值。系统 MUST 拒绝未声明类型或超出该集合的卡片，并以结构化错误指明越界项，MUST NOT 静默降级为纯文本。

提交的答案 SHALL 按键校验：缺少必填字段、`enum` 取值不在声明集合内、`number` 不可解析时 SHALL 拒绝提交并逐项返回字段错误，MUST NOT 落库半份答案。

#### Scenario: 未知字段类型被拒

- **WHEN** agent 提出一张含类型 `signature` 字段的卡
- **THEN** 工具返回结构化错误并指明该字段类型不受支持
- **AND** 不产生待办行

#### Scenario: 缺必填字段不能提交

- **WHEN** 用户在只填了一项必填字段的情况下提交
- **THEN** 提交被拒绝且逐项返回缺失字段
- **AND** 该请求仍停留在待答状态

### Requirement: 一次请求一行持久记录，先答者生效

输入请求 SHALL 以一行持久记录存在，至少保存：请求标识、所属会话与调用方身份、卡片声明、无人应答策略、到期时刻、状态、作答者与答案。待答状态 MUST NOT 只存在于进程内存：任一实例重启、客户端断连重连、或用户在另一台设备打开时，SHALL 都能从该行取回同一张待答卡。

同一个请求的多次并发应答 SHALL 只有第一次生效，后到者 SHALL 收到「已被他人作答」的结构化结果且 MUST NOT 覆盖答案。请求 SHALL 只从待答状态进入已答、已取消、已过期、已升级四态之一，终态不可再变更。

#### Scenario: 两端同时作答只生效一次

- **WHEN** web 与小程序同时对同一请求提交答案
- **THEN** 只有一个答案被落库并回灌给调用方
- **AND** 另一端收到已被作答的结构化结果，其界面转为该答案的只读摘要

#### Scenario: 换实例后仍能看到待答卡

- **WHEN** 用户在实例 A 提出请求后断连，随后连到实例 B
- **THEN** 实例 B 从持久行水合出同一张待答卡，用户可直接作答

### Requirement: 无人应答按声明策略收尾

每个请求 SHALL 声明无人应答策略，取值限定为 `wait` / `default` / `abort` / `escalate`，并 SHALL 声明到期时刻。到期时：`wait` SHALL 继续等待直到被作答或调用方取消；`default` SHALL 以卡片声明的默认值收尾；`abort` SHALL 以结构化「未获输入」收尾并终止该请求；`escalate` SHALL 将请求升级进入所属团队的拍板队列并把该行标记为已升级。

策略 SHALL 由请求携带，缺省时由团队/岗位策略决定。系统 MUST NOT 让一个请求无限期等待而无到期时刻。

#### Scenario: 无人面按策略升级

- **WHEN** 一个 A2A 调用的回合提出策略为 `escalate` 的请求，且 10 分钟内无人作答
- **THEN** 该请求进入该团队的拍板队列，行状态为已升级
- **AND** 调用方收到「已升级待人工处理」的结构化结果，而不是超时错误

#### Scenario: 无人面按策略终止

- **WHEN** 一个定时任务回合提出策略为 `abort` 的请求且无人作答
- **THEN** 请求到期即终止，回合以「未获输入」的结构化结果继续或失败
- **AND** 不留下永久的待答行

### Requirement: 答案以单一形状回灌调用方

请求完成后，系统 SHALL 以同一形状的答案对象回灌：按键的答案映射、终态（已答 / 已取消 / 已过期 / 已升级）与作答者标识。回合内等待的请求 SHALL 把该对象作为工具调用的返回值交回原回合；后台等待的请求 SHALL 以一条引用该请求标识的系统消息注入后续回合。

系统 MUST NOT 因为回灌方式不同而改变答案的形状或字段名。

#### Scenario: 回合内等待直接返回

- **WHEN** 用户在提出请求的同一回合内作答
- **THEN** 该回合的工具调用返回答案对象，回合继续执行

#### Scenario: 后台作答注入后续回合

- **WHEN** 提出请求的回合已结束、随后用户才作答
- **THEN** 系统以引用该请求标识的系统消息把同一形状的答案注入该会话的新回合

### Requirement: 面的渲染能力不影响请求语义

每个面 SHALL 依据自身能力渲染或降级同一张卡，且 MUST NOT 改变请求的语义、必填校验或终态集合。无图形界面的面 SHALL 以编号文本呈现字段与选项，并把下一条入站消息解释为答案；无法呈现的卡类型 SHALL 按声明的无人应答策略收尾，MUST NOT 静默丢弃。

#### Scenario: bot 通道以文本呈现表单

- **WHEN** 一张含两个文本字段的卡被投递到 bot 通道
- **THEN** bot 以编号提问逐个索取，下一条入站消息被解释为该字段的答案
- **AND** 全部字段收齐后按同一答案形状落库

### Requirement: 应答人受归属校验

系统 SHALL 只接受该请求归属用户的应答。公开分享会话与匿名访问 MUST NOT 具备应答能力，SHALL 返回结构化拒绝。当团队/岗位策略限定应答人时，系统 SHALL 按该限定拒绝非授权应答者。

请求归属 SHALL 由调用方所在的 harness 通道给出，且**不得由调用方自述**：dsh 侧由 per-user profile 注入会话归属；ACP 等 runner-carried 通道 SHALL 取该 agent 部署 descriptor 记录的部署者身份（`deployerEmail`），部署级 `INPUT_REQUEST_OWNER_EMAIL` 仅作兜底；两者皆空时系统 SHALL NOT 向该 agent 提供该工具（宁可不给工具，也不落一行无人能答的记录）。

#### Scenario: 分享会话不能代我拍板

- **WHEN** 匿名访客通过公开分享链接打开一个含待答卡的会话并尝试提交
- **THEN** 提交被拒绝并返回无权应答的结构化错误
- **AND** 请求仍停留在待答状态

#### Scenario: ACP agent 的请求归属其部署者

- **WHEN** 一个由 A 部署、harness 为 ACP 的 agent 调用 `request_input`
- **THEN** 落库的归属用户是 A，且只有 A 能应答；同一 runner 上由 B 部署的另一个 ACP agent 提出的请求归属 B
- **AND** 该归属不读取请求体里的任何身份字段

#### Scenario: 无归属来源时不给工具

- **WHEN** 一个 ACP agent 的 descriptor 没有部署者身份，且部署环境也未配 `INPUT_REQUEST_OWNER_EMAIL`
- **THEN** 该 agent 的工具面里没有 `request_input`，请求不会以空归属落库
