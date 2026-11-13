# Tasks: desktop-catch-up-release

## 0. 前置纪律

- [x] 0.1 额度判决（2026-10-21 10:56）：私有池合计剩 9360 min（4.7 池），但**本仓 fd-craw-private=PRIVATE，release 矩阵计费走所属账号 FindDataTechnology=2011/2000 已耗尽**→ GHA 干跑当下会被额度闸秒拒。**改道**：打包件确证改走本机 arm64 本地 dist（仓库既有调试先例，零额度）；GHA 矩阵留到月初重置（2026-11-01）随正式 tag 一次跑

## 1. 打包缺口修复 + 建制化断言

- [x] 1.1 落地：files 清单的运行时目录块改为从 RUNTIME_DIRS 生成（`...RUNTIME_DIRS.map(d => \`${d}/**\`)`），agent-runner 随块入列——单源后此缺口类不可再漏
- [x] 1.2 `scripts/lib/runtime-dirs.mjs` 单一真源（RUNTIME_DIRS 9 目录 + PACKED_ELSEWHERE_DIRS 4 目录）+ descriptorSpawnRefs 静态扫描 + verify-bundle 新门；真实 descriptors 三引用（server.js/agent-runner/node_modules dsh bin）全过；开发树全量 verify-bundle exit 0
- [x] 1.3 `scripts/test-runtime-dirs.mjs` 5/5：未知目录红（neither…nor）/ 引用目录缺盘红 / RUNTIME_DIRS 条目缺盘红 / 真实仓布局绿 / files 接线（RUNTIME_DIRS.map）钉死防单源烂掉

## 2. 干跑确证

- [x] 2.1 改道完成（0.1 判决后）：GHA 干跑被 FDT 池耗尽所阻，**本机 arm64 `npm run dist` 替代**（npmmirror 双镜像 env 绕 electron 辅助件下载墙）——产出 dist/Platform-1.3.17-arm64.dmg + .app，全程 verify-bundle 门在环（还拒了一次我自己的 bots 误报，证明门行为正确）
- [x] 2.2 **自动化证据已全绿**（2026-10-21）：①打包版 server 无头 7s READY（SPA/skills/update-preview/mp 端点全通零错）；②win-install-smoke 三相（装机链/后端 ready 200/Windows 窗口自检渲染 exit 0，run 39542514305）；③**官方 1.3.18 dmg（sha256 与发布 digest 一致）在本机既有数据目录上真升级装**——GUI 自检 exit 0、did-finish-load、100% 像素着色、旧 4 会话保留、桌面专属导航眼见（Apps 应用中心 + Wanxing Fleet 舰队页=IS_DESKTOP 门正确）、Connected 状态在位。**移交日常验证项**（需用户活凭据/生产配对，非装机缺陷面）：舰队配对真启动（涉生产 seat 状态）、并发切窗流式、语音 ASR 实录
- [x] 2.3 **坐实且多抓一例**：① agent-runner 缺口坐实（v1.3.13 files 清单无此目录，静态证据链）+ 修复实证（.app 树 agent-runner/index.js 在位）；② **第四例同类病**：server/layout.js 运行时 import `packages/core/src/lib/recipes.ts` 而 files 清单从无 `packages/**`（角色线 10-17 后带入，1.3.18 不修即装机炸）——本地冒烟首启动即捕获已修（RUNTIME_DIRS +packages，commit 5dd1b1c5）。desktop-fleet spec delta：无需（打包类根因，D5 判据不触发）

## 3. 补版发布

- [x] 3.1 bump 1.3.18（`105a7c41`）+ 干净快照（gitleaks 零泄漏）推 `testaction003/build-pool` 侧分支 + tag `v1.3.18`（**备用仓通道**：FDT 池耗尽，用户拍板走备用池；tag 触发 release 矩阵 **4/4 绿** run 39541416123，arm64 319MB/x64 327MB/exe 240MB，pool main 与 image 机器零扰动）
- [x] 3.2 win-install-smoke run 39542514305 三相全绿，`smoke:` 真证据行在案（**#85** Phase B `/api/ready` 200、**#53** Phase C 窗口渲染自检 exit 0）——dispatch 需 workflow 在默认分支的坑：已配套把 win-smoke 放池 main（dispatch-only 零触发面）
- [x] 3.3 release-sync 数据 c64cc41 双端推；资产落盘走 **dl-publish 镜像轨**（本机/cheap3 拉 GitHub 均 ~20KB/s、runner→cheap3 ssh 不可达——keyscan 60s 实锤；改池仓 dispatch 打 scratch 镜像推 `hkccr/yizuo/desktop-installers:1.3.18`，cheap3 docker pull+cp 落 `/srv/dl/platform/1.3.18/`）；**三产物 sha256 与 GitHub asset 逐一相等**；prune 1.3.12 留 1.3.13/1.3.18；dl 直链三 200 content-length 精确
- [x] 3.4 台账 §12.3 全链记录（06546d55）；升级文案=官网下载带沿用（无 autoUpdater 手动重装语义已在既位文案；记录在案）
- [x] 3.5 validate 绿；归档待 2.2 人工走查完成后执行（release-pipeline ADDED 需求届时随归档同步主 spec）
