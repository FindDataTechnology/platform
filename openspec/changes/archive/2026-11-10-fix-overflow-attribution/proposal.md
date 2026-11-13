## Why

`pi-ai detected context overflow` 在 12 小时里发生 **28 次 / 215 回合（13%）**，是当前最大的一类失败。但要判它「是什么」，昨天必须写三个临时探针去 `trace.db` 里捞 `platform/stream` 帧——因为失败行本身没有证据：

- `member_turn_events.usage_input` 恒为 `null`（回合在拿到 usage 之前就抛了）；
- `detail` 只有 `{kind:"context_overflow", contextPressure:true, compactions:1, overflow:true}`，**没有撞墙时有多少 token、也没有解析到的窗口是多少**。

补出来的分布说明这不是一种病：17 条能测到的里，**13 条撞墙在 ≥90k 输入**（声明窗口 128k，属真累积到顶），**4 条在 4.6k–9.6k 就溢出**（该模型实际供给窗口远小于声明值）。两种成因对应完全不同的处置（前者要压输入/减固定开销，后者要改模型目录），而现在数据上分不开。此外回合要烧 **160–454s** 才撞墙，中途没有任何预警。

## What Changes

- **溢出失败自带证据**：`detail` 增加 `lastInputTokens`（本回合见过的最大输入 token）、`contextWindow`（运行时实际解析到的窗口，缺失如实写 `null`）、`steps`、`toolResults`。只记录**见过的事实**，不推算、不用声明值冒充实际值。
- **失败行保留 metering**：回合抛错前若已有任何一次 usage 快照，`usage` 照常落库（现在整行全 null）。
- **接近上限提前收口（带开关，默认关）**：同一回合内某一步 `input + cacheRead ≥ 窗口 × 0.95` 时，按 `context_overflow` 提前收口并走同一条收尾补数车道，不再等上游报错或 600s。默认关，先跑一窗数据看误停率再开。
- **窗口来源单一化**：`contextWindow` 一律取运行时 `request/context` 的解析值；目录里的声明值不再参与回合判定（声明与实际不一致本身就是待查项，不能让它伪装成事实）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `cron-module`: 回合收口条款——溢出失败 SHALL 记录撞墙现场的输入 token 与解析窗口；SHALL 在接近窗口上限时提前收口（开关控制）；SHALL NOT 用目录声明值替代运行时解析值。

## Impact

- 代码：`server/cron-runner.js`（collector 记录 usage/窗口、提前收口判定）、`server/fleet-events.js`（detail 字段与 metering 传递）、`dsh-bridge.js`（如 `request/context` 未上抛则补一条只读访问）。
- 数据：无迁移；旧行保持 `null`（不回溯填造）。
- 行为：默认零变化（提前收口默认关）；开启后只在「已到窗口 95%」的回合上改变结局——最坏与原行为等价（仍按 `context_overflow` 收口），最好省下 100–400s 与一次上游 400。
- 观测面：`fleet_turns_read` / 卡面沿用 `detail`，无需前端改动；溢出可按 `lastInputTokens / contextWindow` 直接分档。
