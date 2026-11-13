# Tasks: fix-fleet-provisioner-unique-post

- [x] 1.1 provisioner 在岗校验：resolve 循环对 persona/cluster 目标查 `db.findPostByTarget` + 本批 claimed 集合，冲突岗 `targetId=""` 降级并记 `conflicts`（含 occupiedBy），a2a 豁免；缺位与冲突互斥（缺位岗不查占用——死目标非任何人的在任者）
- [x] 1.2 from-template 响应透传 `conflicts`（路由原样回 provisioner 返回体）；空哨兵岗照常建岗、出生 paused、cadence null 岗无任务、有节奏岗 reconcile 停火
- [x] 1.3 读面诚实文案：`deriveMemberStatus` 空哨兵 →「no incumbent assigned — uniqueness conflict at instantiation」；`resolveTarget` label 兜底空串改 null（cockpit 断言 target.label===null）
- [x] 2.1 单测：跨舰队占用冲突（occupiedBy 带舰队/岗位名）✔、模板内重复目标冲突（occupiedBy null+intraTemplate）✔、a2a 多岗豁免（雙崗同 target 不冲突）✔、冲突岗换防补岗（路由腿内：解散占方→swap 200→target 回真值）✔、既有缺位/幂等用例回归 ✔（test-fleet-templates 9/9）
- [x] 2.2 路由测试：from-template 201 响应含 conflicts+occupiedBy ✔；建岗 409 与 provisioner 降级两路径同源对照 ✔；cockpit 空哨兵岗 status=vacant+statusReason 含 conflict ✔
- [x] 3.1 全量回归：test-fleet-templates 9 + core 13 + report-lane 12 + decision-lane 10 + scheduler 12 + report 8 全绿；`npm run lint`/`typecheck` exit 0；openspec validate 绿
