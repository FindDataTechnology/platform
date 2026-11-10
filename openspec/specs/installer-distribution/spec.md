# installer-distribution Specification

## Purpose

Distributes Platform desktop installers beyond GitHub: a plain-file HTTPS host for domestic downloads, a one-shot sync script that maps a GitHub Release into the official site's download-center snapshot and pushes artifacts to the host, beta promotion tied to real install smokes, and unsigned-install documentation. The snapshot shape is the cross-repo contract defined by the read side (fd-official-web `download-center`); this capability owns the write side.

## Requirements

### Requirement: Plain-file distribution host

The installer artifacts SHALL be served over HTTPS from `dl.finddatatech.cloud` as plain files from a static directory (Caddy on a cheap host), laid out as `/platform/<version>/<artifact>`. Artifacts SHALL be byte-identical to the GitHub Release assets of the same version. Distribution SHALL NOT bake artifacts into container images (per-version registry tags do not recycle quota). At least the two most recent published versions SHALL remain served; older versions MAY be pruned by the sync tooling.

#### Scenario: dl artifact matches the GitHub asset

- **WHEN** an artifact is fetched from `dl.finddatatech.cloud/platform/<version>/`
- **THEN** its digest equals the corresponding GitHub Release asset of that version

#### Scenario: Retention keeps the newest two versions

- **WHEN** the sync tooling publishes a new version with prune enabled
- **THEN** the two most recent version directories remain served and older ones are removed

### Requirement: release-sync one-shot chain

