# Design — add-facade-memory-read-lane

## Context

- as-built：`GET /memory` / `POST /forget` person-only（owner root 内解析）；`/admin/report` 已允许 runner/platform 带 rootKey 查任意 root——本刀把同一信任模式扩到可见性面，不新增权限等级。
- fd-wanxing facade 已持部署者鉴权与 registry 访问；fd-memory platform 令牌在生产 secret `fd-memory-platform`（挂载给需要平台缝的组件即可）。

## Decisions

### D1 rootKey 参数只对 platform/runner 族生效

- 两路由开头统一解析：person → 自身 root（rootKey 若带则拒绝，防降级）；platform/runner → 必须带 rootKey（缺失 400）；deployment/pod → 403（与现状一致，不因新参数开口）。
- rootKey 经 `rootForKey()` 打开对应 root——不存在则自动建（与 capture 行为一致）；越权面不存在（平台缝本就是全根信任）。

### D2 审计与调用面

- 平台缝调用的审计主体 = `platform:<tokenId>`（forget 行同既有格式）；GET 无审计（读面与 person 读一致不记）。
- 不加限速/白名单：与 /admin/report 同级信任，运维面靠令牌吊销兜底。

### D3 消费方接线（姊妹仓概要，不在本刀实现）

- facade 新 env：FD_MEMORY_URL + FD_MEMORY_PLATFORM_TOKEN（secret `fd-memory-platform` 注入）；
- console「记忆」页：部署者 → registry 解析其 packId 列表 → `/memory?rootKey=d-<packId>&scope=&layer=&since=` 聚合展示 → 行级 forget 按确认后调 `/forget?rootKey=`。

## Risks / Trade-offs

- [platform 令牌可 forget 任意根] → 与 /admin/report 同暴露面；审计行可追溯；令牌可吊销。UI 侧 forget 二次确认由姊妹 change 钉。
- [rootKey 拼错建空根] → 根创建幂等无害；facade 侧以 registry packId 派生正确键。

## Migration Plan

fd-memory 镜像重出 + 滚产（可与下次 fd-memory 发布同车）；无数据迁移。回滚 = 回镜像。

## Open Questions

（无）
