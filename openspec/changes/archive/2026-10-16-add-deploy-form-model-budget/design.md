# 设计 — 壹座部署表单补模型/回合预算输入

## Context

纯前端接线：部署 API 已接受 `models` / `budgets`（`gateway/packs.js` 1134/1242 起，含白名单→车道→roster 三道闸与 `MODEL_LANE_REJECTED` / `MODEL_NOT_IN_ROSTER` 错误码），萬星向导已暴露同款字段；本变更只动壹座侧四个文件面——`PackDetailDialog.tsx`（表单）、`packs-api.ts`（`deployPack()` 与 TS 类型）、五语言 locale、e2e。不改任何服务端行为。

## 决策

### D1 — 空输入 = 省略（该维度不动），不用 null；生效值三态

部署表单是**初始配置**面，不是配置编辑面。空输入 → 该 agent 不进 `models` / `budgets` 映射（与 rhythms 的既有纪律一致），生效值走既有优先级：**既有覆盖 → 包声明 → 平台默认**。重部署（升级）场景下既有覆盖存活（`CONTEXT.md` 服务配置词条「升级时已覆盖字段保留」；`lib/agent-serving.js:568-582` deployToRegistry 先铺 `existingState.configOverrides` 再叠请求映射），所以「空 = 声明/默认」只在首部署成立——提示语写中性三态「留空 = 维持现状」，不承诺「回落声明」。

**表单不读既有配置、不预填**（grill Q1=A）：与节奏字段现状同款；预填会引入「预填的 override」与「placeholder 的声明默认」两种来源混淆，且「预填后清空」在没有 null 语义的表单里无解（清空只能是省略=维持，反直觉）。清除既有覆盖是萬星服务配置面的事，不在本表单。

### D2 — 预算客户端校验挡提交；模型不挡

- **预算**：单一标量、规则纯本地可判（正整数 ≤120，`BUDGET_MAX_MINUTES`）→ 客户端复刻 `budgetMinutesError` 的规则（不是 import——web 与 lib 分属两个包边界，仓库先例是 RhythmEditor 复刻 `lib/rhythm.js` 规则、注释声明镜像关系），无效则禁提交并提示规则。**不学 rhythm 的「静默剔除无效项」**：rhythm 是列表、部分有效有意义；预算是标量，静默丢弃等于替用户改主意。
- **模型**：三道闸里只有白名单在表单时可知（manifest 就在手）；车道取决于部署键（可能还没贴）、roster 取决于落位 runner——**都不做客户端预判**，提交后服务端错误回显。白名单以 datalist 选项 + hint 呈现；声明的 `serving.model` / `serving.budget.turnMinutes` 作为 placeholder，让空输入的后果可见。
- **预算无声明时的平台默认**：`AGENT_RUNNER_TURN_TIMEOUT_MS`（默认 180s = 3 分钟，`agent-runner/config.js:138`，env 可调）——**文案不写死分钟数**（grill Q4：写死则 env 一调 UI 就撒谎），placeholder 写「留空 = 包声明的上限或平台默认」，3 分钟事实只记本文件备查。

### D3 — 错误本地化分支挂真码

`deploy()` 的 catch 已有按 `e.body.code` 分支的结构（`BILLING_KEY_INVALID` 等）；新增两个分支：`MODEL_LANE_REJECTED`、`MODEL_NOT_IN_ROSTER`，回显服务端 reason（已含 agentId 与可用模型列表）+ 本地化前缀；503 无码的「billing plane not configured」走既有 raw-message 兜底（与计费键错误同款呈现，不新造 key）。

### D4 — 字段落在既有 per-agent 覆盖块内

模型/预算输入加进 `pack-deploy-override-<agentId>` 块（rhythm 编辑器旁），不新开区块——部署区的 per-agent 行已是「该 agent 的部署选择」的自然聚合；「plain-language 副标题」由块内字段 label + hint 承担（见 specs delta MODIFIED 需求）。testid 沿用既有命名族：`pack-deploy-model-<agentId>`、`pack-deploy-budget-<agentId>`。

### D5 — `deployPack()` 追加可选参数

`deployPack(id, version, rhythms?, billingKeys?, models?, budgets?)`——只追加不重排，现有唯一调用方（`PackDetailDialog`）同批更新；请求体纪律与 rhythms 一致：非空映射才上 body。TS 的 `PackManifestAgent.serving` 补 `model?: string`、`modelWhitelist?: string[]`、`budget?: { turnMinutes: number }`（manifest 字段的类型层追认，无运行时影响）。

### D6 — 测试：e2e 走 registry-stub 链路断言落点

服务端行为不动，测试断言两件事：(1) UI 填了模型/预算 → 部署后 registry-stub 记录的 agent entry `metadata.effective_model` / `config_overrides` 正确（`agent-service-config.spec.js` 的 `entryOf` 模式直接复用）；(2) 空输入 → 描述符记录声明值/无字段（回归 D1）。无效预算挡提交断言「无请求发出」（`page.request`拦截或 stub 计数为零）。放新文件 `e2e/pack-deploy-config.spec.js`（服务器搭建照抄 agent-service-config.spec.js，UI 驱动照抄 packs.spec.js 的详情对话框动线）。

## 风险与边界

- **五语言 i18n**：`check:locales` 是 web:build 的前置步骤，漏一个 locale 构建即红——任务里单列。
- **key 名词三打架，新文案回避**（grill Q3=A）：术语表正名「部署键」、现有 UI 文案用「计量 key」、指南文档用「计费键」——本变更新增 hint 一律用「所用 key」等中性指称，不站队；「计量 key → 部署键」的同屏统一是独立的文案清偿，不混进来。本变更自己的文档（proposal 等）用术语表正名。
- **不改萬星控制台**：部署后编辑面（三态来源徽标 + lanes 提示）是另一套已完整实现，本变更不碰。
- **harness 不扩面**（grill Q5）：部署 API 的 `harnesses` 维持 API-only（萬星向导同样未暴露），避免本变更长出第二个头。
- **升级存续不重测**：空输入下既有覆盖存活是 `agent-service-config` 的升级存续（Overlay）语义，已有归属与测试；本表单只承诺「不发映射」，不重复背书服务端语义。
