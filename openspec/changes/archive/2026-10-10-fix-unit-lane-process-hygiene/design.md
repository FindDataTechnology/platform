# Design — fix-unit-lane-process-hygiene

## Context

- e2e 车道已有四层防御（00b308b/d83953a）：`e2e/helpers.js` 的 `spawnTestServer`（detached 自成进程组 + `kill(-pid)` 组杀 + 20s 挂梯）、worker 信号钩子、`e2e/teardown.js` 的 PPID=1+标记双门控扫荡。**该实现是已验证的正确形状，本设计复刻它并补上 unit 车道缺的两层。**
- unit 车道（`npm run test:unit` = `node --test --test-concurrency=1 scripts/test-*.mjs`，CI 三处引用）零防御：14 个 spawn 型脚本裸 `spawn` + finally 里只杀单 PID、600ms 即 SIGKILL。node --test 每文件一个子进程，全部子孙继承 runner 的进程组。
- 事故形态（2026-10-10）：spawner 挂死 → 脚本 SIGKILL"收尸人"网关 → dsh cell 被 launchd 收养（PPID=1、组号仍是死掉的 runner 组），每个稳定烧 ~40% 内核态 CPU（用户态采样全空闲——死管道上的事件churn），整机 load 20 / 54% sys。
- 硬约束：仓内 mkdtemp 前缀 120+ 个且持续增生——任何"标记枚举"路线（扩 `E2E_MARKER` 正则或统一改名）都不可行。结构化扫荡（PPID=1 + tmpdir store）会误杀 detach 的手工调试会话（10-09 夜的 `dbg-*` 残留即此类）。

## Goals / Non-Goals

**Goals:**
- unit 车道任何退出方式（正常/断言失败/Ctrl-C/SIGTERM/脚本被 SIGKILL）都不留进程与 store 目录残留
- 与 e2e 车道单一事实源，两套防御不再漂移
- 清尸对并发运行的其他测试零误杀

**Non-Goals:**
- Playwright 车道行为变化（仅同源重构）
- probe/诊断脚本（`scripts/probe-*.mjs` 等）换装
- 生产 cell 断链自灭兜底（另立 change——孤儿 cell 的内核态空转是生产问题，但检测语义需要独立 grill）
- CI runner 卫生（瞬态环境）

## 词汇（工程术语，不进产品 CONTEXT.md）

- **车道（lane）**：同一套测试进程生命周期管理下的运行入口——Playwright e2e 车道 / node --test unit 车道。
- **进程组归属（group ownership）**：server 以 detached 自成进程组组长被 spawn，其所有子孙继承该组，一组一杀可达全树。
- **属主（owner）**：spawn 该 server 组的测试脚本进程；属主退出即应收车。
- **登记（registration）**：helper 在 server 可产子孙前落盘的 `{组号, 属主PID, store根}` 三元组。
- **陈尸（corpse）**：属主已死但组仍活（或 store 根仍在）的登记。

## Decisions

### D1 · 安全网 = 所有权登记，不是标记扫荡

**决定**：helper spawn 时把进程组登记到 `$TMPDIR/paas-test-servers/` 下（**每 组 一 个 JSON 文件**，文件名=组号），helper 模块导入时先扫该目录：属主 PID 已死（`kill(pid, 0)` ESRCH）→ 组 SIGKILL + `rm -rf` store 根 + 删登记；属主存活 → 跳过。

**理由**：120+ 前缀证明标记路线永远追着漏；结构化扫荡有误杀手工会话风险。登记是精确所有权：谁 spawn、谁收、收不掉的自愈。每组一文件天然免锁免写竞态（node --test 串行，且并发直跑也不共享文件）。

**备选否决**：① 扩展 `E2E_MARKER` 枚举前缀（永远漏新前缀）；② `test:unit` wrapper 退出时杀 runner 组（保护不了直跑单脚本；与 detached 自成组互斥）；③ PPID=1+tmpdir 结构化扫荡（误杀手工调试会话）。

### D2 · 钩子住在属主进程里（SIGKILL 之外全覆盖）

**决定**：helper 首次被某脚本进程使用时装 `exit`/`SIGINT`/`SIGTERM` 钩子，退出时对自己登记的全部组直接组 SIGKILL（钩子路径无需优雅——SIGKILL 是兜底，正常路径走 stop() 挂梯）。复刻 `e2e/helpers.js:125-134` 的形状，去掉 Playwright 环境变量门控。

**理由**：node --test 每文件一子进程，钩子随脚本进程生灭，直跑单脚本同样受保护；不需要改 `package.json`。属主被 SIGKILL 是唯一漏网路径，由 D1 自愈兜住。

### D3 · 组杀挂梯与 e2e 共一个 20s 常量

**决定**：`stop()` = 组 SIGTERM → 轮询至退出、上限 20s（与 e2e 同值：bridge 关停梯 5s RPC + 6s EOF + 3s TERM ≈ 14s 最坏）→ 组 SIGKILL → 组内收尾宽限 250ms（rm store 前让内核回收 fd）。

**理由**：600ms 升级线是本次事故帮凶（合法的慢停被当成挂死）；20s 只在真挂死时付满。常量放共享模块仅一份。

### D4 · e2e 同源：抽核到 `scripts/lib/test-server.mjs`

**决定**：把 `e2e/helpers.js` 的 spawn/stop/组杀/钩子核心抽为 `scripts/lib/test-server.mjs`（含登记+自愈），`e2e/helpers.js` 改为 import 并保留其 Playwright 专属部分（per-worker store、页面助手）。14 个脚本换装时 import 同一模块。

**理由**：两套并存必然漂移——本次事故的直接病因就是 e2e 有防御而 scripts 没有。绿道风险由 CI fast e2e 把关。

### D5 · 换装是纯机械替换，逐脚本验证

**决定**：每个脚本：`spawn(process.execPath, [server], {...})` → `spawnTestServer({ env, args })`；finally 里 `proc.kill()` 梯 → `await server.stop()`；脚本自建的健康等待/断言不动。14 个脚本一次换完，CI 三处自动生效。

**理由**：部分换装=留同类洞（已两次复发实证）。行为差异仅"杀得更对"，不改变测试语义。

## Risks / Trade-offs

- **触碰 e2e 绿道**（D4）：抽出的是逐行搬移，CI fast e2e 全绿为验收门。
- **PID 复用**（D1）：复用 PID 让陈尸被当活登记跳过 → 只会延迟一轮清尸，不会误杀；可接受。
- **登记目录残留**：属主死且组也死、但登记文件还在 → 导入扫除按"属主死"门控直接删文件，幂等无累积。
- **孤儿 cell 的内核态空转本身**（烧 CPU 的机理）不在本 change 修复范围——修复后孤儿不再产生，但生产环境同类风险留给断链自灭 change。
- **验收锚点**：全量 `npm run test:unit` 后 `ps` 断言零残留（dsh/server/gateway 全查）；人为 `kill -9` 一个脚本进程 → 跑任一测试 → 断言尸体与 store 根被自动清走。
