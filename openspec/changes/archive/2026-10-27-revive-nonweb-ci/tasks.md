# revive-nonweb-ci — 实施任务

> 实施前提：退出 explore 模式后按其 apply。提交纪律：只 add 本 change 文件（树上有并行在途）。台账=docs/registry-maintenance.md。

## 1 · 私仓 workflow 手术（ubuntu 经济门）

- [x] 1.1 `app-e2e.yml` 去定时档：已删 `schedule: cron "0 3 * * *"`；Maestro iOS 档保留 job 定义但仅 `workflow_dispatch` 可触（名改 manual dispatch）；~~Maestro android 档维持 ubuntu 私仓 paths 触发~~→**2.3 实测后改判：APK/Maestro 双腿一并降为手动挂载**（80-170 分钟/全腿的出血口实证）。验证：yaml.safe_load 过、schedule 段已从文件消失（推送后 gh api 眼见归档）
- [x] 1.2 app 门禁三棒齐备：原 app-e2e `gates` job 有名无实（缺 lint 步）——已补 `npx biome check app/ packages/core/` 步于 typecheck 前；三棒本机全绿（biome 41 件净 / typecheck 绿 / unit 14/14）。路径过滤 `app/**|packages/core/**` 原有。验证：本机命令全绿 + yaml 合法
- [x] 1.3 miniapp 门禁接入：新建 `.github/workflows/miniapp-ci.yml`（ubuntu 小门：biome→typecheck→markdown，paths=`miniapp/**|packages/core/**`；不挂 weapp build，design D6）。本机三棒全绿（biome 71 件净 / typecheck 绿 / markdown 10/10）+ yaml 合法
- [x] 1.4 `release.yml`/`win-install-smoke.yml` 头注运行位置=公开池侧分支通道已写（行为与触发模型不动）。验证：两文件头注含池通道指路 + yaml 合法（台账「非 web 端通道」一节随 2.4 落地后指针即通）

## 2 · 池通道建制化（三件套）

- [x] 2.1 快照脚本落地：既有 `fd-build-snapshot --keep-workflows --branch desktop-release/<ver>` 当选（线 A 三班实测全通）；手序与修剪律成文入台账「非 web 端通道」节；gitleaks 对发布 commit 零报（线 A 实证）
- [x] 2.2 泄漏清单成文：永不入快照名单+快照=origin 干净 clone 天然只含 tracked 件+gitleaks 硬门，全入台账「非 web 端通道」节（`agents.json`/`mcp.json` 为 tracked 发布资产属池仓既有内容，非本次私仓快照面——名单按「增量风险」口径落地）
- [x] 2.3 池通道实跑收口：线 A 实战即实证（`desktop-release/v1.3.19` 三班矩阵+win-smoke+dl-publish 全绿，实测分钟=桌面全套 139/次）；**Open Question 裁定=APK/Maestro 双腿在私仓仅留 workflow_dispatch 手动挂载**（实测 80-170 分钟/全腿×每日 core 触发=出血口，已落 `app-e2e.yml`）；Maestro 双腿的池侧排程留挂账（见下观察）
- [x] 2.4 台账立「非 web 端通道」建制节：分工模型表/快照纪律/实测分钟/判红延伸已立，与 §12.3（v1.3.18）§15.64（v1.3.19）两发实录互相指针

## 3 · 护栏与收口

- [x] 3.1 护栏登记：runs-on 全仓自查=12 ubuntu / 2 macos（app-build+app-e2e 各一，已一并降为 dispatch-only）/ 1 windows（win-smoke，dispatch-only）/ 1 matrix（release.yml，tag 触发、池通道实跑）——mac/win 存量档全部不吃私仓分钟，无新增非 ubuntu runs-on；自查结果随台账通道节入库
- [x] 3.2 AGENTS.md 补「非 web 端通道」条目（发布纪律段下）：私仓 ubuntu 经济门 / 重腿走池侧分支或手动 / 指针台账通道节——已对齐
- [x] 3.3 `openspec validate revive-nonweb-ci --strict` 零 error（2.x-3.x 提交前已跑）；`openspec validate --specs` 186/0 绿。验证：两命令输出已贴本会话
- [x] 3.4 归档预备确认：对照表 = ①非 web 端 ubuntu 门禁→app-build/app-e2e gates+miniapp-ci 三 workflow + 四棒本机绿；②重腿池通道→台账通道节+§12.3/§15.64 两发实录；③定时档护栏→cron 清零+dispatch-only 化四处+runs-on 审计表。随本提交说明入库，archive 走 standard 流程
