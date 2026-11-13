# 证据台账 — slim-browser-lane-footprint

本文件记录任务 3.3 / 4.1 / 4.2 / 4.3 的实测证据与 5.x 的发布路径。数字均为实跑，
不是估计。

## 1. 改造前基线（4.3 前半，2026-11-08，fd-prod）

`kubectl -n fd-prod top pod`：`platform-59c57b8575-kqt2p  430m  1776Mi`
（同期 `platform-demo` 548Mi，另一个 pod，未计入）。

pod 内 `/proc` 扫描（同一套归组规则，只读）：

```
TOTAL RSS MiB: 3523 procs: 37
(no-cell)           2317Mi procs=31 browser=2  browser-mcp.js:50Mi,browser-mcp.js:48Mi
1da519d4c1c0bf89     632Mi procs= 3 browser=1  cli.js:127Mi
3fdc7b8e8ac03b68     573Mi procs= 3 browser=1  cli.js:109Mi
```

- **chromium / headless_shell 进程数 = 0**：浏览器车道此刻完全闲置。
- 闲置成本 = `browser-mcp.js` ×2（98Mi）+ `@playwright/mcp/cli.js` ×2（236Mi）= **约 334Mi**。
- RSS 合计 3523Mi 与 cgroup 1776Mi 的差是共享页重复计（既有已知口径，非本次问题）。
- 注：两个 `browser-mcp.js` 因 cwd 无 cell 线索落在 `(no-cell)` 桶（正是本变更要消除的
  「无归属的每 cell 复制品」形态）。

**改造后对照（4.3 后半）尚缺**：需先出片并上产（见 §3），届时用同样的两条命令复测：
预期 platform pod ≤2.5GB（`kubectl top`），cell 进程表内不再出现 `browser-mcp.js` /
`playwright cli.js`，而 `browser-lane` 桶转为 1 份 `browser-lane-service.js` + 1 份
`cli.js`。

## 2. 真机冒烟（3.3 / 4.1 / 4.2）

`node scripts/smoke-browser-lane-shared.mjs`，本机 macOS + 钉版
`@playwright/mcp@0.0.80`（临时装在 `/tmp/browser-mcp-pin`）+ 本机 chromium-1228：

```
smoke-browser-lane-shared: ok — 24 tools, navigated about:blank,
artifact routed into cell 0123456789abcdef (2 file(s)),
sessions 0123456789abcdef / fedcba9876543210 isolated;
navigate reply: ### Ran Playwright code ... Page URL: about:blank
EXIT=0
```

覆盖到的断言：
- 真实 chromium 导航（`about:blank`，不需要外网，但需要可用的 chromium + 系统库）；
- `browser_take_screenshot` 落在 `<CELL_DATA_ROOT>/<cellId>/workspace/browser/`（具名 1 份
  + 未命名 1 份由清扫归位，共 2 份）；
- 第二个 cell 的截图落在自己目录，两边互不出现（4.2）；
- 回环 cookie 页：cell A 登录写入 `lane_cell=AAA`，cell B 在**同一进程**上看不到该 cookie（4.1）；
- cell A 会话关闭后新会话再访问，同样看不到旧 cookie —— 会话结束不残留（4.1）；
- 全程仅 1 个 `cli.js` 进程（1.2 哨兵的另一侧证据）。

## 3. 实测发现的三个部署事实（已写进 DEPLOY.md）

1. 钉版 0.0.80 的 `--port` 同时暴露 `/mcp`（streamable-http）与 `/sse`（legacy SSE）：
   design D2 的「只有 SSE」前提对这支钉版不成立。前端仍必要（身份/产物/守护是我们
   的职责），当前按设计走 SSE；日后可把上游这段换成 `/mcp`，属简化非行为变更。
2. `--host 127.0.0.1` 必须配 `--allowed-hosts 127.0.0.1:<port>`：CLI 的主机头校验按
   `host:port` 精确比对，缺端口条目会对**自己的** SSE 连接返回 403。
3. 必须 `--allow-unrestricted-file-access`：CLI 把写盘沙箱在 cwd，而共享服务没有单一
   workspace（产物要写进各自的 cell 目录）。模型的越权面仍被前端收窄：输出文件名一律
   降为 basename 并锁进调用方 cell 的产物目录。

## 4. 单测矩阵（`npm run test:unit` 自动纳入）

