## Why

facet-mcp-foundation-v1 上线了数据工作区全链（descriptor 声明 → `<home>/data` 物化 → `AGENT_DATA_DIR`/`AGENT_DATA_QUOTA_MB` 注入 child env），但 dsh 会话沙箱的 workspace-write 可写根推导自 spawn cwd（容器内 `/app`），agent 向 `AGENT_DATA_DIR` 写任何文件都被 fail-closed 拒绝——「客户自助分析产物落自己工作区」这最后一步在 agent 侧不成立。同时，承载 serving agent 的 runner（cheap-1 `agent-runner-dsh`）是 node:22-slim + 代码 bind 挂载的 staging 形态在当生产用，最新功能靠 SFTP 换文件落地；且平台镜像的 Dockerfile 从未 COPY 过 `agent-runner/`——修复代码即使进了镜像也到不了 runner。两件事锁在一起：可写根修复必须借一次 runner 重锚镜像的窗口才能上线。

## What Changes

- **可写根修复（B2 方案）**：`agent-runner/manager.js` 组装 spawnSpec 时，声明了数据工作区的 agent 以 `spec.dataDir` 为 child 的 cwd（spawn 与 initialize 同源）——dsh 的 `session.header.cwd ?? sandbox-policy config.workspaceRoot(process.cwd())` 两条解析路径都收敛到 dataDir，`workspace-write` 可写集合（workspaceRoot + /tmp + tmpdir()）覆盖数据工作区。无声明的 agent cwd 不动、字节等价。不碰 dsh 运行时、不碰权限预设表（presets 只映射 名字→{sandbox, approval}，无可写根字段）。
- **runner 镜像通道**：主 Dockerfile runtime 阶段补 `COPY /app/agent-runner`（同镜像第三角色，facet 先例）；开源快照管线 Dockerfile 同步；repo 的 `agent-runner/docker-compose.yml` 更新为生产实况（`agent-runner-data` volume → `/data`、8790-8850 @ 尾网 IP、env 对齐）。
- **cheap-1 重锚**：单窗切换——新容器挂同一个 `agent-runner-data` volume（homes/meter 零搬迁），不挂任何代码 bind，去掉 `DSH_MATRIX_OVERRIDE`；旧容器 stop+rename 留作回滚文物。窗口前一次性容器预验证 dsh-matrix 启动门。
- 测试：`agent-runner/test/workspace.test.mjs` 扩展（cwd 断言 + 无声明等价）+ 本地真 dsh 沙箱彩排（写 dataDir 成功、写外仍拒）+ 活链验收（对 DAAS analyst 发 a2a 写/读回任务）。

**非目标**：聊天 cell 侧工作目录（`/data/workspace` 有自己的故事）；收紧 workspace-write 对 `/tmp` 的放行（dsh 硬编码，触 fork）；配额姿态升级（维持只说不拦，见 design）；权限预设表任何变动。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-runner`: 新增一条 requirement——声明了数据工作区的已部署角色，其会话沙箱 workspace-write 可写根 SHALL 覆盖该数据目录（写内成功、写外仍拒、无声明字节等价、配额巡检姿态不变）。

## Impact

- 代码：`agent-runner/manager.js`（spawnSpec.cwd 一处）、`agent-runner/compose.js`（返回值已含 dataDir，无改）、`Dockerfile`、`dist-opensource/platform/Dockerfile`（快照管线）、`agent-runner/docker-compose.yml`。
- 测试：`agent-runner/test/workspace.test.mjs` 扩展；新增本地真 dsh 彩排脚本（沿 `scripts/probe-*` 模式）。
- 运维：cheap-1 容器切换（重启全部 4 个在役 child，含 spider-heal——窗口避开其节奏时隙）；`/opt/agent-runner-stage` 退役保留。
- 台账：验收后 finddata `MCP-REGISTRY.md` §3 销「daas 工作区沙箱」挂账行 + 归档件 closeout 追记。
- ADR-0018（runner 随平台镜像发布，SFTP 热修除名）随本 change 归档时落盘。
