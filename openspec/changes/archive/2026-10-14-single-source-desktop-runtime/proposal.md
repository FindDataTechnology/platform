# single-source-desktop-runtime

## Why

`unify-dsh-generation` 把全平台 dsh 统一到 0.2.0-rc.2 后，桌面包面临过渡性膨胀：根 `package.json` 仍保留 39 行 dsh 运行时行（历史上为桌面承重），0.2.0 全家族硬依赖使桌面闭包从"漏装 peer 的残缺 56MB"涨到 ~516MB。同时服务器镜像 `/app/node_modules` 里这些运行时行是纯死重（`DSH_BIN` 已钉 `/opt/dsh`）。

根因是"桌面的 dsh 运行时来源"从未单源化：桌面靠根 manifest 的行 + 嵌套树 hoist 拼出闭包，与 dsh-matrix 各自为政。0.2.0 全家族硬依赖化（嵌套树语义消失）正好是重建这条通路的时机——桌面与服务器从同一份矩阵 manifest 取运行时，版本真相收敛为一处。

**实测订正（2026-10-14）**：删行本身不减体积——保留行 `dsh-sdk-client` 硬依赖 `@deepseek-ai/dsh`，根树永远传递拉入全家族（干净安装实测 290 包 / 219MB，与删行无关）。真正拿到剪枝收益的是把 `prune.json` 应用到 app 树（219MB → 33MB，桌面与镜像同形状）。原稿"删 33 行 → /app 缩到 8 包"的因果链是错的，收益来自剪枝而非删行。

## What Changes

1. **根 manifest 瘦身**：`package.json` 的 39 行 dsh 行收敛为 9 行平台真实 import 包（dsh-sdk-client、dsh-sdk-jsonrpc-server、dsh-tools、dsh-scope、dsh-session、dsh-system-prompt、dsh-llm、schemastery、cordis——以实际 import 盘点为准），版本跟矩阵意图条目。
2. **桌面 predist 矩阵安装**：`predist` 新增一步从 dsh-matrix manifest `npm ci` 出运行时闭包、按剪枝名单（prune.json，与镜像共享）剪枝后并入 app `node_modules`。
3. **hoist 退役**：`scripts/hoist-dsh-runtime.mjs` 删除（0.2.0 平铺布局使"嵌套→顶层"语义消失），其幂等并入纪律由新安装步承接；`electron-builder.js` 的嵌套树拷贝行同步删。
4. **剪枝名单全面共享**：`prune.json` 在各安装位置应用——镜像 `/opt/dsh`（既有）、镜像应用树 `/app`（新）、合同 scratch 树（既有）、桌面 app 树（新）。因根树经 `dsh-sdk-client` 硬依赖传递携带全家族，剪枝是各树达到同一出货形状的唯一手段（实测：app 树 219MB → 33MB）。

## Capabilities

### New Capabilities
（无）

### Modified Capabilities
- `installer-distribution`: 打包闭包来源重塑——从"根 manifest + 嵌套树 hoist"改为"dsh-matrix manifest 单源 + 剪枝名单共享"（requirement 重塑走 REMOVED+ADDED）。
- `dsh-version-matrix`: 新增"应用树 dsh 运行时单源化"约束——根 manifest 只声明平台直接 import 的 dsh 包，运行时闭包只从矩阵来。

## Impact

- 前置依赖：`unify-dsh-generation` 落地（矩阵 manifest 形状与剪枝机制是其产物）。
- 桌面包 dsh 载荷：~516MB（unify 后过渡态）→ 剪后形状（实测 app 树 @deepseek-ai 219MB → 33MB，省 186MB；最终安装包体积在 GHA release 构建后落账）。
- 验收面：win-install-smoke 全跑（历史 nested hoist 正是为修 Windows 打包断——v1.3.2/1.3.3 `Cannot find package 'cordis-plugin-group'` 教训在册）。
- 时序自由：与多 agents 功能无依赖，可在 unify 落地后任意窗口执行。
