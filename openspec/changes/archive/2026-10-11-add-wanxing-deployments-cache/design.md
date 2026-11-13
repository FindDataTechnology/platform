# Design: add-wanxing-deployments-cache

## 病灶与不动区

- 病灶：`gateway/wanxing/index.js` 的 `resolveDeployment`/`listDeployments` 每次调用
  `packsInternalFetch("/api/packs/internal/deployments")` 全量 + 线性扫；A2A 回合、
  卡片、目录全部经它。
- 不动：`a2a.js` 的 registry 条目缓存（60s TTL / paused 15s 重读）已有正确形态；
  packs internal API 权威性不变。

## 快照模块 `gateway/wanxing/bookkeeping.js`

```
snapshot { at, rows[], bySlug: Map<slug, row> }
createBookkeepingCache({ fetchDeployments, ttlMs=15s, hardStaleMs=5min })
  - get() → rows（TTL 内直接回；过期触发单飞刷新，等不到就用旧值）
  - resolve(slug) → row | null（Map O(1)）
  - onRefresh(diff) 钩子（v1 仅日志；③接入后由 fleet-observer 消费）
  - diffDeployments(prev, next) 纯函数导出：
      added   = next 有 prev 无（键 = agentPath）
      removed = prev 有 next 无
      changed = 同键但行内容（agentId/packId/version 等序列化）不同
```

- TTL 15s：与 paused 反映时效（15s）同量级，runner 轮询本身也有滞后，部署可见性
  无需更快。
- 单飞：并发请求只发起一个刷新 promise，其余等结果（防惊群）。
- 陈旧语义：刷新失败 → 继续供旧快照；`Date.now() - at > hardStaleMs` → 目录/卡片
  路由回 503（沿用现有 `DEPLOYMENT_SOURCE_UNAVAILABLE`）。A2A 回合路径的 slug 解析
  不因陈旧 503——已有部署继续服务（部署真相 lag 的旧形态本就如此），只有「枚举面」
  （目录）硬降级。

## 目录分页

- `GET /api/wanxing/v1/agents?page=1&page_size=50`：`page_size` 上限 200，越界钳制；
  响应 `{ agents, page, page_size, total }`。
- 不传参数：全量（现状形状 `{ agents }`），finddata 既有客户端零破坏。几百 agent
  内全量可忍；万级时对外消费者的迁移是⑤门面的课题，不在本变更强推。

## 测试与验收

- 单测：TTL/单飞/陈旧/硬窗降级/diff 三桶正确性（含无变化）。
- 万级形态冒烟：合成 10k 台账行，`resolve` O(1) 常数时间、目录分页 p95 < 100ms。
- 既有 e2e（wanxing facade 套件）全绿——快照对行为唯一可见差异是枚举面陈旧窗。

## 与 fd-wanxing 切片③的衔接

- `diffDeployments` 是 fleet-observer bookkeeper 的地基：最小复制（同一纯函数两仓
  各一份，注释互指），②（facade 迁入 fd-wanxing）完成时收敛单点——program 文档
  硬依赖备忘已记。
