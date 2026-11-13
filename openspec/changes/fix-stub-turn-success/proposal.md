## Why

24 小时里 **67 / 248 个回合（27%）报出的输出恰好是 128 tokens，且全部记 `ok`**——其中 62 条连模型都没落（`model=null`）。抽样看 `trace.db`：有的回合**一条事件都没有**（没有 assistant/message、没有 tool/result），可台账写的是成功。

现有的「空壳护栏」抓不到它：`hollowOk = ok && outcome.hollow === true && !usage && !hasAttribution`——它要求**完全没有 usage**。而这些回合恰恰有 usage（128 个输出 token），于是护栏不动作，一轮没干活的回合被判成成功，推进岗位在场、掩盖下一次同样的失败。

另有一个相关但不同的形状：10 条 `ok` 回合的输入 131k–168k（贴着/超过声明窗口 128k）、输出同样恰好 128 tokens——输入把窗口占满、模型没空间作答，吐了个桩。

两种形状共用一个判据缺口：**结算只看"有没有 usage"，不看"这一点点 usage 背后有没有任何产出"**。

## What Changes

- **桩回合不再计成功**：结算时若一个回合 `ok` 且 ①输出 token ≤ 桩阈值（默认 128）②没有文本产出 ③没有任何工具调用 ④没有报数，则改判 `interrupted`（可重跑、不推进在场），并在 `detail` 写明 `stubTurn: true` 与判定依据。
- 判定只覆盖**四项同时成立**的情形；任一项不成立（有文本 / 有工具 / 有报数 / 输出超阈值）行为与现在逐字节一致。
- `detail` 增加 `outputTokens` / `windowFull: true`（输入 ≥ 窗口 × 0.95 时），使"窗口塞满型"与"从未真跑型"在行数据上可分。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-fleet-core`: 回合结算的成功判据——空壳成功 SHALL 包含「桩输出」形态，不只是「完全没有 usage」。

## Impact

- 代码：`server/fleet-events.js`（`shapeTurnOutcome` 的 hollow 判据与 detail）、`server/cron-runner.js`（把 outputTokens/窗口占用传进结算）。
- 数据：无迁移。旧行不改写；新行多两个 detail 键。
- 行为风险（重要）：若某个正常岗位本来就只输出很短的话（例如只调一次 `report_status` 就结束），输出可能 ≤128 tokens **但有工具调用与报数** → 四项里两项不成立，不会误判。**真正需要盯的误判面**是「既不调用工具也不说话、只输出 ≤128 token 就算完成」的岗位——若存在，它本来就该被看见。
- 观测：`fleet_turns_read` 可按 `detail.stubTurn` 统计；通过率分母不再被桩回合抬高。
- 回滚：判据收紧是纯结算层，回滚=还原 `shapeTurnOutcome` 的这段（无数据副作用）。
