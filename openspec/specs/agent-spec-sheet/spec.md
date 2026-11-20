## Purpose

One shared presentation contract for an agent: persona, skills, and MCP tool face rendered as a single spec sheet with a structurally derived type badge and synthesized provenance, identical across every surface that presents an agent — so official and community agents read the same way everywhere and can be understood rather than only installed.

## Requirements

### Requirement: One shared spec-sheet contract, many surfaces

The system SHALL define a single spec-sheet presentation contract for an agent, consumed by every surface that presents one — at minimum the market detail, the conversation picker, the studio preview pane, and the official gallery. A consuming surface SHALL supply the agent's data and SHALL NOT define its own layout of the three buckets. The same agent SHALL render identically on 壹座 and on the facet (谦面) surface.

#### Scenario: Same agent, same rendering
- **WHEN** the same agent is presented in the market detail on 壹座 and on the facet surface
- **THEN** both render the identical spec sheet, with the same bucket ordering and the same badge and provenance

#### Scenario: A surface supplies data only
- **WHEN** a new surface consumes the spec-sheet contract
- **THEN** it passes the agent's data and renders the shared layout, adding no bucket layout of its own

### Requirement: The three buckets are always rendered, empty included

The spec sheet SHALL always render the three buckets — persona, skills, and MCP tool face — in a fixed order. When a bucket is empty, the spec sheet SHALL present it explicitly as empty rather than omitting it. Each bucket SHALL be individually inspectable: the persona SHALL support a summary with expandable full text, the skills SHALL list names with expandable bodies, and the MCP bucket SHALL list references with their declared tool face (declared count and any narrowed allowlist).

#### Scenario: An agent with only a persona
- **WHEN** an agent declares a persona but no skills and no MCP references
- **THEN** the spec sheet shows the persona bucket with content and shows the skills and MCP buckets explicitly empty

#### Scenario: Full bucket inspection
- **WHEN** a user inspects an agent that declares skills and MCP references
- **THEN** the skills list each name with an expandable body and the MCP bucket lists each reference with its tool face

### Requirement: Type badge is derived, never authored

The type badge on the spec sheet SHALL be derived from the agent document's structure using the platform's existing badge derivation, and SHALL NOT be author-settable or author-overridable. The badge SHALL remain a projection of structure at read time.

#### Scenario: Author cannot set the badge
- **WHEN** an agent document contains a team organization block
- **THEN** the spec sheet shows the blueprint-type badge regardless of any author-supplied type hint

### Requirement: Provenance is synthesized from its three axes

The spec sheet SHALL present provenance synthesized from its three axes — type badge (structure), official status (roster judgment, never the manifest's self-report), and source (manifest provenance) — through the platform's existing single synthesis point. An `official-adopted` source SHALL be shown only when the roster already marks the agent official and the manifest declares the adopted provenance; a manifest self-report alone SHALL never render an agent as official.

#### Scenario: Self-reported official is not official
- **WHEN** a manifest declares official-adopted provenance but the roster does not mark it official
- **THEN** the spec sheet does not present it as official

#### Scenario: Roster-official original
- **WHEN** the roster marks an agent official and the manifest declares official-original
- **THEN** the spec sheet presents the official-original provenance

### Requirement: Guide content comes from the document, not the client

When the agent document carries a usage guide, the spec sheet SHALL render that guide's steps. When it does not, the spec sheet SHALL omit the guide block. The spec sheet SHALL NOT inject guide copy that is not present in the document data.

#### Scenario: Guide present
- **WHEN** the document declares a three-step guide
- **THEN** the spec sheet renders those three steps in document order

#### Scenario: Guide absent
- **WHEN** the document declares no guide
- **THEN** the spec sheet renders no guide block and adds no client-side copy

### Requirement: 消费面传真实桶数据，不得传 null 伪造空态

规格书的三个桶 SHALL 由消费面传入**该智能体的真实数据**。消费面 SHALL NOT 以 `null` / 缺省参数把「该智能体确实没有这个桶」与「消费面没有接这个桶的数据」混为一谈——后者 SHALL 由消费面显式不渲染该桶，或补齐数据，SHALL NOT 借空态呈现。

当同一份智能体数据在多个面呈现时，各面 SHALL 呈现相同的桶内容：同一个智能体在市场中显示 N 条技能，在创作面的规格书中 SHALL 同样显示这 N 条技能，SHALL NOT 出现一侧显示、另一侧显示为空。

#### Scenario: 同一智能体两处桶一致

- **WHEN** 同一份声明了 3 条技能、1 条 MCP 引用的智能体分别在市场详情与创作面检查器中呈现
- **THEN** 两处的技能桶都列出这 3 条技能，MCP 桶都列出这 1 条引用

#### Scenario: 数据可编辑处的规格书同源

- **WHEN** 创作面能编辑技能桶，而检查器同时呈现该文档的规格书
- **THEN** 检查器的技能桶呈现正在编辑的同一份技能数据，编辑后随之更新

### Requirement: 草拟产物可被采用的范围与其可编辑范围一致

当 AI 起草产出某个字段，而该字段在文档中可编辑时，评审卡 SHALL 允许采用该字段。评审卡 SHALL NOT 把可编辑字段标为不可采用——那会让「能改」与「AI 能帮你改」两个事实互相矛盾。

不可采用 SHALL 仅当该字段在文档侧确实不可写；此时评审卡 SHALL 说明原因并指向真正可编辑的位置。

#### Scenario: 技能桶可编辑则技能草稿可采用

- **WHEN** 文档的技能桶可在画布内编辑，AI 起草返回了技能条目
- **THEN** 评审卡的技能行可勾选采用，采用后技能桶落库

#### Scenario: 不可采用须说明去向

- **WHEN** 某个 AI 起草字段在文档侧不可写
- **THEN** 评审卡该行呈不可采用态并说明原因与可编辑位置
