# Design: desktop-catch-up-release

## Context

见 proposal.md（Why）。桌面安装包 = tag 触发（`release.yml:20-22`）三平台矩阵（mac arm64/x64 + win x64），分发走 installer-distribution 链（dl 主机 + 官网快照），无 autoUpdater。缺口证据链：`electron-builder.js:121-168` files 清单无 `agent-runner/**`，`supervisor/descriptors.js:110` spawn `agent-runner/index.js`；前两例同类病（10-07 `lib/`、v1.3.10 `services/`）均为装机后炸、清单注释自证；`verify-bundle.js` 现只断言 Node 二进制与 dsh 运行时。

## Goals / Non-Goals

Goals：补齐 v1.3.13 → HEAD 的 138 commit 桌面缺口（一次 v1.3.18 补版）；修 agent-runner 打包缺口并把「漏运行时目录」类病建制化为构建期断言；打包件冒烟确证舰队机位可启动。

Non-Goals：autoUpdater（另立 explore）；切片③设备管理面/部署按钮解锁；MP 提审眼见；桌面侧新功能；mac x64 专项验证（矩阵照建，冒烟只做 arm64 本机 + win-install-smoke）。

## Decisions

### D1 目录断言 = 显式清单为契约 + descriptor 静态扫描为门

- **显式清单**：`verify-bundle.js` 内维护 RUNTIME_DIRS 数组（`server/ lib/ services/ gateway/ agent-runner/ dsh-profile-template/ electron/ supervisor/ bootstrap/`——与 electron-builder files 清单一一对应），断言打包树内逐一在位。
- **descriptor 扫描**：静态解析 `supervisor/descriptors.js` 各条目的 `args` 中形如 `path.join(projectRoot, <dir>, …)` 的相对路径，解析出的目录必须存在于清单——新增 descriptor 引用未入库目录即红。
- 备选「import-graph 全量 walk（追踪 server.js 动态 import）」被否：动态 require/条件加载导致漏报误报双向风险，两道静态门已覆盖历史三例的病灶形态（descriptor 引用 + 目录缺位）。

### D2 干跑先行：workflow_dispatch artifact-only 一次，再 tag 发布

dispatch 构建不出 release、不触发分发链——一次矩阵成本确证「138 commit 后桌面仍能构建 + agent-runner 缺口坐实/证伪」，把 tag 发布（第二次矩阵成本）留到修复验证全绿之后。若 dispatch 矩阵因故只能全平台（现 workflow 无单平台开关），接受全矩阵成本，不临时改 matrix（改 workflow 本身要过 CI，得不偿失）。

### D3 版本策略：bump 1.3.18 直接 tag

1.3.17 的版本号对应角色体系（10-17），其后又有集群/舰队/闸等大件——跳号到 1.3.18 让版本号与出货内容一致，避免「v1.3.17 tag 内容≠1.3.17 已上产内容」的歧义。tag 即 release；release-sync 幂等（同版本重跑=原位替换）。

### D4 额度纪律：动手前 `fd-build-channel`，两次矩阵成本预算化

release 矩阵 = 2×macOS（×10）+1×Windows（×2），本刀要花**两次**（干跑 + 正式）。发布动作前先跑 `fd-build-channel` 查余额；余额不足则干跑延后，不裸奔。

### D5 条件性 spec 修订的判据（fleet 两 spec）

冒烟清单里「舰队配对真启动」为判据位：若打包件配对成功、机位 spawn、回合可跑——零额外 delta；若仍失败且根因是行为差异（非打包）——才追加 `desktop-fleet-runner` delta（候选位：D6 registry 缺失退出循环、热启停「重启应用生效」措辞）。D1 断言落地后，打包类根因在构建期已被拦。

### D6 冒烟清单（打包件、mac arm64 本机）

① 首启/升级路径（旧 v1.3.13 目录升级装）② 舰队：Preferences 配对 → 机位 spawn → 健康面 ③ 并发会话切窗不断流 ④ 应用中心网格 ⑤ 连接中心分节 ⑥ 语音 ASR 一轮 ⑦ 集群页可开 ⑧ 云目录 last-good（断网/抖动下冷启动）。每项留证据（截图/日志行），失败即停，按 D5 分诊。

## Risks / Trade-offs

- **agent-runner 缺口若被证伪**（存在隐藏包含路径）：干跑白花一次矩阵成本——但干跑同时承担「138 commit 可构建」确证，成本不空转。
- **138 commit 里藏桌面不兼容**（构建红/运行崩）：干跑正是为此存在；win 侧由 tag 后 win-install-smoke 把门（看日志 `smoke:` 行真证据，不认 run 绿）。
- **无 autoUpdater**：用户升级靠手动重装，发布文案要说清升级路径（dl 主机直链）；这是已知产品缺口，本刀不解决。
- **mac x64**：Rosetta 构建照跑但不冒烟——历史出货同姿势，不新增风险。

## Open Questions

（无——autoUpdater 与切片③均已在 proposal 显式排除，不阻塞本设计。）
