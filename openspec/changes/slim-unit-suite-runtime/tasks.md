# Tasks — slim-unit-suite-runtime

## 1. 量（本单的唯一动作）

- [x] 1.1 测出 unit 步骤的绝对耗时与停摆形态
  - 实证：run 42630983629 的 Unit 一步 **63 分钟**；`--test-timeout=180000` 已生效
    （核过该 ref 的 package.json），故非单条悬挂而是累加
- [x] 1.2 定位成本分布
  - 实证（初量）：489 个 `scripts/test-*.mjs` 里 **58 个**含 `spawnTestServer` /
    `initTaskEngine` / `attachAgentSession`
  - **修正（2026-11-10，更宽正则复扫）**：含任何 `spawn` 形态的是 **73 / 510** 个文件，
    但落在 `test(...)` 体内的 spawn 只有 **26 次** —— 即 spawn 基本是**模块级、每文件一次**。
    附带实测：空壳文件 0.1 s/文件（5 文件串行 0.51s、单文件 0.15s），所以 511 文件全串行
    的进程开销仅 ~1 分钟，**63 分钟里 ~62 分钟是每文件真实的 import + 用例工作**。
    由此"共享 server fixture 摊薄"被证伪（跨文件不可能共享进程），
    真正的杠杆是 `--test-concurrency=1` 的**作用域**。
- [x] 1.3 排除错误解法：`--test-shard`
  - 实证：四文件 TAP 复测，shard 1/2 同时含 browser-lane-artifacts 与 queue-health 的用例
    → 切的是用例列表不是文件列表；已入闸 `test-unit-shard-safety.mjs`
- [x] 1.4 备好量尺 `scripts/profile-unit.mjs`（白名单自动挑 spawn 重的文件；拒绝在无依赖/
      软链依赖的树上跑，因为那会把 sqlite 锁问题伪装成产品红）

- [x] 1.5 实测「慢」已经变成**队列积压**（本单因此从"优化"升为"门禁吞吐上限"）
  - 实证：镜像仓快照 `6f963a019` 的 CI 于 14:46:55Z 起跑、>60 分钟未完成；更新的
    `ffc8168b0` 已 queue 在其后。concurrency=QUEUED + 推送间隔 10–30 分钟 ⇒ 队列只增不减
- [x] 1.6 查清 `--test-concurrency=1` 的来历（决定它能不能缩）
  - 实证：由 `1e3ffc509` 引入，commit 理由是"串行化消并发竞态（614/614 两连绿）"——
    为压掉**一个未点名的子集**的竞态而串了**全部**文件。故它是"最省事的安全选择"，
    从未按文件验证过必要性。
- [x] 1.7 并发对照实验（真实依赖，硬链 node_modules，非软链）
  - 隔离样本 24 文件：串行 20s → 并发 8 **7s（2.9×）**，失败集**完全相同**（3 条既有红）
  - spawn 样本 24 文件：串行 27s / 131 全绿 → 并发 8 **9s**，修前 1 红；
    该红经查是 `test-queue-supersede` 的 teardown 竞态（单跑 3 挂 1），已单独立单修复，
    修后同并发 131/131 全绿
  - 结论：并发不引入不稳定；串行该缩成点名清单
- [x] 1.8 静态排查跨文件争用通道
  - 实证：499 文件**零**写死端口（全 `listen(0)`）；241 文件改 env、25 文件 chdir，
    但每文件是独立进程故**进程内**、跨文件不争用；真正共享的只有写死 `/tmp/…`（12 个）
    与 `~/.dsh`/`os.homedir()`（5 个）
- [x] 1.9 120 文件大批量对照（比 1.7 的 24 文件样本强得多）
  - 串行 `--test-concurrency=1`：**3276 s（55 min）**，30 条红
  - 并发 8：**528 s（8.8 min）**，29 条红 → 6.2×
  - **这两个数要打折**：串行那次与后台 gateway 诊断/验证抢 CPU，并发那次几乎空载；
    可信的干净对照是 1.7 的 24 文件两组。大批量的价值在**失败集**，不在时间。
  - 差集：25 条两边同红；5 条只在串行红（`connector-role-migration` /
    `db-migration-compacted-ledger`，两方向都飘，本身 flaky）；4 条只在并发红，**全在
    `test-agent-serving-billing-park.mjs`**
