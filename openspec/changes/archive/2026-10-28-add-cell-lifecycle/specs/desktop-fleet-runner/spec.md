## MODIFIED Requirements

### Requirement: 生命周期跟随应用

桌面 runner 与其 runtime children 的进程生命周期 SHALL 隶属 supervisor：supervisor 为
内嵌形态（未安装常驻管家）时，应用退出即有序 drain 全部 runtime children 后退出（原有
语义）；supervisor 为常驻形态（`desktop-supervisor` 的 resident form）时，runtime
children 存续于 UI 会话之外，drain 只发生在管家有序停机、排干更新或销毁流程——UI 退出
不再携带停机语义。runner 异常退出时均仍由 supervisor 按退避序列自动重启。

#### Scenario: 退出时排空

- **WHEN** 用户退出应用且 supervisor 为内嵌形态（supervisor 有序停机）
- **THEN** 全部 runtime children 被停止后 runner 进程退出，无孤儿进程

#### Scenario: 常驻形态下 UI 退出不停机

- **WHEN** 用户退出 Electron 应用且 supervisor 为常驻形态
- **THEN** 桌面 runner、其 runtime children 与已排定定时任务全部继续运行，仅 UI 客户端
  脱离

#### Scenario: 常驻形态下管家停机才排空

- **WHEN** 常驻管家收到停机/更新/销毁信号
- **THEN** 其按序 drain 全部 runtime children（含桌面 runner）后退出，无孤儿进程
