# Tasks

## 1. 断言闭集与归一化

- [x] 1.1 `server/blueprint-validate.js`：`TRIAL_ASSERTION_KINDS` 增 `llm-judged`；`normalizeAcceptance` 接受 `{ id, kind: "llm-judged", rubric, target? }`，`rubric` 必填非空串（缺则逐条指名拒）；`llm-judged` 否则不参与 `expect` 校验。
- [x] 1.2 ~~`normalizeIncomingContent`：finddata 自由文本归一为 llm-judged~~ **随 remove-blueprint-v1-compat 撤销**（2026-10-29 并行会话裁决：v1 方言如实拒绝、不归一化；自由文本断言须由作者显式改写为 `{kind:"llm-judged", rubric}`，平台不代转）
- [x] 1.3 上限常量与校验：单次试跑 `llm-judged` 条数（默认 8）、单条证据字符（默认 6000），超限在校验面即指名。

## 2. judge 实现（server/blueprint-judge.js）

- [x] 2.1 解析 judge 车道：env 指定模型（`BLUEPRINT_JUDGE_MODEL`）缺省取 cell 默认模型的便宜档；拿 `{ baseUrl, apiKey, model }` 与 `laneKeyFor()` 车道 id。
- [x] 2.2 组提示词：rubric + 已收证据（回合/报数/决策项/看板产物摘要）；**不含蓝图自述**；证据超字符上限即截断失败（如实报，不静默切）。
- [x] 2.3 调用 `/chat/completions`（非流式，`AbortSignal.timeout(60s)`），解析三态；解析不出/超时/不可达 → `insufficient-evidence` 并带原因。
- [x] 2.4 离群保护：判据输出必须落在 `pass|fail|insufficient-evidence` 枚举内，其余一律按 `insufficient-evidence` 处理并保留原文。
- [x] 2.5 审计件：`{ assertionId, rubric, verdict, model, endpointDigest, promptHash, evidenceDigest, rawVerdict, judgedAt }`；`apiKey` 只进哈希永不落盘。

## 3. 试跑管线接入

- [x] 3.1 `runTrial` 增 judge 阶段（机器断言判绿之后、落报告之前）；judge deps 可注入，缺省用 2.x 生产实现。
- [x] 3.2 禁自证：比对 judge 车道与蓝图编制岗位解析车道（含 production 侧 `fleetModelFor`/`resolveModelChain`），相同或无法解析 → 该断言 `insufficient-evidence` + 原因文字。
- [x] 3.3 `report.green` 语义扩展：机器全绿 ∧ 全部 `llm-judged` 判 `pass` ∧ 有签字；报告新增 `judged` 数组与 `signoff` 字段。
- [x] 3.4 断言逐条证据仍落（`turnIds/reportIds/sourceRefs`），判决审计件与证据并列入报告。

## 4. 签字与闸口径

- [x] 4.1 `POST /api/blueprints/:id/trial-signoff`：owner only；须有试跑报告；写 `reportSignoff = { by, at, reportRanAt }`；重跑覆盖报告时旧 signoff 作废（比对 `ranAt`）。
- [x] 4.2 `DELETE /api/blueprints/:id/trial-signoff`：撤签（owner），便于改判后重签。
- [x] 4.3 `gateway/pack-sellability-gate.js`：判绿口径扩为三条件，缺项 400 指名是哪种（`trial-not-green` / `trial-llm-not-pass` / `trial-signoff-missing`）。
- [x] 4.4 免费上架仍放行 + note（口径不变）。

## 5. UI

- [x] 5.1 试跑面板：逐条显示机器/模型断言、三态徽标、证据摘要、审计件可展开（模型/时间/原文）。
- [x] 5.2 签字按钮（有报告且未签字可点；已签字显示签字人与时间；重跑后自动回到未签字）。
- [x] 5.3 五语言新增键（`blueprints.judge.*` / `blueprints.signoff.*`），locale 闸绿。

## 6. 测试与验收

- [x] 6.1 三态解析：`pass` / `fail` / `insufficient-evidence`，含解析不出、超时、不可达三类失败路径。
- [x] 6.2 双钥匙四组合：仅机器绿 / 机器+模型绿未签字 / 三绿已签字 / 签字后重跑失效。
- [x] 6.3 禁自证：同车道拒判；无法解析产出车道时拒判。
- [x] 6.4 成本闸：超条数、超字符如实拒。
- [x] 6.5 跨仓：finddata 试点蓝图四条 free-text 归一后可判（假 judge 全 pass → 机器+模型绿；签字后收费上架放行）。
- [x] 6.6 反向断言扩展：judge 不新增 provider 通道（`scripts/test-blueprint-reverse-assertions.mjs` 加一则：`blueprint-judge.js` 只 import 既有 lane/model 解析，不自建 fetch 配置表）。
- [x] 6.7 `openspec validate add-blueprint-llm-assertions --strict` 全绿。
- [x] 6.8 生产实证：一条含 `llm-judged` 的蓝图跑完 → 审计件可读 → 未签字时收费上架 400 → 签字后 200。