# Tasks: fix-fleet-run-header-settle

## 1. 实现
- [x] 1.1 `db.listOpenRuns({before, limit})`：暴露仍 open 的实例头（raw 清单，不裁判）
- [x] 1.2 `ledger.sweepOpenRuns({now, graceMs=30min})`：过宽限期的头逐一判断——在飞行句柄或 queued/running 任务携带则跳过；零回合明细让位给孤儿判定；否则走既有 settle 口径 finalize（状态由行算出）
- [x] 1.3 `server.js` 启动即跑 + 每小时保洁调用，日志 `[fleet-runs] settled N leaked open run header(s)`

## 2. 测试
- [x] 2.1 泄漏头（回合行已落、句柄已随进程消失）被新进程清扫收口，状态由行算出（ok）
- [x] 2.2 在飞行句柄（链的下游未起）不被误收
- [x] 2.3 宽限期内（<30min）的头不动
- [x] 2.4 零回合明细让位：ledger 判定跳过，孤儿清扫判 failed——两套口径互不覆盖
- [x] 2.5 本文件其余引擎 seam 类失败经 HEAD 对照确认为既有（与本改动无关）

## 3. 上产与验证
- [x] 3.1 出片 `sha-a38dd87`（源 eda8fd24）：构建 run 40647308003 绿、relay OK、ccr 硬门 digest 388f0ead、GitOps 46595be、pod 1/1 Running restartCount=0
- [x] 3.2 镜像内验证 `sweepOpenRuns` 在位（server/fleet-runs.js=2 处、server.js=1 处）
- [x] 3.3 bump 前归属核对：被替换镜像 sha-3029330 的源 fa306bfc ⊂ eda8fd24（未回退他人已部署修复）；origin/main 更新的 9b1b5e38 未部署、不在本镜像，由其车道下一滚带上——立律入记忆 gitops-bump-ancestry-check

## 4. 收口
- [ ] 4.1 `openspec validate fix-fleet-run-header-settle --strict` 绿
- [ ] 4.2 归档 + 主 spec 同步（agent-fleet-runs 两条要求）+ 台账 §15.76 引用本 change
- [ ] 4.3 存量泄漏头的收口路径核验：3fdc7b8e / 6db2b1b4 的 cell server 子进程下次启动时由启动清扫收掉（无需人工动库）
