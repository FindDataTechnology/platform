# dsh-contracts Specification

## Purpose

把平台对 dsh 上游的行为依赖编码为可断言的合同套件：对任意候选 dsh 安装试跑（候选模式），报告每条合同 pass/fail，作为版本跟随（ADR-0007 每 3-4 周跳最新绿 rc）的升级闸门与镜像/PR 的验证面。

## Requirements

### Requirement: 候选模式 runner 接受任意 dsh 安装并输出逐条合同报告
系统 SHALL 提供一个独立 runner（npm 脚本），其目标 dsh 安装由参数指定（候选模式：scratch npm ci 树、镜像内 /opt/dsh、或任意手工安装路径），在该安装上物化隔离的临时 profile home、spawn dsh 子进程并驱动 initialize 握手，随后逐条执行合同断言，输出逐条 pass/fail 与失败原因的报告；任一合同失败 SHALL 使退出码非零，全部通过为零。runner SHALL NOT 读写部署的真实 DSH_HOME，也 SHALL NOT 依赖任何平台运行中的服务。

#### Scenario: 对矩阵 scratch 树全绿
- **WHEN** 对从 dsh-matrix lock `npm ci` 出的 scratch 树运行 runner
- **THEN** 六条 v1 合同逐条报告 pass，退出码 0

#### Scenario: 候选版本破坏合同时逐条指认
- **WHEN** 对一个 cordis-plugin-hmr ≥1.0.17 的候选安装运行 runner
- **THEN** 合同③（registerConfig）报告 fail 并携带失败现场（子进程崩溃输出或握手失败），其余合同照常执行并各自报告，退出码非零

#### Scenario: 不触碰真实部署状态
- **WHEN** runner 在开发机上运行而机器存在 ~/.dsh
- **THEN** 全部物化发生在临时目录（用后清理），~/.dsh 内容不变

### Requirement: 六条 v1 合同钉住平台依赖的上游行为
套件 v1 SHALL 断言以下六条合同，每条独立执行、独立报告：
1. **boot/握手/名册**：子进程以 `--profile platform` + patch 列表启动，initialize 握手完成，模型名册与 preset 名册可投影；
2. **闭包可解析**：安装树内全部包顶层入口可被 Node 解析（针对 lock 声明集），peer 缺口以解析失败显形；
3. **hmr registerConfig 合同**：cordis-plugin-hmr 解析版本 <1.0.17，且子进程不在 boot 期因 watchUserPatches/registerConfig 崩溃；
4. **settings/credentials 热重载**：settings.yaml 出现 `llm-pi-ai:` 段后模型目录热刷新（无需重启子进程）；.credentials.yaml 轮换后新凭证对下一次请求可见；
5. **patch 语义与 scaffold**：cordis patch 的 disable+insert 生效（stock sdk-jsonrpc-server 行被禁用、platform-sdk-server 行生效），profile scaffold 四文件（package.json / pnpm-workspace.yaml / cordis.yml / cordis.patch.yml）被装载；
6. **platform SDK RPC 面**：`presets/list`、`permissions/list`、`permissions/set` 可调用且返回结构符合平台预期，其中 `permissions/set` 在不重启子进程的前提下改变活动会话的权限预设（PermissionPresetService.set 内部 API 合同）。

#### Scenario: 合同⑥捕获内部 API 破坏
- **WHEN** 候选版本重命名或移除 PermissionPresetService.set 依赖的内部接口
- **THEN** 合同⑥的 permissions/set 断言 fail 并指名该 RPC，报告明确归类为内部 API 合同破坏

#### Scenario: 合同②捕获 peer 缺口
- **WHEN** 候选安装缺失一个仅 peer 可达的插件包
- **THEN** 合同②以 ERR_MODULE_NOT_FOUND 指名缺失包，而非等子进程在会话中晚期死亡

### Requirement: 套件接入镜像冒烟与矩阵变更 PR
镜像管线的冒烟阶段 SHALL 在容器内对 /opt/dsh 运行该套件（冒烟通过 = boot 探活 + 六合同双门）；PR CI SHALL 在 dsh-matrix 清单或 lock 变更时对该变更的 scratch 树运行套件，失败阻断合并。合同清单的新增 SHALL NOT 要求修改接线方（runner 单一入口、聚合退出码）。

#### Scenario: 镜像冒烟携带合同门
- **WHEN** 镜像管线执行冒烟步骤
- **THEN** 除 /api/config 探活外，六合同在容器内对 /opt/dsh 执行并通过，否则冒烟失败不推送

#### Scenario: 矩阵 PR 被合同门守卫
- **WHEN** PR 修改 dsh-matrix/package.json 或 package-lock.json
- **THEN** CI 对该 PR 的 scratch npm ci 树运行套件，任一合同 fail 则检查结论为失败
