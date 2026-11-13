# Design — fix-a2a-call-timeout

## Context

`runA2aTurn`（`server/a2a-client.js:47`）是平台作为 A2A **客户端**的唯一回合执行器，三个调用方共用：

| 调用方 | 传 signal | 传 timeoutMs | 现状 |
|---|---|---|---|
| `cron-runner.js:515`（委托回合：巡时/派发/接棒） | 否 | 是（回合预算） | 定时器 `signal?.abort()` 被 `?.` 短路 → **永不结算** |
| `server/agent-session.js:764`（人聊市场 agent） | 是 | 否（吃默认 300s） | 调用方自带 300s timer，先注册先到 → 内部 timer 被 `finally` 清掉，**靠顺序不炸** |
| `gateway/zhiyu/agent-lane.js:54`（智语房 agent 座席） | 是（`controller.signal`，**从不 abort**） | 否（吃默认 300s） | 内部 timer 到点执行 `signal.abort()` → **`TypeError` → 进程退出** |

全仓无 `uncaughtException` handler（`grep -rn uncaughtException` 零命中），所以第三行不是理论风险：
任何一次智语 agent 回答超过 300s，网关进程直接死。

三处根因同一个：**定时器持有的是 `signal`（只能被读、不能发 abort），而拥有 abort 能力的是 controller**；
且委托路径干脆没给 signal，于是「有时限」这件事从未真正成立过。2026-11-08 本机探针三形态实测在案
（`docs/multi-agent-collaboration-explore.md` §7.1 E1-E3）：

- `nosig`（委托形态，`timeoutMs=400`）→ `HUNG`，3009ms 仍未结算；
- `sig`（人聊形态）→ 定时器回调抛 `TypeError: signal?.abort is not a function`；
- `prod`（真产形态：调用方 timer 先注册）→ `ABORTED` @416ms —— 活着，但只是顺序侥幸。

## Goals / Non-Goals

**Goals**

1. 每一次出站 A2A 调用都有真实生效的上界，到点落**可归因**的失败（既有 `timeout` 错误类），不再挂起。
2. 无论调用方是否提供 signal，上界到点都不得产生未捕获异常（第三行调用方即刻受益）。
3. 委托回合的上界与其回合预算同源：调用方下传多少就用多少，不被客户端内建默认值顶替。
4. 人聊车道的双定时器收成一条，去掉顺序依赖。

**Non-Goals**

- **不改 `task-engine.js:683` 的 `TURN_TIMEOUT_MS` 硬编码**。那是「回合预算本身不生效」的另一层缺陷
  （`cadence.turnTimeoutMs` 被 600s 覆盖），属切片①，本 change 只保证「被告知多少预算就守多少」。
- 不改 A2A 协议、不改 runner 侧 `DELEGATION_DEPTH_BOUND`、不动 registry 凭据链。
- 不加超时重试。远端超时一律如实失败（`a2a-client.js` 头注释：nothing here retries）。
- 不做流式空闲检测（只看首字节/帧间隔）。整调用上界已足以解 P0；空闲检测另立。

## Decisions

### D1 · controller 归客户端所有，调用方 signal 只作「上游取消」输入

`runA2aTurn` 内自建 `AbortController`；调用方给了 `signal` 就**单向联动**（caller abort → 内部 abort），
绝不再对 signal 调用 `abort()`。

```js
const controller = new AbortController();
const onCallerAbort = () => controller.abort(callerSignal.reason);
if (signal) {
  if (signal.aborted) onCallerAbort();            // 已取消的入参：立即失败，不建定时器
  else signal.addEventListener("abort", onCallerAbort, { once: true });
}
const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
...
fetch(url, { ..., signal: controller.signal })
finally { clearTimeout(timeout); signal?.removeEventListener("abort", onCallerAbort); }
```

- **为什么不用 `AbortSignal.any([signal, AbortSignal.timeout(ms)])`**：`engines: node >= 22` 支持，
  但拿不到「这次 abort 是预算到点还是调用方主动」的判别位，而 D2 的归因正需要它；自持 controller
  用 `timedOut` 布尔即可分辨，且 `finally` 里能精确摘掉监听器（`AbortSignal.any` 的合成 signal 无法撤销）。
- **为什么保留调用方的 signal 而不是让它只靠内部 budget**：人聊/智语的「停止」走的是调用方 controller
  （`agent-session.js:115` `remoteAbort.abort()` 是导航停机的唯一通道），这条通道必须继续有效。

### D2 · 超时落结构化失败，复用既有错误类，不新造分类

到点后**由客户端**抛一个明确的错误，而不是把 `AbortError` 漏给调用方：

