## Context

见 proposal.md（Why）。现状事实约束设计：/opt/dsh CLI 树 23 包 + profile 模板树 4 包，18 个插件包仅 peer 可达（`legacy-peer-deps=true` 关掉了传递 peer 自动安装，当年被迫手钉）；fd-prod 上 dsh 启动时自维护 DSH_HOME 的扁平 node_modules 树、以 /opt/dsh 为锚；agent-runner 的 compose.js 已验证"profile scaffold + node_modules 软链到共享树"模式在 staging 可跑。本 change 不升版本：矩阵冻结的就是今天的 0.1.1-rc.2 组合。

## Goals / Non-Goals

**Goals:**
- 版本真相收敛为一份 manifest + 一份 lock，重建逐包可复现；同包名跨树同版本。
- 启动期硬门把错树拦在会话之前，带逃生口与可读 diff。
- dsh-profile writer 参数化，agent-runner 直接 import，消灭 compose.js 的格式镜像复制。

**Non-Goals:**
- 不升级任何 dsh 包版本（首次真实 bump 是后续 change，经 dsh-contracts 套件）。
- 不合并/重构 dsh 的 profile 装载机制、不动 bridge 子类链、不加内部 API RPC（ADR-0007）。
- 硬门结果上报 ops console（记为后续可选项，不在本次范围）。

## Decisions

### D1: 单一 union manifest + 单 lock，profile 树 node_modules 改软链
`dsh-matrix/package.json` 声明意图条目的并集：`@deepseek-ai/dsh`、`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-sdk-jsonrpc-server`、`@deepseek-ai/dsh-sdk-protocol`、`@deepseek-ai/cordis-plugin-group`、`@deepseek-ai/cordis-plugin-hmr`（前四者与 hmr 为意图钉版，group 为 CLI 运行需要）。Dockerfile 只做一次 `npm ci` 落在 /opt/dsh（成为唯一实体树）；/opt/dsh-home/profiles/platform 保留四个 scaffold 文件（cordis.yml 等），其 node_modules 从"实装"改为**软链到 /opt/dsh/node_modules**——即 agent-runner seedHome 已在 staging 验证过的同款模式，agent-runner 的 seed 逻辑零改动。两树同包同版本由此结构性成立，不需要事后交叉校验。
- 备选：两树各一份 manifest+lock + 一致性交叉断言——版本真相重新裂成两份，还要额外国卫兵，弃。
- 备选：物理合并两树、删掉 profile scaffold——触碰 dsh profile 装载器的路径假设，跟随者姿态下不动，弃。

### D2: cordis-plugin-hmr 直接依赖 + npm overrides 双保险钉 1.0.16
hmr 既作为直接依赖声明（两树现状即如此），又在 overrides 里钉 `1.0.16`——直接依赖保证它总在树里（dsh-base 的 range 会浮到 1.0.17+），overrides 保证闭包内任何路径解析不出 1.0.17+（该版本删 registerConfig，开机崩环，2026-09-23 事故）。

### D3: 关闭 legacy-peer-deps，用默认 peer 自动安装解析闭包，lock 冻结结果
矩阵目录自带 `.npmrc`（不含 legacy-peer-deps）。生成 lock 时 npm 自动装全 peer 闭包（含那 18 个仅 peer 可达的插件），一次解析、提交 lock；此后 `npm ci` 严格按 lock 落盘，重建可复现。若 npm 在生成期报 peer 冲突，那是今天被 legacy-peer-deps 掩盖的真冲突，在生成期暴露并当场裁决——正是这个 change 想要的故障左移。
- 备选：保留 legacy-peer-deps + 手写 131 包——回到手工枚举，弃。

