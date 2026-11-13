## MODIFIED Requirements

### Requirement: 三手势（记住 / 标为正典 / 改 tag）

成果页每条目 SHALL 提供「记住」、「标为正典」、「改 tag（增/删/改）」三手势；手势 SHALL 经服务端写面生效（直接改真源并同步镜像），AI 提议与人工确认在 UI 明示；改 tag SHALL 在条目内就地编辑（预填现值、可接受/修改/删除 AI 提议、Enter 提交、Esc 放弃，且不遮挡页面其他内容）；手势失败 SHALL 走降语反馈而不置乱态。

#### Scenario: 弹窗接受一个 AI 提议 tag 并删另一个

- **WHEN** 用户在改 tag 编辑面接受「章程」并删「备忘」
- **THEN** 页面即时反映新 tags，并各自记人/AI 来源

#### Scenario: 放弃编辑不改动数据

- **WHEN** 用户在编辑面按下 Esc 或「取消」
- **THEN** 条目的 tags 与编辑前一致，且不发出任何写请求
