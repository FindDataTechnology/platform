## Context

- `collectTurn`（`server/cron-runner.js`）是唯一收集回合事件的地方：它已经把 `assistant/message` 的 usage 累加进 `usage`，把 `compaction/start` 计数进 `compactions`，并按 `OVERFLOW_RE`/`contextPressureDetail()` 给失败定性。缺口在于：**溢出时它没有一个"当前对话有多大"的量**，因为上游 400 发生时最后一个 usage 快照属于**上一步**。
- 运行时在每个回合开工时发 `request/context`，带 `{provider, model, contextWindow}`（`dsh-agent-loop` 的 `session.append("request/context", ...)`）；`platform/stream` 的 `usage` 帧带 `inputTokens/outputTokens/cacheRead`。两者都已落进 `trace.db`，但**没有进 collector 的内存**——所以昨天的分析只能事后从 trace 里捞。
- `recordTurnEvent()`（`server/fleet-events.js`）→ `meteringOf()` → `db.appendTurnEvent()` 是落库唯一通路；`metering.carrier` 等字段已在 `executionCarrier` 上，`detail` 由 `contextPressureDetail()` 生成。
- 早停（`maybeEarlyStop()`）已证明"在 collector 内部主动收口"这条路可行：同样的 `settle(reject, err)` + 压力口径 + 收尾补数车道。

## Goals / Non-Goals

**Goals**
- 溢出失败自带可判读证据（输入 token、解析窗口、步数、工具结果数），使"真到顶"与"窗口被声明错"在**行数据上**可分。
- 已观测到的 usage 不因抛错而丢。
- 提前收口具备开关，默认关，且与早停共用同一条收口车道。

**Non-Goals**
- 不改 dsh/pi-ai 的窗口判定（上游怎么算 overflow 是它的事）。
- 不做"按模型目录自动纠正窗口"——发现声明与实际不符是**产出物**，纠正要走数据修正（且需实测每个模型的真实窗口）。
- 不压缩会话历史、不改注入面（那是另一条线：工具面已经从 397 收到 15）。

## Decisions

**D1. 证据从 collector 内部采集，而不是事后查 trace。**
`collectTurn` 在 `assistant/message` 分支里已经解析 usage；在同一处记 `lastInputTokens = max(lastInputTokens, input + cacheRead)`。`request/context` 分支记 `contextWindow`（只认运行时值，缺失保持 null）。
- 备选：失败后回查 `trace.db`。否决——把观测耦合到存储可用性上，且多一次 I/O；trace 可能轮转。

**D2. `contextWindow` 只取运行时值，缺失即 null。**
目录里的 `contextWindow: 128000` 是**声明**；昨天那 4 条 4.6k–9.6k 的溢出正说明声明可能不是供给窗口。若用声明值填 detail，就等于把待查的疑点写成事实（"unknown is not empty"）。
- 备选：解析不到时回落到目录值并打标记。否决——标记会被读面忽略，最后仍然被当成事实。

**D3. 提前收口放在 collector 内、复用 `maybeEarlyStop` 的收口形状与开关风格。**
判定点：每次 usage 更新后，`lastInputTokens >= contextWindow * 0.95` 且开关开 → 走 `settle(reject, err)`，`err.earlyStop` 语义复用（收尾补数照旧）。开关 `FLEET_OVERFLOW_PREEMPT=1` 开启，默认关。
- 备选：默认开。否决——0.95 可能误停"最后一步只是恰好接近上限但能完成"的回合；先用一窗数据量误停率。

**D4. 失败行保留 usage：`settle` 的 reject 分支带 `err.usage`，`recordTurnEvent` 的 `usage` 从 `outcome.usage` 取。**
风险是"半截 usage 被当完整用量计费"；处置：只在 `detail.usagePartial: true` 时落库，让读面知道这不是整轮用量。计费面（pricing）保持现状——溢出回合本来就没定价。

## Risks / Trade-offs

- **误停**（D3）：0.95 阈值 + 默认关，先观测再开。误停的最坏结果与原行为等价（仍是 `context_overflow` 收口），但会少一次"可能成功的最后一步"。
- **`usagePartial` 被读面误当整轮用量**：需要读面（cost 汇总）显式排除 `usagePartial`，否则会低估成本。tasks 里钉一条。
- **窗口解析不到**（模型/通道差异）：detail 里 `contextWindow: null`，此时提前收口不生效（无窗口可算）——这是**正确**的保守行为，不是缺陷。
- 老镜像上 `request/context` 已存在，但若某些通道不走它，`contextWindow` 恒 null → 观测价值打折。用 4.6k–9.6k 那几条先验证。

## Migration Plan

无存储迁移。detail 只是 JSON 里多几个键，旧读面忽略未知键即可。回滚 = 关掉开关 + 保留证据字段（后者无行为影响）。

## Open Questions

- 0.95 是否是合适阈值？（先测一窗，看"接近上限但成功"的回合有多少）
- 4 条低 token 溢出里，有没有 provider 侧把 `prompt too long` 误报成别的错误？取一条完整 payload 复核。
