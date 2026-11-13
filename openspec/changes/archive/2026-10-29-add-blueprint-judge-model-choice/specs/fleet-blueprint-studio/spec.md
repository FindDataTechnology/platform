# fleet-blueprint-studio（delta）

## MODIFIED Requirements

### Requirement: 模型判据断言为三态，只有 pass 计入绿

断言闭集 SHALL 增加 `llm-judged` 一类：条目携带 `rubric`（自由文本判据）。模型判决 SHALL 为三态之一——`pass`（判据满足）/ `fail`（判据不满足）/ `insufficient-evidence`（证据不足以判断）。SHALL NOT 存在第四态或隐含通过：解析不出的输出、模型不可达、超时、选定模型不在册一律归 `insufficient-evidence` 并如实记入报告，该断言不计绿。

**判定模型 SHALL 可按蓝图指定**（内容字段 `judgeModel`），未指定时取部署默认（`BLUEPRINT_JUDGE_MODEL`），再退到模型名册首个；回落 SHALL 逐级进行，报告 SHALL 记录实际使用的模型与落级来源，不得静默换用而不留痕。

#### Scenario: 证据不足不判绿

- **WHEN** 某 `llm-judged` 断言的证据（回合/报数/看板产物）为空、或模型回答无法解析、或选定模型不可达
- **THEN** 该断言记为 `insufficient-evidence`，试跑不绿，报告写明原因，不重试到「判绿为止」

#### Scenario: 判据只能看到已收证据

- **WHEN** 组装判定输入
- **THEN** 输入只含已收证据（回合标识、报数原文、决策项、看板产物）与 rubric，不含蓝图的自述段落——模型不得靠复读断言得分

#### Scenario: 蓝图自选评审模型

- **WHEN** 蓝图内容声明 `judgeModel: "<在册模型 id>"`
- **THEN** 判定用该模型，报告审计件的 `judgeSource` 记为 `blueprint`

#### Scenario: 未指定时逐级回落且留痕

- **WHEN** 蓝图未声明 `judgeModel`
- **THEN** 判定用部署默认模型（`judgeSource: "deployment"`）；部署默认也不可用时退到名册首个（`judgeSource: "fallback"`），并在报告里写明落级原因

#### Scenario: 指定了不在册的模型

- **WHEN** 蓝图的 `judgeModel` 不在本部署的模型名册里
- **THEN** 校验面（`/validate`）逐字段指名拒绝该蓝图；试跑若被强行触发，该断言记 `insufficient-evidence` 并写明「所选模型不在册」，不静默换模型

### Requirement: 判据不得自证（禁自我评分）

判定 SHALL NOT 由该蓝图自身编制里使用的模型执行——已导出劳作的那条车道不得给自己打分。判定 SHALL 取与产出不同的模型（provider+model 不相同；同名模型即便来自不同 provider 亦视为相同）；当无法区分二者时 SHALL 拒判并把该断言记为 `insufficient-evidence`，绝不静默自评。**该判定 SHALL 在蓝图级进行**：若蓝图显式指定的 `judgeModel` 与其产出岗位模型相同，SHALL 拒绝判定并在报告里指名冲突，SHALL NOT 自动改用别的模型（自动改会掩盖用户的选择错误）。

#### Scenario: 同车道拒判

- **WHEN** 解析出的 judge 模型与该蓝图产出岗位使用的是同一个模型
- **THEN** 该断言不判绿、记为 `insufficient-evidence`，报告写明「judge 与产出模型相同，拒绝自评」

#### Scenario: 用户选了与产出相同的模型

- **WHEN** 蓝图 `judgeModel` 恰是其产出岗位的模型
- **THEN** 判定被拒并指名这一冲突；校验面同时提示该选择会导致无法判定（不静默替换成别的模型）

## ADDED Requirements

### Requirement: 判定模型在校验面即验在册

蓝图的 `judgeModel` SHALL 在校验链（`/validate`、批准、铸造前的重校验）与模型名册比对；不在册 SHALL 逐字段指名拒绝（含该 id 与「可选模型在模型设置页」的指引），SHALL NOT 留到试跑阶段才暴露。

#### Scenario: 校验面拦截错模型

- **WHEN** 蓝图声明了一个名册里没有的 `judgeModel`
- **THEN** `/validate` 返回该字段的错误（entry 指到 `judgeModel`），批准动作被同一条件短路

#### Scenario: 合法模型不打扰

- **WHEN** `judgeModel` 在册或未声明
- **THEN** 校验链行为与本变更前一致（未声明时不做任何额外校验）