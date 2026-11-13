# fleet-blueprint-studio Specification (delta)

## ADDED Requirements

### Requirement: dataSources 可钉知识库 collection，实化成员即为 KB 型岗位
蓝图 v2 的 `dataSources` 引用面 SHALL 接受知识库 collection 作为合法数据源（与 registry 服务名/internal store 逻辑名并列的第三种引用种类，指名 collection）。校验 SHALL 拒绝指向不存在或不可见 collection 的引用并指名之。经该蓝图铸造并实化的团队，其钉了库的成员 SHALL 获得限定到所钉 collection（∪ shared，按 document-library-tools 的边界条款）的 library 工具访问；未钉库的成员不因同队成员钉库而获得访问。试跑 SHALL 与实化同边界，绿报告如实反映"该岗位确实用上了库"。

#### Scenario: 钉库蓝图过校验
- **WHEN** 提交一份 `dataSources` 引用本人某 collection 的蓝图
- **THEN** 校验绿，引用种类被承认为库引用，草稿面显示被钉集合名

#### Scenario: 悬空引用指名拒绝
- **WHEN** 引用的 collection 不存在或不属于蓝图作者可见范围
- **THEN** 校验落一条指名该引用的错误，蓝图不落草稿

#### Scenario: 实化成员获得限定库访问
- **WHEN** 钉库蓝图铸造的团队被实化并开回合
- **THEN** 钉库成员的工具名册含 library 四件、检索只覆盖所钉集合∪shared；同队未钉库成员不含这些工具或不可见该集合

#### Scenario: 跨部署面同边界
- **WHEN** 该团队经一键召唤进入智语房间，或整包含库引用部署到萬星
- **THEN** 成员在两侧车道的库访问边界与站内实化一致，包不携带库内容本体（引用的是部署者账号内的集合）