| 文件 | 覆盖 | 结果 |
|---|---|---|
| `scripts/test-browser-lane-service.mjs` | 1.1 / 1.3 / 1.4 / 1.5 / 4.2 | 9/9 |
| `scripts/test-browser-lane-supervisor.mjs` | 1.2 / 2.4（进程表、EADDRINUSE 收尸、argv 哨兵） | 4/4 |
| `scripts/test-browser-lane-gate.mjs` | 2.1 / 2.2 / 2.3 / 2.4（含无共享端点的逐字段 golden） | 11/11 |
| `scripts/test-browser-lane-manifest.mjs` | 3.1 / 3.2 | 7/7 |
| 既有 `test-proc-memory.mjs` / `test-memory-face.mjs` / `test-cell-wake-admission.mjs` / `test/cell-memory.test.mjs` | 回归（新增 `browser-lane` 桶） | 37/37 |
| `web` `tsc --noEmit`、`check:locales` | 前端类型与五语键 | 干净 |

## 5. 待决与发布路径

- **待裁**：tasks 1.2 的 `--isolated` 与 `browser-use` delta 场景「同一 cell 的登录态跨
  会话保持」互斥。当前按任务实现（隔离优先）。两条路：①承认「同一会话内持久」，删该场景；
  ②给每 cell 持久 profile 目录。
- **发布路径（5.1 / 5.2）**：出片（含本变更的镜像）→ 在 `fd-infra-deploy` GitOps 加
  `browser-lane` 容器与两个 env（`BROWSER_SHARED_MCP_URL` /
  `BROWSER_SHARED_OUTPUT_ROOT`）→ 先只给一个测试 cell 的 patch 打开 → 走查工具面 /
  产物 / 降级三项 → 全量 → 复测 §1 的两条命令 → 回滚演练（删 env + 停 sidecar）。
  生产清单不在本仓，本仓 `k8s/deployment.yaml` 只是设计权威版。

## 6. 灰度实测（5.1，2026-11-08，fd-prod，灰度 cell = aloadtree@finddatatech.cloud / a61f1beddc5297e5）

pod `platform-84c885bc6c-4f6dj`：**2/2 Running**，容器 `platform + browser-lane`，
`shareProcessNamespace: true`。`kubectl -n fd-prod top pod --containers`（两次取样）：

| 采样 | browser-lane | platform | pod 合计 |
|---|---|---|---|
| T+1min | 102Mi | 1864Mi | 1966Mi |
| T+2min | 101Mi | 1629Mi | **1730Mi** |

**走查三项**

1. 工具面 / 服务可达 —— ✅ sidecar `/healthz`：
   `{"ok":true,"sessions":0,"calls":0,"artifactRoot":"/data/browser-lane",
   "upstream":{"mode":"spawn","pid":37,"restarts":0,"reachable":true,"url":"http://127.0.0.1:9311"}}`；
   gateway `/healthz`：`{"cells":2,"browserLane":{"reachable":true,...}}` —— 健康面已带该行。
2. 产物路由 —— ⏳ 待灰度 cell 唤醒后观测（`sessions=0`，该 cell 现为 suspended；产物根
   `/data/browser-lane` 已就位，路由逻辑由单测 + 本机真机冒烟证明）。
3. 降级 —— ✅ 负例成立：未列入 `BROWSER_SHARED_CELLS` 的 cell（`3fdc7b8e8ac03b68` /
   platform-test，真实 cell boot 时写入的 patch）仍是
   `serverName: playwright / transport: stdio / command: node` —— 灰度没有波及其它 cell。

**仅灰度态的成本（重要口径）**：此刻 pod 内同时存在「pod 级一份 sidecar（101Mi）」与
「两个尚未翻转的 cell 各自那份 shim+CLI（RSS 口径约 2×(50+130)≈340Mi）」，所以灰度期总
占用比改造前**略高**，省下的部分要等全量翻转才落地。按进程表口径对照：

| | 浏览器车道占用 |
|---|---|
| 改造前 | 2 cell × (`browser-mcp.js` ~50Mi + `cli.js` ~110–130Mi) ≈ 340Mi |
| 灰度态 | sidecar 101Mi + 2 个未翻转 cell 的 340Mi |
| 全量后（预期） | 仅 sidecar（101Mi 空闲 + 会话期 chromium），cell 侧 0 |

**探针坑（已在 GitOps 修复，cf45601）**：`hostNetwork` 下 `httpGet` 探针按 pod IP
（节点 IP）连，实测 `Get "http://100.64.0.14:9310/healthz": connection refused`，Pod 卡
1/2、Service 无端点；必须 `httpGet.host: 127.0.0.1`（或 exec 探针）。

### 6.1 线上端到端（真 chromium、真身份归因，不经登录）

在 platform 容器里以**灰度 cell 的 runtime 目录为 cwd** 起一个 MCP 客户端连
`http://127.0.0.1:9310/mcp`（这正是服务用来判定归属的证据源：连接方进程的 cwd）：

```
tools=24
nav.isError=false
shot.isError=false
```

sidecar 侧证据：

```
[browser-lane] session 328fe5b6 bound to cell a61f1beddc5297e5 (via cwd);
               artifacts → /data/cells/a61f1beddc5297e5/workspace/browser
[browser-lane] cell a61f1beddc5297e5 browser_take_screenshot:
               filename→/data/cells/a61f1beddc5297e5/workspace/browser/s51-walkthrough.png
```

