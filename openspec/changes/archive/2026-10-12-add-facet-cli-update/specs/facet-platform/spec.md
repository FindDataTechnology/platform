## ADDED Requirements

### Requirement: The facet CLI carries an honest update path

The CLI SHALL record each install locally (`installed.json` under the facet home: pack id, name, target, scope, project, version, time) and SHALL offer `facet update [packRef] [--target]`: with no argument every recorded install refreshes; with a pack reference only that pack. Each refresh SHALL fetch the pack's latest published version — an unchanged version reports `已最新` and changes nothing; a newer version rewrites the skill snapshot through the install write path (identical bytes to a fresh install) and reports `v旧 → v新`. A pack that no longer resolves (unpublished, private, gone) SHALL report honestly per pack without aborting the rest. Updating SHALL carry no subscription semantics — it is a snapshot re-fetch, exactly like install.

#### Scenario: A stale install refreshes with version reporting

- **WHEN** a recorded install sits at v2 and the pack's latest is v3, and the deployer runs `facet update`
- **THEN** the skills directory rewrites to v3's snapshot, the record moves to v3, and the output names the pack with `v2 → v3`

#### Scenario: Current installs are a no-op

- **WHEN** every recorded install already matches the latest published version
- **THEN** update reports `已最新` per pack and writes nothing

#### Scenario: A vanished pack never blocks the rest

- **WHEN** one recorded pack no longer resolves
- **THEN** that pack reports its failure honestly and the remaining installs still refresh
