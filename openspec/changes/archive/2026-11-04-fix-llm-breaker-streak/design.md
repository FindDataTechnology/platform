# Design: fix-llm-breaker-streak

## D1 — 为什么是 streak 而不是「把窗调大」

纯配置路线（WINDOW_MS 调到 12h）治标不治本：
- cadence 谱系横跨 15 分钟（错峰下限）到每日（日报岗），**任何固定窗长都是对某一端 cadence 的赌注**——调到 12h 则 15 分钟级舰队在真故障里被过度熔断（5 次失败可合法来自 12h 内五个不同小时的独立故障，其中夹着成功也会被 streak 清零，滑窗却不会）。
- streak 的定义天然 cadence 无关：**「连续」**就是「中间没成功过」，这正是需求原句「连续失败达阈值」的语义。10-27 实现选择了滑窗，是对该句的一次未经论证的具象化。

## D2 — streak 的状态与清零规则

- `recordUpstreamFailure`：streak += 1；若 streak ≥ threshold（默认 5）→ openUntil = now + openMs。已开窗时再失败=把 openUntil 前滚（探针再败即再开，不要求重新攒满 5）。
- `recordUpstreamSuccess`：streak = 0；openUntil = null（成功即关闸，半开探测即成功——此语义不变）。
- `breakerState`：不再 sweep（无时间窗可清）；open = enabled && openUntil > now。
- **skipped 不喂 streak**（既有纪律）：熔断开窗期内触发的回合被跳过、不记账——否则开窗后永不收敛（成功才能清 streak，而 skipped 不产生成功）。开窗截止即强制回到探针节奏，是唯一的恢复路径，这是有意的。

## D3 — openMs 默认 2h 的取舍

- 下限约束：openMs 必须 ≥ 典型 cadence 才可能跳过至少一个后续回合（小时级 cadence 下 10min 窗永远错过）。
- 上限约束：恢复检测延迟 = openMs（探针只在期满后第一回合）。上游真愈而探针恰遇瞬时 504 → 再吃 2h 冷却，但概率低且 skipped 不伤岗位连败。
- 取 2h = 一次典型日班周期内至少两轮探针，且对 15 分钟级舰队的过度保护半径可接受（最坏连续 4 个 15min 被跳过≈1h）。
- env 可配，与既有三 env 同族。

## D4 — 与降级重试腿的关系（如实记录，不在本 change 修）

链长 1 时 `degradedTo` 腿够不着是**如实行为**（无下一跳可降），非缺陷；生产 94 条 model_upstream 全走此门=各岗单跳链的必然。若运营侧想要「5xx 即换模型」，那是给岗位/舰队配 fallbackModel 的产品动作（本机制对多跳链早已就绪），不塞进熔断 change。

## D5 — 重启语义

进程重启清空 Map——滑窗时代注释说「窗口一个 span 内重新填满即可再开」；streak 时代同理：持续故障里重启后最多再浪费 threshold 次撞墙即回到保护态。接受，注释如实改写。

## D6 — 测试策略

- 单测：同刻连击开窗（旧断言在 streak 下仍成立）、**间隔 3h 的三连击必须能开窗**（滑窗下必挂=红→绿双证的靶心场景）、探针再败前滚 openUntil、成功清零关闸、总闸。
- 缝测：`runPersonaTurn` 开道跳过=已有（attrCtx lane mock 不变）；记账断言字段名 failures→streak 同步。
- e2e 级：上产后真窗观测（tasks 5.2），无窗则沿 drift 先例以红绿双证收口。
