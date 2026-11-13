# 让「计费被拒」在真实错误形态上也能被识别（classify-out-of-band-billing-rejection）

## Why

计费失败停车（`add-billing-failure-parking`，2026-10-21 上产）的判据是 `e?.code === -32003`。但 `-32003` **只在一条路径上产生**：dsh 桥接收到 `platform/stream` 的 `finish` 帧且 `chunk.reason.kind === "error"`（`harness/dsh.js:530`）。

真实的计费拒绝不长这样。模型 SDK 抛出的是自己的 `APIError`——消息形如 `403 status code (no body)`（这串字在 paas 仓里**一处也没有**，属于 SDK 的措辞），错误对象上没有 `-32003`。于是它冒泡到 `manager.turn` 的 catch 时 `e.code` 是 undefined，分类器不触发，只留下 `rollover.js:128` 的一行 warn。

**实证**：`packs-4fhjskpibrr2d0_9bxacqq-wx-alpha`（阿尔法哨兵）以每分钟一回合的节奏、每回合 403，连续失败**数周**；`agent-runner-serving` 的日志里是成排的 `rollover failed for …: 403 status code (no body)`，而停车从未发生。它的计费键确实已失效。

同一件事还有第二个后果：`turn_ended` 事件不带原因，所以观测面只能报 `last_error_kind: unknown`（见 fd-wanxing 的 `surface-silent-agent-failures` measurements），面板看得见"坏了"，说不出"坏在凭证"。

## What Changes

**① 分类触发从「错误码」放宽到「错误形态」，探测纪律不变**
`manager.turn` 的 catch 在决定是否探测时，除 `-32003` 外，还认这些形态：
- 错误对象带 HTTP `status`/`statusCode` 且为 401 或 403；
- 消息匹配 SDK 式 `^40[13] status code` （含 `(no body)` 变体）。

**放宽触发是安全的，因为停车权仍在探测手里**：命中形态只发起一次**零花费** `/models` 探测，探测说"key 被拒"才停车；探测通过、传输失败、或供应商不可探测，一律不停车（既有 D2 语义原样保留）。换句话说，形态只决定"要不要花一次探测"，不决定"要不要停"。

**② `turn_ended` 带 `error_kind`**
失败回合的 `turn_ended` 载荷增 `error_kind`（`billing_rejected` / `timeout` / `child_exit` / `llm_failed` / `unknown`），沿用既有纪律：**不可得时字段缺席，不置空、不猜**；未知消费方不受影响（纯增量）。

**③ 观测面不改**
`last_error_kind` 已经是观测面的字段名，只是过去只能是 `unknown`；本 change 只负责让 runner 把真值送出来。fd-wanxing 侧无需改动。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-runner`：计费失败分类的触发形态（新增"形式判据"但不改探测/停车的裁决语义）；`turn_ended` 载荷增 `error_kind`。

## Non-goals

- **不放宽停车的判据本身**：仍然必须探测确认 key 被拒才停；形态命中只是"值得探一次"。
- 不改 `/models` 探测的调用方式、频率、零花费性质。
- 不改 `-32012` 的对外语义与 `paused` 的优先级关系。
- 不去修 `wx-alpha` 的失效计费键本身（那是该 agent 的运维动作）。
- 不做"看到 403 就停"——上游网关的 403 可能是别的意思，这正是必须探测的原因。

## Impact

**代码**
- `agent-runner/manager.js`：catch 内的触发条件扩为 `code === -32003 || isBillingRejectionShape(e)`；新增纯函数 `isBillingRejectionShape`（可单测，不碰 I/O）。
- `agent-runner/manager.js`：`#classifyBillingFailure` 的入参带上形态来源，用于日志与 `error_kind`。
- `turn_ended` 载荷：`error_kind`（在既有 `#fleetEmit("turn_ended", …)` 三处按分支填值）。

**契约**
- `turn_ended` 只增字段；`agent-runner/spec.md` 里"Turn events carry session and token attribution"那条已确立"纯增量、不可得则缺席"的先例，本 change 沿用同一句法。

**风险**
- 误判形态会多打几次零花费探测（可接受：一次 `/models`，且每 key 有既有频次守卫）。
- 若某个上游把 403 用于非计费语义，探测会返回"通过"，于是不停车——行为回到改造前，不会误停。
