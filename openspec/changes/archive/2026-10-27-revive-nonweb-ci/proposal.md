# revive-nonweb-ci — 非 web 端验证与出包通道复活

## Why

非 web 三端（桌面 Electron、移动 app Expo、微信 miniapp）自 2026-10-12 起处于零验证状态：本私有仓（fd-craw-private）全部 GitHub Actions 运行秒挂，注解实锤额度耗尽（GitHub Free 私有 2000 分钟/月，实测已耗 2011）。病灶是结构性的——macOS 档按 ×10 计费，app-e2e 每晚 200 分钟计费的 iOS 定时档单是它就每月烧穿预算，故重置额度治标不治本。同期桌面源码仍在高速演进（今日刚进 steward 常驻化，客户 deadline 交付），三端共享的 `@platform/core` 每天都在变，而 miniapp 从未有任何门禁。端上代码暂未漂（2026-10-27 本地 typecheck 双绿），断的是验证与出包——正是建制窗口。

## What Changes

- **私有仓 CI 重定义为「ubuntu 经济门」**：现有六门（lint/typecheck/unit/locales/web build/e2e fast）保留不动；新增移动 app 的 lint→typecheck→unit 门禁与 miniapp 的 typecheck→markdown 单测门禁（全部 ubuntu、低分钟成本）。
- **私有仓移除全部 macOS/Windows 定时与触发式重腿**：app-e2e 每晚 03:00 iOS 定时档取消（mac ×10，结构性不可负担）；release 矩阵与 win-install-smoke 在本私有仓不再以月度额度运行。
- **macOS/Windows 重腿建制化到公开池通道**：把台账 §12.3 v1.3.18 备用仓 recipe（gitleaks 零泄漏快照 → `testaction003/build-pool` 侧分支 → tag 触发矩阵 → dl-publish 镜像轨上架）从「每次人工救急」固化为制度：固定快照修剪规则（仅留所需 workflow）、泄漏检查清单、侧分支命名约定、台账登记。
- **额度护栏**：私有仓任何新增非 ubuntu `runs-on` 档必须台账登记成本并过评审；月初重置后不再恢复任何 macOS 定时档。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ci-pipeline`: 新增三类需求——非 web 客户端门禁纳入 CI（移动 app 与 miniapp 的 ubuntu 经济门）；运行通道分工（私有仓仅 ubuntu 档、macOS/Windows 重腿走公开池快照通道）；定时档预算护栏（月度额度约束下的定时档准入）。现有六门需求不变。

## Impact

- **Workflow**：`.github/workflows/ci.yml`（+ app/miniapp 门禁）、`.github/workflows/app-e2e.yml`（去定时档、重腿改手动/迁池）、`.github/workflows/app-build.yml`（保留 ubuntu 门、核对路径过滤）、`.github/workflows/release.yml`（触发模型不变，运行位置文档化为公开池侧分支）、`.github/workflows/win-install-smoke.yml`（保持 workflow_dispatch only，迁池复用）。
- **新文件**：公开池快照脚本/清单（快照修剪规则 + gitleaks 检查项，落 `scripts/` 或 `docs/`）。
- **文档**：`docs/registry-maintenance.md` 台账登记通道制度；`AGENTS.md` 判路入口补充非 web 端通道一句。
- **依赖**：无新运行时依赖；`testaction003/build-pool` 复用现有池。
- **不触碰**：`add-cell-lifecycle`（另一棒在途）、`add-mobile-app` 余下功能任务（另线收口，本 change 只修它的验证通道）。
