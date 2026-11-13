## 1. dispatch 许可：handoff 成对双向授权

- [x] 1.1 `server/fleet-orchestration.js` `dispatchAllowed`：显式 dispatch 边命中外，另查声明 handoff 边——`from→to` 或 `to→from` 任一命中即许可；错误文案同步更新（指明 handoff 授权路径）
- [x] 1.2 错误文案与工具描述（`server/fleet-mcp.js` dispatch_post description）同步：许可来源加 handoff 成对授权
- [x] 1.3 `scripts/test-fleet-orchestration.mjs` 补四场景：正向移交成立 / 反向退回成立 / 未声明第三岗仍拒 / 自派与跨舰队护栏不变
- [x] 1.4 expandedEdges/validateOrchestration 不受影响（无隐式落盘边）——回归断言

## 2. 报数：声明槽位键可见

- [x] 2.1 `server/fleet-context.js` `renderSelfBlock`：本岗块追加声明槽位清单行（键/label/unit；无声明槽位时不加行）
- [x] 2.2 `server/routes/fleets.js` `/report` 响应体加 `declaredSlots`（成员行 kpiSlots 键数组）
- [x] 2.3 `server/fleet-mcp.js` `toolReport`：文本拼装使用 declaredSlots——UNRECOGNIZED 提示改为「声明槽位=…；未识别=…」
- [x] 2.4 `scripts/test-fleet-report-lane.mjs` 补：本岗块含槽位键行 / 声明键报数零 unrecognized / 未声明键仍标 unrecognized

## 3. 回合预算：cadence.turnTimeoutMs

- [x] 3.1 `server/cron-runner.js` `runCronJobTurn`：预算解析=member.cadence.turnTimeoutMs（有界 [120000, 1800000] 钳制；未声明/非法/读失败=默认 10min）；仅 fleetId sourceTag 路径生效
- [x] 3.2 普通定时任务不读该字段（无 sourceTag.fleetId 直接默认）——断言
- [x] 3.3 `scripts/test-cron-round-rotation.mjs`（或就近 cron-runner 测试）补：界内生效 / 越界取界 / 未声明默认 / 解析失败降级
- [x] 3.4 blueprint/模板校验面如涉及 cadence 字段白名单，放行 turnTimeoutMs（查 fleet-template.js cadence 校验）

## 4. 收口

- [x] 4.1 `openspec validate fix-fleet-chain-operability --strict` 绿
- [x] 4.2 相关套件全绿：test-fleet-orchestration / test-fleet-report-lane / test-fleet-mcp-hints / test-cron-round-rotation / test-fleet-turn-veracity
- [x] 4.3 lint（biome）+ 提交（不扫并发会话在途文件）
