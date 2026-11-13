## Why

萬星 console 要给部署者看自己 pack 的记忆（可见性 UI 的姊妹 change 在 fd-wanxing），但 as-built 的可见性面只有 person 令牌（owner root，u/ 族）——**部署记忆在 `d/<packId>` 根里，没有任何部署者可达的读车道**。fd-memory 不持有 packId↔deployer 映射（该映射真源在 registry 部署条目），所以正确的缝是：受信平台缝（platform/runner 族，与 `/admin/report` 同信任级）带显式 `rootKey` 调可见性面，映射解析交给调用方（facade 已持部署者身份与 registry 访问）。

## What Changes

- **可见性面平台缝车道**（fd-memory http.ts）：platform/runner 族令牌可带显式 `rootKey` 参数调 `GET /memory` 与 `POST /forget`（不带 rootKey 时行为不变——person 用自身 root、其余 403）；agent（deployment/pod）族 MUST NOT 获得该参数（继续 403）。
- **审计**：平台缝调用的审计行主体记 `<kind>:<tokenId>`（与既有审计一致），forget 语义（确认参数、逻辑删、真源保留）不变。
- **fd-wanxing 姊妹 change 的契约就绪**：facade 以既有 fd-memory platform 令牌（k8s secret `fd-memory-platform`）+ 部署者→packId 解析（registry）调本车道；本刀只开车道，UI 归姊妹仓。
- **明确不做**：fd-memory 侧不做 deployer 身份验证或映射解析（不引 registry 依赖）；不做写车道（forget 之外）；不做 UI。

## Capabilities

### New Capabilities

（无——扩展既有 `memory-visibility`）

### Modified Capabilities

- `memory-visibility`: 「owner 可按 scope/层/时间筛读」与「forget 带确认逻辑删」两需求补平台缝变体——platform/runner 族带显式 rootKey 可读写可见性面，agent 族仍拒；审计主体可辨。

## Impact

- fd-memory：`http.ts` 两路由 ~40 行（rootKey 参数 + 族判定）；单测 +2（平台缝带 rootKey 通、deployment 带 rootKey 仍 403）。镜像重出 + 滚产（与下次 fd-memory 发布同车亦可）。
- 消费方：fd-wanxing `add-memory-visibility-console`（姊妹 change，本仓 proposal 已另立脚手架）。
- 风险：platform 令牌泄漏 = 可读/可 forget 全部 root——与 `/admin/report` 既有暴露面等同，不新增权限等级；审计行可追溯。
