# unify-dsh-generation

## Why

壹座的 dsh 版本面今天是"一个平台、两棵树、三代版本号"：根 `package.json` 41 行混合 0.1.1-rc.2 / 0.0.1-rc.5 / 0.0.1-rc.1 三代，`dsh-matrix/` 冻结统一 0.1.1-rc.2，两树长期漂移。这个漂移已产生过生产事故（2026-10-09 sha-e956091：rc.1 的 dsh-tools 链进 rc.2 运行时，双 `TOOL_RUNTIME_SCHEDULER` Symbol，全部工具调用死亡），并且是隐藏 bug 的温床。

马上要开工的萬星多 agents 功能（多 harness 运行管理层，见 `docs/facet-wanxing-roadmap.md` 2026-10-14 定向节）会把这个面乘以 N：更多 dsh 子进程 × 更多 profile 树 × 更多桥链接。ADR-0007 原话"落后时是加深内部耦合的最坏时机"——多 agents 的新耦合必须叠在统一后的版本面上。

上游已具备统一条件：`0.2.0-rc.2`（dist-tag latest/next 双标记）全家族同版本号发布、零 peerDependencies、hmr 家族内化（`@deepseek-ai/dsh-hmr`），使"统一到最新版"从愿望变成一次受控跳跃。

## What Changes

1. **统一跳版**：`dsh-matrix/` 意图条目收敛为 `dsh@0.2.0-rc.2`（overrides 全部退役——hmr 1.0.16 钉版随 `cordis-plugin-hmr` 包消失而使命结束）；根 `package.json` 的 41 行 dsh 行在原位统一 bump 到 0.2.0-rc.2（行数收敛留给 single-source-desktop-runtime change）。此后维持 ADR-0007 节奏：每 3-4 周跳当时最新绿 rc。
2. **摘 `--legacy-peer-deps`**：根安装与 dsh-matrix 安装均不再需要该旗（0.2.0 家族单代干净解析已实证）；Dockerfile、release/ci、Jenkinsfile 同步摘除。
3. **允许缺席剪枝**：建立 `ALLOWED_ABSENT` 机制——镜像构建在 `npm ci` 后按随版评审的剪枝名单删除确认不被平台 profile 加载的包，boot 门（`lib/dsh-matrix-verify.js`）对名单内缺席放行、名单外仍拒绝启动。首刀剪 `libreoffice-kit-*` 平台二进制（~159MB，壹座用自有 python office 层）与 `dsh-web-app`/`client-ui-*` UI 部件（~33MB，平台永不渲染 dsh 自带 UI）。
4. **合同③改写**：hmr 合同从"cordis-plugin-hmr <1.0.17"改为断言家族内 `@deepseek-ai/dsh-hmr` 在钉版代存在且 boot 稳定。
5. **适配层 lint**：`@deepseek-ai/*` 直接 import 只许出现在入库评审的适配层文件名单内（dsh-bridge.js、dsh-profile-template/ 桥、agent-runner/index.js、scripts/ 探针与合同套件），CI 强制——这是"dsh 可替换为第一 harness"的接缝。
6. **决策落盘**：新 ADR-0023（统一代跳跃 + 允许缺席剪枝政策），ADR-0007 头部加 superseded 注记（hmr 钉版、overrides 抹平、18 行 peer 历史三处作废）。

## Capabilities

### New Capabilities
- `dsh-adapter-boundary`: 适配层文件名单与 import 约束的 CI 强制——dsh-* 直接引用的边界即"dsh 可替换"的接缝。

### Modified Capabilities
- `dsh-version-matrix`: 意图清单从"多行 + overrides 抹平双代"收敛为"单行统一代"；boot 门新增允许缺席名单语义；剪枝政策入规。
- `dsh-contracts`: 合同③从 cordis-plugin-hmr 版本界断言改为 dsh-hmr 家族断言；runner 破坏示例去 hmr 化。

### Removed Capabilities
（无）

## Impact

- **镜像体积**：朴素跳 0.2.0 会 +233MB（闭包 283→516MB，主因 libreoffice-kit 159MB）；剪枝后 ≈324MB，加根树不变，镜像 dsh 载荷净 **+41MB**（根树 -50MB 收益归 single-source-desktop-runtime）。
- **桌面包**：临时性膨胀（根树 bump 后桌面闭包随 0.2.0 全家族膨胀至 ~516MB），由后续 change `single-source-desktop-runtime`（内嵌剪后闭包 ~324MB）与远期首启下载方案收敛——本 change 显式接受这一过渡成本。
- **爆炸半径**：服务面（cells / facet / runner 三角色同镜像单滚）；`wire-dsh-live-runtime-control` 昨上生产的 ⑧⑨ 合同即跳版安全网，合同试跑全绿才合并。
- **明确不做**：pi-ai 链剪枝（平台 LLM 承重墙，volces 线走 `llm-pi-ai`，`dsh-profile.js:284`）、otel 剪枝（`session-telemetry-otel` 插件行启用）、anthropic/google 子剪、`dsh-api-session-controller` 探索（unify 落地后独立 explore）。
