# 提案：add-dsh-plugin-supply —— dsh 插件供给面（市场兼容①：机制层）

## Why

dsh 的插件生态对壹座当前是封闭的，但接入成本远低于直觉：`dsh-plugin-manager`
服务（inspect/清单/启停/版本门/构建审批/HMR 热重组）已随 `@deepseek-ai/dsh-base`
组合进每个 profile（`dsh-base/cordis.patch.yml:20`），服务 cordis 键
`pluginManager` 已在进程内可用，只是从未接出——无 RPC、无 UI、无供给链。

2026-10-27 spike 实证（候选树合同复测 + 版本门口径实读 `evaluatePluginCompatibility`）：
版本门只约束 `@deepseek-ai/dsh`/`dsh-*` peer，**第三方 bundle（不带该 scope peer）
在现役 0.2.0-rc.2 矩阵上今天就可装可跑**。补开这道口子 = 用户侧能力池立即扩到
「任何声明 dsh bundle 的 npm 包」，且为官方 browser-use 等家族随 dsh 0.2.1 移植
（挂账 `port-dsh-0.2.1`）预先备好交付通道。

## What Changes

- **新增 dsh 插件供给 bridge**：平台模板桥同族新增 plugin-supply 桥，将 profile 内
  `pluginManager` 服务的 bundle 清单读取与启用/禁用接出为 JSON-RPC（
  `plugins/list`、`plugins/set_enabled`）。
- **运营白名单供给（v1 唯一供给路径）**：bundle 由运营在部署期声明——进
  `dsh-matrix` 清单/lock（镜像与桌面 predist 同源烘焙）+ `dsh-profile-template`
  的 `dsh.profile.bundles` 列表；cell 借既有 `linkProfilePinnedModules` 机制解析，
  **不做运行时自助装包**（cell/桌面均无 pnpm；npm 装的 dsh CLI 拒绝 plugin 包管理；
  构建脚本审批无 UI——三条硬性阻断，见 design D2）。
- **Settings 新增「插件」区块**：只读清单（id/描述/启停态/加载相位/错误元数据）+
  启停开关 + 生效方式提示；定位与 MCP/Skills 两区块并列。
- **启停持久化与生效**：写 profile `cordis.patch.yml` 覆盖层（dsh 官方语义），
  HMR 可活重组时热生效，否则走既有 bridge 重启路径（会话按 id 恢复，
  与 set_model 同族）；流式中拒绝切换。
- **agent 面 `tool-plugin-manager` 本版保持关闭**（dsh-base 默认 `disabled: true`，
  不动）；唯一写路径是 UI 桥。

## Capabilities

### New Capabilities
- `dsh-plugin-supply`: dsh 层插件供给与启停——运营白名单 bundle 烘焙供给、
  只读清单投影、启停开关持久化与生效语义、v1 安全下限（禁运行时安装）。

### Modified Capabilities
- `extension-management-ui`: 新增「Plugins 区块」requirement——与 MCP/Skills
  区块并列的 Settings 第三区块：只读清单、启停开关、生效反馈、无安装面。

## Impact

- `dsh-profile-template/`：新增 `platform-plugin-supply-bridge.js`；`package.json`
  的 `dsh.profile.bundles` 成为白名单声明位。
- `dsh-profile.js`：新增 plugin-supply patch 生成器（照 presets/permissions 生成器族）。
- `dsh-matrix/`（manifest/lock/prune.json）：白名单 bundle 烘焙入口；剪枝证据链随评审。
- `server.js` / `server/routes/`：`/api/extensions/plugins*` REST（照
  extension-runtime-management 族），流式中拒绝切换。
- `web/`：Settings「插件」区块（清单 + 开关 + 生效提示 + 错误呈现）。
- `e2e/` + `scripts/dsh-contracts.mjs` 候选扩展：供给打样 bundle（in-repo trivial
  bundle）与启停合同。
- `docs/`（DEPLOY.md / registry-maintenance 台账口径）。
- **不影响**：既有 MCP/技能扩展面、pack 体系、模型/预设选择语义；无 BREAKING。
- **挂账**：运行时自助装包（pnpm 供给 + 构建审批 UI + 版本门豁免 UI）、
  agent 自助装包（tool-plugin-manager 开闸）、官方 @deepseek-ai 家族 bundle
  （随 `port-dsh-0.2.1` 解锁）、computer-use 家族。
