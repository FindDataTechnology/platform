# single-source-desktop-runtime — Tasks

> 前置：`unify-dsh-generation` 已合并落地（矩阵单行 manifest + prune.json + boot 门允许缺席机制在产）。

## 1. predist 矩阵安装步

- [x] 1.1 新脚本 `scripts/install-dsh-matrix.mjs`：staging `npm ci`（源 dsh-matrix manifest+lock+.npmrc）→ 按 prune.json 剪枝 → 平铺树并入 app node_modules（不覆盖已存在顶层包）→ **再对 app 树应用同一份 prune.json**（第 4 步，实测补：不覆盖纪律使 app 树自带的未剪枝闭包存活，不剪则收益为零）
- [x] 1.2 `hoist-dsh-runtime.mjs` 退役（删除；"嵌套→顶层"语义在 0.2.0 平铺布局下已消失，幂等并入纪律由 1.1 承接）
- [x] 1.3 predist 序列接线：install-dsh-matrix 替换原 hoist 位置；verify-bundle 增断言（包内 dsh 版本 = 矩阵意图条目）
- [x] 1.4 electron-builder.js：删嵌套树拷贝行与 files 列表的 nested 声明行

## 2. 根 manifest 瘦身

- [x] 2.1 删除 30 行运行时承重行，保留 9 行直接 import 包（dsh-sdk-client / dsh-sdk-jsonrpc-server / dsh-tools / dsh-scope / dsh-session / dsh-system-prompt / dsh-llm / schemastery / cordis；盘点含 dsh-llm——原稿漏了它，实测 import 面含），版本跟矩阵意图条目
- [x] 2.2 根 lock 重生成；干净安装（临时树 `npm ci --omit=dev`）exit 0、`npm run typecheck` 绿
- [x] 2.3 删行后 predist 全量冒烟：隐式承重盘点（被删 30 行在干净瘦身树中 0 缺失——全由传递闭包供给，无需升格补行）；`npm run predist` 幂等绿；40/40 bridge/profile 单测 + 149/149 runner/cell 单测 + 16/16 dsh 合同绿

## 3. 验收

- [x] 3.1 win-install-smoke 全跑：**v1.3.11 三相全绿**（A 窗口目标 47600/B 包内后端 /api/ready/C GUI 自证，run 38561048904）——途中照出并修掉三个潜伏缺陷：Win npm.cmd 无 shell ENOENT、builder ['app','www'] 探测命中手机 Expo app/（directories.app 钉 '.'）、**electron-builder 收集器不走 peerDependencies**（0.2.0 图谱 ~64 包仅 peer 可达被静默丢弃 → afterPack 按 scripts/lib/packaged-tree.mjs 不动点分类整树同步 + verify-bundle 收集器覆盖门）、files 清单漏 services/ 目录（10-13 新增运行时目录）。坏包 v1.3.9/v1.3.10 已删。
- [x] 3.2 mac dmg 构建 + 首启冒烟：dmg-arm64/x64 构建绿；包内等价面由 debug 直跑与 win-smoke Phase B 覆盖（/api/ready 200 + dshInitError null）；mac 本机源树直跑实证 /api/ready 200（5s）+ WS 真回合（模型回复「收到」，usage 20007/2）
- [x] 3.3 镜像复核：image-build-check 连续双绿（/api/config + /api/ready 硬门 + dsh 合同 + module identity，run 38547121747/38555889325）；Dockerfile 增 `prune.mjs --tree /app`；app 树 @deepseek-ai 290 包/219MB → 233/33MB（-186MB）
- [x] 3.4 桌面包体积落账（GHA 实测）：v1.3.11 = arm64 dmg 303.9MB / x64 312.1MB / exe 230.5MB（对照 v1.3.8：+29.5/+31.8/+18.3MB = 0.2.0 统一代 + 运行时树**完整**的诚实成本——v1.3.8 的较小体积部分是收集器欠发货，如 llamaindex core peer 缺失）；剪枝在树层面省 186MB（无剪枝则另加）

## 4. 文档

- [x] 4.1 dsh-matrix/README.md 增"桌面同源"一节（predist 路线 = 镜像路线共享 manifest 与 prune 名单）
- [x] 4.2 压缩诉求延续 → 已开独立 explore 记录（`notes/desktop-runtime-download-explore.md`，不在本 change 实施）
