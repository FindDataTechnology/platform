# shard-unit-suite-on-github

## Why

本地已经不可能每次跑全量：这台机器上 unit 套件 **574 个文件 / 5115 条用例**，一次 15 分钟起；
冷 CI runner 实测 **63 分钟**（run 42630983629）。而 `slim-unit-suite-runtime` 已经把真因量清楚了——
不是 spawn、不是超时，是 **`--test-concurrency=1` 的作用域**：为了压掉少数几个共享全局状态的文件，
把**全部**文件一起串了。它同时给出了唯一正确的切法：**按文件列表切，绝不用 `--test-shard`**
（那玩意切的是扁平化后的用例列表，会让同一文件的用例并发跑到不同 runner 上），并留下护栏
`scripts/test-unit-shard-safety.mjs`。本单就是把那条 3.4 落地。

第二条动机是公开仓的车道根本没通：`FindDataTechnology/platform` 是 **PUBLIC**（Actions 分钟数
免费无限），但 CI 从 2026-11-08 起每次都死在第 5 步 `biome check .`，unit 那 63 分钟从来没机会跑。
门禁一条红又一条红地叠着，等于没有门禁。

## What Changes

1. **`scripts/unit-shard.mjs`**：以 `scripts/test-*.mjs`（与 `test:unit` 同一个 glob，不是第二份
   清单）为唯一真源，按 **round-robin 文件切片**；`--run` 直接以 `--test-concurrency=1
   --test-timeout=180000` 跑自己那片，本地开发用它替代全量。
2. **`scripts/test-unit-shard-coverage.mjs`**：钉住"切得全"——任意分片数下并集 == 全集、两两不交、
   每片非空、片间大小差 ≤1；以及**收口判据本身能红**（缺片/重复/无人认领的文件都必须点名）。
   丢一个文件的漏跑是"没有症状"的失败：不报错，只是少跑了几条。
3. **`ci.yml`**：unit 从 `gates` 里那一步拆成 `unit` 矩阵（8 片，`fail-fast: false`）＋
   `unit-coverage` 收口 job（下载 8 份 manifest，断言并集 == 全集）。manifest 在**跑测试之前**
   写盘，所以分片自己挂了也仍然交代了它认领了哪些文件。

## Capabilities

（无 —— 纯工程吞吐与门禁拓扑，不改变任何产品行为。`skip_specs: true`。）

## 边界与非目标

- **不动 `--test-concurrency=1`**：片内仍然完全串行。并发是**机器之间**的事，不是文件之间的事。
- **不改任何用例、不裁用例**：本单只回答"在哪台机器上跑哪一段"，不回答"哪些该删"。
- **不给分片单独装依赖**：`unit` 每片都要 `npm ci` + 装 dsh 矩阵树（与原来那一步同形，**不 link**
  进共享 home），所以 dsh 相关套件照旧 skip——这样分片结果与旧的单 job 结果可比。
- **`unit-coverage` 不跑 `npm ci`**：它只用 node 内置模块，不能被一个已经成功八次的安装步骤堵住。

## 已知的、本单不修的

- 公开仓 CI 的 lint 步今天仍红：3 条 blocking error（`scripts/test-library-cjk-search.mjs` 两个未用
  变量、`web/src/pages/DocumentsPage.tsx` 的 `useExhaustiveDependencies`）。它们不属于本单主题，
  但**必须先绿，unit 矩阵才会在主线上被触发到有意义的结果**。
- `scripts/test-design-lint.mjs` 在主线本来就是红的：`web/src/components/fleet/MemoryDrawer.tsx`
  用 5 个命名色、基线只允许 3（文件与基线都与主线逐字相同，即这不是合并带进来的）。设计语汇的
  裁定权在 owner 那条线上，本单不去替它选色、也不去 `--update-baseline` 把棘轮磨平。
- 公开仓的 main 落后于 gitee 真源（最后一次 CI 是 2026-11-10 的 `78f63d4b`）。同步策略要单独定。
