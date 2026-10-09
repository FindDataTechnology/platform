# dsh-matrix — dsh 运行时安装矩阵

镜像内 dsh 运行时的**唯一版本真相**（ADR-0007 跟随者策略）。Dockerfile 的 dsh 安装层
从这里的 `package.json`（意图级钉版）+ `package-lock.json`（全闭包冻结）做 `npm ci`，
不再维护逐包版本清单。

## 规则

- `package.json` 只手写**意图级**条目：dsh 本体、dsh-base、两个 sdk 包、cordis-plugin-group、
  cordis-plugin-hmr。其余全部包（含 18 个仅 peer 可达的 dsh-* 插件）由 npm 解析 peer 闭包
  得到，冻结进 lock。
- **lock 是生成物，不手编辑**（同 skills.ts 惯例）。升级 dsh 版本 = 改 package.json 意图
  条目 → 在本目录重新生成 lock → PR 的评审对象是 package.json，lock diff 是机器产物。
- `.npmrc` 刻意**不含** `legacy-peer-deps`：历史 Dockerfile 用它关掉了传递 peer 自动安装，
  才被迫手钉 18 个插件包（18/18 仅 peer 可达，缺了就 boot 时 ERR_MODULE_NOT_FOUND）。
- 同包名跨安装树恒同版本：现在只有一棵实体树（/opt/dsh），sdk-protocol 的 rc.5/rc.2
  历史分裂已按 design D4 裁决统一为 0.1.1-rc.2（bridge 实际运行的那颗）。

## 为什么 hmr 钉死 1.0.16（overrides + 直接依赖双保险）

cordis-plugin-hmr ≥1.0.17 删除了 `registerConfig`，而 dsh-app-boot 的 watchUserPatches
无条件调用它——浮上去的构建每个 dsh 子进程开机崩环（2026-09-23 事故）。直接依赖保证
它在树里，overrides 保证闭包内任何路径解析不出 1.0.17+。

## 上游陷阱备忘

- `dsh-base` / `dsh-sdk-protocol` 的 `latest` dist-tag 停在首版从未更新——任何"装 latest"
  都会拿到最老的包。跟随上游必须显式读版本清单。
- 上游 ~每日一个 lockstep rc 版本（monorepo 统一发版，三包发布时刻相差几分钟）。
  节奏政策见 ADR-0007：合同套件落地前钉死，落地后每 3-4 周跳最新绿 rc。

## 升级步骤（每 3-4 周窗口，ADR-0007）

1. 改 `package.json` 意图条目到目标 rc（`overrides` 里的 dsh-* 同步；hmr 的 1.0.16
   override 除非上游修了 registerConfig，否则**不动**）。
2. 重新生成 lock：在本目录 `npm install --package-lock-only`。lock 是机器产物，PR 的
   评审对象是 `package.json`，lock diff 只作旁证。
3. 跑合同套件：仓库根 `npm run dsh:contracts`。缺省对 scratch `npm ci` 树跑（首跑约几分钟，
   之后按 lock hash 缓存复用；`--fresh` 强制重建）。候选模式可对任意安装试跑：
   `npm run dsh:contracts -- --tree <安装根> [--bin <dsh 路径>]`。
4. **六合同全绿 → 跟**：合并 PR 即完成升级。镜像冒烟与矩阵 PR CI 会各再跑一次同一套件兜底。
5. 有 fail → 看逐条归因再决定：
   - 公开面合同 fail（①②③④⑤）= 不能跟，先解决或等下一个 rc；
   - 带 `internal-API` 标签的 fail（⑥）= 上游动了内部面（PermissionPresetService.set 一类），
     评估替代实现或继续锁旧版，不是自动的"不能跟"；
   - ③ fail 且报告指 cordis-plugin-hmr ≥1.0.17 = 检查 overrides 是否被放开——这是唯一
     "fail 但改回 pin 即修复"的形态。
