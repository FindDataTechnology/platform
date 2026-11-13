# revive-nonweb-ci — 设计

## Context

见 proposal.md · Why。约束事实（2026 年 10 月现场实测）：

- **账单算术**：GitHub Free 私有仓 2000 分钟/月；macOS runner ×10、Windows ×2、ubuntu ×1。app-e2e 每晚 iOS 档一次 ~20 实分钟 = 200 计费分钟/夜 ≈ 6000/月，单条腿结构性烧穿预算——这就是 10 月中额度耗尽（2011/2000）的第一嫌疑。
- **额度耗尽形态**：run 3 秒即终、注解 `recent account payments have failed`，作业根本不会调度（不扣分钟，但零验证）。
- **已验证的备用通道**（台账 §12.3，v1.3.18 当日全绿 4/4）：干净快照（gitleaks 零泄漏）→ 推 `testaction003/build-pool` 侧分支（`.github` 只留所需 workflow，池主支零扰动）→ tag 触发矩阵 → 产物走 dl-publish 镜像轨落 cheap3 → 官网上架，sha256 逐项核验。
- **池仓陷阱已录**：`workflow_dispatch` 只认默认分支上的 workflow——侧分支快照里要跑的手动 workflow 必须留在池 main；CN 网络大文件搬运一律走镜像轨，SSH/rsync 直连全废。
- 端与核心共享：桌面（Electron，内嵌 server.js）、移动 app（Expo，依赖 `@platform/core`）、miniapp（Taro，同样依赖 `@platform/core`）。core 每日多变，双端本地 typecheck 今日（10-27）实测全绿。
- ubuntu 26 label 迁移预告（GitHub 注解 10-19 起）是背景噪音，不改变分工。

## Goals / Non-Goals

**Goals:**

- 私有仓 CI 在 2000 分钟/月预算内长期可持续，且覆盖三端门禁（web 六门既有 + app lint/typecheck/unit + miniapp typecheck/markdown）。
- macOS/Windows 重腿永不再依赖私库月度额度：公开池快照通道从人工急救 recipe 固化为制度（脚本 + 清单 + 命名约定）。
- 额度护栏成文，防同一死法复发。

**Non-Goals:**

- 不出桌面 v1.3.19 安装包、不改 `add-mobile-app` 的功能任务（2.3/4.2）——分别是线 A、线 C，本 change 只修通道。
- 不建制 miniapp 的微信上传/预览管线（无 CI 上传先例，留观察项）。
- 不引入自托管 runner（运维成本与理由见 Decisions D2）。
- 不动 `add-cell-lifecycle` 任何在途件。

## Decisions

### D1 分工模型：私仓 = ubuntu 经济门；池 = 一切 macOS/Windows 定时与重腿

私仓保留并扩 ubuntu 门（每次 PR/push 全量六门 + 受 paths 过滤约束的 app/miniapp 门）；mac/win 重腿只能通过池通道跑。

- 替代 A「等 11-01 额度重置、维持原状」——否决：iOS 每晚档 ×10 计费每月必穿，重置后同一死法复发。
- 替代 B「付费升级 GitHub Team/加分钟包」——否决：公开仓标准 runner 免费无限是既有纪律（AGENTS.md），能公开就公开；付费是为纪律破例。
- 替代 C「删了 app-e2e/重腿算了」——否决：移动端 Maestro 与 win-smoke 有真实拦截记录（win-smoke 曾逮住 47600 拒连相），宁可迁不可删。

### D2 重腿落点 = 公开池 `testaction003/build-pool` 侧分支，不做自托管 runner

沿用台账 §12.3 已走通的轨道：侧分支命名 `desktop-release/<ver>`（桌面包）与 `nonweb-e2e/<date>`（Maestro/win-smoke 按需）。自托管 runner 替代方案否决：要养活 mac/win 两台常驻机、钥匙串/证书/清理全自理，运维面比收益大。

### D3 快照建制化三件套

把 10-21 的人工 recipe 固化：

