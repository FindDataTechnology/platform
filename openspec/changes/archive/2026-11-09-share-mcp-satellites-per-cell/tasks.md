# Tasks — share-mcp-satellites-per-cell

## 1. 可行性收口（设计期先答，不写代码）

- [x] 1.1 确认 dsh 的 MCP 客户端在 `streamable-http` 下**不会**自动重连/重试导致宿主被反复打爆
      （`@modelcontextprotocol/client` 的 StreamableHTTPClientTransport 行为）；验证 = 读装的那个
      版本的源码 + 一个最小连通实验（宿主停 30s 再起，观察客户端是否自恢复）
- [x] 1.2 确认 13 个卫星里哪些**真的与成员无关**（本期只共享这一档）：逐个核对它启动时读的 env
      是否只含 cell 级值；已知 fd-memory（成员 token）/ library（成员集合）必须排除；
      验证 = 产出「可共享 / 必须保留 per-worker」两栏表，落 design.md
- [x] 1.3 确认 `sessionGatedMcp: ["websearch"]` 的闸在哪一侧：若闸在 dsh 侧（tools/set），
      共享宿主可保留 websearch；若在卫星进程内，则 websearch 需留在 per-worker 档；
      验证 = 代码定位 + 结论写进 design.md

## 2. 宿主（cell 内一份）

- [x] 2.0 范围按可行性结论钉死：只共享 **8 个「只读 cell env」卫星**（fleet/cron/delegation/
      fleet-architect/blueprint-author/pack-author/persona-evolution/skill-evolution）+ bench-proposal；
      `actions` 本期不做（需 `DSH_SESSION_ID` 按请求注入）；library/websearch/fd-memory 留 per-worker。
      收益按此重算 = ≈560Mi 标称 / **≈270Mi 实扣**（不是 proposal 初稿的 450Mi）
- [x] 2.1 cell server 起一份卫星宿主，仅承接该 cell 的 dsh 世代；`TASK_WORKER_MAX=0` 时**不启动**
      （单 dsh 走原路径，形态不变）；验证 = 单测：cap=0 不启动、cap>0 启动一次
- [x] 2.2 宿主以 streamable-http 暴露，dsh 侧以 `url` 条目接入（`toMcpClientEntry` 已支持）；
      验证 = 单测断言生成的 patch 里该条目 `transport: streamable-http` 且无 `command`
- [x] 2.3 宿主生命周期与 cell 同生共死（cell 退出即收），并对自身子进程做退出清理（不留孤儿）；
      验证 = 单测：`stop()` 后 ps 里无残留（已实证）；与 cell 同生共死待 2.1 接线后验证
- [x] 2.4 失败域：宿主挂 → 该 cell MCP 工具降级、其它 cell 不受影响、恢复后自动可用；
      验证 = 故障注入单测（停宿主 → 工具报错且原因明确；重启宿主 → 恢复）
      - 实证：SIGKILL 一个卫星后邻居仍正常出工具；该端点按**声明集**回答
        `satellite "<name>" is not running`（POST 走 200+SSE JSON-RPC error，与真传输失败同形），
        `/healthz` 同步 `up:false`；重启宿主后客户端自恢复（1.1 实测 ~4ms 恢复）

## 3. 成员级覆盖保持原样

- [x] 3.0 **白名单校验**（D4 风险）：断言共享集里的每个卫星其启动 env 不含成员级键
      （TOKEN/SECRET/COLLECTIONS/PROJECT_ID/EMAIL），新增卫星若不遵守会在这里红；
      验证 = 单测遍历共享集合 + `server/*-mcp.js` 的 env 读取，出现成员级键即失败

- [x] 3.1 fd-memory / library 仍走 worker 私有 patch（`writeMemberMcpPatch` 未改）；
      验证 = 既有成员补丁单测全绿 + 新增「共享宿主下成员视图不变」用例
      - 用例断言 `library` 仍 `transport: stdio` 且带 `LIBRARY_COLLECTIONS`，
        `fd-memory` 仍带 `headers.Authorization: Bearer <member token>`
