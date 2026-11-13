## Why

`add-principal-disclosure-gate` 的 D8 定的是「runner 每次对外应答前向 cell 取一次裁决，取不到就不发」。这条在代码里**只写完了下半截**：

- 接裁决的一侧齐了——`manager.js:1186` 的 `#mandateVerdict()` 在拿不到客户端时返回 `{ok:false, reason:"no_verdict_client"}`，失败关闭；cell 侧 `POST /api/actions/mandate-verdict` 也在，未配置如实 503。
- **递裁决的一侧从来没接上**——`agent-runner/index.js` 构造 `ChildManager` 时压根没传 `mandateVerdictClient`，于是 `manager.js:139` 的默认值 `null` 永远生效，`:1188` 的 `no_verdict_client` 是**恒定结果**，不是异常兜底。

结果是：对外披露闸从上线那天起就没做过一次真裁决。它的「失败关闭」表现为**一律不发**，闸门的绿灯（拒绝发出）与它坏掉的形态（拒绝一切）**在账本上同形**——正是本项目反复吃过的那个坑。归档 change 里 `6.6 失败关闭演练：引擎侧未注入裁决客户端即拒绝发出` 打了 `[x]`，但那条验的是「未注入时拒绝」，恰好把缺陷本身验成了预期行为。

## What Changes

- **`agent-runner/config.js`** 解析两个新 env：`MANDATE_VERDICT_URL`（去尾斜杠）、`MANDATE_VERDICT_TOKEN`。
- **`agent-runner/index.js`** 在构造 `ChildManager` 前按 env 组装 `mandateVerdictClient` 并作为实参传入。客户端做三件事：5s 超时、按 `Bearer` 调 `/api/actions/mandate-verdict`、把响应规整成 `{ok, decision, reason, violations}`。
- **两条判定口径写进规格**（此前只在 design 里说过，规格里没有）：裁决通道未配置 ⇒ 不注入 ⇒ 失败关闭；裁决通道给不出肯定答复（非 2xx、超时、坏形状）⇒ 同样失败关闭。两者都不许被当成「放行」。
- 未配置的安全性由「两个 env 缺一即不注入」保证：任何只配了一半的部署，行为与打补丁前**逐字节相同**（仍是 `no_verdict_client`），不会因为半配置而变成「放行」。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `principal-disclosure-accountability`：补一条 requirement——裁决通道缺失或不可达时 SHALL 失败关闭，且「通道不可用」与「通道判了拒绝」必须在可观测面上可分。

## Impact

- 代码：`agent-runner/config.js`、`agent-runner/index.js`。42 行新增、0 行删除；不进 cell、不进 gateway。
- 数据：无迁移。不写库、不动 `action_audit` 结构。
- 部署：只有同时注入 `MANDATE_VERDICT_URL` 与 `MANDATE_VERDICT_TOKEN` 的 runner 才会开始真裁决；未注入的部署行为不变。
- 回滚：`git revert a5ca95d9b`（release 线对应提交 6b77b1114），回到「从未注入 ⇒ 恒 no_verdict_client」。回滚不涉及数据，无迁移负担。

## 决定记录（硬约束③）

两条口径都有歧义的两个方向，一律选了**可验证更严的一侧**，理由与反例写在 `design.md` 的 D1 / D2。
