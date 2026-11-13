## Why

`dsh-plugin-supply` 的供给单位是**部署**：插件烘进镜像，这台机器上所有 profile 都能看到、都能开。团队（fleet）没有任何表达途径——一个 ERP 团队需要的那两个插件，和一支法务团队需要的那两个，只能同时开关，谁都不能说"这台机器上只给这个团队开"。

而团队制品（pack = 模具）已经把技能、MCP 引用、人设都声明齐了，唯独插件没有位置。结果是：团队可以被分发、被克隆、被导出，但它运行时依赖的插件得靠运维口头约定。

本变更给 pack 加第六个声明面：`plugins[]`——**只能引用已烘入 roster 的 id**，落地点是团队实例的 profile 补丁（insert/enable），不是安装通路。这样团队制品自足，而"运行期不下载、不构建、不安装"一个字都不动。

## What Changes

- pack manifest 新增可选 `plugins[]`，每项 `{ id, version? }`；`id` SHALL 命中已烘入 roster，`version` 若不填即取烘入版本，若填且不等于烘入版本则拒绝安装（版本是**断言**不是选择器——只有烘好的那一个版本存在）。
- 团队由模板落地（`from-template`）时，把声明的插件写进该团队实例的 profile 补丁（幂等）；团队归档/删除时移除对应行；同名插件在多个团队间共享同一烘入副本，不复制。
- 团队的导出/导入随包携带 `plugins[]`；导入到另一台机器时，若该机未烘入同名插件，安装 SHALL 明确失败并列出缺失项（不静默降级为"没有这个插件"）。
- 供给态复用既有三态（`enabled` / `available` / `unsupplied`）：团队层面 `unsupplied` 表示"这台机器没有烘入"。
- 团队读面（驾驶舱/运行台账）SHALL 显示该团队实际生效的插件，并标出来源是"团队声明"还是"部署默认开启"。
- **不改**：`dsh-plugin-supply` 的"运行期不装/不构建"；烘入白名单与五轴审校；插件的启用/停用持久化与热应用语义；技能与 MCP 的引用规则。

## Capabilities

### New Capabilities

- `pack-plugin-references`: pack 的 `plugins[]` 声明契约——引用已烘入 roster 的 id、版本断言语义、由模板落地为团队实例的补丁行、导出/导入的完整性、缺失时的明确失败、团队读面暴露实际生效集合。

### Modified Capabilities

（无。`dsh-plugin-supply` 继续管部署级供给与"不运行时安装"；本变更只增加"团队级声明"这一层，且它只能引用部署已供给的东西。）

## Impact

- **lib**：`lib/pack-manifest.js` 增 `plugins[]` 校验（形状、id 形态、至多 8 项、重复拒绝、`version` 形态）；id 命中 roster 的判定在安装面做（那里才有 roster），发布面只查形状。
- **server**：`server/routes/fleets.js` 的 `from-template` 增补丁写入；新增 `server/fleet-plugins.js`（团队 → 插件行投影、幂等写入、移除、读面聚合）；团队归档路径补清理。
- **fleet 实例**：补丁行形态为 `{ insert: [{ id: "<plugin-id>", name: "<bundle-package>" }] }`，写入走既有 `dsh-profile` 的原子写与热应用，不走新通道。
- **导出/导入**：pack 导出随 manifest 带 `plugins[]`；导入前置校验对照本机 roster，缺失即失败并列出。
- **读面**：驾驶舱与运行台账新增"生效插件"一栏（来源标记：team / deployment）。
- **测试**：新增 `scripts/test-pack-plugins-manifest.mjs`（形状/版本断言）、`scripts/test-fleet-plugins-materialize.mjs`（幂等落地、归档清理、多团队共享）、`scripts/test-fleet-plugins-offline.mjs`（断网落地零网络调用）、`scripts/test-pack-plugins-import-missing.mjs`（缺失明确失败）。
- **兼容性**：不声明 `plugins` 的 pack 与今天字节一致；不新增运行期下载路径；不改变既有部署级开关的语义。
