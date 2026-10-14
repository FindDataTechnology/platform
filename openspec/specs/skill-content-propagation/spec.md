# skill-content-propagation Specification

## Purpose
registry 技能条目的 SKILL.md 正文随 pack 版本传播：部署侧升级技能时，内联正文可经更新
API 落库，取值 URL 随版本派生刷新，内容端点永远返回与条目当前元数据一致的正文。

## Requirements

### Requirement: 技能更新接受内联正文

技能更新 API（PUT）SHALL 接受 `skill_md_content`（内联 SKILL.md 正文，与存储模型
同名字段对齐）：请求携带非空该字段时写入条目；请求未携带、或携带空串（归一为未携带）时
SHALL 保留库中既有正文不变。正文发生实际变化时，条目的内容更新时间戳 SHALL 一并刷新。

#### Scenario: 部署升级携带新正文

- **WHEN** 调用方 PUT 更新技能，载荷含当前版本的 `skill_md_content` 与版本化 `skill_md_url`
- **THEN** 条目存储的正文更新为载荷正文，内容更新时间戳刷新

#### Scenario: 不带正文的编辑不清空存量

- **WHEN** 调用方 PUT 更新技能，载荷不含 `skill_md_content` 字段（如 registry UI 编辑表单）
- **THEN** 条目已存储的正文保持不变

### Requirement: raw_url 随 skill_md_url 派生刷新

技能更新 API SHALL 维持「取值 URL 是展示 URL 的派生值」这一不变量：updates 携带
`skill_md_url` 且与条目现值不同时，取值 URL（raw URL）MUST 按与创建时相同的翻译规则
从新展示 URL 重新派生并写入；updates 未改 `skill_md_url` 时取值 URL 保持不变
（包括经库外手段人工设定的值）。

#### Scenario: 版本化 URL 更新带动 raw_url

- **WHEN** PUT 更新把 `skill_md_url` 从 v1 版本化 URL 改为 v10 版本化 URL
- **THEN** 条目的取值 URL 同步刷新为从 v10 URL 派生的取值 URL，内容端点回退拉取不再指向旧版本

#### Scenario: 未改展示 URL 不动取值 URL

- **WHEN** PUT 更新不含 `skill_md_url` 或其值与现值相同
- **THEN** 条目的取值 URL 保持不变

### Requirement: 内容端点取值与当前版本一致

正文取值端点（内容 API）SHALL 维持既有取值顺序——库内正文优先，空则回退取值 URL
拉取——且在上面的传播规则生效后，pack 升级部署完成的那一刻起，该端点为部署方技能
返回的正文 MUST 与被部署版本的正文一致，不出现「展示元数据是新版本、实际正文是旧
版本」的错位。

#### Scenario: 升级后子机冷启动取到新正文

- **WHEN** pack 升级部署完成（PUT 含新正文与新版本化 URL），随后子机冷启动经内容端点取正文
- **THEN** 返回的正文为升级后版本的正文
