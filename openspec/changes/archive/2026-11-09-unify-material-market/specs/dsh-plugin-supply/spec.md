# dsh-plugin-supply Specification Delta

## MODIFIED Requirements

### Requirement: Deployment supplies whitelisted bundles at build time

The deployment SHALL declare its supplied dsh plugin bundles in one operator-owned
place (the profile template's manifest bundle list plus the dsh install matrix), so
that every bundle is installed at image-build / desktop-predist time and never at
runtime. A whitelisted bundle SHALL resolve through the same module-resolution anchor
as the profile's own plugins (the profile directory's module chain, backed by the
deployment's linked module tree). The platform SHALL NOT download, install, or build
any plugin package while a profile is running.

This invariant is untouched by the move of the plugin surface out of Settings and
into the 插件 tab of the 素材市场 surface. Being listed in the operator's curated
plugin catalogue (per `supply-catalog`) SHALL NOT be read as a supply declaration:
catalogue membership says what MAY be offered, while the supply list — the profile
template's manifest bundle list plus the dsh install matrix — is the only thing that
puts a plugin on a deployment. A catalogued plugin absent from the supply list SHALL
be reported as `未供应` by the catalogue view and SHALL NOT be presented as a
toggleable bundle.

#### Scenario: bundle visible after provisioning

- **WHEN** the operator adds a bundle package to the deployment matrix and declares it in the profile template's bundle list
- **THEN** every newly materialized profile SHALL compose that bundle's patch layer at boot
- **AND** no package-manager process SHALL run during profile boot or runtime

#### Scenario: no runtime install paths

- **WHEN** any client or agent requests installation of a package at runtime
- **THEN** the platform SHALL expose no such route
- **AND** the agent-facing plugin-manager tool SHALL remain disabled

### Requirement: Read-only bundle inventory projection

The 插件 tab of the 素材市场 surface SHALL expose the read-only plugin catalogue view:
for every plugin in the operator-curated catalogue — supplied or not — a row carrying
at minimum its identifier, display name, one-line description, the five-locale name
and description taken from the catalogue annotation (per `supply-catalog`), and
exactly one of three supply states:

- `可启用` — supplied with this deployment and currently disabled; the enable toggle is available;
- `已启用` — supplied with this deployment and currently enabled;
- `未供应` — catalogued but not baked into this deployment; the row offers 申请供应 (per `plugin-supply-request`) and no toggle.

Supplied rows SHALL also carry the effective enabled state and — when the underlying
loader has it — the live phase and any error metadata. The view SHALL be a
point-in-time snapshot and SHALL reflect composition changes after the next read. It
SHALL NOT render any row whose state is undecidable: a plugin is supplied or it is
not. A catalogued-but-unsupplied row SHALL NOT render a disabled toggle that pretends
it could work; it SHALL render the 申请供应 affordance instead. Enable/disable and
apply semantics remain governed by "Enable/disable persists to the profile patch
layer" and "Apply semantics follow the model-switch family" unchanged: this view
reads state and never writes it.

#### Scenario: client reads the inventory

- **WHEN** a client requests the plugin catalogue view
- **THEN** the server SHALL answer one row per catalogued plugin — including catalogued plugins this deployment does not supply — with id, name, one-line description, five-locale name/description, and its supply state
- **AND** a supplied plugin whose composition carries an error SHALL surface that error on its row rather than being omitted or reported as enabled

#### Scenario: inventory reflects a toggle after re-application

- **WHEN** a supplied bundle has been disabled and the change has been applied
- **THEN** a subsequent catalogue read SHALL report that plugin as `可启用` rather than `已启用`

#### Scenario: the three supply states each render once

- **WHEN** the 插件 tab renders a catalogue containing one supplied-and-enabled plugin, one supplied-and-disabled plugin, and one catalogued-but-unsupplied plugin
- **THEN** the three rows SHALL carry `已启用`, `可启用`, and `未供应` respectively, and no row SHALL carry more than one state
- **AND** the `可启用` and `已启用` rows SHALL expose the enable toggle, while the `未供应` row SHALL NOT
- **AND** the `未供应` row SHALL offer 申请供应 and SHALL state that the plugin is not baked into this deployment

#### Scenario: catalogue present but nothing supplied

- **WHEN** the deployment's catalogue carries plugins but none of them is in the supply list
- **THEN** the tab SHALL render every catalogued row as `未供应` above an explanatory empty state that says no plugin is supplied with this deployment and that 申请供应 is the way to ask for one
- **AND** the pane SHALL NOT render blank, and SHALL NOT render a disable-all or empty-toggle placeholder