- [x] 3.2 断言共享**没有**把成员视图放宽为账号级；验证 = 两成员跑同一宿主，各自只看到自己的集合
      - 两个 persona（`mo-inventory` / `ops-wx-chief`）在同一宿主下各写一份补丁：
        集合 `col-a,col-b` vs `col-z`、token 各自一份，互不继承

## 4. 观测与验证

- [x] 4.1 内存面 cell 行暴露卫星进程数与总量；验证 = 单测 + 真机：单 dsh cell 与多 worker cell 可直接对比
      - 单测：`groupScan` 的 cell 行新增 `satellites: { count, totalBytes }`（没有卫星就报 0，
        不是缺字段——形状不能随流量变）；face 层 admin 与 owner 两档都断言不被 scoping 剥掉
      - 真机（2026-11-08，`platform-5f47f47dbf` / 镜像 `sha-6f121f5`，仍是**旧镜像**）：3 个 cell
        各 1 个 dsh，卫星 **14 / 13 / 13** 颗、997–1120Mi/cell，全 pod 40 颗。这就是新字段的数据源；
        字段本身随下次出片生效（cap=0 / cap=1 的对照仍归 4.2）
- [x] 4.2 真机收益对照：同一 cell 在 cap=0 / cap=1 两种形态下的 pod 实扣与卫星数；验证 = `kubectl top`
      + /proc 扫描，数字进台账
      - **已在 scratch 做完整 A/B（2026-11-09）**：不占 fd-prod 配额。`default` 命名空间
        （cheap-ts，12Gi 配额 0 使用）+ 生产镜像 `sha-6f121f5` + **线上真实 mcp.json**
        （ConfigMap `platform-mcp-config`，13 个服务器）+ 真 dsh 二进制
        （`node /app/node_modules/@deepseek-ai/dsh/lib/bin.js --profile platform --patch …`）。

        | 形态 | dsh | 卫星进程 | 卫星 RSS |
        |---|---|---|---|
        | 不共享（每 dsh 自起一套） | 2 | **12** | **909Mi** |
        | 共享（一份宿主，按 url 接入） | 2 | **9** | **628Mi** |

        `satellites per dsh` **6.0 → 4.5**；第二个 dsh 省 ≈281Mi（其中 ≈225Mi 是
        fleet/cron/delegation 三颗被合掉的）。省不掉的是 library/actions/bench-proposal：
        真实清单里 `bench-proposal` 带 `envRefs`（BENCH_URL/BENCH_CONSUMER_TOKEN/
        BENCH_PROPOSAL_DOMAIN），被 D4 守卫按成员级处理，故**真机的"可共享 9 个"是上限**。
      - **真池派发下的 A/B（2026-11-09，同一 scratch，cap=2 真实派发）**：自起 `server.js`
        （`TASK_WORKER_MAX=2` + 死模型 `LLM_BASE_URL=http://127.0.0.1:9/v1` 吊住回合），
        铸两个 persona、经 `POST /api/delegation/tasks` 发两条委派，
        `[worker-pool] active` + `spawned worker-1/worker-2` + 两条同时 `running`（overlap）。

        | 形态 | dsh（主 + 2 worker） | 卫星进程 | 卫星 RSS |
        |---|---|---|---|
        | `MCP_SATELLITE_HOST=0` | 3 | **42** | **2848Mi** |
        | 共享宿主 | 3 | **26** | **1814Mi** |

        **省 16 颗 / 1034Mi**，正好 = 2×(8 颗共享集)。规律：省 = 8 ×（dsh 数 − 1）。
        工具面实测（不走 dsh 日志，直接打共享端点）：`fleet` `status=200 count=6`
        （report_status/escalate/dispatch_post/decision_queue/decision_resolve/
        decision_escalate_to_owner）。
        **口径**：两个 dsh 的手臂是"手起两代"（合成形态），3 dsh 的手臂是**真池派发**；
        后者才是生产 cap=2 的形状。共享集在这个镜像里是 8 颗（多出 meta-team 那 5 颗：
        blueprint-author / fleet-architect / pack-author / persona-evolution / skill-evolution）。
      - **A/B 顺带抓到一个真缺陷并已修**：宿主取 spec 与补丁改写用的是两套判据。补丁里
        "还带 command 的可共享名"≠"实际被改写成 url 的名"，于是 bench-proposal 会被
        **宿主和每个 dsh 各起一份**（比不共享更糟）。修法：`isShareableSatellite()` 单一判据 +
        `writeMcpPatch` 落 `mcp.shared.json` 权威清单，宿主机只认这份（无 sidecar 时回落声明集，
        老目录升级不退化）。真环境验证：sidecar 恰为 `fleet,cron,delegation`，宿主 specs 一致。
      - **fd-prod 仍不能验**：`all-services/prod/platform.yaml` HEAD = `TASK_WORKER_MAX: "0"` +
        `limits.memory: 4Gi`；`bad370c revert … — namespace quota blocks 7Gi`；更早 `e40ef37`
        注释写死「TASK_WORKER_MAX=0 是**刻意的容量决定**，节点预算不含并行 dsh 子进程」。
        链条：开槽需富余内存 → 7Gi 被 38Gi 命名空间 quota 否掉 → 回 4Gi → 3 cell 已占 ≈4.1Gi。
        **本变更是让开槽变便宜的那一刀，不是那个决定本身。**
      - 现状基线（cap=0，2026-11-08 生产真机）：3 cell / 每 cell 1 dsh / 卫星 14·13·13 颗 /
        997–1120Mi per cell / 全 pod 40 颗 —— cap=1 时的对照就拿这一行比
      - **取数命令**：`node scripts/probe-satellite-sharing.mjs`（只读，进 pod 用镜像自带的
        `lib/proc-memory.js` 采 `/proc`，打印每 cell 的 dsh 数 / 卫星数 / 卫星 MiB /
        占比，末行 `satellites per dsh`；`--json` 出单行便于前后 diff）。窗口前后各跑一次
