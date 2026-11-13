## Context

`registry-bridge.js` 的 `doRefresh()` 已经并行读取三个端点，其中 servers/skills 带
`?limit=500`，agents 裸读。2026-10-17 实测网关三个端点默认 `limit=20`、响应体带
`total_count` / `limit` / `offset` / `has_next`，且服务端**不设上限**（`limit=1000` 可取回全部
212 条技能）。所以"读不全"不是网关能力缺失，是调用方读法问题。

`limit=500` 这类硬顶本身也是同一类隐患：今天 212 条够用，条目增长到 500 以上就再次静默
截断。本设计要消除的是"单次读取 = 全量"这个假设，而不是把 500 改大。

## Goals / Non-Goals

**Goals**

- 列表读取与条目总数解耦：按 `has_next` 翻页直到取尽。
- 截断从静默变为可观测（日志含端点、`total_count`、实际条数）。
- 保留现有 single-flight、last-good、`market_changed` 广播语义不变。

**Non-Goals**

- 不改网关契约、不要求网关调大默认 `limit`（跨仓，登记为后续项）。
- 不改 `extension-store` 的合并/可见性逻辑；本 change 只保证输入集合完整。
- 不引入重试/退避策略；单页失败仍按现有 last-good 处理。

## Decisions

**D1. 真翻页，而非调大 `limit`。**
新增一个 `fetchAllPages(endpoint)` 助手：以 `limit=500` 起读，读 `has_next` 为真则按已取条数
推进 `offset` 继续，直到为假。理由：`limit` 是服务端可裁剪的建议值，翻页才是契约；硬顶
只是把问题推迟到条目数越过阈值那天。
替代方案：把 500 改成 5000——放弃，同一缺陷换个数字。**实测网关上限为 2000**（`limit=5000`
返回 422 `"Input should be less than or equal to 2000"`），所以"改大"连退路都很窄。

**D1b. 硬顶站点不止 `registry-bridge.js`。**
2026-10-17 全仓普查，生产代码共 5 处 registry 列表读取：

| 位置 | 端点 | 读法 | 处理 |
|---|---|---|---|
| `registry-bridge.js:270` | agents | 裸读 | 必须修（本 change 主目标） |
| `registry-bridge.js:268-269` | servers, skills | `limit=500` | 改走助手 |
| `lib/agent-serving.js:514` | agents | `limit=500` | 改走助手（端口占用优化，失败可降级） |
| `agent-runner/registry.js:37` | agents | `limit=500` | 改走助手（runner 分片过滤） |
| `gateway/packs.js:815` | agents | `limit=500` | 改走助手（fleet scheduler） |
| `server/routes/wanxing-fleet.js:58` | agents | `limit=500` | 改走助手（catalog 投影） |

后四处今天都"够用"，但它们与裸读是**同一个假设**（单次读取 = 全量），只是把失效点从
20 推到 500。既然助手存在，统一改走的成本低于分别留坑。
替代方案：只修裸读那一处——放弃，等于承认"500 以内截断可接受"，而这个阈值没有任何依据。

**D2. 助手返回 `{items, complete}`，而不是只返回数组。**
`complete` 由最后一页的 `has_next` 决定。调用方据此区分"registry 真的只有这么多"与
"我没读完"。这是让截断可观测的最小信息载体，也让测试能直接断言。
替代方案：助手内部直接 `throw`——放弃，会把一次可降级的读取升级为整轮 refresh 失败，
与现有 last-good 语义冲突。

**D3. 截断告警走 `console.warn`，不清空快照。**
与现有 `[registry-bridge] agent '...' has no url — dropped` 同一条通道。截断是**部分成功**：
取回的前 N 条仍然有效，比退回空目录有用。运维通过日志发现后修调用方，而不是让用户看到空市场。
替代方案：截断时保留 last-good 整体回滚——放弃，会把"少显示几条"放大成"少显示全部"。

**D4. 三个端点共用一个助手，端点参数化。**
现状是三个各写各的 fetch 串，agents 因此漏掉。抽成助手后，新增端点默认走完整读取路径，
"忘记翻页"不再可能。测试桩相应改为按 `offset` 返回切片，覆盖多页。

## Risks / Trade-offs

- **翻页放大 refresh 耗时** → 当前 212 条在 `limit=500` 下仍是 1 次请求，零额外开销；仅在
  条目数越过 500 时多一跳。`FETCH_TIMEOUT_MS` 按单请求计，不累积。
- **网关若忽略 `offset` 返回同一页** → 循环会死。助手按"本页条数为 0 或 `offset` 未推进"
  双重终止，并在终止时记一条告警。
- **`has_next` 字段缺失（旧版网关）** → 退化为单页读取并按 `total_count > 已取条数` 判定
  截断，保持向后兼容。
- **`limit` 越界返回 422 而非空页** → 助手若把 422 当"无数据"会静默清空。必须按非 2xx 处理
  并抛错（走 last-good），不能把 422 误判成"取完了"。
- **`server/routes/wanxing-fleet.js` 有 8s 超时** → 多跳翻页可能超出。该路由是只读投影，
  截断时按现有 best-effort 返回已取部分并告警，不阻断。
- **`daas-analyst` 是孤儿**（pack 404、`num_skills=0`）→ 修好后它会进入目录但内容为空。
  这是数据问题不是读法问题，不在本 change 修；但验收断言应只断言"条数完整"，不要断言
  "该角色可用"。

## Migration Plan

纯代码修正，无数据迁移。滚产后一次 refresh 周期（TTL tick 或手动 `refreshRegistry()`）即
生效；无需改 ConfigMap/Secret。回滚 = 还原 `registry-bridge.js`，快照在下个周期恢复旧行为。

## Open Questions

（无。跨仓的网关默认 `limit` 与 finddata 两份脚本同步已登记为 tasks 中的后续项，不影响
本仓实施。）
