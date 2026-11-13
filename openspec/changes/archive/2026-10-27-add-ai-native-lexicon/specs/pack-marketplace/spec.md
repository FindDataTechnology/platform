## ADDED Requirements

### Requirement: Market entries carry a structure-derived type badge

Every market entry SHALL display exactly one type badge derived automatically from the manifest structure, in this precedence order:

- **蓝图 (Blueprint)** — the manifest declares a fleet/cluster organization block
- **分身 (Facade)** — no organization block, but at least one agent in the pack carries a facade serving contract
- **助手 (Assistant)** — the pack declares agents but neither an organization block nor a facade serving contract
- **工具 (Toolkit)** — the pack declares no agents (pure skills/MCP bundle)

The badge SHALL be computed by the platform — authors MUST NOT be able to set or override it via manifest fields or display-name conventions. It SHALL be visible on store listing cards and on the pack detail view, with en labels (Blueprint / Facade / Assistant / Toolkit) on the en surface.

#### Scenario: Fleet-template pack earns Blueprint badge

- **WHEN** a published pack's manifest declares a fleet/cluster organization block
- **THEN** its store card and detail view display the 蓝图 / Blueprint badge

#### Scenario: Facade pack earns Facade badge

- **WHEN** a published pack declares no organization block but includes an agent with a facade serving contract
- **THEN** its badge is 分身 / Facade

#### Scenario: Agent pack without organization or facade earns Assistant badge

- **WHEN** a published pack declares agents but no organization block and no facade serving contract
- **THEN** its badge is 助手 / Assistant

#### Scenario: Pure tool bundle earns Toolkit badge

- **WHEN** a published pack declares only skills and/or MCP references and no agents
- **THEN** its badge is 工具 / Toolkit

#### Scenario: Existing entries gain badges without republish

- **WHEN** the badge derivation ships
- **THEN** already-published entries (e.g. CRM 客服套件 → 工具, 分身工坊 → 助手, 寻数分身 → 分身) display correct badges with no republish required, since derivation is structural and applies at read time