- [x] 4.3 出片 + 灰度（先一个开 worker 的 cell）；验证 = `tools/verify-rollout.sh` + 该 cell 回合/工具面走查
      - 镜像已出并灰度（`sha-5d79069`，灰度 `aloatree@gmail.com`）。订正：灰度键**没有被覆盖**——
        它在 ConfigMap `platform-config`（`envFrom` 注入），pod 内实测 `CELLS=aloatree@gmail.com`
      - **走查在等价环境完成（2026-11-09 scratch / `default` ns）**：自起 `server.js` +
        `TASK_WORKER_MAX=2` + 死模型吊住回合，铸两 persona、发两条委派 →
        `[worker-pool] active`、`spawned worker-1/worker-2`、两条同时 `running`；
        `[satellite-host] sharing 8 satellite(s) … fleet,cron,delegation,blueprint-author,
        fleet-architect,pack-author,persona-evolution,skill-evolution`；
        工具面直接打共享端点：`fleet status=200 count=6`（工具名见 4.2）
      - **口径（必须写明）**：这不是 fd-prod 的灰度 cell，而是同镜像 + 同真实清单的等价部署。
        fd-prod 侧灰度 cell 从未进入共享路径（池关），所以那条路径上的走查**不可能**发生，
        直到容量决定改变（见 4.2）。
- [x] 4.4 回滚面：`TASK_WORKER_MAX=0` 即回到单 dsh 原形态，无需回滚镜像；验证 = 演练一次
      - **演练已在 scratch 完成（2026-11-09）**：同一 pod、同样 2 个 dsh，只切换宿主开关——
        开：9 颗卫星/628Mi（共享）；关（`MCP_SATELLITE_HOST_URL` 不设）：12 颗/909Mi，
        patch 逐条回到 `transport: stdio` + `command: node`，即改造前形态，**未回滚镜像**
      - 生产侧的两个杠杆另有实证：`TASK_WORKER_MAX=0` → 宿主根本不启动（`worker pool off`，
        2026-11-08 实测）；单测「without a host url the composition is byte-identical stdio」
      - 口径：这是**机制回滚**演练；真正的"生产开→关"演练要等池开启（与 4.3 同一场）
