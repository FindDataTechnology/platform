# Tasks — add-deploy-form-model-budget

## 1. API 包装与类型（web/src/lib/packs-api.ts）

- [x] 1.1 `PackManifestAgent.serving` 类型补 `model?: string`、`modelWhitelist?: string[]`、`budget?: { turnMinutes: number }`
- [x] 1.2 `deployPack()` 追加可选参数 `models?: Record<string, string>`、`budgets?: Record<string, number>`；非空映射才上请求体（rhythms 同款纪律），JSDoc 注明「空 = 声明/默认语义，部署表单不发 null」

## 2. 部署表单（web/src/components/packs/PackDetailDialog.tsx）

- [x] 2.1 per-serving-agent 状态：`modelDrafts` / `budgetDrafts`（与 `keyDrafts` / `overrides` 同族，keyed by agentId）
- [x] 2.2 `pack-deploy-override-<agentId>` 块内增两输入：
  - 模型：text input（testid `pack-deploy-model-<agentId>`）+ `modelWhitelist` datalist + hint（有白名单列白名单；无则「提交时按所用 key 的模型车道校验」——不点「计量 key/部署键」名词，grill Q3=A）；placeholder = 声明 `serving.model`
  - 预算：数字 input（testid `pack-deploy-budget-<agentId>`）；placeholder = 声明 `serving.budget.turnMinutes`，无声明则「留空 = 包声明的上限或平台默认」（不写死分钟数，grill Q4）；无效（非正整数或 >120）时禁提交并提示规则
  - 两字段空输入提示均为中性「留空 = 维持现状」（既有覆盖 → 声明 → 平台默认，grill Q1=A；表单不读不预填既有配置）
- [x] 2.3 `deploy()`：非空 modelDrafts/budgetDrafts 组装进 `deployPack()` 调用；成功后清 drafts
- [x] 2.4 catch 分支：`MODEL_LANE_REJECTED` / `MODEL_NOT_IN_ROSTER` 本地化前缀 + 服务端 reason 回显；503 无码走既有兜底
- [x] 2.5 客户端预算规则复刻 `budgetMinutesError`（注释声明镜像关系，RhythmEditor 先例）

## 3. i18n（web/src/locales/{en,zh-CN,es,fr,ja}/common.json）

- [x] 3.1 新 key：模型/预算 label、两条 hint（白名单版/无白名单版）、预算无效提示、两个错误码前缀、（如需）placeholder 文案
- [x] 3.2 `npm run check:locales` 绿

## 4. e2e（e2e/pack-deploy-config.spec.js，新建）

- [x] 4.1 服务器搭建照抄 preset-publish-flow.spec.js 的 route-mock 桩（`**/api/packs**` 有态替身记录部署请求体）——比 registry-stub 链更贴 UI 断言面；manifest 含 `modelWhitelist`、声明 `model`、声明 `budget.turnMinutes`（描述符落点由 agent-service-config.spec.js 既有覆盖背书）
- [x] 4.2 UI 动线：打开 pack 详情 → 部署区 → 断言模型/预算输入与白名单 datalist、声明值 placeholder 渲染
- [x] 4.3 填模型/预算 → 部署 → mock 记录的请求体断言 `models`/`budgets` 落对；模型闸拒（400 MODEL_LANE_REJECTED）与计费面未接（503）各自本地化回显且表单不被换掉（503 文案会误中 `/not configured/i` 分支的回归守卫）
- [x] 4.4 空输入 → 部署 → 请求体无 models/budgets/rhythms 映射（D1 回归）
- [x] 4.5 预算填 121 → 无效提示出现、提交禁用、无部署请求发出

## 5. 收口

- [x] 5.1 `npm run typecheck` 绿
- [x] 5.2 `npm run lint` 绿（biome）
- [x] 5.3 `npx playwright test --project=fast e2e/pack-deploy-config.spec.js` 绿；既有 packs / agent-service-config spec 无回归
