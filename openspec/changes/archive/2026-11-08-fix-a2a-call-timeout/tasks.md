# Tasks — fix-a2a-call-timeout

## 1. 客户端：真实生效的上界（`server/a2a-client.js`）

- [x] 1.1 `runA2aTurn` 内自建 `AbortController`，调用方 `signal` 只作**单向联动**输入
  - 调用方已取消（`signal.aborted`）→ 立即失败，不建定时器、不发请求
  - 否则 `signal.addEventListener("abort", onCallerAbort, { once: true })`，`onCallerAbort` 里 `controller.abort(signal.reason)`
  - `fetch(..., { signal: controller.signal })`；**全局不再出现 `signal.abort()`**
- [x] 1.2 定时器只 abort 内部 controller，并置 `timedOut = true`
  - `finally` 内 `clearTimeout(timeout)` + `signal?.removeEventListener("abort", onCallerAbort)`（监听器不留在调用方 signal 上）
- [x] 1.3 到点落结构化失败：`timedOut === true` 时抛
  `Error("A2A call timeout after <ms>ms — no complete response from <host>")`，附 `code: "a2a_timeout"` / `timeoutMs`
  - 文案必须含 `timeout` 字样（`server/fleet-events.js:50` 分类表靠它命中 `timeout` 行）
  - **不新增 `ERROR_KINDS` 成员**
- [x] 1.4 调用方主动取消保持原语义：`timedOut === false` 且 `signal.aborted` → 原样抛 `AbortError`
  （人聊 `if (!abort.aborted)` 的静默判定不能变）
- [x] 1.5 默认值收口为具名常量并只作兜底：`DEFAULT_A2A_TIMEOUT_MS = 300_000`，
  注释写明「调用方下传即硬上界，本值仅在既无 signal 又无预算时生效」

## 2. 人聊车道：双定时器合一（`server/agent-session.js`）

- [x] 2.1 `streamA2aChat` 删除自带的 `setTimeout(() => abort.abort(), 300_000)`
  - controller 保留（用户停止/导航停机走 `ctx.activeRemoteTurnAbort`，`agent-session.js:115` 是唯一通道）
- [x] 2.2 调用处显式下传 `timeoutMs: A2A_HUMAN_TURN_MS`（300_000，具名常量）
- [x] 2.3 `finally` 内删掉随之失效的 `clearTimeout(timeout)`，`ownsTurn` / `finishTurn` 语义不动
- [x] 2.4 确认 300s 到点的可见结果：`abort.aborted === false` → 走 `sendToViewers({ type: "error", message })`
  （有意变化：从「静默结束」变为「一条超时错误」，见 design D4）

## 3. 测试

- [x] 3.1 新建 `scripts/test-a2a-client-timeout.mjs`（`node --test`，只用 `node:http` 造「接连接永不应答」的远端，不引 task-engine）
  - ① 不传 signal、`timeoutMs=120`：约在 120ms 落结构化失败，`err.code === "a2a_timeout"`，**不 hang**
  - ② 传 signal（内部上界先到）：同样落结构化失败；进程级 `uncaughtException` 监听为零触发
  - ③ 传 signal（调用方先 abort）：抛 `AbortError`（**不是** `a2a_timeout`），且后续内部上界到点不再产生第二个动作
  - ④ 正常 SSE 响应：`{ text }` 与本变更前逐字节一致（用既有 `sseStub` 同形的 delta+message 两帧）
  - ⑤ **判别性用例**：`timeoutMs=120` 且不传 signal → 结束时刻必须 `< 1000ms`（把上界退回固定 300s 默认，这条必红）
- [x] 3.2 反证：临时把 1.2 的定时器改回 `signal?.abort()`，①⑤ 必须红；恢复后全绿
  （证明测试对准缺陷本身，不是自证）
- [x] 3.3 `node --test scripts/test-a2a-client-timeout.mjs` 全绿；
  `node --test scripts/test-agent-delegation-a2a.mjs` 原六条**一条不改**仍全绿

## 4. 门禁

- [x] 4.1 全量单测无新增红：**989/989 绿，0 红**
  - 首段（glob 从 `test-a2a-client-timeout` 到 `test-bots` 之前）527 绿
  - 尾段（`test-bots` 之后到 `test-zhiyu-*`）462 绿
  - **唯一未跑成的是 `scripts/test-bots.mjs`：它单独跑也挂住**
    （120s 后 `Promise resolution is still pending but the event loop has already resolved`）。
    已核该文件不引 `a2a-client.js` / `agent-session.js`（`grep` 零命中，只有注释提到 a2a），
    故与本 change 无关，属既有挂起，**不计入本 change 的验收**，另记给后续清理
- [x] 4.2 `npx biome check server/a2a-client.js server/agent-session.js scripts/test-a2a-client-timeout.mjs` 绿
- [x] 4.3 `openspec validate fix-a2a-call-timeout --strict` → `is valid`

## 5. 上线（不含在本 change 内）

- [x] 5.1 出片上产（2026-11-08 03:0x 完成）：通道 `scs001/platform-image-verify`（公开仓免费）→
  tag `sha-d7e693b`（快照 commit，私仓真 sha 061433d62）→ relay OK 03:03 → ccr skopeo 实证
  digest `sha256:3aaddcbd` → fd-infra-deploy 双清单（platform.yaml:57 + facet.yaml:66）滚 tag →
  gitee push → ArgoCD hard refresh → 两 deploy rollout 完成；in-pod 实证 `/app/server/a2a-client.js`
  带 `a2a_timeout`，两种形态真探针都 `a2a_timeout @307ms` 且进程存活
- [ ] 5.2 滚版后观测 7 天（观察项，非交付物）：`member_turn_daily` 的 `timeout` 桶份额变化（design R2 的口径平移），
  以及 `gateway/zhiyu` 是否还有 300s 附近的进程重启

## 6. 挂账（同源缺口，不在本 change）

- 6.1 **回合预算本身不生效**：`task-engine.js:683` 用 `TURN_TIMEOUT_MS`（600s 硬编码）覆盖
  `turnTimeoutMs`，导致 `cadence.turnTimeoutMs` 与 `budgetPerEdgeMin` 一律无效（生产实证：设 1200000
  仍在 621s 被杀，`turn_budget_exceeded`）。本 change 只保证「被告知多少就守多少」，改硬编码属切片①
- 6.2 **流式空闲检测**：当前只有整调用上界，一个持续吐 keepalive 帧但永不完成的远端仍会占满预算。
  需量「帧间隔」阈值后再定
