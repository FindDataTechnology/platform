## ADDED Requirements

### Requirement: Trace 读面标注舰队归属

Trace 回合列表 SHALL 对可关联的舰队回合(回合事件的 trace 关联键命中执行实例账本)标注其岗位名,并提供进入所属舰队驾驶舱的入口;标注 SHALL 服务端一次批量查询完成,不增加逐行往返。不可关联的回合(网页会话回合、关联键已被裁剪)SHALL 照旧呈现,不虚构归属。

#### Scenario: 舰队回合带岗位标注

- **WHEN** 某舰队岗位回合的 trace 关联键命中账本
- **THEN** Trace 列表该行呈现岗位名徽章,并可进入所属舰队驾驶舱

#### Scenario: 网页回合不虚构归属

- **WHEN** 一条网页会话回合出现在 Trace 列表
- **THEN** 该行无舰队标注,呈现与现状一致
