# Tasks: add-cockpit-run-reclaim

- [x] 1.1 `reclaimOrphanRuns`:open + 超宽限(30min) + 零明细 → failed(endedAt=startedAt, turns 0);并入 pruneRuns 返回值,导出单测;验证:单测 孤儿收口/在途不动/有明细不动 21/21
- [x] 1.2 server.js 启动即跑一次 + 每小时(与既有保洁同函数,记 warn 日志);验证:语法/lint 绿
- [x] 1.3 全量回归 + 出片随下班车 + 真机验残留 run_d92b41 被清
- [x] 1.4 台账补记 + 归档
