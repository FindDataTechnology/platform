# Design — add-blueprint-judge-model-choice

## 决策

### D1 三层解析，蓝图优先

`judgeModel`（蓝图）→ `BLUEPRINT_JUDGE_MODEL`（部署）→ 名册首个（兜底）。

理由：蓝图作者最清楚自己判据的性质；运营侧需要一个不改代码就能改的全局默认（现网 `glm-5.3-flash` 挂在 503 上时，运营要能一键换掉所有蓝图的口径）；名册首个是最后一根稻草，保证「名册里至少有一个能用的」时判定不会整体失能。

**回落必须留痕**：审计件加 `judgeSource`（`blueprint`/`deployment`/`fallback`）与 `judgeFallbackReason`。没有这两项，回落就是静默换模型——事后复核时无法解释「为什么这份报告用的不是我选的那个」。

### D2 禁自证在蓝图级重算，不自动换模型

用户选了与产出相同的模型时，**拒绝判定并指名冲突**，而不是自动换一个。

被否方案：自动 fallback 到下一个可用模型。看起来更"贴心"，实际掩盖了用户的选择错误：他以为用的是 A，报告上却是 B，而 B 的判定标准可能完全不同。宁可让这次试跑不绿、报错指到字段，让人去改。

### D3 在册校验放校验面，不放试跑面

`judgeModel` 不在册要在 `/validate` 就报（entry 指到 `judgeModel`）。理由与「未知断言 kind 拒绝而非猜测」同族：错配置要早暴露，试跑是重动作（装台+点火+一轮+判定），等到那时候才说"模型不存在"是浪费。

名册来源与既有模型面同源（`buildUserProviderEntries().models`），不新造清单。

### D4 部署 env 语义降级但保留

`BLUEPRINT_JUDGE_MODEL` 从「唯一裁决」变为「部署默认」。既有部署不需要改任何配置——未声明 `judgeModel` 的蓝图行为与现在完全一致。这让本变更天然向后兼容，也让运营侧的应急换模型能力保留。

### D5 UI：下拉 + 冲突预警，不阻断

构造间的评审模型下拉列出名册全部模型，对「与产出模型相同」和「当前不在册」两类选项打标（禁用 + 理由 tooltip）。不禁用保存——蓝图可以先选好模型再调岗位模型，硬阻断会打断编辑流；冲突在试跑时按 D2 拒判，在校验面按 D3 指名不能判。

## 备选与被否

- **只有蓝图级、去掉部署级**：应急时运营要改每一份蓝图，不可行。
- **只有部署级（现状）**：本变更要解决的问题。
- **按岗位级指定 judge**：过度设计——评审是对整份报告的判断，不是逐岗位。

## 涉及面（实施者锚）

| 面 | 锚 |
|---|---|
| 解析与审计 | `server/blueprint-judge.js` `resolveJudgeLane` / `judgeAssertion`（`judgeSource`/`judgeFallbackReason`） |
| 在册校验 | `server/blueprint-validate.js`（`validateBlueprint` 的 findings 增加 `judgeModel` 段） |
| 传递 | `server/blueprint-trial.js`（把 `content.judgeModel` 传进 `judgeAssertion`） |
| UI | `web/src/pages/BlueprintStudioPage.tsx`（下拉，roster 用 `useChatStore((s) => s.models)`）、`web/src/lib/blueprint-api.ts` |
| i18n | `web/src/locales/*/common.json`（`blueprints.judge.model.*`） |

## 验收闸

- `openspec validate add-blueprint-judge-model-choice --strict` 全绿。
- 单测：三层解析各命中、回落留痕、蓝图指定与产出相同 → 拒判指名、不在册 → 校验面指名。
- 生产：蓝图选一个与产出不同的模型 → 试跑审计件 `judgeSource: "blueprint"`；选产出模型本身 → 拒判并指名；选不存在模型 → `/validate` 422 指名。