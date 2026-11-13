# Design: add-runner-packid-disambiguation

## Context

需求方拍板（2026-11-01 AskUserQuestion）：方案 A——成员声明 packId。跨包同名现状（`reception`
×3）下用户无法用 runner（runner-ambiguous 诚实回退）；packId 绑定给同名场景一条精确路。

## D1 存储与穿线（与 carrier 完全同款的双通道）

- `fleet_members.pack_id TEXT`（additive ALTER，null=不钉）。
- PATCH 面：`packId` 可选非空字符串 ≤64 或 null（清除绑定）；memberView 透出。
- 物化：reconcile materializedSpec 带 `packId` + specDrift 原位改写；任务记录持久化
  （cron addJob/updateJob 白名单 + task-engine saveTasks/createManualTask）。
- 路由：调用侧传 `job.packId`（物化值）→ `runnerEntryFor({ packId })`。

## D2 匹配规则

多命中时以 `agentPathOf(entry)` 含 `/packs/<packId>/` 过滤：

- 钉后唯一 → 该 entry（远端执行）。
- 钉后仍多（同包同键多部署——结构性不应存在，诚实兜底）或钉不中任何条 → 维持
  `runner-ambiguous`（不猜测）。
- 无 packId → 行为本需求前逐字节等价。

备选被否：C 确定性优先序（字典序/官方优先）——猜错包的远端回合会静默跑到别人包的哨兵身上；
B 纯现状——同名场景永久不可用。

## D3 测试

test-fleet-carrier 两枚：钉中（双包同名 + packId → 精确命中、无 fail-open）；钉不中/未声明
→ 维持 ambiguous。
