# Tasks — shard-unit-suite-on-github

## 1. 切分器

- [x] 1.1 `scripts/unit-shard.mjs`：唯一真源是 `scripts/test-*.mjs`（与 `test:unit` 同一个 glob）；
      round-robin 文件切片；`--shard i/N` 打印清单、`--manifest` 落 JSON、`--run` 自带
      `--test-concurrency=1 --test-timeout=180000`、`--check-artifacts <dir>` 做收口断言
      - `--shard 3/8` = 72/574 个文件；`npm run test:unit:shard -- 3/8` 本机实测 **67 s / 613 条**
- [x] 1.2 `scripts/test-unit-shard-coverage.mjs`：并集 == 全集、两两不交、每片非空、大小差 ≤1
      （分片数 1..8 逐一验）
- [x] 1.3 **反向证明护栏能红**：给 `shardFiles` 注入"每片悄悄丢掉最后一条"，覆盖用例立刻报
      `✖ every shard count 1..8 partitions the files exactly once`；还原后 4/4 绿（备份 cp + 覆写 + cp 还原，
      未用 `git checkout --`）
- [x] 1.4 收口判据的 CLI 路径也反向验：8 份 manifest → `✓ 所有分片并集 == 全集（574 个文件，无重复、无遗漏）`
      exit=0；删掉 `shard-6.json` → 同时点名 `shard indexes are 1,2,3,4,5,7,8 but 8 shards were declared`
      与 `72 suite file(s) ran on NO shard`，exit=1
- [x] 1.5 `package.json` 增 `test:unit:shard` / `test:unit:shard:check`；`test:unit` 本身一个字未改
      （`test-unit-shard-safety.mjs` 仍钉着 `--test-concurrency=1` 与"禁 `--test-shard`"）

## 2. CI 拓扑

- [x] 2.1 `ci.yml`：`unit` 矩阵 8 片，`fail-fast: false`，`timeout-minutes: 45`；每片
      `npm ci` + 装 dsh 矩阵树（**不 link**，与旧行为同形）+ 写 manifest 后跑自己那片
- [x] 2.2 `unit-coverage` job：`needs: unit` + `if: always()`，`download-artifact` `merge-multiple`，
      跑 `--check-artifacts`；不 `npm ci`
- [x] 2.3 `gates` job 删掉 "Unit tests" 一步，job 名改成 `lint → typecheck → locales → build → e2e (fast)`；
      120 分钟上限保留（现在是余量而不是止损）
- [x] 2.4 YAML 解析验证：jobs = `unit, unit-coverage, gates, dsh-contracts`，矩阵 8 片，
      `gates` 里已无 unit 步
- [x] 2.5 **真跑（2026-11-13，公开仓 run 43326300851）**：8 片全部结出，**6 绿 2 红**，
      收口 `unit (shards cover the whole suite)` 绿、`gates` 绿（自 2026-11-08 以来第一次）。
      片耗时 **1:41–4:31**（原单步 63 分钟）；收口 job 15 秒。
      红的两片各只有**一个文件**，都是主线既有债、不属本单（见 §4）

## 3. 本地用法（本单的日常价值）

- [x] 3.1 改了哪个方向就只跑那一片：`npm run test:unit:shard -- 3/8`（67 s vs 全量 ~15 min）
- [ ] 3.2 把这条写进 `AGENTS.md` 的执行偏好段（等 2.5 绿了再写，免得先教一个没验过的做法）

## 4. 真跑暴露出来的事（逐条归位）

前四轮 CI 一共翻出 8 个只有真跑才会露的问题，其中 6 个已在本单修掉：

| 现象 | 真因 | 处置 |
|---|---|---|
| 7 片挂 `Cannot find package 'react'` | 旧的单 job 里 unit 在 `Install web dependencies` **之后**；拆 job 时漏了 | unit job 补该步 |
| 收口报 "shard indexes are 7 but 8 shards were declared" | `merge-multiple` 把 8 份同名 `shard.json` 合成一份 | 文件名带分片号 + 静态护栏 |
| `test-personal-auditor` ENOENT | 仓里写死 `/Users/chengsishi/finddata/paas/…` | 从本文件推 repo 根 + `pathToFileURL` |
| `test-app-zhiyu-routes` 缺 expo-router | 要 app 自己那份依赖（断言的是解析后的路由树） | unit job 补 `npm --prefix app ci` |
| `test-memory-vocabulary-parity` 缺兄弟仓 | 单仓 checkout 结构上没有 fd-agent-graph | 只在 `No module named 'fd_agent_graph'` 时带名跳过 |
| `test-trading-fleet-consistency` 无工作区 | 它是**工作区级**验收（比 fd-wire 的 docs/openspec 与仓外 reports） | 文件头 `// workspace-only:` 声明 + 分片器点名剔除 |
| `test-knowledge-profile-noop` "not a valid object name" | 它用 `git log -S` 搜全史找引入提交，再取其父提交 | unit job `fetch-depth: 0`（全史仅 ~48 MB） |

**剩下两片红，都在别的线上，本单不修**（它们是真债，不是环境）：

- `scripts/test-design-lint.mjs` → `web/src/components/fleet/MemoryDrawer.tsx` 用了 5 个命名色、
  基线只许 3。**文件与基线都与主线逐字相同**，即主线本来就是红的。该用哪个状态色是设计语汇的
  判断，归那条 UI 线的 owner；`--update-baseline` 会把棘轮磨平，不做。
- `scripts/test-kind-dispatch-ratchet.mjs` → `server/cron-runner.js:1564` 与 `:1854` 按
  `=== "persona"` 直接分流，既没走 `isPersonaBackedTargetKind` 也没写理由。归 kind dispatch
  那条线（"统一"还是"写理由"是它的语义选择）。
