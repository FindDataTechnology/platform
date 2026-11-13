# single-source-desktop-runtime — Design

## 前置与现状

依赖 `unify-dsh-generation` 落地：矩阵 manifest 已是单行统一代、prune.json 与 boot 门允许缺席机制已建立。本 change 把"桌面的运行时来源"接到同一源头，并顺带让服务器镜像应用树瘦身。

现状机制（将被替换）：

- 根 `package.json` 41 行 dsh 行 = 桌面闭包供给（桌面上无 `DSH_BIN`，app 树即运行时；`dsh-profile.js` 的 RUNTIME_NODE_MODULES 回退 `APP_NODE_MODULES`）。
- `scripts/hoist-dsh-runtime.mjs`：把 dsh **嵌套树**（`node_modules/@deepseek-ai/dsh/node_modules`）拷到顶层——历史上 electron-builder 的静态依赖走会丢动态加载组件（v1.3.2/1.3.3 win 事故）。
- `electron-builder.js:42-43`：显式拷贝嵌套树 `node_modules/@deepseek-ai/dsh/node_modules/**`。
- 0.2.0 后两个前提俱变：全家族硬依赖使嵌套树近乎空置（npm 顶层平铺），hoist 的"嵌套→顶层"语义失效。

## D1 — 根 manifest 瘦身（41 → 8）

保留行 = 平台代码直接 import 的包（2026-10-14 盘点，grep 全仓非 node_modules 的 `from "@deepseek-ai/`）：

| 包 | import 面 |
|---|---|
| dsh-sdk-client | HarnessClient ×6、TransportClosedError |
| dsh-sdk-jsonrpc-server | HarnessSdkJsonRpcServer（a2a serving） |
| dsh-tools | defineTool ×3（桥插件） |
| dsh-scope | createScope、scopeOf |
| dsh-session | SessionId |
| dsh-system-prompt | 默认导出 |
| schemastery | ×4 |
| cordis | ×1 |

版本全部跟矩阵意图条目同代（0.2.0-rc.2 及后续跳版同步）。删除的 33 行是运行时承重行——其职能整体移交矩阵安装步骤。风险点：某行若被间接解析依赖隐式承重（如 pnpm-workspace/cordis patch 引用名），实现时以"删行后 predist 全量 win/mac 冒烟"兜底。

## D2 — predist 矩阵安装步（新）

`predist` 序列（现有：fetch-build-icon → build-node → hoist-dsh-runtime → verify-bundle）插入替换：

1. `npm ci --prefix <staging>`（staging = 构建临时目录，源 = dsh-matrix manifest+lock+.npmrc）——与 Dockerfile 的 /opt/dsh 安装完全同构。
2. 按 `dsh-matrix/prune.json` 剪枝（与镜像共享名单，不建副本）。
3. 并入 app `node_modules`：staging 平铺树逐包拷入顶层（替代旧 hoist 的嵌套→顶层拷贝；`hoist-dsh-runtime.mjs` 改源为此 staging 树，幂等语义保留——已存在的顶层包不覆盖，npm 已验证的解析优先）。
4. `verify-bundle.js` 增断言：包内 `@deepseek-ai/dsh` 存在且版本 = 矩阵意图条目。

electron-builder.js 的嵌套树拷贝行（42-43）删除；`files` 列表的 `node_modules/@deepseek-ai/dsh/node_modules/**` 行同步删（0.2.0 后该目录空置，显式声明反成误导）。瘦身排除规则（`!node_modules/**/{*.md,...}`）沿用。

## D3 — 桌面运行时解析不变式

`dsh-profile.js` 的 `RUNTIME_NODE_MODULES` 推导不变：无 `DSH_BIN` 时回退 `APP_NODE_MODULES`——桌面 app 树在 predist 后含矩阵闭包，桥插件链接（`PROFILE_BRIDGE_PACKAGES`）继续从同一棵树取，realpath 单例约束（2026-10-09 Symbol 事故的修复）自然保持。`Links point at the app's own copies` 的既有合同语义不变。

## D4 — 记账收敛（原「镜像顺带瘦身」的订正）

**订正（2026-10-14 实测）**：本 change 不产生镜像/包体积收益。原稿假设"根 manifest 删 33 行 → 根树不再装运行时闭包 → `/app/node_modules` 的 @deepseek-ai 面缩到 8 包（~5MB）"，实测证伪：

- 瘦身后根清单的干净安装（`npm ci --omit=dev`，临时目录）仍是 **290 个 `@deepseek-ai` 包 / 219MB**，`@deepseek-ai/dsh` 照常在树里。
- 原因：保留行 `dsh-sdk-client` 在 `dependencies` 里硬写 `"@deepseek-ai/dsh": "0.2.0-rc.2"`，而 dsh 硬依赖全家族 → 根树**永远传递拉入整个闭包**，与根清单列几行无关。
- 反证 `dsh-sdk-client` 是元数据冗余而非真依赖：其 `lib/` 只 import `dsh-sdk-protocol` / `dsh-session` / `dsh-llm`（grep 全量，零处 import 裸 `@deepseek-ai/dsh`）。要拿体积收益只能改发布方包的元数据（overrides/本地 patch），属于「动 dsh」范畴——**明确不做**（用户 2026-10-14 明令：不删 dsh 的部分）。

**本 change 的真实收益 = 版本真源收敛 + 构建路径统一**：

- 桌面闭包的**声明位置**从根清单 39 行（手维护、须与矩阵同步 bump）收敛到 `dsh-matrix/` 单源（manifest + frozen lock + prune 名单），与镜像 `/opt/dsh` 完全同构——桌面与服务器从此不可能各装一代。
- 旧机制的两个历史前提（嵌套树拷贝、41 行手维护）在 0.2.0 平铺布局下本就失效，本 change 把失效机制清掉，而不是新增机制。
- Dockerfile 零改动（原稿"无 Dockerfile 改动需求"这半句仍成立）。根树 `--legacy-peer-deps` 的摘除属 unify 变更，与本 change 无耦合。

体积账（3.4）相应改判：桌面载荷**不变**（闭包逐包同版），只落"声明面 39→9 行 + 一条 predist 步替代 hoist 步"的机制账。

## D5 — 验收门

- `win-install-smoke` 全跑（Windows 打包历史四轮修复的教训：builder 闭包走丢是高发区；本 change 改的就是闭包来源）。
- mac dmg 构建 + 首启冒烟（dsh 子进程起、模型名册投影、一次工具调用回合）。
- 镜像侧：构建后 `du` 复核 /app/node_modules @deepseek-ai 面缩量（预期 ~5MB）；boot 冒烟不变绿即回退。
- verify-bundle 新断言进 predist 必跑。

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 删行伤及隐式承重 | predist 全量冒烟兜底；发现即把该包升格为"直接 import 盘点"补行（有明确判据） |
| Windows builder 闭包走丢复发 | win-install-smoke 是硬门；hoist 幂等语义保留 |
| staging 并入与 npm 顶层冲突 | 沿用 hoist 的"不覆盖已存在顶层包"纪律；verify-bundle 版本断言卡漂移 |

回滚线：根 manifest revert（41 行形态是 git 历史，一个 revert 即回）；predist 步独立成脚本可单独禁用。
