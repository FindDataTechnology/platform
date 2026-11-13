## Why

镜像里的 dsh 运行时由 Dockerfile 手写的 28 个 `@deepseek-ai/*` 钉版条目组成（两棵树、无 lockfile），重建不可复现——npm 对传递包的 peer 自动安装已两次产出错树（`dsh-sandbox-policy → dsh-sandbox` 的 ERR_MODULE_NOT_FOUND、cordis-plugin-hmr 1.0.17 崩环事故），`dsh-sdk-protocol` 在两棵树里钉着两个不同版本。上游以约每日一个 lockstep rc 版本移动（当前落后 19 版），而平台对它没有上游影响力（ADR-0007 跟随者策略）：跟随是必然事件，本 change 让"装了什么"可声明、可复现、可在启动时被验证，把跟随税从生产故障提前为构建期 diff 与启动期明确报错。

## What Changes

- 新增 `dsh-matrix/` 安装清单（仓库内一份 package.json + 提交的 package-lock.json）：只手写意图级条目——`dsh`、`dsh-base`、`dsh-sdk-jsonrpc-server`、`dsh-sdk-protocol`（全家对齐同一版本行，裁决现存 rc.5/rc.2 分裂），`cordis-plugin-hmr` 经 npm overrides 钉 1.0.16（1.0.17+ 删 registerConfig 会开机崩环）。peer 闭包（约 131 包）由 npm 一次解析后冻结进 lock，Dockerfile 两棵树（/opt/dsh 与 profile 模板树）改为从该清单 `npm ci`，18 行手写承重钉版退役。
- paas server 与 agent-runner 启动时校验"实际安装树 vs lock"，不一致**拒绝启动**并输出可读 diff；`DSH_MATRIX_OVERRIDE=1` 为逃生口。
- dsh-profile.js 的 patch/credential writer 参数化（目标 home 由调用方传入，不再绑死模块顶层 DSH_HOME）；agent-runner/compose.js 改为直接 import 这些 writer，消灭对 dsh-profile 文件格式的镜像复制（当前其唯一守卫 staging probe 6.2 尚未落地）。
- 明确不做（见 ADR-0007）：不升版本（本 change 落地时钉住的仍是 0.1.1-rc.2 矩阵，首次真实 bump 属后续 change、经 dsh-contracts 套件验证）；不自研内部 API 实时 RPC；不动 bridge 子类链。

## Capabilities

### New Capabilities
- `dsh-version-matrix`: dsh 运行时安装矩阵的声明（意图钉版 + peer 闭包 lock 冻结）、构建期从矩阵安装、启动期安装树与 lock 一致性硬门及逃生口。

### Modified Capabilities
<!-- 无：dsh-runtime-bridge 的行为需求不变；dsh-profile writer 参数化与 compose.js 改 import 是纯重构，无 spec 级行为变化。 -->

## Impact

- **构建**：Dockerfile 两条 `npm install --prefix` 改为基于 dsh-matrix 的 `npm ci`（层缓存失效一次）；镜像内容物不变（同矩阵）但 sdk-protocol 两树对齐，需 boot 验证。
- **运行时**：server.js 与 agent-runner 启动路径新增校验步骤（失败即退，`DSH_MATRIX_OVERRIDE=1` 逃生）；运维面启动日志新增矩阵 diff 输出。
- **代码**：dsh-profile.js（writer 签名参数化）、agent-runner/compose.js（镜像格式改直接 import）、新增 dsh-matrix/ 目录与校验模块。
- **开发流**：升级 dsh 版本的动作从"改 Dockerfile 28 行"变为"改 dsh-matrix/package.json 意图条目 + 重新生成 lock"，PR diff 可读。
