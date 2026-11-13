## Context

沙箱可写根的现状推导链（实读 dsh 0.1.1-rc.2 安装树）：

```
dsh 子进程（runner spawn，cwd = config.cwd = AGENT_RUNNER_CWD || repoRoot → 容器内 /app）
 ├─ cordis 行 sandbox-policy
 │    config: { mode: DSH_PERMISSION_MODE ?? 'workspace-write',
 │               workspaceRoot: process.cwd() }
 └─ 每次工具调用解析（dsh-sandbox-policy/lib/index.js:142）
      workspaceRoot = session.header.cwd ?? 上述 config
      workspace-write 可写集 = { workspaceRoot, /tmp, tmpdir() }
                              （dsh-sandbox/lib/index.js:154 硬编码，无额外根口子）
```

runner 侧链路：`agent-runner/config.js:122` cwd 默认 repoRoot → `manager.js:624` 进 spawnSpec → `child.js:91-106` 同时喂给 spawn cwd 与 `initialize({cwd})`；`session/prompt` 只带 `{sessionId, contentBlocks}` 不带 cwd。cheap-1 实况（2026-10-06 探针）：容器 `agent-runner-dsh` = node:22-slim，代码全量 bind 自 `/opt/agent-runner-stage`，homes 在 named volume `agent-runner-data` → `/data`，端口 8790-8850 @ 100.64.0.11（尾网），env 带 `DSH_MATRIX_OVERRIDE=1`（手装 dsh 树 vs 冻结锁偏差）。

## Goals / Non-Goals

**Goals:**

- workspace 声明的 agent：数据目录可写、写外仍拒、无声明字节等价
- runner 落地通道收敛为平台镜像，SFTP 热修除名
- 单一重启窗口完成重锚+修复

**Non-Goals:**

- 收紧 `/tmp`/`tmpdir()` 放行（dsh 硬编码；产物落 /tmp 依旧不可服务——语义注记，不立规格）
- 配额硬执行（维持只说不拦；触顶再议）
- 聊天 cell 侧工作目录（`/data/workspace`、fix-agent-workspace 域）
- 权限预设表（read-only/workspace-write/danger-full-access）任何变动

## Decisions

### D1 修法选 B2（spawn cwd = dataDir），不选 B1/home

- **选定**：`manager.js:624` 改 `cwd: spec.dataDir ?? config.cwd`。
- **为什么两条解析路径都收敛**：header.cwd 若源自 initialize 的 cwd → 值即 dataDir；若 header.cwd 缺席 → 回退服务行 `process.cwd()`（= spawn cwd = dataDir）。单旋钮双覆盖。
- **备选 B1**（per-agent 写 `sandbox.patch.yml` 覆写 sandbox-policy 行 `workspaceRoot`，模式同 `skills.patch.yml`）：留作彩排暴露 MCP 子进程 cwd 语义冲突时的退路。**备选 home**：agent 可写 `.credentials.yaml` 与人设 preset——自我改造通道，否。**dataDir 而非 home** 是最小授权的落点。
- 适配层边界（CONTEXT.md「适配层」词条）恰好覆盖 agent-runner 组合器——改动不越层。

### D2 配额姿态维持只说不拦

原先 fail-closed 让「只说不拦」守的是开不了的门；门开后仍维持：硬执行会制造「客户数据因配额锁死」的新故障面，5120MB 默认配额下触顶应是异常而非常态，fleet 事件已上板面。真实触顶再立后续 change。

### D3 镜像通道（ADR-0018 随归档落盘）

主 Dockerfile runtime 阶段补 `COPY --from=builder /app/agent-runner ./agent-runner`（缺口实证：runtime 阶段现有 COPY 列表无 agent-runner，`docker-compose.yml` 声称镜像已带源码与实况不符）；开源快照 `dist-opensource/platform/Dockerfile` 同步（快照仓已带 agent-runner 源码但同样缺 COPY——公开镜像同样跑不起 runner 角色）。facet 服务「同镜像第二角色」先例在前，runner 为第三角色。放弃 bind 挂载的热修敏捷，换谱系完整性。

### D4 单窗切换

镜像一次带齐（修复代码 + COPY），容器切换一回。回滚 = 启旧容器（home 在共享 volume 上完好）。窗口避开 spider-heal 的 effective_rhythm 时隙（实施时从 registry 条目读取定钟点）。

## Risks / Trade-offs

- [MCP 子进程 cwd 语义随 child cwd 改变] → 本地真 dsh 彩排全量过一遍 MCP 挂载；异常则切 B1 备选（不改 spec 语义）
- [镜像 dsh 树与冻结 matrix 不匹配 → 启动门 fail-closed 拒启] → 窗口前一次性容器独立跑 dsh-matrix 校验预证明；门拒启即中止回滚，不硬闯
- [切换重启全部 4 个在役 child（含 spider-heal）] → 2026-10-06 实测 runner 重启 child 可恢复；择时 + 窗口前记录在役清单
- [child cwd 改变后 agent 相对路径读写落点变化] → 读不受沙箱限制、写以 AGENT_DATA_DIR 绝对路径为准（env+人设引导已在位）；彩排覆盖
- [runner 指标/计量中断] → meter.jsonl 在 volume 上续写；切换后核对最后一条时间戳连续

## Migration Plan

```
窗口前：镜像构建（含修复+COPY）→ 一次性容器预验证 matrix 门 → 记录在役 child 清单
窗口内：stop 旧容器（rename agent-runner-dsh-old 保留）→ 起新容器
        （同 volume agent-runner-data:/data、同端口段 8790-8850@100.64.0.11、
          env 对齐去 DSH_MATRIX_OVERRIDE、4 token 值照抄不落文档）
        → 起服后 poll 拉齐在役 agent → 活链 a2a 写/读回探针验收
回滚：  stop 新容器 → start agent-runner-dsh-old（child 再重启一回，home 完好）
善后：  验收通过后清 /opt/agent-runner-stage（保留 .bak 系列一个周期）
```

repo 侧同步：`agent-runner/docker-compose.yml` 更新为生产实况（volume 名/挂载点/端口段/env_file），使其从「Harbor 变体 + /app/runner-home」的失实描述变成可复刻生产的真文件。

## Open Questions

- 重探梯（Change B）与本 change 的镜像可同滚亦可分滚——无耦合，随构建节奏定。
