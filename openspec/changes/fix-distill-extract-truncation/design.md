## Context

蒸馏链路：`drain → distillOne → 分批 → sidecar /distill → engine.distill()`。引擎内部是若干次 LLM 调用（`coding_extract` 一次、reconcile 若干、subject judge 若干），每次调用由 sidecar 回传 `stage` 与 `prompt/completion tokens`。

现状的三个约束共同制造了「静默丢产出」：

1. `CodingMemoryExtractor(max_tokens=6000)`（`distiller/engine.py`）——抽取输出在这里被截断；
2. 截断后的 JSON 由 `json_repair` 兜底解析，解析失败时返回空数组，**不抛错**；
3. `distill-scheduler` 拿到 `facts: []` / `experiences: []` 后照常 `upsertDistillState` 推进游标。

三者叠加的结果：**一次被截断的运行与一次真的没内容的运行，在账本、日志、游标上完全同形**，且材料被永久跳过（游标已过）。

## Goals / Non-Goals

**Goals:**

- 让「可能截断」成为一个可判定、可记账、可重试的状态。
- 让被截断的批次不推进游标，材料下一轮还在。
- 让「顶到天花板的比例」与「每条材料的 token 成本」进指标面，支撑后续摊薄决策。

**Non-Goals:**

- 不改引擎的抽取提示词（那在 `hy_memory` 侧，不在本仓）。
- 不在本变更里加大 `CHUNK`（见 D4 的顺序约束）。
- 不改 L2 写入纪律与 supersede 语义。

## Decisions

### D1. 判定「可能截断」只看 completion 是否触顶，不看解析是否失败

sidecar 已经回传 `llm_calls[].{stage, prompt_tokens, completion_tokens, ok}`。新增的判定：

```
truncated = 存在 stage=='coding_extract' 且 ok!=false 且 completion_tokens >= max_tokens * 0.98
```

**为什么不看解析失败**：解析失败既可能来自截断，也可能来自模型输出畸形；把它当截断会让重试在畸形输出上无限循环。触顶是一个客观、离散、可复现的信号。

**为什么留 2% 余量**：不同 provider 的 completion 计数存在 ±1 的取整差异，严格相等会漏判。

**备选方案**：让引擎在截断时显式返回 `truncated: true`。更好，但需要改动 `hy_memory` 依赖的调用约定；本变更先用 sidecar 已上报的字段，等引擎侧愿意改再收敛。

### D2. 重试策略是「对半拆批」，最多一次

检测到截断时，把该批次对半拆开重发；两半都仍触顶则记 gap 并停止。

**为什么是对半拆而不是加 `max_tokens`**：`max_tokens` 上调会让每次调用的成本上限变高，而成本问题恰恰是固定提示词被反复购买——先拆批能把「一批 2 条」降到「一批 1 条」，最坏情况退化成「每条一次调用」，代价可算；上调 `max_tokens` 则回到「赌模型这次不截断」。

**为什么不重试多次**：两次仍触顶说明单条材料本身超出抽取能力，继续重试只是烧钱；记 gap 让它显形更诚实。

### D3. 截断失败时游标不动，正常空产出仍推进

- 触发截断且拆分后仍触顶 → `last_error = "extract_truncated"`，`gaps += 1`，**不写 cursor**；
- 未触顶的空产出 → 照常推进游标（这是「模型认为没内容」，不是失败）。

**风险**：如果某条材料永远触顶，游标会永久卡住、该 project 后续材料全部堵住。缓解：`gaps` 达到阈值（例如 3）时，把游标越过这一条并记 `last_error = "extract_truncated_skipped"`——**跳过要留痕**，而不是默默跳过。

### D4. 摊薄（加大 CHUNK）排在最后，且必须能引用前三条的指标

`CHUNK=2` 的现状使每条材料承担约 13,000 tokens；`chunk=20` 时约 1,300。差距是 10 倍，但只有在 D1–D3 生效之后才能安全地加大——否则每一次截断都会变成一次静默丢弃。

顺序写进 tasks：D1 → D2 → D3 → 指标 → 才允许改 `CHUNK`。

## Risks / Trade-offs

- **[重试让调用数上升，短期内花费变高]** → 只在检测到触顶时重试，且最多一次；短期成本上升是可观测的，替换掉的是不可观测的丢数据。
- **[`max_tokens*0.98` 的阈值在 provider 间可能漂移]** → 阈值走配置，且把「触顶次数」本身进指标；阈值错了会立刻表现为触顶比例异常高或为 0。
- **[游标卡死]** → D3 的 gaps 阈值 + 显式 `extract_truncated_skipped` 留痕。
- **[把畸形输出误判为正常空产出]** → 本变更不解决这一项，属既有行为；记录为 Non-Goal，避免扩大范围。

## Migration Plan

1. 先上指标（D1 的判定 + 计数），**不改任何行为**——观察真实触顶比例；
2. 比例确认非零后，再上重试与游标语义；
3. 最后才评估 `CHUNK`。
回滚：三阶段各自独立，回滚只需退对应开关（阈值设 0 等于关闭检测）。
