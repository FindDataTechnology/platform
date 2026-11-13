# Design: add-rollout-gap-durability

## Context

滚版窗口治丢的两条缝（提案 Why）。已核事实：webhook 入口 `server/routes/bots.js`
（POST /api/bots/webhook/:botId/:secret）现用**内存 bootBuffer**（BOOT_BUFFER_MAX 满则 503，
SIGKILL 即丢）；各平台适配器已解析消息标识（企微 MsgId 等）；cron 停机补拍在 `cron.js`
（`countMissedOccurrences` + `withinToleranceWindow`，2× 周期地板 6h，杀开关
`PLATFORM_CRON_CATCHUP=0`）；回合孤儿清扫在 `server/fleet-runs.js` `sweepOpenRuns`
（30 分钟宽限）。

## D1 受理队列（write-ahead，盘上）

- 落盘位置：`PLATFORM_DATA_DIR/bot-acceptance`（prod /data 下，随卷持久）；显式
  `BOTS_ACCEPTANCE_DIR` > PLATFORM_DATA_DIR > `dirname(DB_PATH)`（测试 tmp 同根）。
  每受理项一个 JSON 文件，**tmp+rename 原子替换**，0600 权限（载荷含平台签名头）。
- 状态机单向：`pending → dispatched → done`，`transition` 守卫使重复认领（接管与 boot drain
  竞速）返回 null——**单处理保证**。`dispatched` 意为回合已启动：崩溃后接管**不重跑**（防双回
  信），如实结算 done(interrupted)；`pending`（从未启动）才补处理。
- 顺序：验签 → 解析 → 落盘 → 平台应答 → 异步回合 → 打标。重复键（平台重试/边缘重放）在受理
  时命中幂等索引：ack 不二跑，done(duplicate) 可观测。
- bootBuffer 合流：启动窗同样落盘受理，registry 就绪后认领重放——旧 BOOT_BUFFER_MAX 的「丢」
  变「盘上限」（BOTS_ACCEPTANCE_MAX，超限 503 由平台侧重试兜底）。
- 重启接管：构造即装载（load 是构造器的职责）；接管 pass 与 boot drain 认领互斥，重放与首处理
  同路径，幂等层兜底重叠。

## D2 幂等键

- 键 = `botId + 平台消息标识`（适配器已有解析面取名：企微 MsgId、飞书 messageId 等）。
- 存放：受理队列记录自带其键与处理状态；去重查询在受理时（新到项 vs 队列/近期已完成记录）。
- 保留窗：与受理队列同生命周期（D3 的清理策略），不另设 TTL 配置面。
- 解析不出标识的载荷：不造键，按原行为处理（宁重复不假重）。

## D3 队列清理

- 处理完成 + 保留期（≥ 容差补处理窗口，建议常量与 cron 容差同数量级）后删除盘上记录；
  启动时一并清扫已完成且过保留期的残留。上限（盘字节数/条数）超限时显式 503 + 留痕。

## D4 fsync 与丢失窗口的诚实边界

- 落盘用「写临时文件 + rename」原子替换；fsync 目录一步在 v1 可省（进程崩溃不丢已 rename 文件，
  掉电窗口接受）——如实记录该边界，死窗（无监听）回调仍依赖平台重试，本变更保证重放安全。

## D5 打断回合补拍（与 cron 补拍合流）

- `sweepOpenRuns` 结算 cron 源孤儿 run 后挂钩 `onInterruptedRun`（factory 注入参数，server.js
  传 `cron.makeUpInterruptedBeat`——决策单点在 cron 模块导出，可测）。
- `makeUpInterruptedBeat({fleetId, memberId})`：杀开关 → 无任务/暂停 → `no-task`；
  `withinToleranceWindow`（2× 周期、地板 6h，同源复用不复制）不过 → `outside-tolerance`；
  窗内 → `catchUpPending = true` + `fireTask`（与 boot 补拍同 marker 同引擎路径=无双发），
  返回 `makeup`。窗外/不补的痕迹=已结算 run 行（interrupted/failed 如实在账）+ warn。

## D6 测试

- 受理队列：落盘先行（应答前文件在）、重启接管补处理、上限落盘、超限 503。
- 幂等：同键重放不二跑（回合数断言）、无标识不造键、跨重启幂等保留。
- 补拍：孤儿+窗内→makeup 一拍且不与 cron catch-up 双发；窗外→missed。
