# installer-distribution Delta

## REMOVED Requirements

### Requirement: Packaging closure covers runtime-only packages
**Reason**: 闭包来源重塑——0.2.0 统一代后全家族以精确钉版硬依赖随 dsh 本体发布（嵌套树/peer-only 承重行/双代 ERESOLVE 三个场景的前提俱不存在），打包闭包改由 dsh-matrix manifest 单源供给，以新名 Requirement 重述。

## ADDED Requirements

### Requirement: 打包闭包由运行时矩阵单源供给
桌面包内的 dsh 运行时闭包 SHALL 由 dsh-matrix manifest（与服务器镜像同一份意图条目与 lock）在打包期安装供给：构建产物内运行时树与矩阵 lock 逐包一致（剪枝名单内条目豁免，与镜像共享同一名单）；根 `package.json` SHALL NOT 再声明平台代码不直接 import 的 dsh 运行时行。打包闭包 SHALL 覆盖运行时解析的全部包——凡 lock 声明且不在剪枝名单内的包都在包内，运行时 boot 无 module-not-found。剪枝 SHALL 在**每个安装位置**应用同一份 `dsh-matrix/prune.json`（镜像 `/opt/dsh`、镜像应用树 `/app`、合同 scratch 树、桌面 app 树）——因根树经 `dsh-sdk-client` 的硬依赖传递携带全家族，剪枝是各树达到同一出货形状的唯一手段。

#### Scenario: 运行时树随包完整
- **WHEN** 打包后的应用在无外置供给的机器上启动 agent 运行时
- **THEN** 运行时解析的每个包（lock 声明、剪枝名单外）都在包内，boot 无 module-not-found

#### Scenario: 矩阵是唯一版本真相
- **WHEN** 检视桌面包内 dsh 运行时树的包版本
- **THEN** 与 dsh-matrix lock 逐包一致；根 package.json 只含平台直接 import 的 dsh 包，不构成第二个版本来源

#### Scenario: 剪枝名单四面共享
- **WHEN** dsh-matrix 剪枝名单变更
- **THEN** 镜像（/opt/dsh 与应用树）、合同 scratch 树、桌面包在下一次各自构建时应用同一名单，不各自维护剪枝副本
