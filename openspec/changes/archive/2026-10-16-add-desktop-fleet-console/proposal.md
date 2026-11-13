# Proposal: add-desktop-fleet-console

## Why

切片①（add-desktop-fleet-runner）让桌面成为一个萬星 runner 机位，但没有眼睛和
驻留：用户看不到本机 agents 的状态，关窗即全停（定时任务随 app 死）。本切片交付
桌面舰队页与托盘驻留，完成 grill Q5/Q7 定案的桌面「主要执行平台」体验闭环。

## What Changes

- 桌面 web 新增舰队页（`/fleet`）：本机 runner 直读区（agents 五态/版本/端口/
  budget 足迹）+ 市场目录区（公网 registry 只读目录，部署按钮标注「待设备面
  （切片③）解锁」）。数据经 cell server 代理端点，不新增桌面凭据。
- cell server 新增 `/api/wanxing/fleet/live`（透传本机 runner `/health`）与
  `/api/wanxing/fleet/catalog`（代理公网 registry 目录）——标准 cell 鉴权，
  runner 未运行/registry 未配置时如实降级（503 + 状态文案），不是错误。
- 托盘驻留：关闭窗口=最小化到托盘（agents 继续跑，含定时）；托盘菜单「显示/
  退出」，退出=supervisor 有序停机（drain 全部 children）。
- 范围调整（回写底稿）：「部署到本机」的动作链挪切片③——部署动作的正确通道是
  console 部署目标选本机机位，而本机机位对 console 可见=③的设备管理面；②若硬
  做部署需把服务间内部凭据（x-facet-token）下发到桌面，持有者可伪造任意转发
  身份，不可接受。

## Capabilities

### New Capabilities
- `desktop-fleet-console`: 桌面舰队页的读面（live/catalog 代理+降级态）与托盘
  驻留生命周期。

### Modified Capabilities

（无——`desktop-fleet-runner` 的主 spec 尚未随切片①归档落册；托盘驻留的「关窗
≠会话结束」语义全部收进本 change 的新 capability，两 spec 归档后互补不冲突。）
