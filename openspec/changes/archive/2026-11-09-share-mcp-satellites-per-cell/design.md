# Design — share-mcp-satellites-per-cell

## Context

动机与实测数字见 proposal.md。本文件只记**决定方案的三个实测/读码结论**，以及由此钉死的范围。

### F1. 宿主重启后客户端能否自恢复 —— 能（实测 + 读码）

最小连通实验（同一 Client 实例，宿主整体停机 4s 后重启）：

```
1) connect + listTools: ping
2) host stopped; 等 4s（传输层重试预算 1s+1.5s，DEFAULT maxRetries=2）
3) 宿主全停时调用（2ms）: FAILED fetch failed
4) host restarted
5) 同一 client 再调（4ms）: RECOVERED tools=1
```

两层机制叠加：

| 层 | 行为 | 源码 |
|---|---|---|
| 传输层 | SSE 流自动重连：`initialReconnectionDelay 1000`、`growFactor 1.5`、`maxReconnectionDelay 30000`、**`maxRetries 2`** | `@modelcontextprotocol/client` `DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS` |
| dsh 侧 supervisor | 连接掉落 → 重建 server，`initialDelayMs 500 / maxDelayMs 30000 / maxAttempts 10`，耗尽则 unregister 工具 | `@deepseek-ai/dsh-mcp-client` `RECONNECT_DEFAULTS` |

> 结论：**宿主重启不需要 cell 重启**。当次调用快速失败（`fetch failed`，2–4ms，不悬挂），
> 之后两次退避阶梯任一接上即恢复；最坏 ≈2.5 分钟后该 server 工具被摘除——与今天 stdio
> 卫星反复崩溃时的行为一致，**不是新增退化**。

### F2. 哪些卫星可共享（按 env 实测分类）

| 类别 | 卫星 | 依据 |
|---|---|---|
| **可共享（只读 cell 级 env）** | fleet、cron、delegation、fleet-architect、blueprint-author、pack-author、persona-evolution、skill-evolution（**8 个**） | env 只有 `<NAME>_MCP_URL` / `HOST` / `PORT` |
| 可共享（无 env） | bench-proposal | 启动期不读任何 env |
| **需按请求注入才能共享** | actions | 读 `DSH_SESSION_ID`（→ `proposerSession`），是**会话级**而非 cell 级 |
| **不可共享（成员级）** | library（`LIBRARY_PROJECT_ID`/`LIBRARY_COLLECTIONS`）、websearch（`SEARCH_RELAY_TOKEN`/`SEARCH_USER_KEY`）、fd-memory（成员 token，外部包，经 `writeMemberMcpPatch` 下发） | 成员视图不同，共享即越权 |

**收益按实测重算**：8 个 ×（65–77Mi）≈ 560Mi **标称**，按 RSS→cgroup ≈0.48 得 **≈270Mi 实扣**
（proposal 初稿写的 450Mi 按 13 个算，口径偏高，以此为准）。若后续把 actions 也做进来
（需会话按请求注入）→ 9 个 ≈ 300Mi。

### F3. websearch 的会话闸在哪一侧 —— 平台侧，不受共享影响

`dsh-bridge.js:291` 传 `sessionGatedMcp:["websearch"]` → `platform-preset-bridge.js:129`
存 `#gatedServers` → `:240` 调 `installSessionToolGate(agentCtx, sessionId, …)`
（定义 `platform-tool-scope.js:328`）。闸是**每会话、在平台侧**执行的，
共享宿主不会移动或削弱它——所以 websearch 保持 per-worker 即可，无需额外改造。

## Goals / Non-Goals

**Goals**：同一 cell 的多份 dsh（主 bridge + worker 槽）共用一套**可共享**卫星；
`TASK_WORKER_MAX=0` 形态逐字节不变；每多一个 worker 槽省 ≈270Mi 实扣。

**Non-Goals**：跨 cell 共享（需可信调用方→cell 绑定，且卫星代表 cell 执行写操作）；
改动成员级覆盖（library/websearch/fd-memory 留在 per-worker）；改 `TASK_WORKER_MAX` 取值。

