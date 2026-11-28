# fd-wire 递送：model_upstream 韧性实弹证据——降级路径零触发（镜像）

> 真源：`finddata/fd-wire/docs/paas-model-upstream-resilience-evidence.md`（2026-11-04，提出方 fd-wire/柏讯线）
> 本文件是投递到 paas 仓的镜像，内容以真源为准；状态：待评审。
> 对应：`fix-fleet-model-drift` 5.2（「真机验证挂账：等中毒再次复发」）、`fix-fleet-turn-attribution` §三/§四。

## 实弹观测（2026-10-28 上产后窗口，10-31 只读普查）

| 事实 | 数值 |
|---|---|
| 窗口内回合 | 199 条：ok 85 / 非 ok 114（**57.3%**） |
| 头号死因 | `model_upstream` **68 条**（67×503 + 1×502，token 网关 deepseek 窗口同源） |
| 降级触发 | **0 条** detail 带 `degradedTo` |
| 熔断开窗 | **0 条** `skipped`（§四 设计的开窗记录通道整窗未出一条） |
| 重灾区 | 识律政心监测舰 0/6 全非 ok；营销·官网内容舰 96 非 ok |
| 11-04 旁证 | ops 板 24h turns/errors=1552/1417（口径未对齐，仅证窗口仍在延续） |

对照：平台侧三缺口（可见性/0 秒 RNR/timeout 归因）验收全过，已回写 fd-wire ROADMAP-v2 Wave 0.1。

## 请壹座办理

1. 用 `fix-fleet-model-drift` 5.2 挂账场景收口——本窗口即「中毒复发」；
2. 回答降级为何零触发：触发条件未命中（<60s 快败 + 车道键解析）/ 配置未开 / detail 记录位遗漏，三选一或另述；
3. 若确认不咬合，立修复 change（验收：下次上游 5xx 窗口内出现 `degradedTo` 或熔断开窗证据，政心舰不再全灭）。

---

## 定谳回执（壹座侧 · 2026-11-04）

三假设逐一落定（取证面：代码复读 + 平台 API 分层重测 + 生产 pod 内 lane 探针），全文见真源 §四，此处摘要：

1. **`degradedTo` 零触发 = 链长 1 如实行为**：生产各岗解析链恒单跳（member.model==boot 默认 deepseek、fallbackModel 全 null、fleet defaultModel 全 null → 去重后无下一跳），降级腿门槛 `landedIndex+1 < candidates.length` 恒假；240h pod 日志 0 条降级 warn 实锤。要「5xx 即换模型」= 给岗位配 fallbackModel 的产品动作，非缺陷。
2. **`skipped` 零 = 接线活着、滑窗语义够不着 cadence**：pod 探针证实 lane 解析正常（deepseek-v4.1-flash → lane-01eb3e096d91165c）；真因=滑动窗 5/10min+10min 冷却 vs 回合节奏 ≥15min 错峰/小时级——攒不满窗、攒满（10-30T23:38 恰 5 条）也无回合落进冷却期。**已修=paas change `fix-llm-breaker-streak`（f665725f）**：streak 连续计数（间隔无关、成功清零关窗、探针再败前滚 openUntil）、冷却默认 2h、WINDOW_MS 废止；测试 408 全绿。
3. **`modelRectified` 零 = 自愈门死代码**：normalize 丢 explicitChain（drift 4.2 e2e 逮出），已红绿双证修复并随 drift 归档（fc46bf14），待与熔断 streak 同面出片滚产。

请办项对账：①=drift 4.2 收口（真机显现待复发窗）；②=本段定谳；③=`fix-llm-breaker-streak` 已立（上产后下个 5xx 窗内 skipped 或探针关窗证据为验收）；④=数据本稿自含。
