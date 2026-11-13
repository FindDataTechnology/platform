# Tasks: add-runner-packid-disambiguation

## 1. 实现

- [x] 1.1 `fleet_members.pack_id` additive ALTER + createMember INSERT/VALUES + PLAIN_COLUMNS
- [x] 1.2 PATCH 面收 packId（校验 ≤64 非空或 null）+ memberView 透出
- [x] 1.3 物化穿线：reconcile materializedSpec/specDrift + cron addJob/updateJob + task-engine
  saveTasks/createManualTask
- [x] 1.4 `runnerEntryFor({ packId })`：多命中按 `/packs/<packId>/` 过滤；调用侧传 `job.packId`

## 2. 测试

- [x] 2.1 test-fleet-carrier：钉中（双包同名+packId 精确命中、无 fail-open）
- [x] 2.2 test-fleet-carrier：未声明/钉不中 → 维持 runner-ambiguous
- [x] 2.3 全量回归 + lint

## 3. 出片与验收

- [x] 3.1 公开门 CI 四轮绿（含并线两修+读面补钉一轮重滚）→ 池两轮 → relay/ccr（手动 skopeo
  绕过，双仓 digest 一致）→ GitOps bump 两版（sha-57af8e6→sha-108aeee，imageID 双验 89460ec2/aa6ec5b2；
  bump 前祖先律核过，feat/agent-builder b9d48b17 并入为超集）
- [x] 3.2 真机验收（一次性舰队活体矩阵）：未钉→turn 1497 `runner-ambiguous`；钉中（Ut_bJMuW/
  KmpgjvkE）→turn 1554/1560 **无 carrierFallback**、远端车道真实尝试、网关后端 502/503 如实传播；
  钉不中（zzz）→turn 1562 `runner-ambiguous`。**绿远端回合挂账**：reception 同名 4 entry 的三包
  接待服务后端全 502/503 下线（供给侧，非本机制；同 km 车道类外因）。途中逮出并修复真缺陷：
  `deserializeMember` 漏 packId 读面（写面有读面丢→物化静默归零），回环测试钉死 13/13
- [ ] 3.3 台账 §15.121 续九 + 双分支收正 + 归档（主 spec 同步律）
