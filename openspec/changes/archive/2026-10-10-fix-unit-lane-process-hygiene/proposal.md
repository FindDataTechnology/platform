## Why

unit 车道（`npm run test:unit` = `node --test scripts/test-*.mjs`）没有任何进程卫生防御：14 个 spawn 子进程的测试脚本全部裸 `spawn` 网关/server，teardown 只杀单 PID、600ms 等不及就 SIGKILL——而 SIGKILL 杀死的恰恰是负责收 cell 的网关进程本身。2026-10-10 晚两轮 test:unit（跑在 spawner 修复 122b7aa 之前的代码上）泄漏 4 个 dsh 孤儿（PPID=1），每个稳定烧 ~40% 内核态 CPU（整机 load 20、54% sys 时间、swap 3.4GB）；另有 2026-10-09 夜一次手工调试 server 残留 19 小时。既有"四层防御"（00b308b）只覆盖 Playwright e2e 车道，其扫荡标记路线对仓内 120+ 个 mkdtemp 前缀也不可行。

## What Changes

- 新增共享测试 server spawn helper（`scripts/lib/`）：detached 自成进程组 + 组杀升级梯（组 SIGTERM → 20s 宽限 → 组 SIGKILL），与 e2e 车道已验证的 `spawnTestServer` 同一形状
- helper 为属主脚本进程安装 `exit`/`SIGINT`/`SIGTERM` 钩子，退出时收走自己登记的全部进程组（覆盖 Ctrl-C、worker 崩溃等 stop() 未及执行的路径）
- 所有权登记：helper spawn 时把进程组（+ store 根）写入 `$TMPDIR` 登记文件；helper 导入时扫陈尸——属主 PID 已死的登记直接 SIGKILL 其组并 `rm -rf` store 根。被 SIGKILL 的脚本留下的残局由下一次任何测试运行自动清走
- 14 个 spawn 型测试脚本全量换装共享 helper（机械替换：spawn→helper、finally kill→stop()）
- `e2e/helpers.js` 抽核复用同一实现（单一事实源，消除 e2e/scripts 两套漂移——本次事故的直接病因）

**非目标**：Playwright 车道行为不变（仅同源重构，由 CI fast e2e 验证）；probe/诊断脚本不换装；生产 cell 断链自灭兜底另立 change；CI runner 自身（瞬态环境）不涉及；`package.json` 的 test:unit 命令不变。

## Capabilities

### New Capabilities

- `test-process-hygiene`: 测试进程的生命周期卫生——进程组归属（所有子进程可被一次组杀覆盖）、属主收车（脚本退出即收走自己的组）、挂梯组杀（SIGTERM 有界宽限后组 SIGKILL，永不只杀"收尸人"）、陈尸自愈（属主已死的登记在下次测试运行时被自动清杀，进程与 store 目录一并）。

### Modified Capabilities

（无——现有 specs 无测试基建能力，本 change 不改动任何既有需求。）

## Impact

- **代码面**：`scripts/lib/` 新增一个模块；14 个 `scripts/test-*.mjs` 机械换装；`e2e/helpers.js` 改为 import 共享核心。不改任何生产行为。
- **风险与对策**：触碰 e2e 绿道 → 依赖 CI fast e2e 全绿；清尸误杀风险 → 陈尸判定以"属主 PID 存活即跳过"保守门控（PID 复用只会导致漏杀、不会误杀）；并发测试运行 → 登记按组一文件，无写竞态。
- **验收基准**：全量 `npm run test:unit` 跑完后 `ps` 断言零 dsh/server 残留；人为 SIGKILL 一个测试脚本后，下次运行自动清尸。
