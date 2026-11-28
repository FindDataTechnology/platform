# 壹座 Linux 桌面客户端（AppImage）

Linux 版以**单文件 AppImage（x64）**发行：免 root、免包管理器、可自更新。

## 安装与运行

```bash
chmod +x Platform-1.3.28-x64.AppImage
./Platform-1.3.28-x64.AppImage
```

首次运行会在 `~/.config/platform`（数据）与 Electron 的 userData 目录落配置，
与 macOS / Windows 的语义一致（`PLATFORM_DATA_DIR` 可覆盖）。

### 缺少 FUSE 2 时

AppImage 默认用 FUSE 挂载自身。部分发行版（或容器/精简系统）没有 FUSE 2，
直接运行会以一句 cryptic 的 mount 错误退出。改用解包运行：

```bash
./Platform-1.3.28-x64.AppImage --appimage-extract-and-run
```

这条路径同样可正常使用全部功能，但**不会自动更新**（见下）。

## 更新

- **以 AppImage 形态运行**：启动后自动静默查新，后台差分下载，退出时原子替换自身（替换失败保留旧版本）。
- **以解包方式运行**（`--appimage-extract-and-run`）：只提示有新版本并给出下载地址，不会自动替换——因为没有可替换的 AppImage 文件。

检查入口：设置 → 关于/更新。「检查更新」按钮就在那里。

## 常驻（重要）

**Linux 暂不支持常驻管家。** 关闭窗口后，本机的定时任务与舰队不会继续运行。

原因是 AppImage 每次启动都挂载到新的临时目录，写进系统的自启单元在下次登录时已指向
不存在的路径——那会变成一个永远修不好的假成功。真正的常驻需要先把运行时复制到稳定目录
（如 `~/.local/share/platform`）再注册 systemd user unit，是独立的一块工作。

设置页会明确显示这条限制，而不是给一个点了必然失败的「安装常驻」按钮。

## 支持范围

- 已声明支持：Ubuntu 22.04+ / Debian 12+ 的 **x64 桌面**。
- 其他 x64 发行版（含国产化系统）尽力而为，未逐一验证。
- ARM64 暂无产物。

## 卸载

AppImage 免安装：删除该文件即可。若要一并清掉个人数据：

```bash
rm -rf ~/.config/platform ~/.config/Platform
```