```js
// timedOut === true 时（预算到点，而非调用方取消）
const err = new Error(`A2A call timeout after ${timeoutMs}ms — no complete response from ${host}`);
err.code = "a2a_timeout";
err.timeoutMs = timeoutMs;
throw err;
```

- 文案里带 `timeout`，正是 `server/fleet-events.js:50` `classifyErrorKind` 表里 `timeout` 那一行的命中条件
  （`/timeout|timed? ?out|超时/i`，且 `timeout` 排在 `model_upstream` 之前）→ 回合台账直接落
  `errorKind: "timeout"`，零改动地获得归因。**不新增 `ERROR_KINDS` 成员**（表是唯一调谐点，加成员会连带
  改报表口径与既有告警规则）。
- **调用方取消（`signal.aborted`）保持原样直接抛 `AbortError`**。人聊的 catch 用 `if (!abort.aborted)`
  判「用户主动停 → 静默」，这个语义不能变。判别位就是 D1 的 `timedOut`。

### D3 · 上界来源：调用方下传值优先，默认值只作兜底

`timeoutMs` 的默认（300_000）保留，仅服务「既不传 signal 也不传预算」的未来调用方；**一旦下传就是硬上界**。
委托路径（`cron-runner.js:515-522`）已经下传回合预算（`runCronJobTurn` 的 `timeoutMs`，见 `:1284`），
**本 change 不需要改这个调用点** —— 需要改的只是「下传的值终于被当成上界」。
- 由此 requirement 2 的判据是可证伪的：预算 120s（< 300s 默认）时必须在 ~120s 结束；若谁把它退回固定默认，
  就会在 300s 结束 → 测试红。

### D4 · 人聊车道双定时器合一

`streamA2aChat`（`agent-session.js:751`）删掉自带的 `setTimeout(() => abort.abort(), 300_000)`，
改为显式下传 `timeoutMs: A2A_HUMAN_TURN_MS`（300_000，收敛为具名常量）。controller 保留（D1 的取消通道），
`finally` 里的 `clearTimeout(timeout)` 一并删掉。

**可见行为变化（有意）**：到 300s 时用户从「回合静默结束、无任何说明」变成「收到一条超时错误」
（`if (!abort.aborted)` 成立 → 走 `sendToViewers({type:"error"})`）。这正是 requirement 1 的
「可归因」在人聊面上的兑现，不是回归。

### D5 · 智语车道不动代码，靠 D1 自动免于崩溃

`gateway/zhiyu/agent-lane.js:54` 传的是自己的 `controller.signal`（从不 abort），当前形态会在 300s 撞上
`TypeError`。D1 之后定时器只碰内部 controller → 该车道到 300s 正常落超时错误，代码零改动。
**代价**：房内用户会看到一条 timeout 错误而不是永久挂起（原本是进程级事故，无法商量）。

## Risks / Trade-offs

- **R1 · 合法长跑被切**：委托上界 = 回合预算（floor 2min / ceiling 30min），一个仍在正常流式输出但总时长
  超预算的远端会被切断。取舍：无界挂起占死串行回合槽（`task-engine.js:616-618`）的代价是整支舰队停摆，
  远大于一次可重跑的超时。且预算是岗位可配的（`cadence.turnTimeoutMs`，受 2–30min 夹紧）。
- **R2 · 历史报表可比性**：原先这类失败落 `errorKind: "other"`（`AbortError` 不含 timeout 词），改后落
  `timeout`。跨变更前后对比时 `other`/`timeout` 两桶份额会平移。取舍：宁可口径变，也要让失败可归因。
- **R3 · 用户可见文案**：超时文案是英文单行（`A2A call timeout after Nms`），会经人聊错误条、智语 IM
  桥直达终端用户。取舍：暂不做多语文案（现有 A2A 错误串同样未本地化），一致性优先。
- **R4 · 取消与超时同刻**：调用方 timer 与内部 timer 同 ms 到点时，`timedOut` 的置位与 `signal.aborted`
  谁先谁后都会收敛（两路都是 `controller.abort()`；判别只看 `timedOut`，不再二次 abort）。测试用
  「先到者」而非精确时序断言，避免 flaky。

## Migration Plan

无 schema、无配置、无协议变更；一次镜像滚版即生效，无顺序约束。
回滚 = revert 该 commit（唯一外部行为差异是失败面：挂起/崩溃 → 结构化超时）。

## Open Questions

无阻塞项。唯一待观测项：上线后 7 天内 `member_turn_daily` 的 `timeout` 桶份额变化是否符合预期
（R2 的口径平移幅度），若异常再单独提 change 调 `turnTimeoutMs` 默认。
