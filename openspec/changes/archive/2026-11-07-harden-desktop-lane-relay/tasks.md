# Tasks — harden-desktop-lane-relay

## 1. CI 发布班修复（release.yml）

- [x] 1.1 lane push 步骤凭据名改 `TCR_USERNAME/TCR_PASSWORD`（对齐 image.yml 命名）；tag 发布时缺凭据显式报错 exit 1（fail-loud），非 tag 触发保持跳过。验证：yml 解析通过（node yaml.parse）；attempt-2 重跑实证旧名下凭据恒空走 fail-open 路径、改名后 `Login Succeeded`（run 42316882577 日志）。
- [x] 1.2 lane OCI build 改隔离临时 context（mktemp 装 dist 副本 + Dockerfile.lane），脱离仓根 `.dockerignore` 影响。验证：attempt-2 重跑实证仓根 context `COPY dist/` 必炸（"/dist": not found）；隔离 context 后演练 run COPY 成功（run 42316882577）。
- [x] 1.3 push 后加 `docker manifest inspect`（带凭据）复验 `:current` 存在，失败即 job 失败。验证：演练 run 日志 `##[notice]lane image pushed and verified: hkccr...:current`（00:25:23Z）。
- [x] 1.4 test-tag 全链演练：tag `v1.3.29-test`（池侧分支 desktop-release/lane-drill = v1.3.28 + 本修复 + version bump）触发 run 42316882577，眼见 `lane image pushed and verified` + cheap3 `SYNCED`（lane→1.3.29-test，sha512 全量过）→ 演练毕 lane 回滚 1.3.28、test release/tag/分支全删。验证：`LANE-CHECK OK lane=1.3.29-test relay=1.3.29-test`（desktop-lane-check.log 08:56:30）；lane 现 latest.yml version: 1.3.28。

## 2. cheap3 分发面（desktop-lane-sync.sh + 对账探针）

- [x] 2.1 `desktop-lane-sync.sh`：`SKIP pull failed` 连续 ≥3 次升级为 `LANE-STALE FAIL`（exit 1）；配置性跳过（无 env）保持 SKIP。验证：计数器置 2 手跑 → `LANE-STALE FAIL pull failed x3 ... exit 1`（desktop-lane-sync.log 08:09:28）。
- [x] 2.2 新增 `desktop-lane-check.sh` 每日对账（lane latest.yml 版本 vs hkccr :current 内 yml 版本，不一致 exit 1，日志带 `LANE-CHECK` 标记）。验证：relay 无图期如实 FAIL（08:09:38 relay unpullable）；演练后 OK lane=relay=1.3.29-test；lane 回滚后如实 FAIL 报漂移（09:19:16）——三态全实证。
- [x] 2.3 `desktop-lane-sync.sh` 头注补资产名契约（yml `url` 为准；release 资产名点分隔≠原件名，OCI 路带原名不受影响）。验证：文件头注可见。
- [x] 2.4 部署两脚本到 cheap3 `/usr/local/bin/` + cron（探针每日 07:17）；确认 `/var/log` 落痕。验证：crontab -l 可见两行；sync/check 日志各有落痕。
- [x] 2.5（演练抓出的第四雷）sync 校验正则 `- url: (\S+)` 对带空格文件名（1.3.28 起 `Platform Setup x.exe`）首空格截断 → 0 匹配 → "yml has no file entries" FAIL——relay 就算修好也分发不出去。改 `(.*?)` 懒捕获 + PUT key URL 编码（urllib.parse.quote）。验证：修复后 SYNCED lane→1.3.29-test，5 件全 200，exe round-trip sha512 一致。

## 3. 文档与收尾

- [x] 3.1 RELEASE_CHECKLIST.md 增「池迁移」段：换池必配 `TCR_USERNAME/TCR_PASSWORD`；workflow 面四件对齐清单；lane 落盘名以 yml 为准。验证：段落可见且与 release.yml 现状一致。
- [x] 3.2 池仓 workflow 面带上 1.1–1.3 修复：演练分支 desktop-release/lane-drill 已带（release.yml 与 paas 工作树同文件）；下次正式出片按 RELEASE_CHECKLIST 同步。验证：run 42316882577 即用修复版 workflow 全绿。
- [x] 3.3 CI 路真通后收尾：删除 testaction001 的临时别名 secrets（TCR_USER/TCR_PASS，gh secret list 仅余 TCR_USERNAME/TCR_PASSWORD）；删除 hkccr `:push-probe` 探针 tag（v2 API DELETE 202 + 复验 404）；删除 v1.3.29-test release/tag/演练分支。
- [x] 3.4 LANE-STALE 消费面落定：exit code + `LANE-CHECK`/`LANE-STALE` 显式标记 + RELEASE_CHECKLIST 体检命令（`tail -5 /var/log/desktop-lane-check.log`）；推送式告警总线本环境不存在，留待有告警面时接入（design.md Open Questions 已记）。

## 验收（真机闭环）

- [x] 4.1 windows-admin（100.64.0.5）真机验收：①1.3.19 装机实证**无 updater**（asar/electron 产物零 updater 字符串——1.3.19 早于本功能，老客户端只能手动升，如实记）②手动 /S 升 1.3.28（exit 0）③boot 查新=up-to-date（lane 1.3.28）④lane 上 test 版后 boot 查新→downloading→downloaded→装机→复启 runningVersion=1.3.29-test 且 up-to-date。完整生命周期五态全真证（state mirror 实录）。
- [x] 4.2 如实偏离记录：退出安装钩子未真触发（验收用 WMI Terminate 硬杀——Electron 无窗口进程 CloseMainWindow 不达 quit 路径），安装一步以 electron-updater 的 pending 缓存安装器 /S 执行（同一二进制、同一静默参数，quitAndInstall 的内部路径）；「优雅退出自动安装」的真钩子待有 GUI 交互的真人退出时自然发生（autoInstallOnAppQuit 为 electron-updater 默认，机制在）。
