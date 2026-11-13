## Why

编制自己规定了交付契约：官方模板 `docs/fleet-templates/**/teams/*.json` 里 **35 个岗位中 34 个写着「收尾必 report_status」**（97%）。而 24 小时产线实测：**516 个回合只交了 129 份报数（0.25 报/回合）**，`decision_items` 与 `decision_escalations` 全 cell 总计 **0**——拍板链没有任何输入。

抽查最典型的一组（`cell 1da519d4`，24h）：`政策巡检员` 8 个回合 **全 ok、0 报数**；同组的 `盘账岗`、`报班岗` 共 23 个回合里 **22 个没有任何上报痕迹**（`reported:true` 仅 1 条、被拒 0 条）——不是"交了被拒"，是**根本没交**，而结算层照样记 `ok`。

这是同一族缺陷的第六个变体：**成功没有要求交付物**。前五个（读不到当不存在 / 接线被重构删掉 / 声明值冒充实际值 / 128 token 的桩记成功 / 额度满了不找备用）修的都是"记账不诚实"；这一条更靠前——**记账诚实地记了一件没兑现的事**。

## What Changes

- **结算期检查交付契约**：一个 `ok` 的舰队回合，若所在岗位的人设**声明了必交报**而本回合没有完成的 `report_status`，结算 SHALL 标注 `detail.missingReport: true`，并给出 `reported=false` 的依据。
- **不改 status**：仍记 `ok`（回合确实跑完了），但**不再算作"合格交付"**——读面（通过率/交付率）用 `missingReport` 区分「跑了」与「交付了」。这是刻意的：把 `ok` 改成 `failed` 会污染失败率与重跑面，而它其实跑完了。
- **判据来自人设，不来自全局开关**：模板里 34/35 声明、1 个（`wire-fleet-content`，只在被委派时起回合）没声明。检查 SHALL 只在人设声明了契约时生效——一个没声明必交报的岗位不会被判违约。
- **声明是否可机读**：人设文本是自然语言，SHALL 由平台在写 profile 时同时落一条结构化标记（`persona.reportContract = "required" | null`），结算读标记而不是每次正则匹配散文。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-fleet-core`: 回合结果事件的交付契约——`ok` 不等于合格交付；声明了必交报而未交 SHALL 可被判读。

## Impact

- 代码：`server/fleet-events.js`（`shapeTurnOutcome` 增加 `missingReport`）、`server/cron-runner.js`（把岗位的 reportContract 传进结算）、人设装载处（生成 `reportContract` 标记）。
- 数据：无迁移。detail 多一个键；旧行不改写（历史交付率无法追溯，只在读数里说明起算日）。
- 读面：`spend`/通过率之外新增"交付率"（`ok ∧ !missingReport` / 全部回合）。**通过率不变**，这是刻意的。
- 风险：若某岗位人设声明了必交报、但业务上确实"无事可报"（例如本轮扫描无命中），它会被标 `missingReport`。这正是要暴露的：编制要求"必报"时，"本轮无新数据"也该报一句——人设里已写「空结果与失败按四分类如实上报」。
- 回滚：纯 detail 标注，无行为副作用；回滚 = 去掉该键。
