# Tasks — fix-overflow-attribution

## 1. 证据采集（无行为变化）

- [x] 1.1 `collectTurn` 在 `request/context` 分支记 `contextWindow`（只认运行时值，缺失保持 null）
- [x] 1.2 `collectTurn` 在 usage 更新处记 `lastInputTokens = max(prev, input + cacheRead)`、`steps`、`toolResults`
- [x] 1.3 `contextPressureDetail()` 接收并在溢出时带上这四个字段；非溢出路径逐字节不变
- [x] 1.4 失败行保留已观测 usage：`settle` 的 reject 分支带 `usage`，并在 `detail` 标 `usagePartial: true`

## 2. 提前收口（开关，默认关）

- [x] 2.1 `FLEET_OVERFLOW_PREEMPT=1` 开启；默认关，行为与现状一致
- [x] 2.2 每次 usage 更新后判定 `lastInputTokens >= contextWindow × 0.95`，命中则按 `context_overflow` 收口（复用早停的 `settle` 形状与收尾补数车道）
- [x] 2.3 窗口为 null 时不判定（无窗口可算，保守不动）

## 3. 测试

- [x] 3.1 溢出失败 detail 四字段齐全；`contextWindow` 缺失时为 null（不回落到声明值）
- [x] 3.2 失败行带 usage 且 `detail.usagePartial === true`
- [x] 3.3 开关关闭：同样输入下回合不提前收口（跑满原预算）
- [x] 3.4 开关开启：达 95% 即收口、话术与 `context_overflow` 一致
- [x] 3.5 非溢出路径（正常成功 / 普通超时 / 早停）detail 与现状逐字节一致
- [x] 3.6 反证：把 `max(lastInputTokens, …)` 改回覆盖式 → 3.1 红；去掉 `usagePartial` → 3.2 红

## 4. 规格

- [x] 4.1 `cron-module` 回合收口条款 + 4 场景（已随 proposal 写入 delta）

## 5. 上线与观测

- [x] 5.1 已上产（2026-11-09 18:41Z，镜像 `sha-06866f0`，源 `89c5b0cce`，digest
  `sha256:63ba9fe0`，hkccr 与 ccr 实测同 digest）— ArgoCD 自动滚；舱内实测
  `lastInputTokens`(11 处) / `FLEET_OVERFLOW_PREEMPT`(2) / `partialTurns`(2) 均在；
  `test-fleet-context-pressure` 20/20、`test-worker-pool` 22/22 绿。
  **但「detail 真的出现在生产行上」还没等到样本**：部署后 11 分钟内该 cell 只有 3 个
  回合（1 ok / 1 upstream 502 / 1 budget_exhausted skipped），零 overflow。
- [x] 5.2 观测一窗：溢出回合按 `lastInputTokens / contextWindow` 分档（≥90% / 90–50% / <50%），确认"低 token 溢出"确实存在并点名模型
  → **已达（2026-11-09 20:12Z，镜像 `sha-806de87`）**，部署后 6 分钟就出现样本：
    两条生产行的 detail 为
    `{"kind":"context_overflow","lastInputTokens":163631,"contextWindow":128000,"usageSteps":5,"usagePartial":true,...}`
    与 `…162910/128000…`。
    **判读**：ratio = **1.28**——真到顶并超出 28%，不是「窗口被声明错」；5 步就撞墙说明是
    单轮内累积过大，不是步数爆炸。这两条正是旧镜像里要靠临时探针才拿到的那类事实，
    现在一个 `detail` 就答了。
  - 附带发现（未立项）：两条都落在 `glm-5.3-flash` 上（deepseek-flash 503 之后降级过去），
    而它实测窗口 128k、输入 163k 必爆——说明即使把 glm 降到队尾，仍存在把它选中的路径
    （模型漂移/降级链），值得单独查。
- [x] 5.3 决策：**暂不开 `FLEET_OVERFLOW_PREEMPT`（保持默认关）**
  - 近 6h 的成功回合里，输入分布（以声明窗口 128k 为分母）：`<50%` 41 条、`50–80%` 0、`80–95%` 0、`≥95%` **10 条**。
  - 那 10 条的模型侧表现是关键：输入 131k–168k、**输出恰好 128 tokens**（`out=128`）。
    即：超了声明窗口仍然被上游接受，但模型已无空间作答，吐了一个 128 token 的桩，
    回合仍记 `ok`。**这是「空壳成功」的新形状**，不是「接近上限但正常完成」。
  - 结论：0.95 阈值打到的正是这 10 条**伪成功**，把它们停掉是收益不是误伤；但同一条线
    也会打到「跑在更宽窗口模型上的合法回合」（131k–168k 被接受说明窗口因模型而异）。
    两件事现在分不开 → **先不开**，等 `out=128` 这类伪成功有独立判据（另项）再说。
  - 附带：`out=128` 精确等于某个上限，怀疑是上游 `maxTokens` 截断的痕迹，未证。
- [x] 5.4 读面口径（实现时偏离原任务，理由在下面）— 原任务写「排除 usagePartial 的行」，
  但那些 token **真扣了钱**，排除会**低估**花费。改为：**计入花费，并单独报出
  `partialTurns`**（`spendProjection` 各窗口与 allTime），让读面知道其中有半截快照。
  断言在 `test-fleet-context-pressure`；反证：去掉计数 → 红。
- [ ] 5.5 归档（`openspec validate --strict` 通过后）
