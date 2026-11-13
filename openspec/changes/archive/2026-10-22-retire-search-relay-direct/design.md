## Context

词元车道上产后，SerpAPI 仅作冷备。原 change 的观察期任务（3.3）移入本 change，观察起点
2026-10-15（relay 启动日志 `upstream=ciyuan-lane, 1 standby serpapi key(s)`）。

## Goals / Non-Goals

**Goals**：观察期满且判据满足后，把直连路径、冷备 key、面板冷却视图、台账全部退役干净。

**Non-Goals**：不动车道本体与 BYOK 语义；不动对外请求/响应契约（调用者零感知）。

## Decisions

### D1 到期判据双门（缺一不退）

① 车道稳定（stats 面板 `reachable=true`、`breakerOpen=false` 长期保持，无回退事故）；
② 冷备接管计数 `upstream.fallbacks` 长期为 0 或仅演练产生。判据是**冷备已无存在必要**的
实证，不按日历盲退。

### D2 退役顺序（先观测后动刀）

1. 复检判据（stats+日志）；
2. platform 出片确认 2.1 面板行已在产（若中途已滚则跳过）；
3. 代码删除（直连路径/serpapi 池/冷却视图）→ 单测收敛 → 出片滚产（fd-build-channel 判路
   → 快照池）→ configmap/secret 重嵌（keys.json 只留车道凭据）；
4. 台账+主 spec 同步；本 change 归档。

## Risks / Trade-offs

- [车道突发不可用而冷备已退] → 判据②要求 fallbacks 长期为 0 才退；退后若词元车道故障，
  搜索工具降级为明确报错（调用者可见），不影响其他工具面。回滚=恢复 git 历史中的直连分支
  并重嵌 serpapi key（冷备 key 保留在台账记录中）。

## Migration Plan

见 D2。回滚=代码 revert + secret 重嵌。

## Open Questions

（无——判据与顺序已定，观察是唯一等待项。）
