# Design: add-desktop-in-app-update

## Context

已核事实：`package.json` 无 `electron-updater`、`dist` 用 `--publish never`；`electron/main.js`
零 updater 代码；桌面分发=私有手动安装（steward CI 打包+win-install-smoke/installer-e2e 烟测，
v1.3.27）。桌面端两平台（macOS/Windows）同批发布。

## D1 通道决策（拍板点，按推荐落）

- **v1 = generic provider + 自托管静态道**：贴现链路（私有分发面，不引公开 GitHub release）。
  静态道宿址随实施定（现有静态 serving 面择一挂载，`/desktop-releases/` 形态），CI steward 班
  出包同班发 `latest.yml`。
- GitHub release provider 备选留对外版（届时客户端通道 URL 可配，见 D3）。
- 备选被否：不引 updater 继续手动（升级摩擦已是立项动因）；自研差量更新（成本远超 electron-updater
  全量包，v1 不值）。

## D2 updater 接线

- `electron-updater`（NSIS target 的 autoUpdate）+ 主进程生命周期：启动后延迟查新（boot 就绪后，
  非阻塞）；`autoDownload=true` + `autoInstallOnAppQuit=true`（默认策略=退出时装）；
  手动入口=设置面「检查更新」按钮（走同一 updater 实例，`quitAndInstall` 仅显式用户动作触发）。
- 事件面：available/downloaded/error 三态进设置面（可见、可说明），error 静默留痕不弹窗（查新
  失败）而下载/校验失败如实提示。

## D3 通道可配

- 通道 URL 读桌面配置（桌面管家面已有 config 面）+ 内置默认值；无配置时用默认道。通道探测失败
  即 D2 的静默降级，不做通道切换 UI（v1 单道）。

## D4 macOS 签名边界

- 无签名/公证：macOS 构建不上自动安装路径（updater 对 unsigned mac 不可靠），只提示+给获取路径
  ——spec 的如实降级由此落地。签名就绪后同一开关翻转（环境/构建标志驱动，不改代码路径结构）。

## D5 CI 发布

- steward 打包班追加：出包 → 生成 latest.yml（electron-builder publish 配 generic dir 或脚本
  生成）→ 推静态道（追加语义，不回填）。win-install-smoke/installer-e2e 照旧不回归。

## D6 测试

- 单测：元数据生成（版本/哈希一致性）；客户端侧 updater 事件面 stub 测试（查新/下载/退出安装
  三态 + 失败降级）；通道不可达静默。
- 真机：Windows 一次端到端（v1.3.x → v1.3.x+1 退出安装眼见）；macOS 提示路径眼见。
