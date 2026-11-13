# Proposal — fix-decision-delivery-context

## Why

「立即执行」是**主人亲手把一个裁定塞进岗位回合**——这条车道上的回合是全局里最重要的一类。
而它恰恰是上下文最少的那一类（explore P1-5）：

```js
const digest = renderDecisionSegment(deliverable);
const base = task.prompt?.includes("{{fleetContext}}") && digest
  ? task.prompt.replace(/\{\{fleetContext\}\}/g, digest)   // ← 决策段把占位符吃掉
  : `${task.prompt ?? ""}\n\n${buildExecuteNowPrompt(deliverable)}`;
```

- **模板带占位符**：决策段**替换**占位符 → 引擎的注入缝（只认占位符）判定"无需渲染"→
  该回合拿到裁定，却**一行舰队上下文都没有**（在岗多少、下级报了什么、自己上轮说了什么，全无）。
- **岗位无节奏任务**（手动送达车道）：`buildExecuteNowPrompt(...)` 直接当 prompt，**连占位符都没有**。
- 两条车道还各用一套文案：模板路径拼 `renderDecisionSegment`，手动路径拼 `buildExecuteNowPrompt`
  （后者=一句指令 + 同一段 digest）——同一个动作两种形态。

## What Changes

- 抽出**一个判据** `cron.keepFleetContextPlaceholder(prompt)`：模板带占位符 **且** 渲染器在位 → 保留占位符，
  让注入缝统一渲染（裁定随该段到达，**不再重复拼一份**）；渲染器缺席 → 不保留，直接拼裁定正文
  （否则占位符会作为字面量喂给模型，裁定丢失）。
- 手动送达车道（persona）的 prompt 补上 `{{fleetContext}}`，与非送达回合同等上下文。
- a2a / tool 不放宽：a2a 是另一服务、tool 的 prompt 必须纯 JSON。
- 送达标记**不动**：它由回合完成事件按岗位落定（`addOnFinished → markDelivered`），与 prompt 形态无关。

## Impact

- Affected specs: `agent-fleet-decision-lane`（1 处 MODIFIED：批复经注入管线送达原岗位）
- Affected code: `cron.js`（新增 `hasFleetContextRenderer` / `keepFleetContextPlaceholder` 两个只读判据）、
  `server/routes/fleets.js`（execute-now 拼接 + 手动车道）
- 无迁移、无新表；送达语义不变。
