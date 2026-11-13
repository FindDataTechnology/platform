# 覆盖偏好是偏好 diff，不是资源快照

pack-agent-scoping 的 spec 把资源范围锁成纯推导不变量（「SHALL NOT persist as independent state that can drift from the preset」），而用户侧微调（add-focus-overlay）需要用户的增删在重新组合之间存活。决定：overlay 以「加/减偏好列表」按预设存储（偏好键 `focus.overlay.<presetId>`），在每次组合（boot、切预设、MCP/技能变更、崩溃自愈）时叠加到推导结果之上——「加」只能选用户已启用的资源宇宙，「减」永远合法；包升级后 diff 对新集合重新解析，悬空项静默收敛。这样保住了不变量的目的（没有会过期的快照可以漂移），只修正了字面；spec 措辞相应改为「有效范围 = f(preset, 覆盖偏好)，仍无快照」。

## Considered Options

- 存资源快照：被否——包升级/MCP CRUD 后立刻变陈旧，正是 spec 要防的漂移。
- 禁止持久化、只允许会话内调整：被否——重启即蒸发，用户侧微调没有实用价值。
