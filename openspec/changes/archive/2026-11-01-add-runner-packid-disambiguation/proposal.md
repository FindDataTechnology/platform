# Proposal: add-runner-packid-disambiguation

## Why

add-runner-route-key-match 落地后，runner 路由按部署 agent 键匹配；跨包同名（`reception` ×3）歧义
诚实回退 `runner-ambiguous`——但同名包场景的用户从此用不了 runner。需求方拍板（2026-11-01）：
**方案 A——成员声明 packId**，同名键时精确钉到该包的部署；未声明且歧义维持诚实回退。

## What Changes

- `fleet_members` 加可选 `pack_id` 列（additive ALTER，null=不钉）。
- 成员 PATCH 面收 `packId`（可选非空字符串 ≤64 或 null 清除），memberView 透出。
- 物化链穿线：reconcile materializedSpec 带 `packId` + specDrift 原位改写；cron 任务记录持久化
  （addJob/updateJob/saveTasks 白名单——与 carrier 同款双通道）。
- `runnerEntryFor` 收 `packId`：多命中时以 path 段 `/packs/<packId>/` 过滤——钉中唯一 → 远端；
  钉后仍多（同包同键双部署）或钉不中任何条 → 维持 `runner-ambiguous` 诚实回退。调用侧传
  `job.packId`（物化值）。
- 无 packId 的行为逐字节不变（唯一命中照常、歧义照常回退）。

## Capabilities

### Modified

- `agent-fleet-carrier` — 执行路由需求 ADDED 一条 packId 消歧场景组（钉中/钉不中仍歧义/无 packId 不变）。
