# verify-zhiyu-live-eyes

## Why

智语这一轮（`fix-zhiyu-room-lifecycle-and-bridge-watermark` / `debounce-zhiyu-fleet-health-events` / `polish-zhiyu-reception-welcome-line`）的代码全部上产并已在生产按层验证：事故房封顶零增长、水位线落库、欢迎行列全席（`seats=4`）、主动招呼真答、保留期到期制 tick 真跑（`zy_meta.retention_last_run=12:09:46`）。

剩下三项**不是没做，而是缺执行条件**，且都属"需要外部对象/凭据"的验证，放进各自 change 会让那三单永远挂着未勾项。本单把它们**显式接过来**，让前序三单可以干净归档，同时不让任何一项消失：

1. **live 浏览器眼跑不起来**：`e2e/live-zhiyu-embed.spec.js` 需要 `PAAS_TEST_IDENTIFIER/PASSWORD`，`.env` 里的口令已过期（Logto 返回 `Incorrect account or password`）。该 spec 已覆盖完整访客链路，并在本轮补了两条断言（首屏必须 `?tail=200`、流必须 `events?after=<cursor>`）。
2. **健康抖动合并缺观察对象**：两间订阅房均已结束，现网没有"活跃房 + 会抖的队"可供观察；代码在产、单测覆盖，但"活房里抖动被合并"没有生产样本。

## What Changes

（无代码改动。本单只承接三条**待执行验证**，各自带触发条件与命令。）

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无——`skip_specs: true`。纯验证承接，不改任何行为契约。）

## Impact

- 无代码、无 schema、无部署影响。
- 前置条件：①有效口令进 `.env`（不进出口对话）②一间活跃房订阅一支会抖的队（或等现有订阅房重开）。
- 前序三单因此可归档：本单承担它们最后未勾项的追踪责任。
