# Tasks — fix-legacy-fleet-task-tags

## 1. 判据

- [x] 1.1 `fleetTagOf(job)`：`sourceTag.fleetId ?? origin.fleet.fleetId`，memberId 同样双源回填
- [x] 1.2 替换 6 处单源判定：`roundChildSessionId`、就绪门、`earlyStop`、两处 `isFleet`（收尾/诊断）、`cron.js` 的上下文注入门

## 2. 测试（`test-legacy-fleet-task-tags.mjs`，3 条）

- [x] 2.1 双源解析：现代 / 存量 / 混合（sourceTag 赢、memberId 从 origin 补）/ 都不是 → null
- [x] 2.2 存量任务轮转子进程对话；真非舰队任务不轮转
- [x] 2.3 存量任务进入收尾判据；真非舰队任务不进
- [x] 2.4 反证：退回单源 → 3 条全红；还原 3/3 绿
- [x] 2.5 28 个 cron-runner 消费套件全绿

## 3. 规格

- [x] 3.1 `cron-module`：舰队回合条款补双源归属 + 1 场景

## 3b. 覆盖面实测（产线，1820 条舰队岗位任务）

- [x] 3b.1 `sourceTag` 1301（71.5%）· `originOnly` 394（21.6%）← 本刀修复 · **三源皆空 125（6.9%）**
- [x] 3b.2 三源皆空样例：`company-ceo` / `company-oss` / `invest-chief` 等早期 cron 物化任务
- [x] 3b.3 判定：第三源（preset→成员反查）**未做**——会把归属从记录字段变成运行时查询依赖；
      候选处置是修数据（给这 125 条补 sourceTag），属写操作，待拍板

## 4. 上线

- [x] 4.1 快照 5621744 → GHA ✅ → relay → digest sha256:fe9230bf → GitOps 53ddec2 → ArgoCD → 舱内实证
      `fleetTagOf=6 / threshold=4 / worker=1`，套件 3/3
- [x] 4.2 归档
