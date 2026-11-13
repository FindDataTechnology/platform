# Design — search-relay 上游切词元

## Context

relay 现状：`services/search-relay/index.js` 的 `poolSearch` 直连 SerpAPI
（keys.json `serpapi[]` 轮转+进程内冷却）；词元车道在 `ciyuan-lane-pool-failover`
后有 DB 冷却+轮转+BYOK。词元端点：`POST /v1/search` `{engine,q,num}` →
`{meta:{engine,latency_ms},results:[{title,url,snippet,position}],usage}`，
鉴权 `Authorization: Bearer <词元 key>`，BYOK 头 `X-Serpapi-Key`，来源头
`x-search-source`。relay 部署在 fd-prod ConfigMap 内嵌代码（subPath 挂载，
改代码须 rollout restart）。

## Goals / Non-Goals

**Goals**
- relay 对外契约零变化（cells/websearch-mcp/设置面板无感）。
- SerpAPI 供给与冷却只在词元；relay 降为准入归因层（token/日限/缓存/stats）。
- 切换可回滚：冷备直连窗口。

**Non-Goals**
- 不动 websearch-mcp、dsh-profile 注入链、设置面板交互（stats 字段增补除外）。
- 不删 scoped token 派生/日限/缓存（准入归因层职责保留）。
- 不做 relay 本身退役（退役冷备路径=本 change 尾段；relay 服务下线是更远期决策）。

## Decisions

**D1 relay 直调词元公网端点（token.finddatatech.cloud）而非集群内直连** —
词元在 sub2api ns、relay 在 fd-prod（不同节点），公网端点已是生产验证路径；
少一条集群内网络定制。代价是出一跳公网 TLS（内网两节点互联本来也走公网 IP）。
备选 k8s Service 直连被否：跨 ns/节点 hostNetwork 拓扑下不比公网稳，且引入
服务发现耦合。

**D2 映射极薄**：relay 发 `{engine:"serpapi", q:query, num}`，取应答
`results[]` 原样回（title/url/snippet 字段同名，position 忽略）；`num` 上限
沿用 relay 侧 1-10 夹取（车道上限 20，relay 收紧不影响）。信封 meta/usage
不透传（调用者契约没有它们）。

**D3 内部凭据**：词元建 internal 组（websearch 价目 0）+ 专用 key，relay
keys.json 新增 `ciyuan:{url,key}`；该 key 消费进词元用量账（可见性=行数）。
**不**用任何客户 key。词元侧若将来要真实成本核算，把 internal 组价目拧回
市场价即可，纯配置。

**D4 来源三态不变，冷备路由只进 stats** — 车道/冷备都属「池」供给，
调用者视角来源仍是 user/pool/pool-after-user-failure；冷备启用在 `/v1/stats`
加 `upstream:{mode:"ciyuan"|"direct-fallback",reachable,fallbacks}`，面板
加一行展示。备选「第四态来源头」被否：三态是 cells 与面板既有契约，路由细节
是运维事实不是调用者契约。

**D5 冷备判据**：车道请求 5xx/超时/401（配置错也算不可用）→ 直连路径接管
该请求；车道连续 N=3 次失败进入 60s 熔断（期间直接走直连，省一跳延迟），
恢复探测每 60s 一次真请求。直连 keys.json `serpapi[]` 在窗口期保留现有
新 key（顺带完成「换 key」既定动作）。

**D6 BYOK 透传不短路** — 用户 key 请求仍先带 `X-Serpapi-Key` 打车道（车道
侧实现优先/回退/标注），relay 不本地判断用户 key 有效性（避免双份判据）。
车道 BYOK 失败的回退语义由车道 `x-search-source` 透传，relay 原样回传。

## Risks / Trade-offs

- [新增一跳（relay→词元→SerpAPI）延迟 +40-80ms] → 缓存命中（演示流量占比高）
  不受影响；冷备熔断兜底。
- [词元发版窗口 = 搜索供给抖动] → 冷备直连接管；词元部署本身 Recreate 秒级。
- [keys.json 形状变更+secret 更新是运维动作] → 部署 runbook 写清（secret 目录
  挂载+kubelet 同步 ~1min+热重载，既有路径）。
- [ConfigMap 内嵌代码漂移] — relay 代码在 repo `services/search-relay/index.js`
  与 manifest ConfigMap 双份 → 切换实现以 repo 为源，manifest 用脚本重嵌
  （既有流程），runbook 注明。

## Migration Plan

1. 前置：`ciyuan-lane-pool-failover` 上产（BYOK+轮转可用）。
2. 词元 admin 配 internal 组+key（零代码）。
3. relay 代码改造（repo）+ manifest 重嵌 + secret 新形状（含新 SerpAPI key 进
   冷备数组）→ rollout restart → 探针：正常搜索、BYOK 三态、断词元（手动停
   车道账号）验冷备、stats 面板。
4. 观察一周 → 退役段（另开小 change 或并入本 change 尾任务）：删直连路径、
   secret 去 serpapi[]、面板文案、台账登记。
5. 回滚：恢复旧 keys.json（serpapi[] 常设）+旧 ConfigMap rollout——单服务
   Recreate，分钟级。

## Open Questions

- 冷备窗口时长（建议一周，按生产流量观察定）——不影响实现，运维节奏。
- relay 最终形态（长期是否并入 ops-console 或独立保留）——超出本 change。
