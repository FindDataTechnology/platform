## MODIFIED Requirements

### Requirement: Shell views are addressable hash routes

The facet web shell SHALL address its views by hash: `#/` (intro) as the default landing, `#/packs` (packs market), `#/mcp` (MCP service catalog, carrying the per-server depth views and the skills catalog), `#/docs` (the documentation view), and `#/studio` (the creation face), plus identity-conditional views — `#/mine` (creator console, visible to signed-in users) and `#/curate` (curation board, visible to admins). The tab control and the hash SHALL stay in sync in both directions: switching tabs updates the hash, and loading or navigating to a hash renders the matching view with its tab active. An unknown or empty hash SHALL fall back to `#/`, and the shell SHALL add no router dependency. A view the shell borrows from the 壹座 web app SHALL render completely on the facet shell without any routing-context ancestor; a host-side navigation affordance that only makes sense inside 壹座 SHALL be suppressible by the shell without altering the borrowed view's data behavior. A conditional view's tab SHALL appear only when the viewer's identity grants it; navigating to a conditional hash without the grant SHALL fall back to the intro landing (the data plane rejects the calls anyway). Depth views SHALL remain reachable within `#/mcp` without adding new top-level hashes.

The server side of the shell SHALL keep three path classes apart: API paths (`/api/**`, `/auth/**`) are never answered with the shell document; machine-surface paths (`/llms.txt`, `/llms-full.txt`, `/catalog.json`, `/robots.txt`) SHALL be answered with 404, because this host owns no machine surface and a soft HTML success is indistinguishable from a real one to a crawler; every remaining path MAY serve the shell document so hash routes resolve on direct entry.

#### Scenario: deep link and refresh

- **WHEN** a visitor opens `#/mcp` directly, or reloads while on `#/packs`
- **THEN** the matching view renders with its tab active

#### Scenario: tab and hash stay in sync

- **WHEN** a visitor switches to the packs market tab
- **THEN** the location hash becomes `#/packs` and a reload keeps that view

#### Scenario: unknown hash falls back

- **WHEN** the location hash is unknown or empty
- **THEN** the intro view renders as the landing

#### Scenario: borrowed view needs no routing context

- **WHEN** the packs market view mounts on the facet shell and public packs exist
- **THEN** pack cards render and the view is interactive (search, detail dialog)
- **AND** no routing provider is present anywhere in the facet shell, and no host-only navigation affordance renders

#### Scenario: conditional tabs follow identity

- **WHEN** an anonymous visitor, a signed-in creator, and an admin each load the shell
- **THEN** the anonymous visitor sees only the four public tabs; the creator additionally sees the creator-console tab (`#/mine`); the admin additionally sees the curation tab (`#/curate`)

#### Scenario: depth views stay inside the mcp hash

- **WHEN** a visitor opens a server's depth view or the skills catalog
- **THEN** the view renders within `#/mcp` (no new top-level hash is introduced), and a reload on `#/mcp` returns to the catalog

#### Scenario: machine paths are not masked by the shell

- **WHEN** an agent requests `/llms.txt`, `/llms-full.txt`, `/catalog.json` or `/robots.txt` on the facet host
- **THEN** the status is 404 and the body is not the shell HTML

#### Scenario: human deep entry still resolves after the machine-path rule

- **WHEN** a visitor loads `#/docs` or `#/packs` directly in a browser
- **THEN** the shell document is served as before and the view renders

### Requirement: Client capabilities are stated as a verified matrix

The facet surface SHALL publish a client-capability matrix — per client: user-level and project-level skill installation, user-level and project-level MCP config writing, marketplace form availability, and the update path — with each cell traceable to either a code fact (what the CLI writes) or a recorded real-environment walkthrough (what the client honors), never invention. The matrix SHALL render in the docs view (derived from the same single-source facts as the command tables, so drift fails tests) and ship in the OSS deep docs. A smoke script SHALL verify the CLI side periodically: isolated-home installs per target with the native config shapes asserted per client, runnable in CI without real credentials.

Every deep-link target the docs view emits SHALL resolve: the matrix's own deep link and every per-client guide link SHALL be addresses that exist in the public repository, and a link that cannot resolve SHALL fail a test rather than ship. The docs view SHALL state the self-hosted install form (the `--base` flag) alongside the official-market form, so a self-hoster following the page does not silently install from the official marketplace.

#### Scenario: The docs view answers "can it" at a glance

- **WHEN** a visitor opens the docs view's install section
- **THEN** the capability matrix renders one row per client with its verified cells, and the deep guides carry the per-client evidence

#### Scenario: The smoke catches a shape drift

- **WHEN** the CLI's write path for any target changes shape (file location or entry form)
- **THEN** the smoke script's assertion for that target fails, forcing the matrix and guides to move with the code

#### Scenario: A dead deep link fails a test

- **WHEN** a docs-view link points at a guide path that is absent from the public repository
- **THEN** a repository test fails naming that path, instead of the visitor meeting a 404

#### Scenario: Self-hosted install form is on the page

- **WHEN** a visitor reading the install section runs a self-hosted facet
- **THEN** the page shows the `--base` form next to the official form, and the command it shows resolves against their own host

### Requirement: The facet CLI carries an honest update path

The CLI SHALL record each install locally (`installed.json` under the facet home: pack id, name, target, scope, project, version, time, and the marketplace base it was installed from) and SHALL offer `facet update [packRef] [--target]`: with no argument every recorded install refreshes; with a pack reference only that pack. Each refresh SHALL fetch the pack's latest published version — an unchanged version reports `已最新` and changes nothing; a newer version rewrites the skill snapshot through the install write path (identical bytes to a fresh install) and reports `v旧 → v新`. A pack that no longer resolves (unpublished, private, gone) SHALL report honestly per pack without aborting the rest. Updating SHALL carry no subscription semantics — it is a snapshot re-fetch, exactly like install.

A refresh SHALL read from the base recorded with that install, not from a global default: an install taken from a self-hosted marketplace SHALL keep updating from that marketplace, and `--base` SHALL override the recorded value for that run. A recorded install whose base is absent (written by an older CLI) SHALL fall back to the official marketplace and say so in its report, rather than silently switching markets.

#### Scenario: A stale install refreshes with version reporting

- **WHEN** a recorded install sits at v2 and the pack's latest is v3, and the deployer runs `facet update`
- **THEN** the skills directory rewrites to v3's snapshot, the record moves to v3, and the output names the pack with `v2 → v3`

#### Scenario: Current installs are a no-op

- **WHEN** every recorded install already matches the latest published version
- **THEN** update reports `已最新` per pack and writes nothing

#### Scenario: A vanished pack never blocks the rest

- **WHEN** one recorded pack no longer resolves
- **THEN** that pack reports its failure honestly and the remaining installs still refresh

#### Scenario: A self-hosted install updates from its own market

- **WHEN** a pack was installed with `--base https://facet.example.internal` and the deployer later runs `facet update` with no `--base`
- **THEN** the refresh resolves against `https://facet.example.internal` and no request reaches the official marketplace

#### Scenario: A legacy record names its fallback

- **WHEN** a recorded install carries no base because an older CLI wrote it
- **THEN** update uses the official marketplace and the per-pack report says the base was defaulted
