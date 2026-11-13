# Design: migrate-fd-prod-cells

## Context

网关与 cell 的机制已实现并被 e2e 覆盖（`gateway/spawner.js`、`tenant-cell-runtime` 规格、`scripts/test-cell-containment.mjs`），但生产从未运行过该拓扑：fd-prod 的 platform 是单进程 pod（cheap-5，hostPath `/opt/platform`→`/data`，`AGENT_WORKSPACE=/data/workspace`），demo 是另一个单进程匿名 pod。实测容量：platform 328Mi、网关型 pod 空载 230Mi（限额 768Mi）、节点 8C/8Gi ×5。现存唯一在线 Agent Service（演示包）经 registry 反代调用，其注册 origin 指向平台公网入口。

关键约束：对外 origin 与 API 路径不可变（Logto 回调、MP 客户端、已注册的 a2a 服务、分享链接都锚在上面）；单进程模式（dev/桌面/demo pod）必须原样保留；回滚要能回到今天的单进程形态且数据无损。

## Goals / Non-Goals

**Goals:**
- fd-prod 以网关为唯一公共面，每个登录用户一个 cell，隔离面覆盖 workspace/uploads/resources/documents（规格 delta 已列）。
- 已注册的 a2a 服务在 cutover 后继续以原 URL 应答。
- 切换可回滚：迁移用「拷贝」而非「移动」，旧 `/data` 原地保留至 burn-in 结束。

**Non-Goals:**
- demo pod 并入网关 demo 模式（`MP_DEMO_MODE`）——独立后续 change。
- 跨节点 cell 调度、每用户配额、计费。
- 单 cell 内多账号（cell 即用户，粒度不再细切）。

## Decisions

### D1: cutover 用原地换入口，不做双跑蓝绿
platform Deployment 保持单副本 Recreate，仅改启动命令为 `node gateway/index.js` 并调整 env/volumes。理由：同一 origin 无法双入口；状态绑在 hostPath 上，双跑等于分叉数据；GitOps revert 即回滚（镜像不变、代码路径纯增量）。
*替代方案（否决）*：新 Deployment + 切 ingress——需要第二份数据根和第二入口，回滚链更长，收益为零。

### D2: cell 运行 cwd 改为 per-user root，捆绑资产路径改模块相对
spawner 的 `cwd: REPO` 改为 `path.join(root, "runtime")`（per-user、spawner 预建）。动机：规格要求「pin 被拒的兜底不得落在跨 cell 共享目录」，而 cwd 兜底=REPO 恰是共享目录；且 cwd=REPO 时任何相对路径写都会漏出数据根（违反既有「no writable state outside the data directory」）。配套：`skills.js:106` 等 `path.resolve("skills")` 类调用改为基于 `import.meta.url` 的 repoRoot 解析（只读捆绑资产仍从镜像读，行为不变）——先审计全部 `path.resolve("` 字面量调用点再动手。
*替代方案（否决）*：保持 cwd=REPO、依赖 spawner mkdir 让 pin「实际不可能失败」——理论失败路径仍指向共享目录，且放任相对写泄漏面。

### D3: per-cell workspace 由 spawner 权威注入
`spawnCell` 的 env 追加 `AGENT_WORKSPACE: path.join(root, "workspace")`（排在 `...baseEnv` 之后，覆盖任何继承值——网关自身 env 即使残留 pin 也无法合并 workspace，规格场景已覆盖），并在 mkdir root 时一并建好。启动链（pin>偏好>cwd）不改：偏好与 cwd 现在都落在 per-user root 内，整条链天然合规。`platform-config` 里的 `AGENT_WORKSPACE=/data/workspace` **保留不删**：单进程回滚模式仍需要它，网关路径下被 per-cell 值覆盖，无害。

