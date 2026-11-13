## Why

`search-relay-via-ciyuan`（2026-10-15 上产，词元车道成为主上游、SerpAPI 降冷备）留了一段
规格内退役工作：**观察一周**（车道稳定、冷备 `upstream.fallbacks` 长期为 0）后删除直连
路径与 `serpapi[]` 冷备、隐藏面板 keys 段、台账与 spec 同步。原 change 的 3.3 是定时任务
（观察起点 2026-10-15），不能带着未到期的任务归档——本 change 承接该退役段，让原 change
即刻归档（规格其余部分已全部上产并验收）。

## What Changes

- **触发条件（到期判据，2026-10-22 前后复核）**：① 车道连续稳定无回退事故（stats
  `reachable=true`、breakerOpen 长期 false）；② 冷备接管计数 `upstream.fallbacks`
  长期为 0（或极低且均由演练产生）。
- 删 relay 直连路径与 `serpapi[]` 冷备（keys.json 只留车道凭据）；web-search 面板不再
  展示 per-key 冷却视图；台账与主 spec 同步退役事实。
- 台账 `docs/registry-maintenance.md`（或 search-relay 所在记录）补退役段。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `web-search`: 退役——直连路径与冷备 `serpapi[]` 删除后， SHALL 段收敛为车道单上游；
  面板 keys 段随冷备退役隐藏。spec delta 以 REMOVED/ MODIFIED 承接原 change 未退役段。

## Impact

- 代码：`services/search-relay/`（直连路径、serpapi 池与 breaker 的直连分支）、
  `web/src/components/settings/WebSearchSection.tsx`（keys 段）、
  `scripts/embed-search-relay-configmap.mjs`（keys 形状收敛）。
- 部署：search-relay configmap/secret 重嵌滚产；无 breaking（对外请求/响应契约不变）。
- 触发方式：用户届时说「退役 search-relay 直连」即可执行；到期未触发则在复检时提醒。
