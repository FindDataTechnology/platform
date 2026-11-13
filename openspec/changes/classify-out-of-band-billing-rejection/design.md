# 设计：按错误形态触发计费探测

## Context

见 proposal.md 的 Why。设计必须容纳的既有事实（都在 `agent-runner/manager.js`）：

- 触发点只有一处：`turn()` 的 catch 里 `if (this.config.billingParkEnabled !== false && e?.code === -32003) void this.#classifyBillingFailure(key);`
- `#classifyBillingFailure(key)` 的裁决权在探测：`const verdict = await this.#probeBillingPin(key); if (verdict.outcome !== "rejected") return;` —— 只有探测说"key 被拒"才写 park、发 `billing_parked`、后续 `-32012` 快速失败。
- `#probeBillingPin` 走被测方的 `/models`（零花费），路由从 `LLM_PROVIDERS_STORE`/env 解析；解析失败或传输失败一律"不可探测"⇒ 不停车（fail-open）。
- `reprobeParked()` 以慢频次复探、通过即解停并发 `billing_unparked`。
- `-32003` 的唯一来源是 `harness/dsh.js:530`（`platform/stream` 的 `finish` + `reason.kind === "error"`）；`a2a.js:212/215` 只在响应边界用 `e.code ?? -32003` 兜底。
- 观测面（fd-wanxing）读 `turn_ended` 的 `outcome`；原因字段缺失时只能报 `unknown`。

## Goals / Non-Goals

**Goals**
- 真实的计费拒绝（模型 SDK 抛的 401/403）能到探测这一步，不再依赖 `-32003` 这个过窄的判据。
- 失败原因进事件流，观测面能从"坏了"升级到"坏在凭证"。
- 放宽触发**不**放宽停车判据。

**Non-Goals**
- 不新增探测种类、不改探测频率与零花费性质（见 proposal Non-goals）。
- 不为"看到 403 就停"开口子。

## Decisions

### D1 判据从「错误码」改为「错误码或形态」，形态判定做成纯函数

```js
// 判"这个错误像不像计费门拒绝"——只决定是否值得花一次零花费探测，
// 不决定是否停车（停车权在 #probeBillingPin 的裁决）。
export function isBillingRejectionShape(e) {
  if (!e || typeof e !== "object") return false;
  const status = Number(e.status ?? e.statusCode ?? e.response?.status);
  if (status === 401 || status === 403) return true;
  // SDK 措辞：`403 status code (no body)`、`401 Unauthorized` 等。
  return /^40[13]\b.*status code/i.test(String(e.message ?? ""));
}
```

触发改为 `e?.code === -32003 || isBillingRejectionShape(e)`。

**为什么安全**：形态只买"一次探测"。探测通过/不可探测 ⇒ 与改造前逐字节一致（不停车）。所以最坏情况是多打几次 `/models`，不会误停。

**为什么必须这么做**：`-32003` 只在一条帧路径上生成，而 SDK 的 `APIError` 在帧之前就抛了——判据与病因不同形态，这就是 `wx-alpha` 连续数周未被停车的机制。

### D2 `error_kind` 只在失败分支填，且不可得时缺席

三处 `#fleetEmit("turn_ended", …)` 里，成功分支不动；失败分支按序判定：

| 条件 | `error_kind` |
|---|---|
| 探测已确认 key 被拒（或 `e.code === -32003` 且随后探测拒绝） | `billing_rejected` |
| `e.code === -32001` 且 `child.budgetKilled` | `timeout` |
| `e.code === -32002` | `child_exit` |
| `e.code === -32003` | `llm_failed` |
| 形态命中但探测未拒绝 | `billing_unconfirmed` |
| 其余无码错误 | `unknown` |

**为什么不是"必填"**：既有 spec 已为 `session`/`tokens` 立了"不可得则缺席而非置空"的先例（`agent-runner/spec.md` 的 "Turn events carry session and token attribution"）。这里沿用同一句法：**能在事件发出时确定的就填，需要在事件之后才知道的（探测结果）用第二次事件或后续事件表达**，不为了凑字段而把事件延后。

**注意时序**：`turn_ended` 在 catch 里同步发出，而探测是 fire-and-forget 异步。因此 `billing_rejected` **不会**出现在 `turn_ended` 上——它体现在随后那条 `billing_parked` 事件里（既有事件，不改）。`turn_ended.error_kind` 给的是**形态级**的答案（`billing_unconfirmed` / `llm_failed` / `timeout` / …），足以让面板说"像是凭证问题"，而 `billing_parked` 才是判决书。

这条时序区分必须写进 spec，否则实现者会试图把探测结果塞进已经发出去的事件。

### D3 形态命中但探测通过 ⇒ 明确发 `billing_unconfirmed`

只有当 `billingParkEnabled` 打开、形态命中、且探测返回非 rejected 时，记一条 debug 级日志与 `error_kind: billing_unconfirmed`。

**为什么**：这条路径正是"上游用 403 表示别的意思"的情形。留着它，下次有人问"为什么 403 没停"，答案在数据里而不是在猜测里。

## Risks / Trade-offs

- [形态太宽 → 探测次数上升] → 命中才探；`#probeInFlight` 既有守卫；一次 `/models` 零花费。可接受。
- [`error_kind` 语义被误读为"判决"] → spec 写明 `billing_rejected` 不进 `turn_ended`；判决在 `billing_parked`。
- [供应商 401/403 语义各异] → 探测是唯一裁判，fail-open；行为退化到改造前，不会误停。
- [改动落在最热的错误路径] → `isBillingRejectionShape` 是纯函数、零 I/O；用既有 `#probeInFlight` 防并发风暴。

## 迁移计划

1. 纯函数 + 单测（形态表驱动），不动调用点。
2. 接入触发 + `error_kind`（失败分支），跑既有 runner 测试确认零回归。
3. 上产后用 `wx-alpha` 复现：换回失效 key（或另建一个同形态的样本）后应在**一个失败回合**内看到 `billing_parked`，而不是几周的 warn 风暴。

**回滚**：触发条件是单行守卫；回退即恢复 `e?.code === -32003`，`error_kind` 是纯增量字段可不回退。

## Open Questions

- 观测面是否要在 `billing_unconfirmed` 上做聚合告警（"某个 key 反复 403 但探测通过"）？——属观测面的事，不阻塞本 change。