落点核对：该 cell 的 `workspace/browser/` 出现 `s51-walkthrough.png`（4254B）**以及**
自动命名的 `page-2026-11-08T04-49-26-455Z.yml`（未命名产物被清扫归位）；另一个 cell
（3fdc7b8e）同名文件计数 **0**。走查后已删除这两份产物，只留台账。

### 6.2 灰度第二次滚动（带会话退役，2026-11-08）

滚动后 pod `platform-6669d48ddc-lgch6` 2/2；`platform` 容器镜像 `sha-c4b5573`（并发会话的
基线），`browser-lane` 容器镜像 `sha-6da050d`（本变更 + 会话退役）。sidecar `/healthz`：
`{"ok":true,"sessions":0,"calls":0,"sessionIdleMs":1800000,"upstream":{"pid":37,"reachable":true,"restarts":0}}`
—— `sessionIdleMs` 字段本身就是新构建在产的证据。gateway `/healthz` 仍带
`browserLane.reachable=true`。

`kubectl top --containers`：browser-lane **103Mi** / platform 2206Mi（此时两个非灰度 cell
各有一条 dsh 回合在跑，platform 侧取数偏高，不用于对比）。进程表口径：
`(no-cell) cli.js:105Mi + browser-mcp.js:45Mi + 47Mi` —— 105Mi 那份是**共享服务自己的**
上游 CLI；另两份 shim 属于尚未翻转的 cell。

**滚动期间观测到的既有脆弱点（非本变更引入）**：platform 容器首启 3 次因
`FetchTimeoutError: outbound fetch timed out after 10000ms: https://auth.finddatatech.cloud/oidc/.well-known/openid-configuration`
CrashLoop，第 4 次才起。与 `fd-deploy` 侧 auth 的 boot 期 OIDC fail-fast 同源，见
memory 的「登录链两侧脆弱点」。共享车道的 sidecar 不受影响（它不依赖 OIDC）。

### 6.3 全量 + 回滚演练（5.2 / 4.3 终值，2026-11-08，用户批准）

**全量**：去掉 `BROWSER_SHARED_CELLS`（不设 = 全部 cell）→ Argo 同步 → 滚动。验证：

- **所有在跑的 cell patch 都是 `transport: streamable-http`**（3fdc7b8e / 2b043ce / 1da519d4，
  05:27 写入）；suspended cell 保留旧 patch，下次开机自然翻转（懒翻转，符合预期）。
- **cell 内 browser 子进程 = 0**（三个在跑 cell 的 `browser=0`）：
  `1da519d4 466Mi procs=2 browser=0`、`3fdc7b8e 434Mi procs=2 browser=0`、
  `2b043ce 374Mi procs=2 browser=0`。
- **整个 pod 只有 1 个浏览器进程**（`browser_procs=1`，共享服务那一份）。
- 共享服务会话按 cell 分布：`sessions=4`，覆盖 3 个 cell（其中一个 cell 两条会话）。

**footprint（`kubectl top`，全量后、4 个活跃 cell）**

| | 值 |
|---|---|
| pod 合计 | **2294Mi**（browser-lane 120Mi + platform 2173Mi） |
| 提案基线（4 cell，改造前） | 3102Mi |
| 差值 | **约 −800Mi** |

同一口径的进程表（RSS，含共享页重复计）：改造前 3523Mi/37 procs → 全量后
4406–4671Mi/51 procs；差异来自活跃 cell 数从 2 涨到 4、且此刻**真有浏览器在跑**
（改造前 chromium 数为 0）。**省下的部分是"每 cell 的重复份"**（每个在跑 cell 约
170Mi：shim ~46Mi + CLI ~110–130Mi），而不是整块内存。

**回滚演练（完整一次）**

1. 注释 `BROWSER_SHARED_MCP_URL` + 滚动 → pod 内该 env 计数 **0**；cell 侧重新长出
   `browser-mcp.js ×3 + cli.js ×3`（`1da519d4 613Mi browser=1 cli 129Mi`、
   `3fdc7b8e 542Mi browser=1 cli 132Mi`、`2b043ce 496Mi browser=1 cli 128Mi`）；
   共享服务 `sessions=0`。**删 env 即回每 cell 自家进程，无需回滚镜像** —— 与设计一致。
2. 恢复 `BROWSER_SHARED_MCP_URL` + 滚动 → Argo `Synced/Healthy`，pod 2/2，
   cell 侧 `browser=0` 再次成立，共享服务重新接会话。

**滚动期间**：每次滚动 platform 容器仍可能因 boot 期 OIDC discovery 10s 超时被
CrashLoop 一到数次（既有脆弱点，与本变更无关）；sidecar 不受影响。
