## MODIFIED Requirements

### Requirement: 显示字段的 zh 主轨与顶层叠加块

pack manifest 的既有显示字段(name、description、notes、guide.steps、skills[].description、mcpServers[].description、agents[].name、bots[].name/description、cluster、card 文本)SHALL 保持纯字符串形状与既有校验规则不变,其文本即中文(zh)主轨。manifest SHALL 可选携带顶层 `i18n` 对象,形状为 `{ <locale>: { <显示字段覆盖> } }`:locale 键 SHALL 匹配 BCP-47 小写主标签形态且 SHALL NOT 为 `zh`(zh 由基字段承担,双写视为非法);每 locale 块内 SHALL 只出现显示字段白名单内的覆盖;数组型字段 SHALL 按索引对齐覆盖,命名实体(skills/agents/bots/card.skills/mcpServers)SHALL 按其在 manifest 中已声明的名字或 id 覆盖。

#### Scenario: 旧式纯字符串 manifest 依旧合法

- **WHEN** 一份不含 `i18n` 键、显示字段为纯字符串的 manifest 提交校验或安装重校验
- **THEN** 其与本次变更前逐字节同规则通过,无任何新增错误或警告

#### Scenario: 合法双语 manifest 通过

- **WHEN** 一份 manifest 的基字段为中文,`i18n.en` 覆盖 name 与全部三步 guide.steps 的 title/body
- **THEN** 校验通过,英文覆盖被存储并可用于按 locale 展示

#### Scenario: `i18n` 块引用未声明实体被拒

- **WHEN** `i18n.en.skills` 试图覆盖一个 manifest `skills` 中不存在的技能名,或 `guide.steps` 索引越界,或 `i18n.en.mcpServers` 试图覆盖 manifest `mcpServers` 中未声明的 registryName
- **THEN** 校验以指明该 locale 与字段路径的结构化错误拒绝

#### Scenario: `zh` 写在叠加块内被拒

- **WHEN** manifest 携带 `i18n.zh` 键
- **THEN** 校验拒绝并指明中文应写在基字段

#### Scenario: mcpServers 描述副轨覆盖合法

- **WHEN** 一份 manifest 的 `i18n.en.mcpServers` 按已声明 registryName 覆盖其 description
- **THEN** 校验通过,英文描述可按 locale 投影,registryName 与连接配置零变化
