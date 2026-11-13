# add-desktop-release

## Why

桌面安装包的机器全部就绪而从未发布：electron-builder 配置（mac arm64/x64 + win x64、捆绑独立 Node、asar:false）与公开仓 release.yml（v* tag → 三矩阵 → GitHub Release）都在，但公开仓 0 releases、0 个 v* tag——整条发布链一次都没真实跑过。定位定案（2026-10-07 拷问）：桌面安装包 = 本地轨道的自含形态（不是云端客户端）；官网下载带（姊妹 change add-platform-product-page，fd-official-web 仓）等这条链产出真实链接。本 change 收官"tag → 构建 → 分发 → 官网回写"整链。

## What Changes

- 推 `v1.3.0` tag 至公开仓触发 release.yml 三矩阵，首次真实构建验证（首跑即彩排，暴露 win runner 差异 / 资源缓存 / artifact 上传等坑，修完才公开挂链），产物挂 GitHub Release
- 新子域 `dl.finddatatech.cloud`：cheap 机 Caddy 静态目录 + rsync 同步产物。刻意不走 k8s 镜像线——TCR tag 删不回收配额（2026-10-06 事故在册），300MB/版的镜像 tag 只会堆积；具体哪台 cheap 机实施时定
- 半自动一条龙发版脚本（`scripts/release-sync.mjs`）：输入 tag → 拉 GitHub Release 元数据 → 回写 fd-official-web 仓 desktop-releases snapshot JSON → 触发官网 roll → 产物 rsync 到 dl 目录。可重跑、步骤可见、失败停在明处
- **snapshot 契约已由读取侧定稿**（fd-official-web add-platform-product-page D2，跨仓锁步）：`src/data/desktop-releases.json`，`{schema:1, releases:[…]}` 新者在前、下载带只渲 `releases[0]`；条目 = `version`（semver）/`released_at`/`platforms.{macos|windows}`，平台键闭集，每平台 `beta` + `official_url`（可空）+ `github_url`，至少一源在；读取侧忽略未知字段（写侧可先行加字段不破站）、已知字段缺失或非法构建即炸——release-sync 产出必须过官网构建校验
- 未签名首发：mac Gatekeeper / win SmartScreen 绕过说明——官网下载带脚注为主（由 download-center 渲染），公开仓 README 链接为辅
- 验收纪律：mac 本机安装冒烟必做；Windows 暂无测试机 → 产物标 beta，完成实机冒烟后转正；任一平台未冒烟不在官网公开挂稳定链
- 明确不做：代码签名证书（Apple / Windows，后置）、Linux target、LLM key 首启 onboarding（另立 change 评估）、寻数预置版构建（PRODUCT_NAME 机制现成，后置）

## Capabilities

### New Capabilities

- `installer-distribution`: 安装包分发——dl 子域托管形状（目录布局 / 版本保留策略 / rsync 载体）、双源链接语义（官网直链为主源、GitHub Releases 为国际源）、release-sync 回写链（snapshot schema 与 fd-official-web 的 download-center 锁步）、beta 标记与转正条件、未签名绕过文档的位置与内容要求

### Modified Capabilities

- `release-pipeline`: 构建之外补发布语义——v* tag 触发真实 GitHub Release、产物同步至 dl、版本元数据回写官网 snapshot

## Impact

- **脚本**：paas 仓 `scripts/` 新增 release-sync（gh api 读 Release 元数据 + fd-official-web 仓 commit 回写 + ssh/rsync 推 dl 目录）
- **运维**：dl.finddatatech.cloud DNS + cheap 机 Caddy 站点 + 目录初始化；不进 k8s / GitOps
- **fd-official-web**：snapshot JSON 被回写后官网 roll——download-center 的数据生产侧在此，消费侧在彼
- **公开仓**：README 增下载章 + 未签名绕过说明；v1.3.0 tag 推送为一次性运维动作
- **风险**：release.yml 首跑的矩阵坑（win runner 路径差异、resources 缓存命中、artifact 命名）预期会暴露一批——修复属于本 change 的验收范围，不算扩scope