## Decisions

### D1. 共享粒度 = 一个 cell（不是 pod）

主 bridge 与 worker 槽同凭据、同数据根、同 owner，卫星完全重复 → 共享不产生跨租户面。
pod 级共享留待另一个 change（需要 F2 之外的身份改造）。

### D2. 宿主放在 cell server 进程里，而不是独立进程

理由：① cell server 已是该 cell 的唯一长生命周期进程，宿主与它同生共死，不需要新的
supervisor；② `TASK_WORKER_MAX=0` 时**不启动**，单 dsh 路径零改动（回滚面最小）；
③ 卫星本来就是 cell 的资源，放回 cell 里比跨容器更符合现有归属模型。

*备选*：独立 sidecar（否决——要跨容器访问 `/data/cells`，且 `TASK_WORKER_MAX=0` 时白起一份）。

### D3. dsh 侧以 `url` 条目接入（streamable-http）

`toMcpClientEntry` 已支持 `{transport:"streamable-http", url}`（浏览器车道就是这么接的），
不需要新形态。per-worker 私有 patch 仍走 stdio（library/websearch/fd-memory），两者共存。

### D4. 只共享"只读 cell env"的卫星，其余原样

即 F2 表格第一行 + bench-proposal。`actions` 本期**不做**（它的 `DSH_SESSION_ID` 需要按请求
注入，属额外改造）；library/websearch/fd-memory 明确不动。

**实测订正（2026-11-09 scratch A/B）**：F2 的 9 个名额是**上限，不是保证**。线上真实清单
（ConfigMap `platform-mcp-config`）里 `bench-proposal` 带
`envRefs: [BENCH_URL, BENCH_CONSUMER_TOKEN, BENCH_PROPOSAL_DOMAIN]`，按本节的守卫规则
**不共享**。本舰队实际共享的是 fleet / cron / delegation 三颗（A/B 里省下的 ≈225Mi 就是它们）。
判据集中在 `isShareableSatellite()`，`writeMcpPatch` 每次把结果落成 `mcp.shared.json`，
宿主机只认这份清单——两处各自推导会漂移成"宿主一份 + 每个 dsh 一份"（比不共享更差）。

### D5. 失败语义沿用 dsh 既有降级，不新增回退

宿主挂 = 该 cell 的这些工具按 F1 的阶梯降级/恢复；**不**在 cell 内回退拉起 per-dsh 卫星
（那会静默恢复重复份，正是本变更要消除的形态）。

## Risks / Trade-offs

- **[单点]** 宿主挂 → 该 cell 的 8 个工具一起不可用（对话本身不受影响）。今天的形态下这些
  卫星是按 dsh 各一份，挂一个不影响另一个 dsh——**这是本变更为省 270Mi 主动接受的集中化**。
- **[slow start]** 宿主启动要多等一次"卫星全部就绪"；若 cell 唤醒 SLA 敏感，需要预热或并行启动。
- **[成员级边界]** D4 的边界靠"卫星是否读成员级 env"判定；新增卫星若不遵守此约定，会悄悄越权 →
  落地时必须加一条**测试**：断言共享集里的卫星 env 里不含成员级键（白名单式校验）。

## Migration Plan

1. 宿主在 cap>0 时启动，先只接线 8 个可共享卫星；其余继续 per-worker（行为可逐项对照）。
2. 灰度：一个开着 worker 的 cell；对比 `kubectl top` 与 /proc 的卫星数（应 −8×N）。
3. 回滚：`TASK_WORKER_MAX=0`（宿主不启动）或删该 cell 的共享开关 → 回到 per-dsh 形态，无需回滚镜像。

## Open Questions

- **Q1** 宿主是否需要 chromimum 式的"空闲退役"？（卫星是长生命周期 MCP，不像浏览器上下文有会话边界）
- **Q2** 8 个卫星里哪些在启动时会做重活（如 fleet-architect 读库），并行启动还是串行、要不要限制并发？
- **Q3** 观测口径：内存面按什么归组这些共享卫星（现在会落 `(no-cell)`；挂了共享后应归到该 cell）。
