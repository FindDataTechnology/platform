# Design: add-trial-window-adaptive

## Context（§15.121 续六/七定量化）

- `runTrial`（server/blueprint-trial.js）的 `collectAndWait`：`deadline = now + timeoutMs`（10min
  硬编码默认），每 `pollMs`（15s）轮询一次报告落账。
- `fireRound` = `cron.runJobNow(job.id)`——回合任务进 cell 的**全舰队共享串行队列**；繁忙 cell 实测
  队列延迟 ~16 分钟 > 10min 窗口（三连红：窗口内零回合）。
- cron 任务记录自带 `state`（queued/running/idle，jobs.json 持久化面同款）——在途判定零新探针。

## D1 顺延规则（纯函数可测）

`nextTrialDeadline({ deadline, hardCap, inflight, pollMs, now })` → 新 deadline：

- `inflight === false` → 原样返回（回合已执行，停止顺延）。
- `inflight === true` 且 `deadline + pollMs <= hardCap` → `deadline + pollMs`（按轮询步进顺延）。
- `inflight === true` 且越过 hardCap → 返回当前 deadline（封顶，下一轮 while 条件自然判超时）。

`hardCap = now + 2 × timeoutMs`（绝对封顶 2 倍总窗）。纯函数导出（test-blueprint-trial 直接钉）——
生产 `collectAndWait` 内联调用，测试不再自扛逻辑（在册律：桩自重写逻辑自洽骗人）。

## D2 在途判定

`cron.listJobs().some(j => j?.sourceTag?.fleetId === fleetId && (j.state === "queued" || j.state === "running"))`
——`cron` 闭包已在 deps 构造域内（fireRound 同款），零新依赖面。`listJobs` 每 poll 调一次（15s 一次，
N 条记录内存过滤，量级无害）。

## D3 如实留痕

顺延发生时累计 `extendedMs`；收证结束（无论成败路径）把它挂进证据面 `evidence.windowExtendedMs`。
报告/judge 面零改动（多余字段无害且可查）。

## D4 语义边界

- 回合执行后（job.state 离开 queued/running）即停止顺延——执行后的失败证据照常落红。
- 三态判据（judge）不受影响：判据吃的是证据面，窗口只决定**何时停止收集**。
- 不做跳队（候选①）与专用 cell（候选③）——跳队动执行器语义（串行链纪律），专用 cell 是运维权
  限；自适应窗口是纯试跑面改动，风险最小、诚实度最高。
