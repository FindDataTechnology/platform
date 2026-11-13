## MODIFIED Requirements

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

## ADDED Requirements

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
