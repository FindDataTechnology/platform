# Tasks — fix-persistence-flush-teardown-race

## 1. 定位

- [x] 1.1 复现「用例全绿、文件判红」
  - 实证：`test-queue-supersede.mjs` 单跑 3 次，第 3 次红；TAP 里 `ok 1..7` 之后跟着
    `unhandledRejection`，node 报文件级 `not ok 1`
- [x] 1.2 找到真实抛点
  - 实证：`lib/persistence.js` 只对 `rename` 做了 ENOENT 兜底；`open(tmp,"w")` 在目录被
    删后抛 ENOENT 时**没有任何兜底**，拒绝直接逃逸
- [x] 1.3 确认这是既有绕法的根因
  - 实证：`scripts/test-queue-health.mjs:54` 的注释把同一现象记成"删目录会撞 rename ENOENT"，
    于是改成只删文件——绕开而非修复

## 2. 修

- [x] 2.1 `atomicWriteText`：flush 全链路 ENOENT 归一为「告警 + 清理临时文件 + 返回」
- [x] 2.2 **放弃 retry/mkdir 重建**（先试过的错解）
  - 实证：重建目录会让所有者的递归 `rmSync` 撞 `ENOTEMPTY`，同一文件 8 次挂 1 次——
    比原缺陷更糟。删掉的数据目录不该由写库复活。

## 3. 验

- [x] 3.1 `scripts/test-persistence.mjs` 增 3 条（open 腿 / rename 腿 / 非 ENOENT 照抛），12/12 绿
- [x] 3.2 反向验证：换回 HEAD 的 `lib/persistence.js`，新用例 4 号必红（10/12）
- [x] 3.3 `test-queue-supersede.mjs` 连跑 15 次全绿
- [x] 3.4 24 文件 spawn 样本并发 8：131/131 绿
- [x] 3.5 `biome check` 两个改动文件无告警