### D4: 无会话车道全部网关/部署级——实现期核实修正（supersedes 拷问轮 Q2/Q9 的原前提）
实现期核实推翻了设计初稿的「网关按 owner 路由 a2a 流量」设想，真实架构是：**a2a 服务面在 cell 之外**——deploy 动作是网关挂载路由（`gateway/packs.js:411`，identity 门控），Agent 服务本体跑在部署级 runner（cheap1 独立容器，ADR 0004），registry 反代直达 runner，**a2a 协议流量不经过网关**；匿名技能 md 路由（`/api/packs/**.md`）由网关从**共享 packs.db**（`DATA_ROOT` 级，本就设计为「outlive and cross cells」）自伺服，不 spawn 任何 cell；会话分享早有 owner 代读契约（`session-share`）。因此：不需要 owner 路由表、不需要 cell 冷启加固（runner 是常驻进程，重启恢复由既有轮询规格覆盖，上限 5 分钟）。迁移要做的只有两件事：`AGENT_SERVING_*` env 落在**网关进程**上（deploy 路由在那里运行；baseEnv 继承与 per-cell 无关）；单进程的 `packs.db` 拷贝到 `CELL_DATA_ROOT` 根（网关级，不进任何用户目录）。原 Q2（演示服务随 owner cell）与 Q9（冷启恢复加固）按此修正：演示服务不依赖任何 cell 在线，无首调拉起延迟问题。

### D5: 存量数据一次性拷贝进 owner cell + 网关级库就位
新脚本 `scripts/migrate-single-to-cell.mjs`：由 email 定位 owner userId；建 `CELL_DATA_ROOT/<userId>/{data,dsh,workspace,runtime}`；`/data` 全量（SQLite、uploads、resources、cron、mcp.json、preferences）→ `data/`；`/data/workspace/*` → `workspace/`；旧 DSH_HOME（`/opt/dsh-home` hostPath）→ `dsh/`（注意已知坑：dsh 首启 stale-symlink 自愈、hmr pin 在 Dockerfile 双前缀里——拷贝后首个 turn 前观察 healer 日志）。**网关级库**：单进程 `storeDir("data")/packs.db`（即 `/data/data/packs.db`）→ `CELL_DATA_ROOT/packs.db`（网关共享市场，不进用户目录）；share-tokens.db 无需迁（share 是网关专属功能，单进程无此库）。documents/resources 无 owner 列——落进 owner cell 即归属，无需补列。停机窗口内执行（Recreate 已保证单实例），完成后网关拉起。
*替代方案（否决）*：给单进程 DB 加 owner 列原地多租户——即被否掉的「虚拟层」路线，治不了共享 agent 运行时。

### D6: 容量包络按实测起步，reap 兜底（已定稿）
网关 pod request 1Gi / limit 2Gi（≈4–5 个并发活跃 cell + 网关本体）；`CELL_IDLE_REAP_SECS=3600`（账号 cell 闲时回收，流量再拉起，状态在盘）；`CELL_START_TIMEOUT_MS` 维持 60s。cheap-5 现有余量足够首期（当前平台+周边占用远低于 8Gi）。上限观察交给 ops-console 的内存探针（见 R4）。此组值为 burn-in 起步值而非长期承诺，8.1 观测后调整。

### D7: 认证收口网关，cell 全部 forward_auth；准入收口身份提供方
网关成为唯一 Logto 客户端 + MP 签发方（`gateway/index.js` 现成）；cell 沿用 spawner 注入的 `AUTH_MODE=forward_auth` + `CELL_GATEWAY_SECRET` + `CELL_USER_EMAIL`，不接触身份提供方。`PAAS_BASE_URL=https://craw.finddatatech.cloud` 保证回调与 secure cookie 判定正确。已有浏览器会话在 cutover 后失效一次（cookie 由不同 secret 体系签发），公告即可。**准入不在网关设第二套名单**（ADR 0008）：谁能成为 cell 由 Logto 的注册/邀请开关单独决定；cutover 检查单含「用户列表 == 仅 owner + 注册置关」的冻结两步，burn-in 通过后再放开。

### D8:（已并入 D4 修正）a2a 可用性语义随真实架构定案
Agent 服务的承载者是部署级 runner（常驻、不参与 cell 回收），可用性语义由既有 `a2a-agent-serving` 规格的轮询发现契约（≤5 分钟）覆盖；cell 的 idle reap 与服务可用性无关。原拷问轮 Q9 的「boot 立即轮询加固」针对的是「服务在 cell 内、cell 被回收」这一不存在的前提，随 D4 修正一并作废。

