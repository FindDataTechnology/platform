## Purpose

The one-way promotion channel from a running 壹座 instance to a supply-domain Studio draft (roadmap D7): tuning results worth persisting can be forked into a draft with honest provenance, while the running instance is never mutated by Studio edits — creation and run are bridged bidirectionally in visibility but gated one-way in writes.

## ADDED Requirements

### Requirement: 实例状态可晋升为 Studio 草稿

壹座实例（在跑舰队/团队的配置态）SHALL 提供晋升动作：fork 实例当前 preset/配置/skills 态生成一份供给域 Studio 草稿，provenance SHALL 如实记录来源实例与时间。

#### Scenario: 晋升生成带出处的草稿

- **WHEN** owner 对一支在跑团队执行晋升
- **THEN** 供给域 Studio 出现一份新草稿，内容为该实例当前配置态，provenance 标注来源实例与时间

### Requirement: 晋升单向闸门

晋升 SHALL 只产生草稿：Studio 侧对文档的任何编辑 SHALL NOT 反向改动运行中实例；实例的继续运行 SHALL NOT 因晋升而中断或变更。

#### Scenario: 编辑草稿不动实例

- **WHEN** owner 编辑一份由实例晋升而来的草稿并保存
- **THEN** 来源实例的运行态与配置逐字节不变，草稿要生效须走发布→装机既有链

### Requirement: v1 fork 范围如实划定

v1 晋升 SHALL 仅 fork preset/配置/skills 态；记忆与会话历史 SHALL NOT 被 fork；界面 SHALL 如实呈现 fork 范围（含「未包含」项），MUST NOT 暗示完整状态已带走。扩围 SHALL 走后续单独探索。

#### Scenario: fork 范围如实呈现

- **WHEN** owner 发起晋升并查看确认界面
- **THEN** 界面列出将被 fork 的状态类别与显式「未包含：记忆/会话历史」标注