A single script SHALL map a GitHub Release (via `gh api`) into the official site's download-center snapshot and complete the distribution update: read the release and assets, map them to the snapshot entry (macos links the arm64 dmg + the Release page; windows links the exe directly; the x64 dmg rides to the host unlinked), validate the merged snapshot against the site's own build-time rules BEFORE any write, then commit and push the snapshot to both site remotes (triggering the site's image roll) and rsync the artifacts to the distribution host. Re-running the script for the same version SHALL be idempotent (same-version replace, no duplicate entries).

#### Scenario: A release becomes the live download band

- **WHEN** the script runs against a published `v<semver>` release
- **THEN** the site's snapshot gains the version entry and the site roll renders it
- **AND** the artifacts are served from the distribution host

#### Scenario: Invalid snapshot never reaches the site repo

- **WHEN** a mapped entry would fail the site's snapshot validation
- **THEN** the script fails before writing, committing, or pushing anything

### Requirement: Beta promotion discipline

A platform entry SHALL carry `beta: true` in the snapshot until an install smoke on a real machine of that platform has completed for that version; promotion to stable SHALL be a snapshot update recording the completed smoke. No platform SHALL be presented as stable on the official site before its smoke has passed.

#### Scenario: Windows ships beta until smoked

- **WHEN** a version publishes with no completed Windows install smoke
- **THEN** its `windows` snapshot entry carries `beta: true` and the download band marks it beta

#### Scenario: Smoke promotes to stable

- **WHEN** a Windows install smoke completes for that version
- **THEN** a snapshot update flips `beta` to `false` and the band presents it as stable after the roll

### Requirement: Unsigned installer documentation

The public repo README SHALL document that the installers are unsigned and the bypass steps for macOS Gatekeeper and Windows SmartScreen, and SHALL link the official site's download-band guidance; this documentation SHALL exist before any stable (non-beta) download link is published.

#### Scenario: README carries bypass guidance

- **WHEN** the public repo README renders
- **THEN** unsigned-install bypass steps for both macOS and Windows are present, linking the site's guidance

### Requirement: Assisted installer is explicitly configured
The Windows installer MUST be produced as an assisted (wizard) installer, with the NSIS options declared at the configuration top level rather than nested under a platform key.

#### Scenario: NSIS options live at the top level
- **WHEN** the packaging configuration is loaded
- **THEN** the NSIS block is a top-level configuration key
- **AND** the packager reads it (a block nested under the Windows platform key is silently ignored)

#### Scenario: Installer exposes directory choice, progress and completion
- **WHEN** the user runs the Windows installer
- **THEN** the installer presents a wizard with an installation-directory choice
- **AND** shows progress during unpacking
- **AND** shows a completion page
- **AND** allows canceling the installation

#### Scenario: Per-user install by default
- **WHEN** installing on Windows without a signed binary
- **THEN** the install targets the per-user location
- **AND** does not require elevation

### Requirement: 打包闭包由运行时矩阵单源供给
桌面包内的 dsh 运行时闭包 SHALL 由 dsh-matrix manifest（与服务器镜像同一份意图条目与 lock）在打包期安装供给：构建产物内运行时树与矩阵 lock 逐包一致（剪枝名单内条目豁免，与镜像共享同一名单）；根 `package.json` SHALL NOT 再声明平台代码不直接 import 的 dsh 运行时行。打包闭包 SHALL 覆盖运行时解析的全部包——凡 lock 声明且不在剪枝名单内的包都在包内，运行时 boot 无 module-not-found。剪枝 SHALL 在**每个安装位置**应用同一份 `dsh-matrix/prune.json`（镜像 `/opt/dsh`、镜像应用树 `/app`、合同 scratch 树、桌面 app 树）——因根树经 `dsh-sdk-client` 的硬依赖传递携带全家族，剪枝是各树达到同一出货形状的唯一手段。

electron-builder 的 node_modules 收集器只遍历 dependencies/optionalDependencies、从不走 peerDependencies，而 0.2.0 dsh 图谱有大量仅经 peer 可达的运行时包及其传递依赖——打包 SHALL NOT 依赖该收集器推导运行时闭包（v1.3.9 实证：~64 包被静默丢弃、包内 boot 即崩）；打包期 SHALL 以 predist 备好的树为准整体同步（scripts/lib/packaged-tree.mjs 不动点分类 + afterPack），且 `verify-bundle` SHALL 持有收集器覆盖门（树内任何 @deepseek-ai 包都必须归入出货集）。

#### Scenario: 运行时树随包完整
- **WHEN** 打包后的应用在无外置供给的机器上启动 agent 运行时
- **THEN** 运行时解析的每个包（lock 声明、剪枝名单外）都在包内，boot 无 module-not-found

#### Scenario: 矩阵是唯一版本真相
- **WHEN** 检视桌面包内 dsh 运行时树的包版本
- **THEN** 与 dsh-matrix lock 逐包一致；根 package.json 只含平台直接 import 的 dsh 包，不构成第二个版本来源

#### Scenario: 剪枝名单四面共享
- **WHEN** dsh-matrix 剪枝名单变更
- **THEN** 镜像（/opt/dsh 与应用树）、合同 scratch 树、桌面包在下一次各自构建时应用同一名单，不各自维护剪枝副本

#### Scenario: 收集器盲区不伤闭包
- **WHEN** 某运行时包仅经 peerDependencies 可达（manifest 不声明、收集器不遍历）
- **THEN** 打包流程仍把它与其传递依赖同步进包（afterPack 整树同步），且 verify-bundle 的收集器覆盖门在该包会被丢弃时判红

### Requirement: Profile module links are maintained by the app
The app MUST ensure the agent profile can resolve its bare-specifier plugins on a machine that has no out-of-band provisioning.

#### Scenario: Bridge plugin dependencies are linked into the profile
- **WHEN** the app prepares the agent home
- **THEN** the packages the profile bridge plugins import are linked into the profile's module directory
- **AND** links point at the app's own copies

#### Scenario: Links do not shadow the runtime's own resolution
- **WHEN** linking packages for the profile
- **THEN** only the packages the bridges import are linked
- **AND** the runtime's own plugin names continue resolving from the runtime's own tree
- **AND** no link replaces a path the agent runtime itself manages

#### Scenario: Stale non-link entries are cleared before linking
- **GIVEN** a previous install left a real directory where the runtime expects a managed link
- **WHEN** the app prepares the agent home
- **THEN** the stale entry is removed and replaced by a link
- **AND** the runtime's boot does not abort with an ownership error

### Requirement: Readiness reflects the agent runtime
The readiness endpoint MUST report healthy only when the agent runtime actually initialized.

#### Scenario: A degraded agent keeps readiness unhealthy
- **WHEN** agent initialization fails but the server degrades instead of exiting
- **THEN** the readiness endpoint remains non-200
- **AND** the response exposes the initialization error
- **AND** readiness later follows runtime events as the runtime recovers or dies

#### Scenario: A healthy agent reports ready
- **WHEN** agent initialization succeeds
- **THEN** the readiness endpoint returns 200

### Requirement: 安装包预置入门 bundle

桌面安装包 SHALL 支持在 `resources/bundles/` 预置官方入门 bundle（`.yizpack`
文件），由 predist 烘焙阶段从仓库内受控清单收纳；烘焙 SHALL 幂等（同一源
重复构建产出相同集合，不叠加）。预置目录 SHALL 允许为空或缺失（应用照常
运行，导入路径只等用户选文件）。预置 bundle 的合法性与可导入性 SHALL 由构建
期校验兜住（对每个预置文件跑一次 bundle 元信息与摘要校验），坏包 SHALL 在
构建期失败而非留到用户机器上暴露。

#### Scenario: 烘焙幂等

- **WHEN** 同一提交连续两次执行 predist
- **THEN** `resources/bundles/` 的文件集合与内容摘要一致，无重复条目

#### Scenario: 坏包构建期拦下

- **WHEN** 受控清单指向的 bundle 摘要失配或元信息损坏
- **THEN** predist 失败并指名该文件，不产出安装包

#### Scenario: 空预置目录照常出包

- **WHEN** 受控清单为空
- **THEN** 安装包不含 `resources/bundles/`，构建与安装流程零变化
