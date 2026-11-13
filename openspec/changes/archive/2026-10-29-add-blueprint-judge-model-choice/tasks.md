# Tasks

## 1. 解析与审计（server/blueprint-judge.js）

- [x] 1.1 `resolveJudgeLane({ preferredModel })`：按 `preferredModel`（蓝图）→ env → 名册首个 三层解析，返回 `{ ..., judgeSource, fallbackReason }`。
- [x] 1.2 `judgeAssertion` 接受 `judgeModel`；透传到解析，并把 `judgeSource`/`judgeFallbackReason` 写进审计件。
- [x] 1.3 蓝图指定的模型不在册时：不静默回落，返回 `insufficient-evidence` + 指名「所选模型不在册」（与 D3 同族：错配置不猜）。

## 2. 在册校验（server/blueprint-validate.js）

- [x] 2.1 `validateBlueprint` 增 `judgeModel` 段：若 `content.judgeModel` 存在且不在名册 → 逐字段指名（entry = `judgeModel`），含「可选模型在模型设置页」指引。
- [x] 2.2 名册读取失败（providers doc 不可读）时**不阻断**校验（否则存储问题会让所有蓝图不能批准），降级为不校验并在 findings 里记一条提示。

## 3. 传递（server/blueprint-trial.js）

- [x] 3.1 `judgeAll` 把 `content.judgeModel` 传进 `deps.judge({ judgeModel })`。
- [x] 3.2 报告的 `judged[]` 审计件保留 `judgeSource`；顶层 `report.judgeModelUsed` 记录实际使用的模型（便于一眼看出）。

## 4. UI（BlueprintStudioPage + api client）

- [x] 4.1 构造间加「评审模型」下拉，roster 取 `useChatStore((s) => s.models)`；首项为「跟随部署默认」（空值）。
- [x] 4.2 与产出模型相同的选项打标（禁选 + 理由 tooltip）；不在册的当前值打标提示。
- [x] 4.3 试跑面板展示 `judgeModelUsed` 与 `judgeSource`。
- [x] 4.4 `blueprint-api.ts` 的 `BlueprintContent` 增 `judgeModel?: string`；`TrialJudgement.audit` 增 `judgeSource`/`judgeFallbackReason`。

## 5. i18n

- [x] 5.1 五语言新增 `blueprints.judge.model.{label,followDefault,sameAsProducer,notInRoster,used,source.*}`，locale 闸绿。

## 6. 测试与验收

- [x] 6.1 三层解析：蓝图指定命中 / 未指定走部署默认 / 部署默认不可用退名册首个，`judgeSource` 各自正确。
- [x] 6.2 蓝图指定 = 产出模型 → 拒判指名（不自评、不自动换）。
- [x] 6.3 蓝图指定不在册 → 判定 `insufficient-evidence` 指名；`/validate` 422 且 entry = `judgeModel`。
- [x] 6.4 名册不可读 → 校验不阻断（降级提示），既有蓝图仍可批准。
- [x] 6.5 未声明 `judgeModel` 的既有蓝图行为逐字节不变（向后兼容锁）。
- [x] 6.6 `openspec validate add-blueprint-judge-model-choice --strict` 全绿。
- [x] 6.7 生产实证：选与产出不同的模型 → `judgeSource: "blueprint"`；选产出模型 → 拒判指名；选不存在模型 → `/validate` 422。