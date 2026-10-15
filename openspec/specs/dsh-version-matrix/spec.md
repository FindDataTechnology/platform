# dsh-version-matrix Specification

## Purpose

声明并冻结镜像内 dsh 运行时的安装矩阵（意图钉版 + peer 闭包 lock），使构建可复现、启动可验证，把"装错树"类故障从运行时诡异失败提前为启动期明确报错。跟随上游发版（ADR-0007 跟随者策略）的受控基础。

## Requirements

### Requirement: 镜像构建从矩阵安装而非手写包清单
镜像构建 SHALL 以 dsh-matrix manifest + lock 为唯一版本来源安装 dsh 运行时两棵树（CLI 树与 profile 模板树），Dockerfile SHALL NOT 再维护逐包版本条目或与 manifest 重复的版本事实。

#### Scenario: Dockerfile 无逐包钉版
- **WHEN** 审视 Dockerfile 的 dsh 安装层
- **THEN** 找不到逐包 `@deepseek-ai/*@<version>` 清单，安装指令引用 dsh-matrix，版本真相只在 manifest 与 lock 中

### Requirement: 启动期安装树一致性硬门
从矩阵构建的部署启动时（paas server 与 agent-runner），系统 SHALL 校验实际安装树与冻结 lock 的一致性；偏差 SHALL 按是否在允许缺席名单内分级：名单内缺席放行并在日志标注剪枝标记，其余任何偏差（名单外缺失、多出、版本不一致）SHALL 拒绝启动并输出包级 diff 报告。本地开发环境未提供矩阵安装时 SHALL 跳过校验并正常启动。

#### Scenario: 树不一致拒绝启动
- **WHEN** 镜像内安装树与 lock 存在名单外偏差（如缺失一个插件包）且未设置逃生口
- **THEN** 进程启动失败退出，日志以包级 diff 指明偏差
- **AND** 不出现"dsh 子进程起来后在会话中才暴露 ERR_MODULE_NOT_FOUND"的晚期失败

#### Scenario: 剪枝缺席放行
- **WHEN** 安装树缺失的包恰为剪枝名单内条目
- **THEN** 启动正常，日志保留该缺席的剪枝标记（可区分于意外缺失）

#### Scenario: 逃生口
- **WHEN** 设置 `DSH_MATRIX_OVERRIDE=1` 且树与 lock 存在偏差
- **THEN** 进程照常启动，日志保留完整偏差报告与逃生口标记

#### Scenario: 一致正常启动
- **WHEN** 安装树与 lock 完全一致（含剪枝后状态）
- **THEN** 启动正常，不产生偏差告警

#### Scenario: 无矩阵的开发环境
- **WHEN** 本地开发环境未通过矩阵安装 dsh（无冻结 lock 可比对）
- **THEN** 校验跳过，启动不受影响

### Requirement: 安装矩阵声明统一代并整体冻结
dsh 运行时安装矩阵 SHALL 由单一 manifest 声明统一代：手写意图条目收敛为 dsh 本体单行（钉 lockstep 版本号），不再维护 overrides 抹平或 hmr 钉版（0.2.0 起全家族以精确钉版硬依赖随本体发布、零 peerDependencies）。平台所有 dsh 依赖面 SHALL 解析为同一代：矩阵 lock 内任一 `@deepseek-ai/*` 行、根 `package.json` 的 dsh 依赖行、与应用代码直接 import 的 dsh 包，三者版本恒等于意图条目钉住的代。重建同一 manifest+lock SHALL 得到逐包相同的安装树，且安装无需 `--legacy-peer-deps`。

#### Scenario: 重建可复现
- **WHEN** 同一份 dsh-matrix manifest 与 lock 在不同时间、不同机器构建镜像
- **THEN** 镜像内 dsh 安装树逐包逐版本一致

#### Scenario: 统一代唯一
- **WHEN** 检视矩阵 lock、根 package.json 依赖行与应用直接 import 的 dsh 包
- **THEN** 任一 `@deepseek-ai/dsh*` 包的版本与意图条目钉住的 lockstep 版本号相同，不存在跨代混装

#### Scenario: 干净解析
- **WHEN** 对根 manifest 与 dsh-matrix manifest 分别执行不带 `--legacy-peer-deps` 的安装解析
- **THEN** 两者均成功解析，无 ERESOLVE

### Requirement: 允许缺席剪枝名单
镜像构建 SHALL 在矩阵 `npm ci` 之后按一份入库评审的剪枝名单（位于 dsh-matrix 目录）删除安装树中确认不被平台 profile 加载的包（首刀：`@deepseek-ai/libreoffice-kit-*` 平台二进制与 `dsh-web-app`/`client-ui-*` UI 部件子树）；名单变更 SHALL 与 manifest 变更同评审轨迹。剪枝 SHALL NOT 触碰名单外的任何包，也 SHALL NOT 以手编 lock 的方式实现。

#### Scenario: 剪枝后闭包可解析
- **WHEN** 剪枝后的安装树接受合同②（闭包可解析）与 boot 握手检查
- **THEN** 全部存留包可解析、子进程 boot 正常——被剪包在平台 profile（dsh-base 95 行插件表）中零引用

#### Scenario: 名单随版评审
- **WHEN** 跟随上游跳版
- **THEN** 剪枝名单随 manifest 意图条目一并复核：新增的"大件依赖若不被 profile 加载"候选进入评审，不再被加载的名目移出

### Requirement: 应用树 dsh 运行时单源化
平台应用树（根 `package.json`）SHALL 只声明平台代码直接 import 的 dsh 包（2026-10-14 实测盘点九行：dsh-sdk-client、dsh-sdk-jsonrpc-server、dsh-tools、dsh-scope、dsh-session、dsh-system-prompt、dsh-llm、schemastery、cordis），其版本 SHALL 跟随矩阵意图条目的统一代；dsh 运行时闭包 SHALL 只从矩阵 manifest 安装（服务器镜像装 /opt/dsh，桌面 predist 装入 app 树），根 manifest SHALL NOT 承担运行时闭包供给。

#### Scenario: 根清单无运行时行
- **WHEN** 检视根 package.json 的 @deepseek-ai 行
- **THEN** 只出现平台直接 import 的包，且版本与矩阵意图条目同代

#### Scenario: 桌面运行时与矩阵同源
- **WHEN** 桌面构建安装运行时闭包
- **THEN** 来源是 dsh-matrix manifest + lock（经 predist 安装与剪枝），桌面与服务器镜像的运行时树逐包一致（剪枝豁免除外）

#### Scenario: 应用树剪到出货形状
- **WHEN** 服务器镜像或桌面构建完成
- **THEN** 应用树经共享 prune.json 剪到与 /opt/dsh 同一出货形状（根树经 dsh-sdk-client 的硬依赖传递携带全家族——实测 290 包/219MB——剪枝而非删行才是瘦身手段），DSH_BIN 解析不受影响
