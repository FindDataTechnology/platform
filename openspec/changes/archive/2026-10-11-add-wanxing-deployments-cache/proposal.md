# Proposal: add-wanxing-deployments-cache

## Why

萬星按万级设计（fd-wanxing program 切片①）。热路径病灶：facade 的
`resolveDeployment` 在**每次外部 A2A 回合、每次目录/卡片请求**上都全量拉取
`/api/packs/internal/deployments` 再线性扫 slug（`gateway/wanxing/index.js`）；公共目录
无分页。今天 3 个 agent 无感，几百个就疼（每次回合搬全表），万级必断。registry 条目
缓存已存在（60s/15s TTL，不动）。

## What Changes

- **部署台账快照缓存**（facade 内新模块）：TTL 刷新 + 单飞合并 + 源不可达时供陈旧
  （与既有 entryCache 语义一致）；slug Map 索引使 `resolveDeployment` O(1)、
  `listDeployments` 读缓存数组；陈旧超过硬窗（5 分钟）才降级 503，不产僵尸目录。
- **diff 纯函数导出**：`diffDeployments(prev, next) → {added, removed, changed}`，
  refresh 时可得台账变化——这是 fd-wanxing fleet-observer（切片③）bookkeeper 的
  地基，最小复制共享，②完成收敛单点。
- **公共目录分页**：`GET /api/wanxing/v1/agents` 支持 `page`/`page_size` 参数；不传
  参数保持全量（向后兼容 finddata 既有客户端），传参时分页并附 `total`。

## Capability Impact

- MODIFIED `wanxing-facade`：A2A 路由那条 requirement 增补「目录由台账快照伺服、可
  分页」的 SHALL 语言与场景（全场景按规则携带）。
- ADDED `wanxing-facade`：部署台账快照与变化检测 requirement。

## Non-goals

- fleet-observer 本体与事件流（fd-wanxing `add-fleet-event-backbone`）——本变更只交
  出 diff 函数这个地基。
- registry 条目缓存（已有，不动）；观测 API；ops-console fleet 板（切片④）。
- 台账数据的权威性变化：packs internal API 仍是部署真相，快照只是读路径缓存。
