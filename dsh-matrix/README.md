# dsh-matrix — dsh 运行时安装矩阵

镜像内 dsh 运行时的**唯一版本真相**（ADR-0007 跟随者策略；0.2.0 统一代起另见
ADR-0023）。Dockerfile 的 dsh 安装层从这里的 `package.json`（意图级钉版）+
`package-lock.json`（全闭包冻结）做 `npm ci`，再按 `prune.json`/`prune.mjs`
做装后剪枝。

## 规则

- `package.json` 只手写**意图级**条目：dsh 本体、dsh-base、sdk-jsonrpc-server
  ——即平台 profile 直接组合的三件事（bundle、insert 行）。0.2.0 起全家族以
  精确钉版硬依赖随本体发布、零 peerDependencies，**overrides 已退役**（历史
  上它抹平 rc.2/rc.5 双代并钉 cordis-plugin-hmr 1.0.16；该包已家族化为
  `@deepseek-ai/dsh-hmr`）。
- **lock 是生成物，不手编辑**。升级 dsh 版本 = 改 package.json 意图条目 → 在
  本目录重新生成 lock → 跑合同套件 → 复核 prune 名单。
- **剪枝（ADR-0023 D2）**：`npm ci` 后运行 `node prune.mjs --tree <安装根>`
  删除平台 profile 证实不加载的包（准入证据 = dsh-base 插件表零引用）。boot
  门（lib/dsh-matrix-verify.js）读同一 prune.json：名单内缺席放行（日志标
  pruned），名单外缺席照旧拒启。名单变更与 manifest 变更同评审。禁止以 lock
  手术实现剪枝。
- `.npmrc` 刻意**不含** `legacy-peer-deps`（历史 Dockerfile 用它关掉了传递
  peer 自动安装，才被迫手钉 18 个插件包——该类别随 0.2.0 硬依赖化消灭）。

## 桌面同源（single-source-desktop-runtime）

桌面安装包与服务器镜像**共用这一个源头**，不再有第二条路径：

- 镜像：Dockerfile 的 dsh 安装层 `npm ci` 到 `/opt/dsh` → `prune.mjs --tree /opt/dsh`
  （同一 RUN 里 `--tree /app` 剪应用树）。
- 桌面：`predist` 的 `scripts/install-dsh-matrix.mjs` —— staging `npm ci`（同
  manifest+lock+.npmrc）→ `prune.mjs` staging → 平铺并入 app `node_modules`
  （不覆盖 npm 已解析的包）→ **再 `prune.mjs --tree <app 根>`**。
- 合同 scratch 树：`ensureScratchTree` 同样 `npm ci` + 剪枝（出货形状）。

为什么 app 树也要剪：根 `package.json` 保留的 `dsh-sdk-client` 在 `dependencies`
里硬写 `@deepseek-ai/dsh`（其 `lib/` 实际零处 import 裸 dsh，是发布方的元数据
冗余），dsh 又硬依赖全家族——所以根树**永远**传递携带整个闭包，与根清单列几行
无关（2026-10-14 干净安装实测：290 个 `@deepseek-ai` 包 / 219MB）。剪枝是各树
达到同一出货形状的唯一手段：剪后 233 包 / 33MB（-186MB = libreoffice-kit
148MB + dsh 自家 UI 38MB）。

## 上游陷阱备忘

- `dsh-base` / `dsh-sdk-protocol` 的 `latest` dist-tag 停在首版从未更新——
  任何"装 latest"都会拿到最老的包。跟随上游必须显式读版本清单。
- 上游 lockstep rc 版本（monorepo 统一发版）。节奏政策见 ADR-0007：每 3-4
  周跳最新绿 rc，中间版本直接跳过。
- 0.2.0 的 dsh-base 把整个 agent host 面收编进 bundle（工具/技能/plan/压实/
  subagent/workflow 全在内）——部署组合只剩 persona 与部署自有行，见
  `dsh-profile-template/standard.agent.cordis.yml` 的翻译注。

## 升级步骤（每 3-4 周窗口，ADR-0007/0023）

1. 改 `package.json` 意图条目到目标 rc（单行版本号，无 overrides 可同步）。
2. 重新生成 lock：在本目录 `npm install --package-lock-only`。lock 是机器
   产物，PR 的评审对象是 `package.json`，lock Diff 只作旁证。
3. 跑合同套件：仓库根 `npm run dsh:contracts`（scratch 树自动 npm ci +
   剪枝到出货形状后九合同全跑；`--fresh` 强制重建）。
4. **九合同全绿 → 跟**：合并 PR 即完成升级。镜像冒烟与矩阵 PR CI 会各再跑
   一次同一套件兜底。
5. 有 fail → 看逐条归因再决定：
   - 公开面合同 fail（①②③④⑤⑦）= 不能跟，先解决或等下一个 rc；适配工作
     落在 dsh-profile.js 适配层（0.2.0 跳版的 settings→profile-patch 行、
     preset→声明式行迁移即实例，见 change unify-dsh-generation design D7）；
   - 带 `internal-API` 标签的 fail（⑥）= 上游动了内部面
     （PermissionPresetService.set 一类），评估替代实现或继续锁旧版，不是
     自动的"不能跟"；
   - ② fail 且报告指剪枝名单内条目 = 检查 prune.json 是否漏了豁免接线。
6. 复核 `prune.json`：新增的"大件依赖若不被 profile 加载"候选进评审；上游
   若开始加载某已剪包（dsh-base 插件表新增行）→ 移出名单。
