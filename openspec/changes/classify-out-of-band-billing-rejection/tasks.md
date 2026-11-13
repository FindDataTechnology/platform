## 1. 形态判定（纯函数）

- [ ] 1.1 `agent-runner/manager.js` 旁新增导出纯函数 `isBillingRejectionShape(e)`：认 `e.status`/`e.statusCode`/`e.response.status` ∈ {401,403}，或 message 匹配 `/^40[13]\b.*status code/i`；单测表驱动覆盖 `403 status code (no body)`、`401 Unauthorized`、`e.status=403`、以及**反例**（`500`、无 status 的普通 Error、`402`）各一例
- [ ] 1.2 反例必须为 false——特别是上游 5xx 与超时类错误不得被当作计费候选；这条例用 `-32001`/`-32002` 的真实错误对象断言

## 2. 接入触发（不动停车判据）

- [ ] 2.1 catch 内触发改为 `e?.code === -32003 || isBillingRejectionShape(e)`；验证既有 runner 测试零回归（`npm test` 全绿）
- [ ] 2.2 形态命中但探测未判拒绝时：不停车，记 debug 日志 + 事件 `error_kind: billing_unconfirmed`；单测断言"探测 pass ⇒ 不 park 且 `isParked` 为 false"
- [ ] 2.3 形态命中且探测判拒绝时：与 `-32003` 路径**同一条**停车逻辑（不复制第二份），断言 `billing_parked` 事件与 `-32012` 快速失败都成立

## 3. 事件载荷

- [ ] 3.1 失败分支的 `turn_ended` 增 `error_kind`：`timeout`（`-32001`+budgetKilled）/ `child_exit`（`-32002`）/ `llm_failed`（`-32003`）/ `billing_unconfirmed`（形态命中未确认）/ `unknown`（其余无码）——逐分支单测
- [ ] 3.2 成功分支断言 `error_kind` **缺席**（不是 null）；并断言未知消费方（只读既有字段的测试）不受影响
- [ ] 3.3 断言 `billing_rejected` **不**出现在 `turn_ended`（时序决定的），判决只在 `billing_parked`

## 4. 收口

- [ ] 4.1 `openspec validate classify-out-of-band-billing-rejection --strict` 通过；paas 既有测试套全绿
- [ ] 4.2 上产后复现验证：对 `wx-alpha`（当前已暂停、计费键失效）先 `resume` 使其回到会失败的状态，观察应在**一个失败回合**内出现 `billing_parked`（而不是连续数周的 `rollover failed … 403` warn）；验证完再 `pause` 回去
  - **2026-11-10 实况：此条不成立，先别勾。** 演练证明探针用 runner 级 key（`/models` 200），而回合的 403 来自 agent 自己钉的 `pk_…`（已失效）；两把不是同一把 ⇒ 探针永远 pass ⇒ 永不 parking。这是设计盲点，不是分类器判据问题，详见 `measurements.md` §8。
  - 前置条件改为两条之一：(a) pin 捕获发生在探针之前，或 (b) 探针用子进程实际持有的那把 key。做完任一条再回来跑本条的复现。
  - 补丁 `f1de6a468` 已完成的是「让下一次失败自证原因」：三层里每个非决策分支现在都会写明 why。上产与 pod 内验收（platform + 两个 runner 三处均 `grep` 命中、BUILD-INFO 基线核对）见 `measurements.md` §9；此刻无活样本，warn 按设计沉默。
