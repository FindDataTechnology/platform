# Design — add-blueprint-llm-assertions

## 决策

### D1 确定性不交给模型，而是交回人：双钥匙

「可售态的唯一真源是确定性断言」这条不能因为引入模型判据而软化。做法是把可售条件拆成两把钥匙：

- **钥匙一（证据）**：机器断言全绿 + `llm-judged` 断言模型判 `pass`；
- **钥匙二（终审）**：owner 对**这份报告**显式签字。

模型判据是"这份产出大致符合判据"的专业意见，人是"我认这个结论"的责任落点。代价是多一次点击；换来的是「模型哪天抽风把不合格的包放上收费市场」这类事故不会发生，且责任可追。

被否方案：**只用模型判据**——把确定性寄托在"温度 0 + 固定模型"上是自欺（同一模型不同批次仍会漂，且供应商侧会升级模型）。

### D2 三态而非二态：`insufficient-evidence` 是头等公民

模型输出解析不出、证据为空、车道不可达、超时——一律归 `insufficient-evidence`，绝不"重试到绿"。这条同时防两个坑：一是判据惩罚随机性被当成不满足，二是把"没跑成"伪装成"不合格"。两种都不是绿，但报告要分清楚，主人复核时才知道该改蓝图还是修环境。

### D3 证据接地：只喂已收证据，不喂自述

判定输入 = `rubric` + 已收证据（回合标识/报数原文/决策项/看板产物的摘要与摘录）。**不喂蓝图的自述段落**（boundary/oneLine/persona）。理由：蓝图自述就是断言的复述，喂进去模型只会顺着点头，判决变成回声。

被否方案：把整份蓝图 + 全量证据丢进去——成本高、噪声大，且更上游的自述污染判定。

### D4 禁自证：judge 不得是产出那条车道

已导出劳作的模型不得给自己打分。实现用既有 `laneKeyFor(provider)`（`server/llm-lane.js`）比对：judge 车道 id 与蓝图编制中岗位解析到的车道 id 相同 → 拒判，记 `insufficient-evidence` 并写明原因。无法解析产出车道时同样拒判（宁可判不了，不可自评）。

被否方案：加"提示词里要求它客观"——提示词约束不是隔离。

### D5 判决可审计：留原件，不留结论

每条判决落 `{ assertionId, rubric, verdict, model, endpointDigest, promptHash, evidenceDigest, rawVerdict, judgedAt }`。`endpointDigest` 是 baseURL 的 sha256 前缀（`apiKey` 只进哈希、永不落盘，沿用 lane 键的既有纪律）；`promptHash`/`evidenceDigest` 让复核者能确认"当时喂的就是这些"。

被否方案：只存 `true/false`——那样报告就只是模型的一句话，无法复核也无法追责。

### D6 成本闸：条数、字符量、固定便宜档

单次试跑 `llm-judged` 条数上限（默认 8）、单条证据字符上限（默认 6000）、判据模型固定（env 可换，缺省取 cell 默认模型的便宜档）。超限如实拒并写明超限项——**不静默截断**：截断过的判决看起来通过，实际没判全。

### D7 finddata 自由文本的迁移路径（2026-10-29 修正）

原方案是把 v1 的 `acceptance: ["…"]` 自动归一成 `kind: "llm-judged", rubric: <原文>`。**该方案已撤销**：并行的 `remove-blueprint-v1-compat`（归档 `2026-10-29`）裁决「v1 方言如实拒绝、不归一化兼容」，理由是静默转换会让作者不知道自己在用旧格式。

现行口径：v1 蓝图在写入层即被 422 指名拒绝，返回 v2 字段清单与逐项迁移指引。作者把自由文本断言**显式**改写成 `{ id, kind: "llm-judged", rubric: "<原文>" }` 后即为可判条目——平台不代转，但改写成本很低（一条断言一行）。判决仍受 D1 双钥匙约束。

### D8 判定在试跑管线里的位置与可注入性

`runTrial` 顺序变为：装台 → 点火 → 收证 → **机器断言判绿** → **模型断言判定（judge 阶段）** → 落报告。judge 阶段失败不影响机器断言的证据；报告照样落，只是 `green=false`。

judge 依赖注入（与既有 `deps` 同款）：`judge({ rubric, evidence, lane })` → `{ verdict, raw, model, endpointDigest, promptHash, evidenceDigest }`。测试用假 judge，零真模型调用；生产实现 `server/blueprint-judge.js` 走 `/chat/completions`（与 `server/agent-session.js` 同款调用形状、含 `AbortSignal.timeout`）。

### D9 签字是报告级而非断言级

签字对象是**整份报告**（`reportSignoff: { by, at, reportRanAt }`），不是逐条断言。理由：逐条签字把主人变成点击机器；报告级签字配合"改报告即失效"（`reportRanAt` 变了 signoff 作废）已经足够，且与既有批准闸的粒度哲学一致（一次批准一份稿）。

## 备选与被否

- **模型判据 + 自动放行（无签字）**：见 D1。
- **判据用同一 cell 默认模型（不查车道）**：见 D4。
- **失败重试到绿（最多 N 次）**：把随机性换成"迟早会绿"，等于没有闸。
- **把自由文本断言交人工逐条勾**：可行但把成本转嫁给主人，且不留证据链；作为 `insufficient-evidence` 时的兜底手段保留（主人可手动改判并在签字备注里写明），不设独立通道。

## 涉及面（实施者锚）

| 面 | 锚 |
|---|---|
| 断言闭集与归一化 | `server/blueprint-validate.js`（`TRIAL_ASSERTION_KINDS` / `normalizeAcceptance` / `normalizeIncomingContent`） |
| 判定阶段 | `server/blueprint-trial.js` `runTrial` / `evaluateTrial` |
| judge 实现 | 新 `server/blueprint-judge.js`；调用形状抄 `server/agent-session.js:679`；车道键 `server/llm-lane.js` `laneKeyFor` |
| 签字路由 | `server/routes/blueprints.js`（`POST /api/blueprints/:id/trial-signoff`） |
| 可售闸口径 | `gateway/pack-sellability-gate.js`（判绿 = 机器绿 ∧ 模型绿 ∧ 已签字） |
| UI | `web/src/pages/BlueprintStudioPage.tsx` 试跑面板 + 签字按钮 |
| 既有测试范式 | `scripts/test-blueprint-trial.mjs`（注入式 deps）、`scripts/test-pack-sellability-gate.mjs`（纯函数分支） |

## 验收闸

- `openspec validate add-blueprint-llm-assertions --strict` 全绿。
- 单测：三态解析（含解析不出/超时/不可达）、双钥匙四种组合、禁自证、成本闸超限、改报告即失效。
- 生产：一条含 `llm-judged` 的蓝图跑完试跑 → 报告有审计件 → 未签字时收费上架被拒 → 签字后放行。
- 反向断言：判定不新增 provider 通道（走既有 LLM 车道）；不引入第二次模型判据实现。