1. **快照脚本**（`scripts/nonweb-snapshot.mjs` 或并入既有 fd-build-snapshot 族）：导出干净树 → gitleaks 扫（零泄漏才可推）→ 修剪 `.github/workflows/` 只留当次所需（release+win-smoke 或 app-e2e 双腿）→ 推池侧分支。
2. **泄漏清单**（同脚本内置或 docs）：gitleaks 必须零报；`.env*`、`cell-data/`、`data/`、`uploads/`、`agents.json`、`mcp.json`、本地凭据类文件永不入快照。
3. **台账登记**：每次池通道运行把 run URL + 产物 sha256 记入 `docs/registry-maintenance.md`（spec 场景「桌面版本出包」的验证点）。

### D4 私仓 app 门禁 = lint + typecheck + unit，不进 APK/模拟器

app-e2e 现四条腿拆法：「app lint→typecheck→unit」与「android APK」为 ubuntu 档，留在私仓但只随 `app/**`、`packages/core/**` 变更触发（paths 过滤已有）；「Maestro iOS nightly」（mac ×10）**删 cron**，「Maestro android 模拟器」（ubuntu 但重，~45min quota）评估后迁池或降级为手动 dispatch——默认迁池，实施时按实测分钟数最终定。

- 保留 APK 腿在私仓的理由：ubuntu ×1、是它把「装得上」这个事实钉在每次 core 变更上；若实测烧钱再迁，护栏（D5）兜住。

### D5 额度护栏

私仓任一 workflow 出现非 ubuntu `runs-on`，合并时必须附台账条目（预估月计费分钟 + 评审签认）——spec 已立场景「私有仓 workflow 评审」；落地检查是人审 + 台账，不做 CI 静态扫描（成本/收益不划算）。

### D6 miniapp 门禁范围 = typecheck + markdown 单测

不挂 `taro build:weapp`：构建产物大、依赖多端编译、无 CI 上传消费方，挂了只涨分钟不涨拦截力；真出 typecheck 捕捉不到的问题（如 babel 配置）时回头再加。

## Risks / Trade-offs

- [快照泄漏到公开池] → D3 三件套：gitleaks 零报硬门 + 永不入快照清单 + 推前人审文件列表；§12.3 已按此标准走通一次。
- [池侧分支长期不更新与主仓漂移] → 台账登记每次池 run 的快照 sha；超过 30 天未用先在台账「观察」栏记一笔再跑。
- [私仓 ubuntu 六门本身也烧分钟（web build+e2e fast ~10-25 分/次）] → 监控：月半用 `fd-build-channel` 看余额（24h 缓存 ~2s），过半即评；不预先做路径过滤以免误伤既有拦截力。
- [app-e2e 去 cron 后回归窗口变长] → Maestro 改手动/池侧后，在 add-mobile-app 收口（线 C）时至少各跑一次双腿作为复活基线。
- [ubuntu-latest → Ubuntu 26 迁移期偶发] → 不改 pin 策略，遇到再议（现状注解只是预告）。

## Migration Plan

1. 私仓 workflow 手术：app-e2e 去 cron、重腿改手动/注记迁池；ci.yml（或既有 app-build.yml）并入 app/miniapp 门禁。
2. D3 三件套落地（脚本+清单+台账首条登记）。
3. 用池通道跑一次 win-smoke + Maestro 双腿（顺手给线 A 的 v1.3.19 出包探路）。
4. 全绿后 `openspec validate`、归档；台账补通道制度一节。
5. 回滚：workflow 改动均为可 git revert 的单文件；池侧不动私仓即可。

## Open Questions（收口实录 2026-10-27）

- ~~android APK 腿与 Maestro 档的实测分钟数~~ **已定案**：全腿实测 80-170 分钟/次，paths 触发接 `packages/core/**` 日频变更=与 iOS cron 并列的出血口。裁剪=APK/Maestro 双腿在私仓全部降为 workflow_dispatch 手动挂载（ubuntu 经济门只留 gates 三棒）；重腿池侧排程作为挂账观察项（不再需要时自然死亡）。
- miniapp 接微信 CI 上传管线（mp 上传 key 管理）——维持观察项，本 change 不做。
