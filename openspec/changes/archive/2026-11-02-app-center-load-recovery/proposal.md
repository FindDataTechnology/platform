## Why

应用中心把首拉 `/api/catalog` 的失败静默吞掉（用户走查问题③：「第一次只出现部分组件，刷新才出现全部」）。现行契约「目录不可用时品牌卡照常」让一次冷失败永久呈现为「只有五张静态品牌卡」的半屏——无错误提示、无重试出口，用户只能手动刷新。`listCache` 是进程内 Map，F5 即清空，所以「刷新后正常」实为「这次拉成功了」，不是缓存的功劳；冷失败当下用户得不到任何可行动的反馈。

「不破页」教义（一个数据源失败不拖垮整页）本身是对的，应保留——但它只该适用于**有缓存内容时的后台校验失败**。冷加载（无任何内容）失败必须可见、可重试。

## What Changes

- 冷加载（无缓存）且 `/api/catalog` 失败：产品区呈现错误态 + 「重试」按钮（复用 `states-kit` 的 ErrorState），五张品牌卡照常在场（不破页教义保留）。
- 后台校验失败（已有缓存内容）：保持静默，继续渲染缓存内容（现行行为不变）。
- 冷失败后自动退避重试一次（首次失败后延迟再拉一次），仍失败才落到错误态——避免把一次网络抖动放大成需要用户干预。
- `/api/connections` 失败维持现状（只影响徽章，不属产品区内容，本就应静默）。
- 错误态与重试文案五语齐全。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `app-center`: 「统一网格——一卡一生态产品」的「目录不可用时品牌卡照常」场景细化为「冷加载失败可见可重试 / 后台校验失败静默」两种姿态。

## Impact

- `web/src/pages/AppCenterPage.tsx`（catalog 冷失败错误态 + 重试出口；区分冷失败与后台失败）
- `web/src/hooks/useListCache.ts` / `web/src/lib/listCache.ts`（如需补冷失败退避重试语义，保持对既有调用方兼容）
- `web/src/locales/{en,es,fr,ja,zh-CN}/common.json`（`appCenter.loadError` 等新键五语）
- `web/e2e/`（模拟 `/api/catalog` 首拉失败 → 错误态+重试；重试成功 → 全网格）
