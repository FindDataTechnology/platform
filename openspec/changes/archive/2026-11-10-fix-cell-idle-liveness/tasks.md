# Tasks — fix-cell-idle-liveness

## 1. 定位（诊断由后台代理完成，四条都在源码上复核过）

- [x] 1.1 确认不是 WS 代理的错
  - 实证：alice 的首个 socket 帧是通的（test:284 过）；失败的那次 cell 日志**没有任何**
    `[dsh] runtime ready`
- [x] 1.2 确认 `sessions` 帧的两个发射点都要求 `ctx.session` 已存在
  - 实证：`server/ws.js:422`（连接时）、`:349-354`（onDshReady 后）；`ctx.session` 在
    `server.js:1132` 的启动期模型解析里赋值，boot 被杀则两处都不可能发
- [x] 1.3 确认回收发生在 boot 期
  - 实证：`lastTraffic` 记在 fork（`spawner.js:319`）、只在 `running` 分支刷新（`:668`）、
    `if (pending) return pending` 不刷新（`:677`）、reaper 只看 `lastTraffic`（`~:835`）；
    boot 8.6–12s vs 测试窗口 6s
- [x] 1.4 干预性验证判别式
  - 实证：scratch copy 只把窗口 6s→20s，304/306/314/315 四条 2/2 变绿（未改产品文件）

## 2. 修

- [x] 2.1 `cell.state = "running"` 时重置 `lastTraffic`——空闲从"开始服务"起算
- [x] 2.2 reaper 增加 `isActive?.(cellId)` 早退（挂着的 WS 是 reaper 看不见的流量）
- [x] 2.3 `gateway/index.js` 维护 `liveSockets` 计数并以 `isActive` 注入；`close`/`error`
      各释放一次（`done` 闩锁）
- [x] 2.4 `pending` 分支在 spawn 落地后补刷 `lastTraffic`（986 秒冷启动风暴的放大器）

## 3. 过期断言

- [x] 3.1 2.4 段的 `a cell with an enabled cron job must never be reaped` 与
      `openspec/specs/cell-gateway/spec.md:48-58` 冲突（豁免已被取代），改为断言
      **工作能活过回收**：先等 job 持久（否则断言是空转），再 cold start 后有界轮询确认它还在

## 4. 验

- [x] 4.1 `scripts/test-cell-gateway.mjs` 连跑 4 次全绿（45s / 42s / 75s / 79s）
- [x] 4.2 相邻 registry/reaper 用例 39/39 绿（spawner-dedup / registry-db / crash-ledger /
      wake-admission / memory-gate）
- [x] 4.3 `biome check` 三个改动文件无告警
