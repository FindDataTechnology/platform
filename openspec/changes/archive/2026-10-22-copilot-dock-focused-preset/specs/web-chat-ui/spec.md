## ADDED Requirements

### Requirement: 副驾 dock 注入聚焦预设并在关闭后恢复

从线看板打开的副驾 dock SHALL 在其 iframe URL 中携带该线聚焦助手的 agent 标识（`preset=<agentId>`）；副驾 embed 页面 SHALL 在连接就绪后、首个回合之前，将运行时切换到该 agent，使副驾会话以聚焦预设运行。切换 SHALL 对用户可见：副驾上下文条显示聚焦预设名称，主对话的 agent 选择器同步反映当前 agent，MUST NOT 静默替换。

关闭 dock 时，若当前 agent 仍是 dock 注入的聚焦助手，壹座 SHALL 恢复为打开 dock 前的 agent；若用户在 dock 打开期间已在主对话手动切换到其他 agent，SHALL 保留用户的选择，MUST NOT 覆盖。

切换因主对话正在回答而被运行时拒绝时，副驾 SHALL 在上下文条显示未聚焦的原因并提供重试，MUST NOT 自动循环重试，MUST NOT 伪称已聚焦。URL 不携带预设（该线无聚焦助手）时，副驾 SHALL 显示未聚焦及原因。清除看板上下文 MUST NOT 改变预设。

#### Scenario: 打开 dock 即聚焦

- **WHEN** 用户在 `/boards/facet` 打开副驾，且谦面线解析到聚焦助手「谦面助手」
- **THEN** iframe URL 含 `preset=` 与该 agent 标识，副驾上下文条显示「聚焦预设：谦面助手」，主对话 agent 选择器显示「谦面助手」

#### Scenario: 关闭 dock 恢复原 agent

- **WHEN** 打开 dock 前主对话 agent 为内置助手，用户关闭 dock 时当前 agent 仍是「谦面助手」
- **THEN** 运行时切回内置助手，主对话 agent 选择器恢复显示内置助手

#### Scenario: 用户中途手动切换则不恢复

- **WHEN** dock 打开期间用户在主对话把 agent 切到「法条助手」，随后关闭 dock
- **THEN** 当前 agent 保持「法条助手」，壹座不发出任何恢复切换

#### Scenario: 主对话回答中切换被拒

- **WHEN** 主对话正在流式回答时用户打开 dock
- **THEN** 副驾上下文条显示「主对话正在回答，暂未聚焦」与重试按钮；点击重试后再发一次切换，期间不自动重试

#### Scenario: 无聚焦助手时诚实降级

- **WHEN** 用户从未安装该线助手 pack 的看板打开副驾
- **THEN** iframe URL 不含 `preset=`，上下文条显示「未聚焦：该线助手 pack 未安装」
