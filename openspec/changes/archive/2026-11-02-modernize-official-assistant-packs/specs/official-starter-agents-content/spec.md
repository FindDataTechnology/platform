## ADDED Requirements

### Requirement: 助手型与套件型官方包的内容基线

官方货架上的助手型（单岗对话）与套件型（技能束）包，其 persona 深化必须（SHALL）把改版前文本逐字保留为前缀（零改写），并含【职责边界】与【输出契约】结构段且 ≥380 字；输出契约按形态取用——舰队岗为 report_status 报数契约，对话助手为答复契约（结构/来源标注/诚实兜底），不得把舰队语义硬套给助手岗。同一岗位 id 出现在多支包时，其 persona 必须（SHALL）跨包逐字节一致。

#### Scenario: 前缀改写被拒
- **WHEN** 深化后的 persona 不是改版前文本的前缀扩展（原文被改写或截断）
- **THEN** 基线测试与发布脚本同时拒绝，不允许上架

#### Scenario: 共享岗跨包漂移被拒
- **WHEN** 同一岗位 id 在两支包中的深化文本不一致
- **THEN** 基线测试断言失败，不允许上架

### Requirement: 转正包的上游快照不可动

provenance 为 official-adopted 的包，其技能正文是上游钉定快照——任何改版 overlay 必须（SHALL）不含 skills 键；persona 深化只许加厚包装岗的边界与纪律，不得复述或改写技能步骤。

#### Scenario: 转正技能改动被拒
- **WHEN** 转正包的 overlay 携带 skills 或发布后技能正文与上游快照不一致
- **THEN** 基线测试与发布脚本拒绝，不允许上架

### Requirement: 官方名册的完备性

官方作者名册（OFFICIAL_AUTHOR_EMAILS）是画廊 official 徽章的唯一真源；官方内容的每一位实际作者邮箱必须（SHALL）在册，否则其包在官方画廊对用户不可见。改版批新增或触及非在册作者的官方包时，必须（SHALL）先把作者邮箱补入名册并部署，再走查货架可见性。

#### Scenario: 名册缺员致隐身被拒
- **WHEN** 官方=1 接口在册的包按作者名册判 official=false（画廊不可见）
- **THEN** 名册补齐部署后走查复核，官方画廊卡数必须与官方接口支数一致
