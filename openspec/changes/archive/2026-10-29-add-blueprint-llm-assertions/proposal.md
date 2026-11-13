## Why

蓝图工作室的试跑断言目前只有四类**机器可判**的闭集（`post-materialized` / `first-round-fired` / `report-landed` / `escalate-bounded`），未知 kind 一律判不绿——这是刻意的：可售态的唯一真源必须是确定性的。但 finddata 的蓝图契约（`fleet-packs/blueprints/schema.md` v1）里 `acceptance` 是**自由文本**（试点「跨境电商政策盯梢」四条：「巡检员一个成功回合且 items_found 口径可对账」「主编日报合成且缺位如实标注」……），这类语义机器判不了。现状是跨仓兼容层把它们归一成 `kind: "free-text"` 并如实拒——蓝图能加载、能编辑，但**永远无法通过批准**，等于把内部方法论的既有资产挡在 studio 之外。

需要引入模型判据，但**不能因此把「断言全绿才可售」变成「模型说绿就可售」**。

## What Changes

- 断言闭集新增第五类 `llm-judged`（自由文本 rubric）：模型按 rubric 对**已收证据**给三态判决（`pass` / `fail` / `insufficient-evidence`），只有 `pass` 计入绿。
- **双钥匙闸**：`llm-judged` 断言除了模型判绿，还必须由 owner 对**该报告**显式签字（`reportSignoff`）。两把钥匙齐才算绿——模型判据是证据，人是终审。这把"确定性"重新钉回人身上，而不是假装模型确定。
- 判决必须**可审计**：报告落 `{ assertionId, rubric, model, endpointDigest, promptHash, evidenceDigest, rawVerdict, verdict, judgedAt }`，原件随报告存档。
- **反自证**：判据模型不得是该蓝图自己编制里的岗位模型（禁自我评分）；实现取「与产出车道不同的模型或独立 judge 车道」，无法区分时拒判并如实报。
- 证据接地：判定只喂**已收证据**（回合记录、报数原文、决策项、看板产物），不喂蓝图的自述——否则模型只能复读断言。
- 成本闸：单次试跑的 `llm-judged` 条数上限、单条证据字符上限、判据模型固定为便宜档；超限如实拒（不静默截断）。
- finddata 兼容层：`kind: "free-text"` 归一为 `kind: "llm-judged"`（rubric 即原文），成为可执行条目。

**BREAKING（无）**：四类机器断言语义零改动；`_casting.trialReport` 形状向后兼容（新增字段，旧报告无 signoff 视为未签字）。

## Capabilities

### New Capabilities

（无——本变更不引入新能力，扩的是既有 `fleet-blueprint-studio` 的断言与可售态契约。）

### Modified Capabilities

- `fleet-blueprint-studio`: 「试跑验收为可售态的真源」要求扩写——断言分机器判与模型判两类、模型判须三态且双钥匙签字、判据可审计、禁自证、成本闸；「校验链复用」要求补一句断言段在 `/validate` 即报（已落地行为的规格化）。

## Impact

- 服务端：`server/blueprint-validate.js`（闭集加 `llm-judged`、free-text 归一）、`server/blueprint-trial.js`（判绿后追加 judge 阶段、报告落审计件）、新增 `server/blueprint-judge.js`（judge 车道解析 + 调用 + 三态解析），`server/routes/blueprints.js`（签字路由 `POST /:id/trial-signoff`）。
- 市场侧：`gateway/pack-sellability-gate.js` 判绿口径扩展（机器绿 + 模型判绿 + 已签字）。
- UI：`web/src/pages/BlueprintStudioPage.tsx` 试跑面板显示逐条判决与证据摘要 + 签字按钮；五语言新增键。
- 配置：judge 模型选择（env，缺省走 cell 默认模型的便宜档）；条数/字符上限。
- 依赖：cell 的 LLM 车道（`LLM_API_KEY` / dsh profile）——与聊天同源，不新造 provider 通道。