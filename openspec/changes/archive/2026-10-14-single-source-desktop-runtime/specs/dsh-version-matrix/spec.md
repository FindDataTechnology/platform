# dsh-version-matrix Delta

## ADDED Requirements

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
