## MODIFIED Requirements

### Requirement: Exactly one pack-market doorway in the product

The `/packs` route SHALL NOT be a nav tab and SHALL NOT carry a nav entry of its own. The pack marketplace (market, 我的包, 创作草稿与发布) SHALL be a tab of the 智能体市场 surface at `/agents`, and `/packs` together with its former sub-routes SHALL redirect into the corresponding tab of that surface so no pack link dead-ends.

The product SHALL expose exactly one market doorway — that tab — and SHALL NOT carry an outbound link to a second, separately-hosted marketplace. The marketplace is internal: its catalogue is served by the deployment's own market plane (`PACK_MARKETPLACE=1` mounts it in-process on a single-process deployment; a gateway topology serves the same routes behind the same gateway), so a link leaving the product for "the marketplace" would present the same catalogue as a different product — and would move the user to another origin with another identity for no added capability. Neither a second in-product market entry (a duplicate nav entry, a duplicate market panel, a duplicated 我的包 area) nor an external market door SHALL exist.

The **authoring** entry SHALL remain: composing and publishing packs happens in the supply-domain Studio (facet), which is a different deployment surface of the same repository, not a second marketplace. That entry SHALL stay an explicit outbound link, labelled as the place where packs are built, and SHALL NOT be presented as "the market".

#### Scenario: /packs deep link lands inside the market surface

- **WHEN** the user opens `/packs`, or a stored link to a former packs sub-route such as the 我的包 or 创作草稿 area
- **THEN** the router SHALL land on the `/agents` surface with the matching tab active
- **AND** the link SHALL NOT 404 and SHALL NOT render a standalone packs page

#### Scenario: one in-product market doorway

- **WHEN** the user looks for the pack marketplace from the nav
- **THEN** the sidebar SHALL expose no packs entry
- **AND** the only in-product market doorway SHALL be the market tab of the `/agents` surface
- **AND** no outbound link to a separately-hosted marketplace SHALL be rendered

#### Scenario: one market doorway, no external market door

- **WHEN** the user looks for the pack marketplace from the nav
- **THEN** the sidebar SHALL expose no packs entry
- **AND** the only market doorway SHALL be the market tab of the `/agents` surface
- **AND** the surface SHALL NOT render a link leaving the product for a marketplace

#### Scenario: the authoring entry survives and is not called the market

- **WHEN** the user opens the market surface
- **THEN** an outbound entry to the supply-domain Studio SHALL be present and SHALL point at the Studio route
- **AND** that entry SHALL be labelled as authoring, never as the market

#### Scenario: no duplicated market panel

- **WHEN** the resolved layout includes the `agents` entry
- **THEN** the market content SHALL render in exactly one place inside the product
- **AND** no other nav entry or Settings section SHALL render a second market or 我的包 listing
