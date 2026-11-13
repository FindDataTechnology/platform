# fix-trial-fire-timeout

## Why

真机实锤（§15.120 六续/七续）：试跑 handler 在 fireRound 处可能无限期挂起——`cron.runJobNow` 等待回合入队/执行，回合在共享 DSH child 队列后可滞留 20+ 分钟，期间试跑锁（进程内 trialRunning）被占、后续一切试跑 409，且 fireRound 本身无超时边界。收链曾被锁饿死拖 40+ 分钟。

## What Changes

- **有界点火**：fireRound 的每个 job 点火与 FIRE_TIMEOUT_MS（默认 90s，env `BLUEPRINT_FIRE_TIMEOUT_MS` 可覆盖）竞速；超时者如实记 `{error: "fire timeout"}` 进 fired（既有的 turns 过滤 `!f.error` 语义原样兼容），试跑继续收证。
- **同步端点保持**：trial 仍同步（UI 契约不动）；本单只钉死无界 await，不改异步受理（那归蓝图执行线的试跑异步化单）。

## Capabilities

### New Capabilities

- `blueprint-trial-bounded-fire`：点火有界，锁不因点火悬挂而无限占用。

## Impact

- server/blueprint-trial.js：fireRound 每 job 竞速 + 导出可测辅助。
- 测试：假 cron 无限挂起→有界返回+error 记录。
