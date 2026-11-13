# Tasks — add-fleet-ruling-ledger

## 1. 点火侧记下发起岗（`server/fleet-handoffs.js`）

- [x] 1.1 三类 hop（接棒 persona/a2a、接棒 tool、扇出）在 `origin.fleet` 写 `byMemberId`
- [x] 1.2 与既有 `ignition`/`depth`/`wave`/`chain` 同族，不改变 `memberId` 语义（仍是下游岗）

## 2. 汇总回合开成 run 节点（`server/delegation-aggregator.js`）

- [x] 2.1 `export function rulingTurnIdentity(group, initiator)`：裁决波解析 initiator，
      无裁决波取 `byMemberId`，皆无 → null
- [x] 2.2 `export function rulingTurnJob({group, initiator})`：合成 job（sourceTag + origin.fleet.chain）
- [x] 2.3 注入前 `begin`（在 prompt **之前**，使回合内派发能链到它）
- [x] 2.4 collector 路径用 `collectTurn` 的 `{text,error,usage}` 精确 `end`
- [x] 2.5 live 路径落 `ok` 但不带 usage（dsh-events 收口 usage，此处不虚构）
- [x] 2.6 `end` 后 `settle(runId)` 收口该 run
- [x] 2.7 开/合失败只记警告，汇总照发（降级放行）

## 3. 注释纠正（`server/fleet-events.js`）

- [x] 3.1 `pricingOf` 上方仍写「回合行只带 pricing_at、从不带钱（D4a）」——⑪ 已推翻，改正

## 4. 测试（`scripts/test-fleet-ruling-ledger.mjs`，7 条）

- [x] 4.1 归属：裁决波 / 无裁决波 / 无证据（含升级前缺 `byMemberId` 的 hop）
- [x] 4.2 job 形状：sourceTag + 嵌套 chain（**夹具必须按真实形状嵌 `origin.fleet.chain`**，
      铺平会测到生产中不存在的形状）
- [x] 4.3 账本：节点加入同一 run、parentTurnId/edgeKind 正确、usage 计入、run 收口 turns=2
- [x] 4.4 失败回合落 failed 而不是无行
- [x] 4.5 **全域接线**：`attachDelegationAggregator` + 真 engine 走完整聚合路径
      （collector 通知形状须为 `session.event`/`assistant/message` + `session.status: idle`），
      断言 run 里出现 `w_up`/`delegation`/parentTurnId=`turn_root`/edgeKind=`fanout` 的行
- [x] 4.6 **反向证明**：把注入路径的 `rulingJob` 置 null → 4.5 红（4.3 仍绿，因为它直调 helper）；
      恢复后 7/7 全绿
- [x] 4.7 相邻套件：persona-park-lane 9、fanout-aggregation 5、fleet-runs 26 全绿

## 5. 门禁

- [x] 5.1 `npx biome check`（三个源文件 + 测试）绿
- [x] 5.2 `openspec validate add-fleet-ruling-ledger --strict` → `is valid`
- [x] 5.3 全量逐文件扫（每文件 100s 超时，在隔离克隆里跑）：431 文件 / **3894 条、3892 绿 / 2 红**；
      两个红都是并发线既有的：`test-pack-cell`（断言 `/not a registry server/`，文案已改名
      "not a market server"）、`test-supply-store-migrate`（跑在途的 dual-read 脚本）。
      两者在**不含本 change 的远端线上同样红**，与本 change 无关

## 6. 上线

- [x] 6.1 出片滚版 → 已在产（快照取自远端线 750ae41f3 → GHA `sha-cc3b5d2`，digest `sha256:25c2317a`，
      relay 105s 到位；fd-infra-deploy `633bb40` 双 bump → ArgoCD 75s → 两 rollout 完成；
      镜像内 `test-fleet-ruling-ledger` = 7/7 绿；源码面 `rulingTurnJob`×4、`byMemberId`×3 均在）
- [ ] 6.2 观察项：滚版后看一次真实扇出的 run 详情，确认裁决回合在列表里且合计含它

## 7. 挂账（不在本变更）

- 7.1 「开节点后进程崩溃」不会留下 interrupted 行（引擎回合有回填，此处没有）
- 7.2 live 路径的 usage 需从 dsh-events 的 finishTurn 回收才能入账
- 7.3 前端尚未把裁决节点画进时间线（本次只落账本）
