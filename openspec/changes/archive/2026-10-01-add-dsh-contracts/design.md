## Context

见 proposal（Why）与 ADR-0007。基座已就位：dsh-matrix lock（519 包冻结）+ 启动硬门（lib/dsh-matrix-verify.js）+ 参数化 writer（targetPaths 机制，agent-runner 已直接 import）。e2e 基建证明"每 spec 独立 DSH_HOME 起 dsh"是仓库成熟做法；agent-runner 证明 HarnessClient（@deepseek-ai/dsh-sdk-client）可独立驱动 initialize/prompt/request。本 change 不碰矩阵与硬门，纯新增验证面。

## Goals / Non-Goals

**Goals:**
- 候选模式：一个命令对任意安装跑全套合同，逐条报告，聚合退出码。
- 六条 v1 合同全部可独立执行、独立归因（一条挂不拖垮其余）。
- 双接线（镜像冒烟 + 矩阵 PR）零特殊逻辑：都只是调 runner、看退出码。

**Non-Goals:**
- 不升任何 dsh 版本（首次真实 bump 是套件落地后的独立操作，3-4 周窗口政策）。
- 不做 v2 合同（MCP 热切换、skills Chokidar、flat-module fallback——有兜底重启，破坏会显形）。
- 不做节奏自动化（定时评估 cron）——政策先行，工具到位后人工按窗口执行。
- 不改 dsh-version-matrix 的硬门行为。

## Decisions

### D1: runner 为单文件脚本 + 合同为纯函数表，不引入测试框架
`scripts/dsh-contracts.mjs`（`npm run dsh:contracts -- [--tree <path>] [--bin <path>]`，缺省对 dsh-matrix 的 scratch ci 树）+ `scripts/lib/dsh-contracts/contracts.mjs` 导出 `CONTRACTS = [{id, title, run(ctx)}]`。执行器顺序跑表、捕获每条的异常归因为该条 fail、汇总表 + 退出码。理由：候选模式要能在任意环境（含镜像内）零依赖运行，Playwright/node:test 都太重且把合同混进既有套件会丢"对候选版本试跑"的能力。备选：并入 e2e（丢候选模式）、node:test（runner 内自旋 subtest 无增益）——弃。

### D2: 合同执行的物理形态——临时 home 物化 + HarnessClient 驱动
执行器先物化隔离 home（`mkdtemp` + dsh-profile 参数化 writer 写 settings/credentials/presets patch，DSH_BIN/DSH_HOME 指向临时域），再以 `HarnessClient` spawn `<bin> --profile platform --patch ...` 完成 initialize。合同①③⑤⑥直接骑这个会话（握手/名册/RPC 面）；合同②是纯静态解析（对安装树 lock 集逐包 `import.meta.resolve`）；合同④在会话存续期间改写 settings/credentials 文件断言热重载。LLM 走哑端点（合同只验证路由注册与凭证解析层，不发真实补全——候选模式不得花 token）。

### D3: 合同粒度与失败归因
六合同各自独立 try/catch；子进程崩溃类失败（③的崩环形态）由执行器的子进程退出监听归入当前在跑的合同；超时（单合同 60s、握手 30s）按超时 fail 并附日志尾。合同⑥的 permissions/set 是唯一内部 API 合同，报告里单独打 `internal-API` 标签——它 fail 时的语义是"上游动了内部面，评估替代或锁版本"，与公开面合同 fail（"不能跟"）区分。

### D4: 双接线只认退出码
- image.yml 冒烟：现有 boot 探活步骤后追加一步 `node scripts/dsh-contracts.mjs --tree /opt/dsh`（容器内已有 /app 源与 node）；冒烟容器即候选环境，无需 scratch。
- ci.yml：新增路径过滤触发（`dsh-matrix/**`）跑"scratch npm ci + runner"job；lint 债清偿前该 job 与 lint 并列（不被 lint 阻断）——在 ci.yml 里把合同 job 设为 `needs: []` 独立并列。
- 本地升级规程文档化进 dsh-matrix/README（已有上游陷阱节，追加"升级步骤"节）。

### D5: scratch 树的缓存复用
本地/CI 的 scratch `npm ci`（~500 包）成本不低：runner 的 scratch 物化落在 `node_modules/.cache/dsh-contracts-tree/`（按 lock hash 键），命中即跳过 ci；`--fresh` 强制重建。镜像接线不走 scratch（直接 /opt/dsh），不受此影响。

## Risks / Trade-offs

- [合同④热重载断言依赖 Chokidar 时序（fs 事件延迟）] → 轮询断言（≤10s 窗口）而非事件钩子；e2e 已有同款模式。
- [候选版本改 initialize 参数形状导致握手 fail，六合同全红] → 这正是想要的结果（"不能跟"）；报告首行明确握手失败即全组不可判。
- [runner 与平台 writer 的格式耦合（物化用 targetPaths writer）] → 同仓同源即是设计意图：writer 变更即合同变更，一并被套件覆盖。
- [ci.yml 现状全红（lint 债）] → 合同 job 独立并列不等 lint；lint 债是 repo owner 的既有待办，不阻塞本 change 的门。

## Migration Plan

纯新增，无迁移：runner 落地 → 接线两处 → 对当前矩阵（0.1.1-rc.2）跑绿即为验收基线；首次真实 bump 时它转正为升级闸门。回滚 = 删脚本与接线步骤。

## Open Questions

- 合同②的解析集是否要覆盖 lock 全部 519 包还是仅 @deepseek-ai 域 + 平台 import 面（131+）——实现时以"平台会 import 的面"为准起点，覆盖度可调，不阻塞形态。
