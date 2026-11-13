# Tasks: add-fleet-post-model

## 1. 存储层(fleets-db)

- [x] 1.1 `fleet_members` 加可空列 `model`、`fallback_model`,`fleets` 加可空列 `default_model`(照 `decision_policy` 的 `try { ALTER TABLE ADD COLUMN } catch {}` 幂等先例);`createMember`/`updateMember`/`updateFleet` 读写透传;验证:库既有行不受影响、新列默认 null
- [x] 1.2 roster 读口与三闸校验 helper:写面校验函数复用 `MODEL_ID_RE` + `modelChoiceError`(roster 真源 `getAvailableModels()`,lanes 降级开放 null);验证:单测覆盖形状/roster/三拒绝文案指名

## 2. 路由面(fleets.js)

- [x] 2.1 建岗/改岗/舰队设置接受 `model`/`fallbackModel`/`defaultModel`,含 `fallback⇒model` 约束与「清 model 须先清兜底」;验证:三闸拒绝 400 指名、约束 400、null 清除回显
- [x] 2.2 a2a 与 cluster 岗位设模型 400 明拒(文案说明模型归服务部署配置/各成员岗位);验证:两类岗位写 model 均拒
- [x] 2.3 `memberView` 带 `model`、`fallbackModel` 与 advisory `effectiveModel`(按链+读时 roster 解析);验证:继承岗 effective=舰队默认、声明失效岗 effective=兜底落点
- [x] 2.4 模型解析函数 `resolveFleetModel`(现查岗位/舰队表,返回命中的模型与留痕信息),暴露给 cron 侧消费;验证:纯函数单测覆盖四档链去空去重、失效回落、全灭

## 3. 回合路径(cron-runner)

- [x] 3.1 `runPersonaTurn` 在 preset 归位后做模型归位(复用 `ctx.switchModelTo`,失败即链下一档);失效回落留痕:服务端日志 + 回合结果 + 存在报数行时进 blockers;验证:设模型 A 回合 usage 记 A、改 B 下回合 B、未设岗不被上一岗残留污染
- [x] 3.2 全链无命中 → 回合如实失败(结构化错误,不硬造);执行中故障维持既有失败语义;验证:roster 清空场景回合失败且错误指名
- [x] 3.3 cluster fan-out:成员按各自解析链归位;汇总回合用首个成功成员的模型;fan-out 结束还原原 preset 与原模型(对齐 D6);验证:混编集群各成员 usage 各归其模型

## 4. 驾驶舱(web)

- [x] 4.1 `FleetsPage.tsx` 岗位卡展示 effectiveModel(persona 岗)与失效回落状态(声明档失效、正落兜底);验证:组件渲染断言或 stub 走查

## 5. 测试与回归

- [x] 5.1 `scripts/test-fleet-core.mjs` 补模型字段读写/校验/明拒/解析链用例并全绿
- [x] 5.2 既有舰队测试全量回归(fleet-core/scheduler/report-lane/report/decision-lane/templates)零新增红;`openspec validate add-fleet-post-model` 通过
