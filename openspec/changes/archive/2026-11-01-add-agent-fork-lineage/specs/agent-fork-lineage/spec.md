## Purpose

Learn-and-remix for the agent ecosystem: any agent a user can read, they can clone into their own editable working document — with the fork's lineage stamped and preserved, official status never conferred by forking, and the write always landing in the user's own cell.

## ADDED Requirements

### Requirement: Fork seeds an editable working document from a readable manifest

A fork action SHALL be available wherever an agent is presented with a readable manifest (spec sheet, market detail, official gallery). Forking SHALL seed the Agent Studio working document from the full manifest the caller is permitted to read, and SHALL NOT directly publish, deploy, or cast anything. The forked document is a draft until the user emits it through the existing emit targets and their gates.

#### Scenario: Fork a public agent

- **WHEN** an authenticated user activates fork on a public agent's spec sheet
- **THEN** their Agent Studio opens with a working document seeded from that manifest, and no market entry, deployment, or blueprint is created

#### Scenario: Read gate bounds the fork

- **WHEN** a user cannot read an agent's full manifest (private pack outside their visibility)
- **THEN** the fork action is unavailable for that agent

### Requirement: Fork lineage is stamped, validated, and preserved

A forked document MAY carry lineage as an optional `forkOf` block (`{ packId, version }`) on `provenance`. The manifest validator SHALL accept this optional key and validate its shape; the fork's `kind` SHALL remain within the existing provenance kinds (a fork reads as community material derived from its parent). Lineage SHALL survive republishing: a fork published as new versions keeps its `forkOf` pointing at the original pack and version. The publish gate, version immutability, and all existing provenance kinds SHALL be unchanged.

#### Scenario: Lineage stamped on fork

- **WHEN** a user forks pack X version N and later emits the document as a pack draft that gets published
- **THEN** the published manifest carries `provenance.forkOf` = `{ packId: X, version: N }` and `kind` within the existing three states

#### Scenario: Lineage survives republish

- **WHEN** the author of a forked pack publishes version N+1 with content edits
- **THEN** the N+1 manifest still carries the same `forkOf` lineage unless the author explicitly removes it (a new version may change it, but it does not disappear silently)

#### Scenario: Validator accepts the optional key

- **WHEN** a manifest carries a well-formed `forkOf` block
- **THEN** it passes the existing manifest validation; a malformed block is rejected with a field-level error

### Requirement: Forking never confers official status

Official status SHALL be determined solely by the deployment-side official roster, as today. A fork of an official agent SHALL NOT be presented as official by virtue of its parentage; its provenance source SHALL read as community unless the roster independently marks its author official.

#### Scenario: Fork of an official agent

- **WHEN** a user forks an official agent and publishes the fork under their own authorship
- **THEN** the fork is not in the official set and does not render an official badge

### Requirement: Lineage is displayed where the fork is presented

A surface presenting a forked agent SHALL be able to show its lineage ("forked from" the parent pack and version) alongside the provenance axes. Absence of lineage renders no lineage line.

#### Scenario: Forked agent shows lineage

- **WHEN** a spec sheet presents a pack whose manifest carries `forkOf`
- **THEN** the presentation includes the forked-from reference; a pack without `forkOf` shows no lineage line

### Requirement: Cross-domain fork writes land in the user's cell only

The fork affordance on the facet (谦面) surface SHALL be a deep link: activating it on facet routes the user to 壹座 (Logto SSO as today) where the fork is materialized in their cell. facet SHALL NOT perform the fork write itself; cell-side authoring remains a 壹座 surface.

#### Scenario: Fork from facet

- **WHEN** a signed-in viewer activates fork on the facet surface
- **THEN** they land in 壹座's Agent Studio with the seeded working document, and no write occurred on the facet side
