# Proposal: add-desktop-in-app-update

## Why

桌面客户端（Electron，现 v1.3.27）**没有应用内升级**：electron-builder `--publish never`，
`electron-updater` 不在依赖里，主进程无任何 autoUpdater 代码——每次滚版都要用户手动下载安装包
重装（steward/win-install-smoke CI 只管打包烟测与安装验证）。桌面端已经多版本在跑
（1.3.19→1.3.27），升级摩擦随版本间距线性增长，且旧客户端与新平台面漂移（新面不可见/行为差异）
全靠人肉升级解决。

## What Changes

- 引入 `electron-updater`：启动时静默查新（不阻塞启动）+ 设置面手动「检查更新」入口 +
  「下载后台进行，退出时安装」的默认策略（不打断使用中的会话）。
- 发布通道（**拍板点 D1**，推荐 generic 自托管静态道）：CI（steward 打包班）产出安装包 +
  `latest.yml` 元数据并发布到自托管静态道，updater 以 generic provider 指向该道；GitHub
  release provider 是对外版的备选，随对外分发决策另立。
- 版本与完整性：updater 的 latest.yml 哈希校验启用；Windows 签名现状与手动安装同级（不新增
  恶化），macOS 签名/公证**挂账**（无证书前 macOS 只提示不自动装——如实降级，不假装能更）。
- 多通道共存语义：内网自托管道与（未来的）对外道互不干扰；客户端内置通道 URL 可配置
  （桌面管家面），便于内外两版分道。

## Capabilities

### New Capabilities

- `desktop-app-update` — 桌面端应用内升级：查新/下载/退出安装的生命周期与发布道契约。
