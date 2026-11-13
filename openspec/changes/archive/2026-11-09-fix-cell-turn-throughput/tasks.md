# Tasks — fix-cell-turn-throughput（回溯登记：代码已上产，此处记录验证证据）

## 1. 有界陈旧度

- [x] 1.1 `queueMaxAgeMs()`：`QUEUE_MAX_AGE_MS` 可配，默认 30min，非法/非正数=0（关闭）
- [x] 1.2 `runQueuedExecution` 在开跑前按年龄丢弃排期轮：`skipped` + 不烧预算 + error 写明分钟数
  - 实证：`scripts/test-queue-staleness.mjs` 第 1 例；生产 2026-11-08 三次真实丢弃（40/31/28min）
- [x] 1.3 部署钉 `QUEUE_MAX_AGE_MS: "600000"`（GitOps `platform.yaml`），并写明为何是 10 分钟

## 2. 锚点按首次入队计

- [x] 2.1 `enqueueExecution` 只在本次驻留首次入队时打 `firstQueuedAt`，重入队不刷新
- [x] 2.2 `runExecutionTurn` 开跑即清空锚点（离开队列）
  - 实证：`test-queue-staleness` 第 4 例「重新打戳的等待时钟不会刷新陈旧年龄」

## 3. 锚点持久化

- [x] 3.1 `saveTasks()` 白名单补 `firstQueuedAt`
  - 为什么要单列：该序列化是白名单式，漏一行就等于每次重启丢一次锚点（本单第一版即栽在此）
  - 实证：`test-queue-staleness` 第 5 例读 `jobs.json` 断言字段落盘

## 4. 谁点的决定是否可丢

- [x] 4.1 驻留记录 `queuedBy`（`human`/`cadence`），与锚点同批落盘、同批清空
- [x] 4.2 `runTaskNow` 以 `{ by: "human" }` 入队；老化判定加 `queuedBy !== "human"`
  - 实证：`test-queue-staleness` 第 6 例；生产两次 `queuedBy: human` 的 run-now 均拿到真回合
    （`queuedForMs` 48604 / 173947 → `running` → `done` 276s / 254s）

## 5. 验证

- [x] 5.1 `node --test scripts/test-queue-staleness.mjs` → 6/6
- [x] 5.2 相邻套件不回归：`test-queue-watchdog` 3/3、`test-fleet-turn-events` 15/15、
      `test-queue-health` 8/8（该套件在拆目录竞态下偶发一次 unhandledRejection，重跑两次皆 8/8，
      与本单改动无关）
- [x] 5.3 `node --check task-engine.js` + biome 通过

## 6. 收口

- [x] 6.1 `openspec validate fix-cell-turn-throughput --strict` 绿