- [x] 1.10 查实那 4 条"并发新增红"——**不是并发造成的**
  - 实证：该文件全用 `mkdtemp` 根 + `listen(0)`，无共享资源；单跑 3/3 红，抛的是
    `ReferenceError: options is not defined`（`agent-runner/manager.js:1005`）
  - 真因：串行批次跑在 **rebase 之前**，并发批次跑在 rebase 之后，中间合进来的
    `1ac6bb6c5`（出口闸）读了一个 `turn()` 从未有的 `options` 参数 → **每个完成的回合都抛**。
    已单独立单修复并推产（`fix-disclosure-gate-undefined-options`，`57b101309`）。
  - **方法论教训**：两组样本必须跑在**同一棵树**上。跨 rebase 比失败集，差集里混着
    "新合进来的提交"，会把它误判成"被测变量的影响"。这次是差集把我引到真 bug（赚了），
    但同一条路径也能把真 bug 记到并发头上（亏了）。

## 2. 止损（已完成，不属本单）

- [x] 2.1 作业上限 90 → 120 分钟（`a4f162950`）
- [x] 2.2 每用例 180 秒上限（`153631f3e`）

## 3. 后续（未做，等有数据后再定）

- [ ] 3.1 在真实依赖的主树跑 `profile-unit.mjs`，落一份 per-file 耗时榜单
- [ ] 3.2 量串行的作用域：把 `--test-concurrency` 抬到 N 逐批找出会红的文件，收缩成显式
      白名单（这条比 3.1 更可能真正解决问题——耗时榜单只答"谁慢"）
      - 起点已有：1.7 的 24×2 样本 + **1.9 的 120 文件大批量都不产生并发新增红**（唯一那 4 条
        经 1.10 查实是 rebase 带进来的真 bug，不是并发）；1.8 给出共享路径嫌疑名单
        （写死 `/tmp/…` 12 个 + `~/.dsh`/`homedir` 5 个）
      - **先修掉的错误前提**：早先账上写"42 个 spawn 类文件没隔离 DSH_HOME，必须先各自隔离
        才能并发"。**这是错的**——用正确判据（碰 dsh 且完全没有 `DSH_HOME:`/`process.env.DSH_HOME`）
        只有 **6 个**，且实测并发跑完真机 `~/.dsh` **零改动**（marker + `find -newer` 为空）。
        不构成先决条件，别再把它当阻塞项。
      - **下一步的做法**：同一次 `git rev-parse` 的树里跑"串行 vs 并发"两组（不要让 rebase
        夹在中间，见 1.10 的教训），失败集差异要逐条落到具体文件再判定。
- [ ] 3.3 按 3.1/3.2 处理最慢的几个与必须串行的清单：简化 boot / 独立车道
- [ ] 3.4 若最终要分片：按文件列表切 + 「已执行文件并集 == 全集」断言
- [ ] 3.5 `test-agent-serving.mjs` 的 5 条 deploy 阶梯用例各撞 **90s 上限**（合计 ~7.5 分钟，
      约占 unit 总时长的 12%）：`3.2/3.3 author deploys a version` / `3.2 non-author … refused` /
      `3.3 unpublish warns` / `budget: the deploy route …` / `notify: the deploy route …`
      - 该文件已在夹具里设 `deployConfig.reassuranceDelays = [10, 20]`，想绕开生产阶梯
        （注释指向主线 978b05088 一次 335s 的实测），但实测仍撞满 90s——**这个 seam 没生效**，
        值得单独查：是 `...cfg` 展开在某调用点丢了，还是这些用例等的是别的东西
      - 归属 deploy 路由方向，但它直接吃掉 unit 的 12% 时长，属本单主题
