# Design: fix-digest-adaptive-embed-deadline

## Context

`/digest` 的 embed 预算当前是 `EMBED_DEADLINE_MS = Number(process.env.FD_MEMORY_DIGEST_EMBED_DEADLINE_MS ?? 3500)`（`src/http.ts`），现网配为 8000。它是**每次请求现读的常量**，与历史延迟无关。

熔断器已经在做自适应（`src/embed-gate.ts`）：连败两击进冷却，指数退避 2→4→8 分钟封顶，成功只消一击。但熔断管的是「要不要试」，不管「试多久」。

采样侧有盲区：`noteEmbedSample` 在成功分支记 `Date.now() - e0`；失败分支记的也是 `Date.now() - e0`，但此时 `e0` 到失败之间恰好是预算长度，**记录的数值等于预算而非真实所需时间**，无法回答「本来需要多久」。

调用方预算硬编码在 `server/cluster-memory.js:55`（`setTimeout(..., 5000)`），且 `memory-federation` spec 把「paas 侧超时上限 5s」写成了契约——与 fd-memory 的 8000ms 上限直接冲突。

生产实测（2026-10-29）：6 次连发 `8063, 7, 7, 77, 9, 92` ms，5 次 vector、1 次撞线；单次 embed 直测 5.5–13s，同文本算过一次后再查只需毫秒级（`serializeEmbed` 的 in-flight 合并生效）。

## Goals / Non-Goals

**Goals**
- 让单次 embed 预算跟随近期真实延迟，快速路径不空等。
- 让失败/超时样本如实反映延迟，使自适应有可靠输入。
- 消除「调用方超时 < fd-memory 预算」这条不变量违例。

**Non-Goals**
- 不改 embed 上游、不改模型、不改向量空间（用户已锁定）。
- 不改 `/digest` 的请求/响应字段形状或三档阶梯语义。
- 不做并发闸门调整（`serializeEmbed` 的单飞与合并已在做正确的事）。
- 不引入外部依赖或用例外的采样存储。

## Decisions

### D1' 超时样本是右删失观测，必须给预算提供下界（真机验收推翻 D1）

D1 原设计「预算 = 成功样本 p90 × 余量，失败样本不入输入」。真机验收（2026-10-29）
证明这会在**双峰延迟**下塌缩：慢调用永远超时 → 只有快调用进样本 → p90 看着很快
→ 预算收到下界 → 慢调用更没机会成功。实测构造 50%@2s / 50%@12s 的分布，预算从
8000 一路收到 3000，慢的那一半被永久饿死——**收缩的依据恰好排除了它正在饿死的请求**。

修正：超时是**右删失观测**（censored observation），它的含义是「真实延迟 ≥ 当时的
预算」，而不是「延迟未知，丢弃」。因此：

```
budget = clamp( max( p90_success × headroom ,  maxTimeoutElapsed × 1.2 ) , floor , cap )
```

- 快车道（无超时）：第二项为 0，预算照旧收紧——D1 的收益不丢。
- 出现超时：预算至少抬到「已证明确实不够」的那个等待之上，并留 20% 余量。
- 增长受 cap 约束，不会无限爬。

「失败样本会自我强化」的原顾虑仍然成立，所以**只有 timeout 类**提供下界；上游 4xx /
5xx、`cooling_down` 都不提供（它们不含任何关于耗时的信息，120ms 的 500 不能说明
车道需要 120ms）。超时样本的 `ms` 因此必须记真实等待（D2），否则这个下界无米可炊。

### D1 预算取近期成功样本 p90 × 余量，clamp 到 [下界, 配置上限]

用现有 `embedSamples`（上限 200 条，已是滑动窗）里**成功**样本的 p90 推导，乘一个余量系数（建议 1.5），再 clamp 到 `[EMBED_DEADLINE_FLOOR_MS=3000, FD_MEMORY_DIGEST_EMBED_DEADLINE_MS=8000]`。

- **为什么用 p90 而非均值**：均值被少量极慢值拖偏，p90 更贴近「这一次大概率要多久」，且与 `/admin/metrics` 已有的 `ms_p90` 口径一致，运维读到的数字与系统用的是同一个。
- **为什么保留下界**：样本少或全是极快值时，预算会掉到几十毫秒，一次正常的冷查询就会被误杀。3000ms 是本仓历史上可用的下界（原默认 3500 同量级）。
- **为什么上限沿用现有 env**：现网已配 8000，语义从「固定值」改成「上限」不改变既有部署的天花板行为，回滚面最小。
- **替代方案**：固定 15s（简单但每次都可能空等）／纯熔断无死线（慢请求会拖死调用方）。都不取。

### D2 失败样本记录真实等待 + 明确超时分类

