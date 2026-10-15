# desktop-fleet-console Specification

## Purpose
TBD - created by archiving change add-desktop-fleet-console. Update Purpose after archive.

## Requirements

### Requirement: 舰队页读面经 cell 代理

桌面 web 的舰队页 SHALL 经 cell server 的代理端点读取本机 runner 与公网目录，
不新增桌面侧凭据、不直接跨域调用：`GET /api/wanxing/fleet/live` 透传本机 runner
的 `/health`（runner 地址来自配置，默认本机 ops 端口），`GET
/api/wanxing/fleet/catalog` 以既有 registry 凭据代理公网 registry 的 a2a 目录。
两端点 SHALL 走标准 cell 鉴权。

#### Scenario: runner 运行时舰队页有数据

- **WHEN** 舰队页加载且本机 runner 健康
- **THEN** live 端点返回 runner 的 agents 五态、children 数与 budget 足迹

#### Scenario: runner 未运行如实降级

- **WHEN** 艦队插件未启用或 runner 进程不在
- **THEN** live 端点返回 503 与可展示的状态文案，页面呈现「未启用/未运行」引导态而非错误弹窗

#### Scenario: registry 未配置时目录降级

- **WHEN** 未配置 AGENT_SERVING_REGISTRY_URL
- **THEN** catalog 端点返回 503 与「未配置 registry」文案，舰队页目录区显示引导而非空白

#### Scenario: 目录只读不含部署动作

- **WHEN** 舰队页目录区渲染
- **THEN** 部署入口呈禁用态并标注「待设备管理面（切片③）解锁」，不发起任何写请求

### Requirement: 托盘驻留生命周期

关闭主窗口 SHALL 最小化应用到系统托盘而非退出：runner 与其 agents 继续运行
（含已排定的定时任务）。托盘 SHALL 提供「显示」与「退出」动作；「退出」执行
supervisor 有序停机（drain 全部 runtime children）后真正退出。未启用插件的
安装同样适用驻留（对话 cell 的定时任务同理受益）。

#### Scenario: 关窗驻留

- **WHEN** 用户关闭主窗口
- **THEN** 应用驻留托盘，runner（若启用）与全部 agents 继续运行

#### Scenario: 托盘退出即排空

- **WHEN** 用户从托盘菜单选择退出
- **THEN** supervisor 按序停机、全部 runtime children 停止后应用进程退出，无孤儿

#### Scenario: 托盘显示恢复窗口

- **WHEN** 用户点击托盘「显示」
- **THEN** 主窗口恢复（最小化过的还原）并获得焦点
