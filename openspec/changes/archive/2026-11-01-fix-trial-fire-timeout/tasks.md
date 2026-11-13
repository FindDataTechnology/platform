## 1. 实现

- [x] 1.1 fireRound 每 job 与 FIRE_TIMEOUT_MS（默认 90s，env 可覆盖）竞速；超时记 {error:"fire timeout"}；导出可测辅助 fireJobBounded。【test-trial-fire-timeout 4/4+test-blueprints 27/0】
- [x] 1.2 测试：假 cron 永挂→有界返回（122ms vs 90s 窗）+error 行如实+快火形状逐字节不变+env 覆盖语义。

## 2. 收口

- [x] 2.1 台账记录+归档。【§15.120 十三续】