超时分支在 reject 前记下 `elapsed`，样本写 `{ ms: elapsed, ok: false, reason: "timeout" }`；其余失败（上游 4xx/5xx、熔断冷却）保持各自 reason。这样 p90 只吃成功样本，而失败原因分布能区分「超时」与「上游错误」。

- **为什么不让 p90 吃失败样本**：失败样本的耗时是「预算上限」的截断值，混进去会让预算自我强化（越慢→预算越大→记录越大）。
- **落地约束**：`noteEmbedSample` 的 reason 目前是自由字符串（`/admin/metrics` 按 80 字符截断分组）。新增 `timeout` 作为稳定分类值，须在 `metricsSnapshot` 的 `failure_reasons` 里可辨识，且不改变既有 `cooling_down` 等值的形状。

### D3 调用方超时可配，默认 9000ms，并守住不变量

`server/cluster-memory.js` 的 `setTimeout(..., 5000)` 改为读 `CELL_MEMORY_DIGEST_TIMEOUT_MS`，默认 9000（= fd-memory 上限 8000 + 1s 传输余量）。chat 面与集群面共用同一个 `digestLadder`，因此一处改动两面生效。

- **为什么默认 9s 而非 5s**：调用方必须比 fd-memory 更有耐心，否则 fd-memory 的降级路径（返回带 `model_note` 的关键词档）根本来不及返回。9s 只在对端真的慢时才付出，快路径毫秒级返回不受影响。
- **为什么不把 fd-memory 上限压到 3.5s**：那会让上游 5.5–13s 的常态延迟大量降级，向量档位实际弃用——与「保住向量召回」的目标相反。
- **不变量落地**：两边都是配置，无法在编译期约束。做法是在 `memory-federation` / `chat-memory` spec 里显式写下不变量，并在 paas 侧启动时若检测到 `CELL_MEMORY_DIGEST_TIMEOUT_MS < fd-memory 上限` 无法得知（跨服务）——因此改为**日志可辨识**：配置过小时表现为持续的 digest 超时降级 warn，运维可定位。这一点已写进 spec 场景。

### D4 探针判据用 live probe，不用累计计数器

已有实现（`scripts/probe-embedding-lane.mjs`，2026-10-29 落地）：带 `q` 打一次 `/digest`，看回包有没有 `model_note`。累计的 `vector_ratio` / `failure_reasons` 仅作 `HISTORICAL:` 说明。

- **为什么不用累计值**：实测故障恢复后 `vector_ratio` 仍停在 71.4% 并持续判 DEGRADED——不自愈的判据必然产生永久假警。
- 本次 change 只把这条纪律固化进 spec（探针本身已实现），不重复开发。

## Risks / Trade-offs

- **[p90 在样本少时抖动] → 保留下界 3000ms + 无样本回默认值**。样本数 < 5 时直接用 floor 与默认值之间的保守值，不参与自适应。
- **[样本自强化：慢→预算大→更多慢样本被接受→预算更大] → p90 只吃成功样本**。成功样本的耗时是真实完成时间，不含截断。
- **[调用方超时调大后，慢车道会多占 9 秒连接] → 只在实际慢时付出**；且 fd-memory 侧预算仍在 8s 截断，不会无限等。
- **[跨服务不变量无编译期保障] → 写进 spec + 误配可由持续降级 warn 发现**；后续可加启动自检（本 change 不做）。
- **[改 paas 侧影响面大于 fd-memory] → 默认值取 9s 使既有部署行为只会更宽容，不会更严格**；回滚只需把 env 设回 5000。

## Migration Plan

1. fd-memory 先发：自适应预算是纯内部改动，`FD_MEMORY_DIGEST_EMBED_DEADLINE_MS` 语义过渡（固定→上限）对现网 8000 的部署行为不变（仍是上限）。
2. paas 后发：把硬编码 5s 改为可配 + 默认 9s。此步让慢 embed 从「整块丢失」变为「拿到降级块」，是用户可见改善。
3. 顺序不可反：若先发 paas（9s）而 fd-memory 仍按固定 8s，行为等价于现状，无回退风险；若先发 fd-memory，paas 仍 5s 会继续砍掉 5–8s 的结果——但也不会更差。两者均安全，先发 fd-memory 更顺。
4. 回滚：fd-memory 设 `FD_MEMORY_DIGEST_EMBED_DEADLINE_MS` 保留但让自适应失效的开关**不提供**（避免双路径）；直接回滚镜像即可。paas 侧设 `CELL_MEMORY_DIGEST_TIMEOUT_MS=5000` 回到现状。

## Open Questions

- 余量系数 1.5 与下界 3000ms 是起始值，需按上线后 `/admin/metrics` 的 `ms_p90` 与降级率再校准——属调参，不改变设计。
- 是否需要在 `/admin/metrics` 暴露「当前生效预算」以便运维直读？本 change 不做，留待有需求时加。
