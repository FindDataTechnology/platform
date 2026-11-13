## Why

`add-blueprint-llm-assertions` 落地时把 judge 模型钉在部署级 env（`BLUEPRINT_JUDGE_MODEL`）——换模型要改 GitOps + 滚版，且全平台只能有一个评审模型。2026-10-29 用户裁决：**这该是用户可选项**。不同垂直场景的判据性质不同（有的要严格、有的要宽松、有的要便宜），owner 应当为自己的蓝图选评审；运营侧仍保留部署级默认与兜底。

现网也证明了这个需求的真实性：`glm-5.3-flash` 上游 503、`nvidia/*:free` 404（需付费），只有 `deepseek-v4-pro` / `deepseek-v4.1-flash` / `cohere/north-mini-code:free` 可用——模型可用性随时变化，钉死一个值是脆的。

## What Changes

- 蓝图内容新增可选字段 `judgeModel`（判定该蓝图 `llm-judged` 断言所用的模型 id）。
- 判定模型解析顺序：**蓝图 `judgeModel` → 部署 env `BLUEPRINT_JUDGE_MODEL` → 模型名册首个**（逐级回落，任一级不可用即落到下一级并在报告里写落级原因）。
- **禁自证在蓝图级重算**：所选的 judge 模型不得等于该蓝图产出岗位的模型；相同则**拒绝判定**（`insufficient-evidence` + 指名原因），不静默换模型。
- 选定模型的可用性在**校验面**即检查（不在试跑时才发现）：`/validate` 对 `judgeModel` 做「在册」校验，不在册即逐字段指名。
- UI：构造间加「评审模型」下拉（roster 来自既有 `useChatStore().models`），标出与产出模型冲突的选项；试跑报告记录实际用的模型与落级原因。
- 审计件新增 `judgeSource`（`blueprint` / `deployment` / `fallback`）与 `judgeFallbackReason`。

**BREAKING（无）**：`judgeModel` 可选，未设时行为与既有完全一致。

## Capabilities

### New Capabilities

（无——扩的是既有蓝图能力的判定模型解析口径。）

### Modified Capabilities

- `fleet-blueprint-studio`: 「模型判据断言为三态」与「判据不得自证」两条要求扩写——判定模型可蓝图级指定、解析有回落链、禁自证在蓝图级判定、所选模型在校验面即验在册。

## Impact

- 服务端：`server/blueprint-judge.js`（`resolveJudgeLane` 接受蓝图指定模型 + 回落链 + `judgeSource`）、`server/blueprint-validate.js`（`judgeModel` 在册校验）、`server/blueprint-trial.js`（把蓝图的 `judgeModel` 传进判定）。
- UI：`web/src/pages/BlueprintStudioPage.tsx`（评审模型下拉 + 冲突提示）、`web/src/lib/blueprint-api.ts`（类型）。
- i18n：五语言新增键。
- 部署：`BLUEPRINT_JUDGE_MODEL` 从「唯一裁决」降为「部署默认」，语义保留（既有部署不需要改配置）。