### D4: 家族分裂的裁决——overrides 强制 0.1.1 代，sdk-server 保持 0.0.1-rc.5
生成期暴露的冲突比预想深一层：不是 protocol 单包分裂，而是 `dsh-sdk-jsonrpc-server@0.0.1-rc.5` 的**整个 peer 闭包**是 0.0.1-rc.5 代（dsh-agent/dsh-llm/dsh-session/dsh-subagent/dsh-scope/dsh-invariants/dsh-llm-deepseek/protocol），与 dsh-base 的 0.1.1-rc.2 代在根级不相容——历史上正是 legacy-peer-deps 把这个违反压住、运行时靠扁平解析让 0.0.1 server 骑 0.1.1 家族跑（两棵树皆然）。裁决：**overrides 把这 8 个 peer 名强制到 0.1.1-rc.2**（精确复刻今天 de-facto 运行时，零代码行为差异），sdk-jsonrpc-server 本体保持 0.0.1-rc.5——升到 0.1.1-rc.2 虽然存在且更干净，但那是"升版本"，bridges 子类化的就是 0.0.1 的 server class，留给首次合同套件把守的真实 bump 一并处理。已知违反显式记录在 overrides 里，lock 冻结它。操作备忘：lock 生成需 `NODE_OPTIONS=--max-old-space-size=8192`（npm arborist 在此闭包上会耗尽默认 2GB 堆）。

### D5: 硬门为纯 JS 校验模块，paas 与 agent-runner 共用
新增适配层模块（如 `lib/dsh-matrix-verify.js`，零 dsh import）：读 dsh-matrix 的 lock，遍历实际安装树的顶层包，输出 {extra, missing, mismatch} 三类偏差；全空则通过。`server.js` 启动早期与 `agent-runner/index.js` 启动时调用：有偏差且未设 `DSH_MATRIX_OVERRIDE=1` → 打印包级 diff 后 `process.exit(1)`；设了 → 打印 diff + 逃生口标记后放行。矩阵安装根不存在（本地开发机、e2e 的临时 DSH_HOME）→ 跳过。锁与 manifest 随源码 COPY 进镜像，运行时可直接读。

### D6: writer 参数化采用显式 home 上下文，模块级 DSH_HOME 降级为默认值
dsh-profile.js 的各 writer（presets/permissions/mcp/skills/chart-bind patch 与 credentials）改为接受显式的目标 profile 路径参数；模块内现有调用点传模块级 DSH_HOME 的派生值（行为不变），compose.js 改为 import 这些 writer 并传自己的 homeRoot——`buildLlmProfile/composeAgentPreset/rosterPresetId/resolveShippedPresetRoot` 复用面不变，"formats mirrored" 注释与漂移风险删除。兼容性由现有 e2e（custom-presets、pack-agent-scoping、focus-overlay）回归把关。

### D7: 验证链——e2e 单测硬门 + 镜像冒烟天然覆盖 + staging 先行
硬门本身加一个 e2e spec（篡改一颗 scratch 安装树 → 拒启 + 逃生口放行 + 无矩阵跳过三场景）；镜像 pipeline 现有 boot 冒烟在容器启动时自动执行硬门（一致=通过）；fd-prod 上线走 staging runner 先行验证（cheap1）。

## Risks / Trade-offs

- [union 树让 /opt/dsh 里出现 dsh-base，理论上对 CLI 惰性，但组合是新的] → boot + initialize 握手冒烟为发布门；staging 先行；fd-prod 上线后跑 post-deploy probe（memory 里的既有惯例）。
- [profile node_modules 由实装变软链，若某处代码假设它是真目录] → agent-runner staging 已用同款软链数周；任务中显式核查 fd-prod cell 的 DSH_HOME 物化路径（dsh 自维护扁平树，理论不受影响）。
- [关闭 legacy-peer-deps 后，生成 lock 时冒出被掩盖的 peer 冲突] → 这正是左移目标；在生成期当场裁决并记录进 manifest 注释；最坏情况退回 D4 的候选版本。
- [lock diff 巨大，PR review 噪音] → 矩阵 PR 的评审对象是 package.json 意图条目；lock 视为生成物（同 skills.ts 惯例，不手编辑）。
- [一次大 npm ci 层的缓存失效] → 仅在 manifest/lock 变化时失效，比现状（28 行命令任一变动）更稳定。

## Migration Plan

1. 落地矩阵与校验模块（不动 Dockerfile），e2e 绿。
2. Dockerfile 切换到 `npm ci` + 软链 seed home；本地 `docker build` + boot 冒烟验证（握手 + 名册投影）。
3. 推 staging（cheap1 runner + 沙箱 cell）验证 agent-runner 组合与共享运行时两条路径。
4. fd-prod 常规发布窗口上线；回滚 = 回滚镜像 tag（旧镜像无硬门，天然兼容）。

## Open Questions

- 硬门结果是否上报 ops console（作为矩阵状态灯）——纯增量，不阻塞本次，留后续。
