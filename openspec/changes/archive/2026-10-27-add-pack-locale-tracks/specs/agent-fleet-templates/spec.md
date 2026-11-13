# agent-fleet-templates Specification (delta)

## ADDED Requirements

### Requirement: 模板显示字段的多语言叠加

集群模板 manifest 的 `fleet` 段 SHALL 可选携带 `i18n` 块,形状为 `{ <locale>: { name?, members?: { <memberRef>: { title?, kpiSlots?: { <slotKey>: { label? } } } } } }`,用于覆盖模板名、岗位显示名与 KPI 槽位 label 的副语言文本;每个覆盖值 SHALL 为非空字符串。模板预校验 SHALL 拒绝引用不存在成员 ref 或不存在槽位 key 的覆盖,并以结构化错误指明该 locale 与成员路径。模板 `fleet` 段内部字段(members/cadence 结构、kpiSlots 键集、orchestration 边集)形状 SHALL 与变更前完全一致;岗位 `promptTemplate` 与 persona 属内容层,SHALL NOT 进入 overlay。内置模板的 `nameKey`/`titleKey`/`labelKey` 机制 SHALL 原样保留,与 overlay 并存不互换。

#### Scenario: 双语集群模板按 locale 显示

- **WHEN** 一份模板基字段为中文场景名与岗位名,`fleet.i18n.en` 覆盖模板名与部分岗位 title,某安装面以 locale=en 展示模板
- **THEN** 被覆盖的模板名与岗位名呈现英文,未覆盖岗位与槽位 label 回落中文基字段

#### Scenario: overlay 引用未知成员被拒

- **WHEN** `fleet.i18n.en.members` 含一个模板 `members` 中不存在的 ref
- **THEN** 预校验以指明该 locale 与 ref 的结构化错误拒绝,模板不上架

#### Scenario: promptTemplate 不随语言复制

- **WHEN** 作者试图在 `fleet.i18n.<locale>` 的成员覆盖中携带 promptTemplate
- **THEN** 预校验拒绝并指明 promptTemplate 属内容层不可本地化

#### Scenario: 纯 zh 旧模板零改动

- **WHEN** 一份不含 `fleet.i18n` 的既有模板(含内置 nameKey 模板)重新提交预校验
- **THEN** 行为与本次变更前完全一致,无任何新增错误
