# ci-pipeline delta — automate-nonweb-acceptance

## ADDED Requirements

### Requirement: 桌面装机验收轨随发布自动执行

桌面 release 工作流 SHALL 在安装包构建完成后自动执行装机验收作业（解析包体、安装、启动内置管家并断言 UI 附着、退出 UI 后断言后端存活、卸载后断言清场），并在任一断言失败时把整次发布置为失败。该作业的默认腿运行在 Windows；macOS 腿为可选（显式请求时执行）。

#### Scenario: tag 发布自动验收
- **WHEN** 桌面 release 由 tag 触发且安装包构建成功
- **THEN** 装机验收作业 SHALL 自动运行，并断言「UI 附着管家 / 退 UI 后端存活 / 卸载清场」三段行为

#### Scenario: 断言失败阻塞发布
- **WHEN** 装机验收的任一断言失败
- **THEN** 工作流整体结论 SHALL 为失败，失败证据（日志/状态输出）随运行保留

#### Scenario: macOS 腿按需执行
- **WHEN** 需要 macOS 侧装机验收
- **THEN** 它 SHALL 能通过显式请求同一工作流运行，且默认为不执行以控制成本

### Requirement: 移动端验收轨可排程

移动端端到端验收（配对、页签、语言切换、聊天错误面、图表四系列）SHALL 具备可排程的池侧运行形态：定时任务在池侧对当前主分支内容执行完整验收，不占用私仓的 macOS/Windows 预算；图表流 SHALL 断言四类系列均渲染成功且未回落。排程开关在所需凭据缺失时 SHALL 显式报告跳过（而非静默成功）。

#### Scenario: 定时验收自动执行
- **WHEN** 排程触发且所需凭据存在
- **THEN** 移动端完整验收 SHALL 在池侧运行，并以运行结论反映通过/失败

#### Scenario: 图表四系列断言
- **WHEN** 图表验收流依次请求柱状/折线/饼图/散点
- **THEN** 每次 SHALL 断言渲染成功状态出现且回落状态不出现

#### Scenario: 凭据缺失显式跳过
- **WHEN** 排程所需凭据未配置
- **THEN** 运行 SHALL 明确标注为跳过（输出可见），且不产生"验收已通过"的信号