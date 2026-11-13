## Why

一份 pack 现在只有一条出路：`.yizpack`（离线/预置）与市场条目。团队的能力（技能正文、岗位人设、MCP 引用）本身是**跨 harness 可移植**的——`SKILL.md` 已是开放标准，约 30 个 agent harness 读同一格式——但今天我们没有任何形态能让一份 pack 离开千座之后还被消费。想让生态外延增长，前提是先有一个"拿得走"的制品。

同时三条出路各自维护：`.yizpack` 由 CLI 导出、桌面预置由 `bundles/manifest.json` 手列、市场条目由发布面产出。三份清单必然有一份是假的（DRIFT 盲点那类教训），且任何一处改 manifest 都要人工同步三次。

本变更把这三条出路收敛成**一个源、三个信封**，并把"可移植的边界"写成契约：出去的是能力，编排与控制台留下。

## What Changes

- 新增包级投影器：以某个 pack 的**不可变版本**（市场 manifest 快照）为唯一输入，产出三个信封：
  1. `.yizpack`（既有格式，既有导入管线不动）；
  2. **dsh bundle**（npm 包形态：`skills/` 下 SKILL.md、岗位人设 → agent preset、MCP 引用 → 依赖声明）；
  3. 桌面预置目录 `resources/bundles/` 的清单（由生成器产出，取代手维护）。
- 投影内容边界写成硬规则：出走的信封 SHALL 只含**能力**（技能正文、人设、MCP 的 registry 名引用），SHALL NOT 含舰队编排、拍板策略、控制台声明、任何端点或凭据。
- 三封信封各自带内容摘要与"目标运行时兼容范围"，并对同一输入**确定性**产出（条目序、时间戳归一）。
- 新增漂移闸：CI 重新生成三封并与仓库内产物逐摘要比对，任一不一致即红——取代"改一处、记得改三处"的人工纪律。
- **不改**：`.yizpack` 的容器格式与导入校验管线；`platform.bundle.json`（部署级 bundle）语义；市场发布/安装契约；付费闸。

## Capabilities

### New Capabilities

- `pack-bundle-projection`: 单一源到三个信封的投影契约——输入的唯一性（不可变版本快照）、各信封的内容边界与格式、确定性产出的判据、目标运行时兼容范围声明、漂移检测的判据。

### Modified Capabilities

- `offline-pack-supply`: 桌面预置清单（`resources/bundles/`）的来源从"手工列表"改为"投影器产出"，并保留既有幂等与"预置包无后门"要求。

## Impact

- **scripts**：新增 `scripts/project-pack-bundles.mjs`（三封生成 + `--check` 漂移模式）；`scripts/export-pack-bundle.mjs` 改为复用其 `.yizpack` 适配器（对外 CLI 参数不变）；`scripts/bake-bundles.mjs` 的输入清单改由投影器生成。
- **server**：新增 `server/pack-projection.js`（纯函数：manifest → 三信封的中间表示；无 I/O），供 CLI 与发布面共用同一份边界规则。
- **lib**：`lib/pack-manifest.js` 增投影前置校验（信封内容边界：不得含编排/控制台/端点/凭据）。
- **dsh 信封**：产出 `package.json`（含 `dsh.profile.bundles` 指向自身）+ `skills/` + `presets/` + 声明目标 dsh 范围的 `dshCompat` 字段；不含 `cordis.patch.yml`（不接管加载顺序）。
- **CI**：新增漂移检查步骤（`node scripts/project-pack-bundles.mjs --check`），与既有 drift-guard 并列；判据落在**产物摘要**而非清单文本。
- **测试**：新增 `scripts/test-pack-projection-determinism.mjs`（同输入两次产出逐摘要一致）、`scripts/test-pack-projection-boundary.mjs`（注入含编排/端点/凭据的 manifest 必须被拒，正反两例）、`scripts/test-pack-projection-drift.mjs`（篡改一个信封必须让 `--check` 红）。
- **兼容性**：不新增必须人工维护的清单；不改变任何既有安装/发布行为；`.yizpack` 字节格式不变（切换前须证明"生成结果 == 现手工列表"，否则视为内容变更需单独审）。
