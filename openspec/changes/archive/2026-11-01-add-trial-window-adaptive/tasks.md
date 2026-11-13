# Tasks: add-trial-window-adaptive

## 1. 实现

- [x] 1.1 `server/blueprint-trial.js`：导出纯函数 `nextTrialDeadline({ deadline, hardCap, inflight, pollMs, now })`（D1 规则）
- [x] 1.2 生产 `collectAndWait`：hardCap=now+2×timeoutMs；轮询循环内以 cron.listJobs 判在途 → 调用
  nextTrialDeadline 顺延；累计 extendedMs 进证据面 `windowExtendedMs`

## 2. 测试

- [x] 2.1 test-blueprint-trial：nextTrialDeadline 三态钉（inflight 顺延 / 封顶不再越 / 非 inflight 原样）
- [ ] 2.2 全量回归 + lint

## 3. 出片与验收

- [x] 3.1 公开门双绿 → 池出片 → relay/ccr → GitOps bump（bump 前核祖先）
- [x] 3.2 真机验收：km 3.3 trial 重跑——深队列下窗口顺延、回合获得执行机会、`windowExtendedMs` 落报告；
  若车道稳定则顺手取端到端绿
- [x] 3.3 台账 §15.121 续八 + 双分支收正 + 归档（主 spec 同步律）
