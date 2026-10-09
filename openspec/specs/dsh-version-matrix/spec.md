# dsh-version-matrix Specification

## Purpose

声明并冻结镜像内 dsh 运行时的安装矩阵（意图钉版 + peer 闭包 lock），使构建可复现、启动可验证，把"装错树"类故障从运行时诡异失败提前为启动期明确报错。跟随上游发版（ADR-0007 跟随者策略）的受控基础。

## Requirements

### Requirement: 安装矩阵由一份清单声明并整体冻结
部署镜像内的 dsh 运行时安装树 SHALL 由仓库内单一 manifest（package.json）声明：手写条目仅限意图级——dsh 本体、dsh-base、两个 sdk 包、以及以 npm overrides 显式钉住的 cordis-plugin-hmr；其余全部包（含仅 peer 可达的插件闭包）SHALL 由 npm 从该 manifest 一次解析，并把完整闭包冻结进提交的 package-lock.json。同一个包名 SHALL 在所有安装树中解析为同一版本（裁决现存的 sdk-protocol 双版本）。重建同一 manifest+lock SHALL 得到逐包相同的安装树。

#### Scenario: 重建可复现
- **WHEN** 同一份 dsh-matrix manifest 与 lock 在不同时间、不同机器构建镜像
- **THEN** 镜像内两棵 dsh 安装树逐包逐版本一致，含全部仅 peer 可达的插件

#### Scenario: 同包同版本
- **WHEN** 任一包名同时出现在 CLI 树与 profile 树的解析结果中
- **THEN** 两树中该包版本一致

#### Scenario: hmr 钉版承重
- **WHEN** npm 解析 manifest 的 peer 闭包
- **THEN** cordis-plugin-hmr 解析为 overrides 钉住的 1.0.16，而非闭包内其他 range 浮动出的更新版本

### Requirement: 镜像构建从矩阵安装而非手写包清单
镜像构建 SHALL 以 dsh-matrix manifest + lock 为唯一版本来源安装 dsh 运行时两棵树（CLI 树与 profile 模板树），Dockerfile SHALL NOT 再维护逐包版本条目或与 manifest 重复的版本事实。

#### Scenario: Dockerfile 无逐包钉版
- **WHEN** 审视 Dockerfile 的 dsh 安装层
- **THEN** 找不到逐包 `@deepseek-ai/*@<version>` 清单，安装指令引用 dsh-matrix，版本真相只在 manifest 与 lock 中

### Requirement: 启动期安装树一致性硬门
从矩阵构建的部署启动时（paas server 与 agent-runner），系统 SHALL 校验实际安装树与冻结 lock 的一致性；不一致时 SHALL 拒绝启动并在日志输出可读的偏差报告（多出的包、缺失的包、版本不一致的包），而非带着错树进入运行。本地开发环境未提供矩阵安装时 SHALL 跳过校验并正常启动。

#### Scenario: 树不一致拒绝启动
- **WHEN** 镜像内安装树与 lock 存在偏差（如缺失一个 peer-only 插件包）且未设置逃生口
- **THEN** 进程启动失败退出，日志以包级 diff 指明偏差
- **AND** 不出现"dsh 子进程起来后在会话中才暴露 ERR_MODULE_NOT_FOUND"的晚期失败

#### Scenario: 逃生口
- **WHEN** 设置 `DSH_MATRIX_OVERRIDE=1` 且树与 lock 存在偏差
- **THEN** 进程照常启动，日志保留完整偏差报告与逃生口标记

#### Scenario: 一致正常启动
- **WHEN** 安装树与 lock 完全一致
- **THEN** 启动正常，不产生偏差告警

#### Scenario: 无矩阵的开发环境
- **WHEN** 本地开发环境未通过矩阵安装 dsh（无冻结 lock 可比对）
- **THEN** 校验跳过，启动不受影响
