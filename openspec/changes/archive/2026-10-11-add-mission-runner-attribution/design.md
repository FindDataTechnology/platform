# design — add-mission-runner-attribution

- **D1 归属戳**：manager.turn() 已持有 sessionId——turn_started/turn_ended payload 加 `session: sessionId`；turn_ended 加 `tokens: tokensOf(out?.usage)`（错误回合缺席）。字段名沿用观测面 snake_case 惯例（session 除外——它是标识符不是度量）。
- **D2 planner v2 三律**（技能正文级）：①每醒必核窗（GET 后即比 window_end，不再等开新步）②report 前把每步写终态（done/failed）③每醒开头三行状态小结（mission/状态/下一步）+单步工具调查 ≤N 次防打转；超限即收敛 report 部分成果。
- **D3 车道配方**（ops 文档）：夜间档=agent-service-config PUT planner 部署模型至低价车道（sub2api 组映射）；日间恢复。cron/手工皆可，零代码。
- **D4 测试**：runner 侧 test-agent-runner 既有套补一例（事件载荷断言）；planner 断言补三律关键词。
