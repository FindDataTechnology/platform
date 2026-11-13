# fix-fleet-model-drift — 实施任务

## 1. 强迫断言信通管（D1）

- [x] 1.1 `switchModelToInner` 增 force 选项（未传 = 行型照旧）；`switchModelTo(id, { force })` 全锁顺利直递。如 force=true 跳过 early-return。
- [x] 1.2 normalizeModelForJob 显式链路径（plan.candidates.length>0 且启动链路排过头声明）→ 调 assert via force 而非 switchModelTo；无显式链岗位照旧早退信任。

## 2. modelMismatch 观测列（D2）

- [x] 2.1 回合落账入 member_turn_events 前的 `shape` 检查：与 trace_turn_id 取 `request/header.config.model`（已有 tap 存 trace.db），与 settled/degraded 模型比对不一致 → detail.modelMismatch={declared,resolved,observedHeader} 透明入闸。
- [x] 2.2 解码正确路径：`payload.event.data.header.config`（§15.61 监管教训，非 `.header.config`）。

## 3. 自愈重走（D2 自愈兜底）

- [x] 3.1 `isModelUnavailableError(err)` 判定器（`model_not_available`、`INVALID_MODEL`、`cannot find model`、`400`+`'model'` 回声）添 llm-lane.js 平行层。
- [x] 3.2 cron-runner runPersonaTurn 失败托架：上述错误 + 本轮没走 force + 有显式链 → 追加一次重断言 + 重走链一次；模型主人公就 ok 记 detail.modelRectified；第二败即按现口径记失败。

## 4. 试验 & 上线

- [x] 4.1 单元 + 情景：投毒 child 会话链模型为 qwen → 下一阵走 assert 自动恢复深寻；不知名失败不重试；无显式链路径不变。
- [x] 4.2 e2e 一情景：dispatch 回合走 mock 致 400 model_not_available → 自愈走第二次成功，trace header.model 恢复（第二阵地断言行）。——2026-11-04 落地 `scripts/test-fleet-drift-self-heal.mjs`（真 runPersonaTurn+真 ledger end+桩桥，五断言全过），**且 e2e 逮出真缺陷：normalizeModelForJob 返回缺 explicitChain 字段致自愈门恒不开=自愈重试自上线即死代码（9f4434ef 原样）**——补 normalize 返回透传 explicitChain（红→绿双证：摘补丁 e2e 红、还原后绿），runPersonaTurn 导出供测。
- [x] 4.3 FLEET_MODEL_ASSERT_SOFT=1 回滚路径留灵。

## 5. 出片与验收

- [x] 5.1 出片滚产同面；台账 §15.63 实录：三聚再发同病区不再发生的证据。
- [ ] 5.2 真机验证挂账：等中毒再次复发后回溯 detail.modelRectified/modelMismatch 任何一种生产显现（14:00 turn 185 是顺势反例：502 不误触、header=deepseek 证明断言落地） 真职间 festiv等到服务化：走查抽浆劳动犯过的 cell，CEO 晓巡自动修复不被手动重启。