## Risks / Trade-offs

- [R1] cwd 切换漏改某个相对路径 → cell 内功能静默缺资源 → **缓解**：审计任务穷举 `path.resolve("`/`process.cwd()` 字面量点；image-smoke 在 per-user cwd 下跑全量启动检查。
- [R2] a2a 路由表与 registry 注册漂移（服务卸载未上报）→ 外部调用打到死 route → **缓解**：卸载路径同样上报删除；网关对未知 route 快速 404；cutover 后探活在线演示服务（`vtdpsNmtW6OQ9I99mBhbDw`）。
- [R3] dsh home 拷贝触发 stale-symlink 自愈循环 → owner cell 首启卡住 → **缓解**：迁移后先手工跑一轮 healer 校验脚本再放开流量；60s 启动超时会暴露而不是吞掉。
- [R4] 活跃 cell 数超预算 → OOMKill 连坐网关 → **缓解**：limit + reap；ops-console 内存灯；必要时节点扩 cheap-6/7/8（已有五台 8Gi）。
- [R5] 一次性回话失效 + MP 静默重登路径未过真实机 → **缓解**：cutover 检查单含 MP 真机走查（file-transfer 的 401 重登分支）。
- [R6] 迁移拷贝期间磁盘翻倍（当前 `/data` ~10Gi 级）→ **缓解**：hostPath 所在节点先用 df 核对，不足则清 `/data/workspace` 大文件（加密朋克史交付包可先归档）。

## Migration Plan

1. 预备：镜像含 D2–D4 代码并过 image-smoke；节点 df 核对；registry 侧取证当前注册 URL（留证物）；**Logto 准入冻结（核对用户列表 == 仅 owner、注册置关，D7）**。
2. 停机：GitOps 提交换入口 manifest（不 apply）；`kubectl rollout` 前手工停 platform → 跑 `migrate-single-to-cell.mjs`（拷贝语义）。
3. 起网关：apply 后观察 `[gateway]` 与首个 cell 拉起日志；web 登录 → 会话/文档/资源库/workspace 文件逐项核对；a2a 演示服务探活。
4. burn-in 一周后删除旧 `/data` 原件（workspace 大文件可提前归档）。
5. 回滚：revert GitOps commit → 单进程以原 `/data` 起回（AGENT_WORKSPACE pin 仍在 config，见 D3）——cutover 后新产生的数据留在 cell 侧，回滚即放弃（公告口径）。

## Open Questions

- ops-console 探针从单进程端点切到 `/api/gateway/status` 的具体口径（不阻塞 cutover，可后补）。
- burn-in 后是否把 `CELL_IDLE_REAP_SECS` 收紧到 1800（观察首周内存形态再定）。

## 附录：cwd 相对路径审计清单（任务 1.1 产出，2026-10-01）

生产代码里全部相对解析点，分三类处置：

**A. 捆绑只读资产 → 改 `repoRoot()`（任务 1.2）**
- `server/skills.js:106` `path.resolve("skills")`（基线技能目录）
- `server/context.js:37` `WEB_DIST = path.resolve("web/dist")`（构建产物 SPA）
- `catalog.js:16` `agents.json`（捆绑 agents 目录）
- `extension-store.js:10-11` `market-catalog.json` / `market-catalog-skills.json`
- `registry-bridge.js:34` `registry-groups.json`（可选运维配置，只读）

**B. 状态文件回退（env 覆盖存在；cell 下 env 恒设，dev 下 cwd=repo 不变）——不改**
- `server/session.js:83` `auth`（dataDir 缺省回退臂）
- `server/owner-groups.js:15` `owner-groups.json`
- `chart-bindings.js:32` `chart-replay-allowlist.json`
- `migrate.js` 三处 store 回退（一次性脚本）

**C. dsh cwd 回退（实践中有显式值传入）——不改**
- `dsh-bridge.js:91` `cwd || process.cwd()`（boot workspace 恒传入）
- `dsh-profile.js:434` worker config cwd 回退

未发现 `path.join("` 相对字面量调用。
