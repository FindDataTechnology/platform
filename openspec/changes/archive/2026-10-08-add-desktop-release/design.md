# add-desktop-release — Design

## Context

发布机器就绪未发过：electron-builder（mac arm64/x64 + win x64、asar:false、捆绑独立 Node）与公开仓 release.yml（v* tag → 三矩阵 → GitHub Release）都在，公开仓 0 releases。读取侧契约已定稿（fd-official-web `download-center` D2：`schema:1`、`releases` 新者在前、平台键闭集 `macos`/`windows`、每平台 `beta`+`official_url`+`github_url` 至少一源、读取侧忽略未知字段）。约束：TCR tag 删不回收配额（2026-10-06 事故）；官网发布 = gitee push → ArgoCD 镜像 roll；release.yml 资产名 = `Platform-<version>-{arm64,x64}.dmg` + `Platform Setup <version>.exe`。

## Goals / Non-Goals

**Goals:**
- v1.3.0 真首发：tag → 三矩阵首跑 → GitHub Release 三资产
- 国内可下的 dl.finddatatech.cloud（plain file，不进镜像线）
- release-sync 一条龙：Release 元数据 → 官网 snapshot 回写 → roll → rsync
- beta 纪律（win 无实机冒烟先 beta）+ 未签名绕过文档

**Non-Goals:**
- 代码签名/公证（secrets 缺席 = unsigned 成功，既有语义够用）
- Linux target、LLM key 首启 onboarding、寻数预置版构建（PRODUCT_NAME 机制现成，全部后置）
- 自动化 webhook 发布链（半自动一条龙定位）

## Decisions

**D1 — dl 载体 = cheap 机 Caddy 静态目录，目录 `/platform/<version>/<artifact>`。**
不进 k8s/TCR：300MB/版的镜像 tag 只堆积不回收。保留 ≥2 版，release-sync 带 prune 子命令清老版；盘余实施时核。DNS/TLS 沿现有域名接入路径（备案主体相同）。

**D2 — release-sync 单脚本四步，幂等可重跑。**
`scripts/release-sync.mjs <tag>`：① gh api 读 Release+资产 → ② 按 D3 映射成 snapshot（重跑收敛：同 tag 条目覆写不重复）→ ③ 写入 `FD_WEB_DIR` 指向的官网仓 `src/data/desktop-releases.json`、本地先过校验、commit+push gitee（ArgoCD 自动 roll）→ ④ rsync 三产物到 dl。任何一步失败停在明处，未过校验的 snapshot 不 commit。跑在开发机（有 gitee/gh/rsync 凭据），不进 CI。

**D3 — 资产→平台映射（mac 双 dmg 对单链接位的裁决）。**
release 产出两个 mac dmg 而 snapshot `macos` 只有一个链接位：`official_url` = dl 的 **arm64 dmg 直链**（Apple Silicon 是绝对主流），`github_url` = **该版 Release 页**（x64 用户在页面上自取 `-x64.dmg`，且 dl 同目录也同步 x64 文件可供直拼路径）；`filename` 记 arm64 主产物名。`windows` = exe 双直链。映射纯按资产名模式（release-pipeline 新增 requirement 锁契约）。

**D4 — beta 纪律落 snapshot 字段，转正 = snapshot 翻转 + roll。**
v1.3.0 首发：macos 本机冒烟过 → `beta:false`；windows 无实机 → `beta:true`。Windows 冒烟完成后 release-sync（或手动条目编辑）翻转。与 ② 的 beta 渲染语义（可见标记、不得称 stable）天然对接。

**D5 — v1.3.0 首跑即彩排，修复属本 change 验收范围。**
tag 打在**公开仓 main**上（快照管线独立谱系，非本地 tag 推送），首跑暴露的矩阵坑（win runner 路径、缓存命中、artifact 命名）修到三资产挂上 Release 为止；mac 冒烟过后才回写官网条目——首条目可 GitHub-only 过渡（② 已spec 该态），dl 直链后补即"promotion"语义。

**D6 — 签名不进本期。**
CSC/Apple/Win secrets 全缺席 = unsigned 成功（release-pipeline 既有 requirement）。绕过文档双落点：公开仓 README 章 + 官网下载带脚注（② 已spec 渲染侧）。

## Risks / Trade-offs

- [release.yml 首跑矩阵坑不可预知] → 彩排定位（D5）：dl/官网条目不挂直到全绿 + mac 冒烟；修复不算扩 scope（proposal 已声明）。
- [300MB×版本×保留的盘压] → 保留 ≥2 + prune；cheap 机盘余实施前核，不够就降保留数（policy 字段化）。
- [snapshot 与官网校验漂移] → 写前本地跑同规则校验（D2 步骤③）；跨仓 schema 变更 = 两侧同 PR 锁步（② tasks 5.x 已含回帖纪律）。
- [开发机依赖（gitee 凭据/ssh）] → 接受：半自动定位本就如此；换机重装成本 = 三个凭据，runbook 记。
- [x64 用户直达路径不显式] → 接受：Release 页可取 + dl 同目录可拼；官网 band 不加第三个链接位（读侧 schema 已闭）。

## Migration Plan

全新链路，无迁移。回滚：snapshot revert + re-roll；dl 目录可整删（GitHub Release 恒为真源，dl 只是镜像）。发布顺序建议：1 彩排（GitHub-only）→ 3 dl 平面 → 2 脚本全链 → 5 回写联动（含 dl 直链 promotion）。

## Open Questions

- cheap 机选哪台（盘余/带宽，实施时定）。
- v1.3.0 tag 锚点 = 公开仓当前 main（快照管线最近一次推送），实施时确认 main 即 v1.3.0 内容谱系。
