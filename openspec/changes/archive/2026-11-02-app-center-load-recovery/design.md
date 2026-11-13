## Context

AppCenterPage 以两个 `useListCache` 读（`catalog`、`connections`）驱动，二者失败各自静默回落（见 proposal.md - Why）。`useListCache` 的 `status` 已区分「冷失败」与「有缓存的后台失败」：catch 里 `setStatus(listCacheGet(key) !== undefined ? "loaded" : "error")`——即有缓存时失败仍报 `loaded`，无缓存时失败报 `error`。缺的只是页面侧对 `error && data===null` 这一形态的呈现与重试。`states-kit` 已有 `ErrorState`（含 onRetry），批②六面在用。

## Goals / Non-Goals

**Goals:**
- 冷失败（无缓存 + 拉取失败）呈现错误态 + 重试，不再半屏静默。
- 有缓存的后台失败维持静默（不破页教义保留）。
- 首次冷失败自动退避重试一次，减少用户干预。

**Non-Goals:**
- 不改 `listCache` 的进程内 Map 本质（不引入 localStorage 持久化——身份泄漏面，`web-list-surfaces` 已明令不跨身份）。
- 不改 `connections` 读的姿态（它只影响徽章，本就应静默，`app-center` 既有条文）。
- 不给其他列表面（集群/智能体）铺重试——本次只改应用中心；泛化留待后续。

## Decisions

**D1 冷/静默双姿态由页面侧判 `status==="error" && data===null`，不改 hook 契约。** AppCenterPage 现读 `catalog.status`/`catalog.data`。新增分支：该形态成立 → 产品区渲染 `ErrorState`（testid `app-center-load-error`，onRetry=`catalog.refresh`），品牌卡照常。备选：在 hook 内塞 `isColdError` 派生态——被否，页面已握有 status+data，加派生态是冗余。

**D2 自动退避重试一次放 `useListCache`，以 opt-in 选项 `{ coldRetry?: number }` 注入，默认 0。** 仅 AppCenterPage 的 catalog 读传 `coldRetry: 1`（失败后 ~1.2s 再拉一次，仍失败才 `setStatus("error")`）。默认关闭 → 其他调用方零行为变化。在飞请求用 ref 去重，防 focus 重校验与退避重试叠加双拉。备选：页面侧 useEffect 监听 error 重试——被否，退避计时属数据读取关注点，归 hook；且页面 effect 会漏掉「重试按钮」共用的 refresh 路径。

**D3 复用 `states-kit.ErrorState` 与 `common.retry` 文案，新增 `appCenter.loadError` 标题键五语。** 与批②门面词汇一致，不新造错误卡形态。

## Risks / Trade-offs

- [退避重试撞上真·服务端故障 → 多一次无效请求] → 封顶一次、延迟 1.2s，成本可忽略；换来网络抖动类瞬时失败的免干预自愈。
- [`coldRetry` 选项被误用于高频轮询面] → 仅 catalog 一处传参，单测钉默认 0（其他 key 行为不变）。
- [错误态与骨架首帧的边界（首帧加载中 vs 冷失败）] → 判据互斥：`status==="loading"&&data===null` 出骨架（既有），`status==="error"&&data===null` 出错误态（新增），不重叠。

## Migration Plan

纯前端，无数据迁移。回滚 = 回退镜像。验收：e2e 拦 `/api/catalog` 首拉失败 → 断言 `app-center-load-error` 出现且品牌卡在场 → 放行重试 → 断言全网格；另一测：预置缓存 + 后台失败 → 断言无错误态、缓存网格在场。
