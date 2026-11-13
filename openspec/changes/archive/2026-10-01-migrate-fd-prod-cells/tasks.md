# Tasks: migrate-fd-prod-cells

## 1. 地基：cwd 相对路径审计与 repoRoot

- [x] 1.1 穷举服务端 `path.resolve("`、`path.join(` 以字面量相对路径开头的调用点与 `process.cwd()` 直接读取（`grep -rn "path.resolve(\"\|path.join(\"" server*.js server/ gateway/ lib/`），产出清单：哪些是捆绑只读资产（skills/、模板）、哪些会写盘、哪些是测试/脚本可忽略——清单落 `docs/` 或 design 附录
- [x] 1.2 新增模块相对的 `repoRoot()` helper（基于 `import.meta.url` 上溯），替换 1.1 清单中服务端生产路径的捆绑资产解析（首当其冲 `server/skills.js:106` 的 `path.resolve("skills")`），行为等价验证：本地 dev 起 server，技能清单与替换前一致

## 2. spawner：per-cell workspace 与 per-user cwd

- [x] 2.1 `gateway/spawner.js`：`spawnCell` env 追加 `AGENT_WORKSPACE: path.join(root, "workspace")`（置于 `...baseEnv` 之后）并随 root 一并 `mkdir`；spawn `cwd` 改 `path.join(root, "runtime")`（预建）。单测：注入含 `AGENT_WORKSPACE` 的 baseEnv，断言子进程 env 里 workspace 值为 per-cell 路径且两用户路径互不为祖先（对应规格「inherited environment cannot merge workspaces」场景）
- [x] 2.2 单测：pin 被拒时的兜底语义——伪造不可写 workspace 触发 boot 链降级，断言最终落点仍在 per-user root 内且 boot 日志含 rejected 字样（复用 `server/agent-session.js` 的 resolveBootWorkspace 测试样板，`scripts/test-workspace-boot.mjs`）
- [x] 2.3 cell 场景产出文件链路验证：起 stub-cell（`CELL_SERVER_ENTRY` 指真实 server、临时 `CELL_DATA_ROOT`），agent 写文件 → `/api/files?root=workspace` 200 且落盘路径在 `<root>/<userId>/workspace/` 下；`test-cell-containment.mjs` 扩一条「两 cell workspace 互不可达」断言

## 3. 无会话车道核对（实现期架构修正后：a2a 面在 cell 之外，见 design D4 修正）

- [x] 3.1 网关自伺服匿名 pack md 且零 cell 代价：起真实网关（stub OIDC 发现 + 预置 `DATA_ROOT/packs.db` 种一个带版本的 pack），匿名 `GET /api/packs/:id/versions/:v/skills/:name.md` → 200 字节吻合且 `registry.cells` 保持空；未知 packId 同路由 → 404 且仍无 cell spawn（对应规格「an anonymous pack skill read spawns nothing」与「an unknown pack fails closed」场景）
- [x] 3.2 deploy 车道经网关身份门：同 harness 下匿名 `POST /api/packs/:id/versions/:v/deploy` → 401；核对网关进程 env 必须含 `AGENT_SERVING_RUNNER_URL/PACKS_URL/BACKEND_TOKEN`（deploy 路由在网关进程内执行，env 进 5.2 检查单）
- [x] 3.3 a2a 全链路探活留给 7.1 生产检查单（真实 registry/runner 栈不可本地复刻；staging 在 cheap1）

## 4. 存量数据迁移脚本

- [x] 4.1 `scripts/migrate-single-to-cell.mjs`：参数（email、单进程 DATA_DIR、DSH_HOME、CELL_DATA_ROOT）；创建 `<userId>/{data,dsh,workspace,runtime}` 并**拷贝**（不移动）单进程 `/data`→`data/`、`workspace/*`→`workspace/`、DSH_HOME→`dsh/`；**网关级库**：单进程 `storeDir("data")/packs.db` → `CELL_DATA_ROOT/packs.db`；dry-run 模式只打印计划。本地用临时目录造一份迷你单进程数据跑通：迁移后以该 CELL_DATA_ROOT 起网关，会话列表/文档库/资源库/pack 市场逐项可见
- [x] 4.2 脚本安全栏：目标目录已存在且非空时拒绝（防重复迁移覆盖）；拷贝后输出字节对账（源/目标文件数与总量）

