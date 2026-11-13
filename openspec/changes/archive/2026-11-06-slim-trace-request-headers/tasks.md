# slim-trace-request-headers — tasks

## 1. 实现

- [x] 1.1 `server/trace.js` record()：`request/header` 瘦身为 `{header:{config:{provider,model}}}`——tools 数组与 adapterDefaults 不落库（存储有界纪律）
- [x] 1.2 消费方兼容：turn 列表聚合（header_payload→config 归因）与 fleet-runs 两处读取零改动（字段路径保留）

## 2. 测试与收尾

- [x] 2.1 test-trace-store 新增 1 条：712 工具 roster 落库被拒于门外（identity-only 断言+归因兼容）——12/12 绿
- [ ] 2.2 出片上产（净化快照线）+ 归档
