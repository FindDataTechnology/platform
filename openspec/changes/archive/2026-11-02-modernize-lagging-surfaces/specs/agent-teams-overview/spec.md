# agent-teams-overview Delta Spec

## ADDED Requirements

### Requirement: 团队 hub 的灯与页头层级

智能体团队总览（hub 卡片网格）的卡片 SHALL 整体可点，MUST NOT 在每卡同一位重复渲染装饰性蓝色链接（同屏多枚等位蓝链即违规）；页头 SHALL 经 PageShell 归位——标题先于视图切换与筛选控件；成员与统计胶囊 SHALL 使用状态词表。既有编队视图的迷你图形呈现保持不变。

#### Scenario: 网格不点灯

- WHEN 总览呈现 9 张以上团队卡
- THEN 卡片无等位重复蓝色链接，强调色仅出现在主操作与活体信号处

#### Scenario: 页头归位

- WHEN 用户打开团队总览
- THEN 标题位于视图切换与筛选控件之上，为第一读点
