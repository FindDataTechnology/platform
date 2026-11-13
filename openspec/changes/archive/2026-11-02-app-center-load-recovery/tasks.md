## 1. 冷失败可见可重试（客户端）

- [x] 1.1 `web/src/hooks/useListCache.ts` 增 opt-in 选项 `{ coldRetry?: number }`（默认 0）：无缓存且拉取失败时按 ~1.2s 退避自动重拉至多重试次数，仍失败才 `setStatus("error")`；在飞请求 ref 去重（focus 重校验与退避重试不叠加双拉）；单测钉：默认 0 行为与现状逐点一致（其他调用方零变化）、coldRetry=1 时失败→一次自动重试→成功则 loaded 无 error
- [x] 1.2 `web/src/pages/AppCenterPage.tsx`：catalog 读传 `coldRetry: 1`；新增分支 `catalog.status === "error" && catalog.data === null` → 产品区渲染 `states-kit.ErrorState`（testid `app-center-load-error`，onRetry=`catalog.refresh`），五张品牌卡照常；`status==="loading" && data===null` 出骨架（既有）与错误态判据互斥；单测/e2e 夹具钉三态（loading/error-with-data 静默/error 冷失败）
- [x] 1.3 `web/src/locales/{en,es,fr,ja,zh-CN}/common.json` 补 `appCenter.loadError` 标题键（复用 `common.retry` 既有键），check-locales 门五语键集一致

## 2. 验证与收口

- [x] 2.1 e2e：拦 `/api/catalog` 首拉失败 → 断言自动退避重试发生、放行后全网格渲染（免手动干预）；持续失败 → 断言 `app-center-load-error` 出现且五张品牌卡在场 → 点重试成功 → 全网格；预置缓存 + 后台失败 → 断言无错误态、缓存网格在场
- [x] 2.2 真机走查（生产）：清缓存开应用中心，拔网线/拦请求复现冷失败 → 错误态+重试眼见；恢复网络重试 → 全网格；证据入台账 `docs/registry-maintenance.md`
