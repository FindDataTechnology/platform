## ADDED Requirements

### Requirement: 非 embed 导航的预设深链

壹座对话页 SHALL 在**普通导航**（非 `embed=copilot` 的 iframe 场景）中同样
支持 `?preset=<agentId>` 深链：从功能集安装引导等入口落地 `/chat?preset=…`
时，页面 SHALL 在连接就绪后、首个回合之前将运行时切换到该 agent，语义与
副驾 embed 深链一致——切换 SHALL 对用户可见（选人控件与头部标签同步反映
当前 agent，MUST NOT 静默替换），切换被运行时拒绝（如流式中）时 SHALL 显性
呈现未聚焦原因并提供重试，MUST NOT 自动循环重试或伪称已选中。

深链目标 agent 不存在（如功能集已卸载）时，页面 SHALL 显示明确的原因提示
并保持当前 agent，MUST NOT 报错阻断对话。深链只在会话尚未产生回合时尝试
切换；URL 参数在一次消费后 SHALL 从地址栏清除，避免刷新时重复切换。

#### Scenario: 安装引导直通选中

- **WHEN** 用户从功能集安装报告点击「打开对话」落地 `/chat?preset=<agentId>` 且该 agent 已安装
- **THEN** 连接就绪后页面发送 `set_agent`，「与谁对话」控件与头部显示该 agent

#### Scenario: 目标已卸载时诚实降级

- **WHEN** 用户落地 `/chat?preset=<agentId>` 且该 agent 不在 roster 中
- **THEN** 页面显示「该助手已不在」类原因提示，保持当前 agent，对话可用

#### Scenario: 参数一次消费

- **WHEN** 深链切换完成（或明确失败）后用户刷新页面
- **THEN** URL 已不含 `preset` 参数，不发生重复切换
