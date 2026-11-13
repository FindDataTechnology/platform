# 同一个 cell 的多个 dsh 共用一套 MCP 卫星（不是跨 cell 共享）

## Why

实测（fd-prod 2026-11-08）：**每个 dsh runtime 拉起 13–14 个子进程**（actions/fleet/cron/delegation/
library/bench-proposal/fleet-architect/blueprint-author/pack-author/persona-evolution/skill-evolution/
websearch，各 65–77Mi）→ 一个 dsh 连同卫星 ≈ **930Mi 标称 / 约 450Mi 实扣**（RSS→cgroup ≈0.48）。

而 `TASK_WORKER_MAX=2` 在线上是开着的：worker 槽**又起一个完整 dsh**，于是同一 cell 里出现两套
一模一样的卫星。日志实证：

```
[worker-pool] active, TASK_WORKER_MAX=2
[worker-pool] spawned worker-1 for persona mo-inventory
[worker-pool] spawned worker-2 for persona ops-wx-chief
52 个卫星 = 13×4（3 主 bridge + 1 worker 槽），ppid=1 孤儿 = 0
```

后果是直接可见的：platform 容器 **2845Mi / 4096Mi**，减掉 15% 保底只剩 3.48Gi 可用 → 第 4 个
cell 一唤醒就被内存闸拒（`last_gate_refusal_json` 里 headroom 已到 -0.3%）。**每多开一个 worker
槽 ≈ 多付 450Mi**，这就是「开并发」和「不撞内存闸」今天不可兼得的原因。

关键观察：主 bridge 与 worker 槽**属于同一个 cell**，凭据、数据根、owner 全同 —— 它们的 13 个
卫星是**完全重复**的，共享它们**不产生任何跨租户风险**。

## What Changes

- **每个 cell 一套 MCP 卫星宿主**：由该 cell 的 server 起一份（不是每个 dsh 一份），
  暴露出 streamable-http 端点；该 cell 的所有 dsh 世代（主 bridge + 各 worker 槽）以
  `url` 形式接入，不再各自 `stdio` 拉起 13 个子进程。
- **dsh 侧接线**：`TASK_WORKER_MAX>0` 时，worker 的 MCP 条目从 stdio 改为指向本 cell 宿主的
  streamable-http 端点；`TASK_WORKER_MAX=0` 的单 dsh 形态**逐字节保持不变**（回滚面）。
- **成员级覆盖仍在，但换位置**：fd-memory 的成员 token 与 library 的成员集合目前靠
  **per-worker 私有 mcp patch**（`writeMemberMcpPatch`/`applyMemberOverrides`）下发。共享宿主
  进程只有一份 env，无法同时代表多个成员 —— 因此本期**只共享与成员无关的部分**，
  fd-memory / library 仍按 worker 私有 patch 走（见 Non-Goals）。
- **失败域**：宿主挂了 = 该 cell 的 MCP 工具变灰（dsh 既有降级路径），**不影响其它 cell**，
  也不影响该 cell 的对话回合本身。

## Capabilities

### New Capabilities

- `cell-mcp-host`: 每 cell 一份的 MCP 卫星宿主（端点、会话接入、失败语义、观测）。

### Modified Capabilities

- `worker-pool`: worker 槽不再自带卫星集合，改为接入所属 cell 的宿主；`TASK_WORKER_MAX=0`
  形态不变。

## Impact

- **代码**：`server.js`（起宿主 + 生命周期）、`server/worker-slots.js`（条目形态）、
  `dsh-profile.js`（`toMcpClientEntry` 已是 `url` 就绪，只需在组合期指向宿主）。
- **收益（可行性复核后的实测口径，见 design.md F2）**：可共享的是 **8 个「只读 cell env」卫星**
  （fleet/cron/delegation/fleet-architect/blueprint-author/pack-author/persona-evolution/
  skill-evolution）+ bench-proposal，合计 ≈560Mi 标称 / **≈270Mi 实扣**；`actions` 因读
  `DSH_SESSION_ID` 需按请求注入，本期不做。每多一个 worker 槽即省这一份（约 1.6 倍于浏览器车道）。
- **风险面**：宿主是 cell 内的单点（挂 = 该 cell MCP 变灰，非跨租户）；进程内的凭据=该 cell 的，
  与今天同权限，**没有新增跨租户写面**。
- **观测**：内存面 cell 行应能看出「该 cell 有几个卫星进程」，便于验证共享是否生效。

## Non-Goals（明确不做，避免把风险放大）

- **不做跨 cell 共享**。那需要「可信调用方 → cell」的绑定，且卫星会代表该 cell 执行**写操作**，
  判错即跨租户写。浏览器车道那套（peer → cwd → 16-hex）可复用，但那是另一个 change 的事。
- **不动成员级覆盖**：fd-memory 成员 token、library 成员集合仍按 worker 私有 patch 下发；
  要让它们也共享，得先把 per-member 配置改成**按请求注入**，属于前置改造。
- **不共享读成员级 env 的卫星**（library/websearch/fd-memory），也**不做** `actions`
  （其 `DSH_SESSION_ID` 是会话级，需按请求注入）。
- **不改 `TASK_WORKER_MAX` 的取值**：并发开不开是 worker-pool 线的裁决，本变更只是把「开槽」
  的边际成本从 ≈450Mi 降到 ≈0。
