# fleet-blueprint-studio（delta）

## ADDED Requirements

### Requirement: 模型判据断言为三态，只有 pass 计入绿

断言闭集 SHALL 增加 `llm-judged` 一类：条目携带 `rubric`（自由文本判据，即原先的验收断言原文）。模型判决 SHALL 为三态之一——`pass`（判据满足）/ `fail`（判据不满足）/ `insufficient-evidence`（证据不足以判断）。SHALL NOT 存在第四态或隐含通过：解析不出的输出、模型不可达、超时一律归 `insufficient-evidence` 并如实记入报告，该断言不计绿。

#### Scenario: 证据不足不判绿

- **WHEN** 某 `llm-judged` 断言的证据（回合/报数/看板产物）为空或模型回答无法解析
- **THEN** 该断言记为 `insufficient-evidence`，试跑不绿，报告写明原因，不重试到"判绿为止"

#### Scenario: 判据只能看到已收证据

- **WHEN** 组装判定输入
- **THEN** 输入只含已收证据（回合标识、报数原文、决策项、看板产物）与 rubric，不含蓝图的自述段落——模型不得靠复读断言得分

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

判定 SHALL NOT 由该蓝图自身编制里使用的模型执行——已导出劳作的那条车道不得给自己打分。实现 SHALL 取与产出车道不同的模型（或独立 judge 车道），当无法区分二者时 SHALL 拒判并把该断言记为 `insufficient-evidence`，绝不静默自评。

#### Scenario: 同车道拒判

- **WHEN** judge 解析到的模型与产出岗位使用的是同一车道
- **THEN** 该断言不判绿、记为 `insufficient-evidence`，报告写明"judge 与产出车道相同，拒绝自评"

### Requirement: 模型判据有成本闸

单次试跑的 `llm-judged` 条数与单条证据的字符量 SHALL 有上限；超限 SHALL 如实拒（报告写明超限项）而不是静默截断或跳过。判定调用 SHALL 走既有 LLM 车道（不新造 provider 通道），且判据模型固定为便宜的判定档。

#### Scenario: 超限如实拒

- **WHEN** 蓝图声明超过上限条数的 `llm-judged` 断言
- **THEN** 试跑在判定阶段如实报超限并停在未判状态，不产生半截判决

## MODIFIED Requirements

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