# Design — fix-decision-delivery-context

## D1 为什么"保留占位符"是对的，不是图省事

`buildFleetContext` **本来就有** `decisionDigest` provider：它把该岗位未送达的裁定渲染成
独立的一段（与报数、记忆同一条预算梯）。也就是说"裁定进上下文"这条路早就存在、早就有预算控制。

旧代码却在路由侧又拼了一份，还顺手把占位符删了——于是两件事同时坏掉：上下文没了、重组还在。

所以修法是**回到设计本意**：送达只负责"告诉这个回合它该干活了"，裁定由注入段带上。

## D2 为什么要判渲染器在不在

保留占位符的前提是"有人会展开它"。部署可能没有报数车道（`renderFleetContextFn === null`），
那时占位符会**原样进 prompt**——模型看到一串 `{{fleetContext}}`，而裁定根本没进去。

因此判据必须包含"渲染器在位"。这条判据抽成 `cron.keepFleetContextPlaceholder(prompt)`，
路由只调用它——将来第三条手拼 prompt 的车道也能复用同一判断，而不是各写一份 if。

## D3 为什么手动车道只给 persona

与该车道既有纪律一致（− edge-context、产物句柄同一条线）：
- **a2a**：另一个服务，本队上下文对它没有意义；
- **tool**：prompt 就是 JSON 参数，多一个字符即非法（既有铁律，测试逐字节钉住）。

## D4 送达标记为什么不跟着改

`markDelivered` 挂在 `engine.addOnFinished`，按**岗位**把该岗尚未送达的 approved/rejected 项
标记 delivered。它不看 prompt 内容，所以"保留占位符"与"预拼裁定"两种形态都不会漏标或重标。
这条是本次修复能保持低风险的关键：**改的是文案形态，不是送达语义**。

## R1–R4

- **R1 重复呈现**：保留占位符时不再拼 digest（`buildFleetContext` 会渲染它）——测试钉住"只出现一次"。
- **R2 无渲染器**：判据返回 false → 走旧的 `buildExecuteNowPrompt`（指令 + digest），裁定必达。
- **R3 无占位符模板**：与改动前逐字节一致（仍走 `buildExecuteNowPrompt`）。
- **R4 手动车道**：仅 persona 追加占位符；无渲染器时它不被展开（与 edge-context 的既有降级一致），
  指令仍在最前——不会因为没渲染器而丢裁定（裁定已拼在 `buildExecuteNowPrompt` 里）。