## 5. 部署工件与 runbook

- [x] 5.1 本仓 `DEPLOY.md` 新增「多租户网关布局」章：启动命令 `node gateway/index.js`、env 清单（`CELL_DATA_ROOT=/data/cells`、`CELL_GATEWAY_SECRET`→Secret、`PAAS_BASE_URL`、`CELL_IDLE_REAP_SECS=3600`、保留 `AGENT_WORKSPACE` 的说明）、hostPath 预建与属主（uid 1000）、资源包络 request 1Gi/limit 2Gi；附 GitOps 需要的 manifest diff 片段
- [x] 5.2 cutover 检查单（并入 5.1）：节点 df 核对、registry 注册 URL 取证（留 cutover 前后对照）、**Logto 准入冻结两步——核对用户列表 == 仅 owner 账号、注册开关置关（burn-in 后再开；若发现额外存量账号，处置当场决定并记录）**、停机→迁移→起网关→核对清单（web 登录/会话/文档/资源/workspace 下载/a2a 探活/MP 真机走查含 401 重登分支）、回滚步骤（revert 后单进程以原 `/data` 起回）

## 6. 回归与镜像

- [x] 6.1 单进程回归：dev `npm start` 与单进程 e2e 基线全绿（单进程模式不受 cwd/spawner 改动影响的证明）；e2e 收尾 `pkill -9 'bin/dsh --profile'`（既定清理纪律）
- [x] 6.2 image-smoke 在 per-user cwd 假设下跑通（容器内以非 REPO cwd 启动 server，/api/config 200、技能清单非空、无 path 报错日志）
- [x] 6.3 全量 e2e 基线复跑，失败集与基线一致（不引入新失败）

## 7. cutover 执行（生产，按 5.2 检查单）

- [x] 7.1 fd-prod 切换：GitOps 提交换入口 manifest → 停机跑 4.1 脚本 → 起网关 → 检查单逐项打勾（含 `[gateway]`/`[cell]` 日志、首个用户 cell 拉起、a2a 演示服务 `vtdpsNmtW6OQ9I99mBhbDw` 原址探活 200）
- [x] 7.2 隔离冒烟（生产）：用 Logto 手工创建的第二个测试账号登录（准入收口身份提供方，ADR 0008），断言看不到 owner 的文档/资源/workspace 文件；owner 侧功能回归（对话一轮 + 产出文件下载）

## 8. burn-in 收尾

- [ ] 8.1 一周观察（ops-console 内存灯 + `kubectl top` 记录），确认 cell 内存形态与 reap 行为，决定 `CELL_IDLE_REAP_SECS` 是否收紧（design 开放问题）

  **D2 基线（2026-10-03 深夜，从 facet sha-6a32874 滚动后起算）**：`CELL_IDLE_REAP_SECS=3600`（未动）；gateway `cells:1` 驻留（uptime 7.4min）。内存形态（pod 内 /proc 实测）：网关 92MB；server.js 监督+子 183+171MB；驻留 cell = dsh×2 ≈231MB + websearch MCP 63MB；平台 pod working set **449Mi**（demo 215Mi）。节点 cheap-3：**2,431Mi/3.82GiB ≈62%**，CPU 8%；`/data` 22G/30G（73% 用）。`/data/cells` 磁盘 2.8GB/6 个历史 cell 目录。**口径警告**：当日 4 次镜像滚动每次清空驻留并重置 reap 时钟——3600s 空闲回收在 prod 尚未被观察到过一次；干净一周观测须自**最后一次**重启起算，且期间避免滚动。结论（收紧到 1800？）待窗口走完。
- [ ] 8.2 burn-in 通过后清理旧 `/data` 单进程原件（workspace 大文件先归档再删），在 DEPLOY.md 记录清理日期与回滚条款失效声明
