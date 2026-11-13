# Proposal: add-desktop-fleet-runner

## Why

萬星核心能力（编排/管理上百 agents）目前只存在于云端部署。用户 2026-10-15 拍板：
桌面版是相当多客户的主要执行平台，萬星必须以**可选插件**形态落到桌面——装的是
运行能力不是内容，还要能经协议与外部萬星实例交流。调研
（`docs/wanxing-desktop-fleet-plugin-explore.md`）与 grill 十问已收口：agent-runner
全量代码已随桌面发行树分发，只差接线。本 change 是四切片的**切片①：本地舰队宿主**。

## What Changes

- 桌面 Supervisor 新增 `agent-runner-js` 服务描述符：预装、默认禁用、optional 优雅
  降级；启用后桌面 app 内运行一个萬星 runner 机位。
- 桌面机位身份：首次启用时生成并持久化独占 runner id；默认分片 id 与机位 id 显式
  分离——桌面只拉显式 tagged 给它的部署条目，云端 untagged 条目永不上桌面。
- 桌面机位对云端调度隐形：不登记 agent_runners 机群表、不上报 fleet board，重派
  循环永不看到桌面机位（关 app ≠ 机位死亡，sticky 语义的①实现）。
- 监听收紧：runner ops 端口与 agent A2A 端口支持 host 绑定配置，桌面全 127.0.0.1
  （云端默认 0.0.0.0 字节级零变化）。
- Preferences 新增「萬星舰队」设置区：插件开关 + registry URL/token；保存写
  settings.json，重启应用生效。
- 驻留密度：桌面默认 pod 模式（同 pack agents 共宿）。
- 生命周期 v1=跟随 app：退出=有序 drain 全部 children；崩溃=supervisor 退避重启。

不在本片（后续切片）：舰队 UI 页与内嵌市场页（②）、远程监控上行与设备管理（③）、
信箱协议（④）、托盘驻留（②）。

## Capabilities

### New Capabilities
- `desktop-fleet-runner`: 桌面萬星插件的运行语义——预装禁用、机位身份独占、对云端
  调度隐形、监听收紧、生命周期跟随、pod 密度默认。

### Modified Capabilities
- `desktop-supervisor`: 服务描述符注册表支持条件禁用的插件描述符（enabled 由注入
  env 决定，禁用即跳过启动；optional 失败降级不挡主应用）。
- `preferences-ui`: 可编辑设置面新增萬星舰队设置区（开关+registry 配置，重启生效）。
