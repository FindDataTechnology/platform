# sidebar-nav-families Specification

## Purpose
Gives the left navigation a family grouping with collapse/expand (Codex-style) so the ever-growing list of nav surfaces stays scannable, while the surface registry remains the single authority over which entries exist at all.

## Requirements

### Requirement: Nav entries render inside collapsible families

The sidebar's upper tab region SHALL render registry-resolved nav entries grouped into labeled families, each with a collapse/expand control. There SHALL be exactly four families, ordered: the "知识" family containing the knowledge, resources, and memory surfaces; the "构建" family containing the agent-builder (agents) and tuning (tuning) surfaces — the author→tune pair, i.e. the builder market and the surface where candidates and personas are revised; the "运行" family containing the agent-teams (fleets), machines (machines), and local-runtime (fleet) surfaces — the organization, paired-device, and local-runtime layers of one concept, where fleet is desktop-only by predicate; and the "接入" family containing the apps (apps), channels (channels), and zhiyu (zhiyu) surfaces — the discovery directory, outbound chat channels, and multi-human rooms. The chat and tasks surfaces SHALL render as standalone entries with no family. The blueprint-studio (blueprints) surface SHALL NOT be a family member (its nav entry is retired; the route remains a redirect into the workspace).

The fleets surface SHALL leave the 构建 family and join 运行: 构建 no longer pairs author with run, it pairs author with tune. A stored collapse state for 构建 SHALL NOT implicitly collapse 运行 — 运行 is a fresh family and defaults to expanded.

Family membership is presentation metadata layered on the surface registry: preset narrowing and predicates (adminOnly, desktopOnly) apply before grouping, and a slug the resolver hides SHALL never appear inside a family, with no disabled placeholder. A family SHALL render at the position of its first present member in registry order, and a family with a single surviving member SHALL flatten to a plain entry rather than a one-item collapsible.

#### Scenario: family renders its members

- **WHEN** the resolver includes knowledge, resources, and memory
- **THEN** the 知识 family renders containing all three entries

#### Scenario: four families in canonical order

- **WHEN** the resolver includes members of all four families
- **THEN** the sidebar renders 知识, then 构建, then 运行, then 接入, each at the position of its first present member, with chat and tasks as standalone entries

#### Scenario: the compose pair sits together

- **WHEN** the resolver includes both agents and tuning
- **THEN** both render inside the 构建 family adjacent in registry order, with the Settings shortcut rows below them
- **AND** fleets SHALL render in the 运行 family, not in 构建, and blueprints renders in no family

#### Scenario: the author and tune pair sits together

- **WHEN** the resolver includes both agents and tuning
- **THEN** both render inside the 构建 family, adjacent in registry order, and blueprints renders in no family

#### Scenario: the three runtime layers share a family

- **WHEN** the resolver includes fleets, machines, and the desktop-only fleet
- **THEN** all three render inside the 运行 family in registry order, and none of them renders inside 构建

#### Scenario: collapse state does not carry across the moved surface

- **WHEN** the user has 构建 collapsed and the 运行 family has never been toggled
- **THEN** 运行 renders expanded and only 构建 renders collapsed

#### Scenario: preset-hidden member drops out of its family

- **WHEN** the active layout preset excludes memory
- **THEN** the 知识 family renders with the remaining members and no disabled placeholder for memory

#### Scenario: lone surviving member flattens

- **WHEN** the resolver hides zhiyu and channels, leaving apps as the only 接入 member
- **THEN** apps renders as a plain nav entry with no family container

#### Scenario: desktop-only predicate keeps fleet out of the browser

- **WHEN** the layout resolves in a browser context where fleet is desktopOnly
- **THEN** the 运行 family renders fleets and machines only, and the 接入 family is unaffected

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

### Requirement: Collapse state persists per user
Collapsing or expanding a family SHALL persist across sessions and restarts for that user's default; a freshly seeded family defaults to expanded.

#### Scenario: state survives a reload
- **WHEN** the user collapses 知识, reloads the page, and the family contains no active route
- **THEN** the family renders collapsed

### Requirement: Families never alter routing
Grouping SHALL NOT change any surface's route: deep links to existing paths land on the same pages as before, with no family segment in the URL.

#### Scenario: existing deep link unaffected
- **WHEN** a user follows a pre-grouping link to /resources
- **THEN** the resources page opens, and the 知识 family (if collapsed) expands to show it

### Requirement: The 构建 family renders Settings shortcut rows

The 构建 family SHALL additionally render a footer of secondary shortcut rows — distinct from members, not tabs, and never registry surfaces — that open Settings sections: 工具/MCP → /settings/mcp, 插件 → /settings/plugins, 模型 → /settings/models. Each shortcut row SHALL obey the same predicate and preset filtering rule as family members: if the resolved layout hides the corresponding Settings section, that row SHALL NOT render, and no disabled placeholder SHALL appear in its place. A shortcut row SHALL carry no active state and SHALL never become the family's active entry, even when the user is currently inside the target Settings section.

#### Scenario: shortcuts render under the family members

- **WHEN** the resolver includes mcp, plugins, and models and the 构建 family is expanded
- **THEN** the three shortcut rows render below the agents and tuning entries

#### Scenario: hidden Settings section drops its shortcut

- **WHEN** the active layout preset excludes plugins
- **THEN** the 插件 shortcut row does not render, the other two shortcuts render, and no disabled placeholder appears for 插件

#### Scenario: a shortcut is never the active entry

- **WHEN** the user is on /settings/models and the sidebar shows the 构建 family
- **THEN** no 构建 family member or shortcut row is marked active, and the family expands only by the active-surface rule already applied to nav routes

#### Scenario: shortcut opens the Settings section

- **WHEN** the user activates the 模型 shortcut row
- **THEN** the Settings dialog opens on the models section and the sidebar route is unchanged
