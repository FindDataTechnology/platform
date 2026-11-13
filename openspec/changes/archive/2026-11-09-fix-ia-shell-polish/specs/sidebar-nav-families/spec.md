## MODIFIED Requirements

### Requirement: The active surface is always visible

侧栏的每个导航家族 SHALL 可折叠，当前路由所在的家族也不例外：渲染 MUST NOT 以「是否包含活动路由」作为强制展开的条件。用户的一次显式折叠或显式展开 SHALL 立即产生对应的视觉变化，并按既有的每用户持久化规则保存；点击家族头 MUST NOT 出现「状态已变、界面不变」的空点击。

进入时展开（reveal-on-entry）：当路由**从别处进入**某个存储状态为折叠的家族时（深链、程序化导航、恢复的会话），该家族 SHALL 展开一次，使用户不会落在一个看不见的面之上。该展开 SHALL 是进入时刻的一次性行为，MUST NOT 成为「只要包含活动路由就永远展开」的常驻强制。页面重载与深链 SHALL 同样重新执行该规则，使已存储的折叠状态永远不会把深链路由搁置在折叠的家族里。

在那次进入展开之后，对同一家族的后续显式折叠 SHALL 被尊重，即使该家族仍包含当前活动路由——该控件 MUST NOT 成为死控件。

家族处于折叠状态而其内部含有当前活动路由时，家族头 SHALL 保留活动标记，使折叠不隐藏「当前在哪」。激活家族内的条目 SHALL 再次展开该家族。

全局「全部折叠 / 全部展开」控件的视觉状态 SHALL 由渲染器所使用的同一份存储折叠集合派生，二者 MUST NOT 出现分歧。激活「全部折叠」后，每个家族——包括当前活动家族——SHALL 渲染为折叠，且开关图标 SHALL 显示「展开全部」；激活「全部展开」后，每个家族 SHALL 渲染为展开。

家族只有一个存活成员时 SHALL 继续压平为普通导航条目（无家族容器、无折叠控件）；该既有规则不受上述折叠语义影响。

#### Scenario: deep link into a collapsed family expands it on entry

- **WHEN** the 知识 family is stored as collapsed and the user opens /knowledge directly (a deep link, a programmatic navigation, or a restored session)
- **THEN** the family renders expanded once on entry, with knowledge marked active

#### Scenario: clicking that family's header afterwards collapses it

- **WHEN** the user then clicks the 知识 family header while /knowledge is the active route
- **THEN** the family collapses immediately, and the active marker moves to the family header so the current location stays visible

#### Scenario: collapse all leaves every family collapsed

- **WHEN** the user activates the global collapse-all control while /knowledge is the active route
- **THEN** 知识, 构建, 运行 and 接入 all render collapsed with no exception for the active family, and the toggle reads "expand all"

#### Scenario: expand all restores every family

- **WHEN** the user activates the global expand-all control after a collapse-all
- **THEN** every family renders expanded and the toggle reads "collapse all", the two states agreeing because both are derived from the same stored collapsed set

#### Scenario: stored collapse survives reload while reveal-on-entry still fires

- **WHEN** the user has collapsed 知识, reloads the app, and the landing route is a deep link into 知识
- **THEN** the stored collapsed state is retained for that user, and the reveal-on-entry rule expands 知识 for this entry without discarding the stored state

#### Scenario: a family with a single present member still flattens to a plain entry

- **WHEN** the resolver leaves apps as the only present 接入 member
- **THEN** apps renders as a plain nav entry with no family container and no collapse control

#### Scenario: reload into a collapsed family's route

- **WHEN** the 知识 family is collapsed and the user opens /knowledge directly
- **THEN** the family renders expanded with knowledge marked active
