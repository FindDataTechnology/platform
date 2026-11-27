# official-adoption Specification

## Purpose
运营侧把经审校的外部热门技能转正为官方 Agent 的治理与流程面：只有通过许可门与审校的素材才能转正，转正产物以钉定 commit 的内联快照固化、以上游来源与许可证如实标注、以收窄工具面默认上线，并且只存在于平台官方的精选目录中，绝不削弱未审校素材的隔离墙。

## Requirements

### Requirement: Adoption requires a permissive redistributable license

Adopting an external skill as an official Agent SHALL first pass a license gate that admits only licenses permitting redistribution and commercial hosting (MIT, Apache-2.0, BSD family and equivalent permissive licenses). The license SHALL be determined from the upstream package itself — a LICENSE file carried by the package, the upstream package manifest's license field, or an equivalent upstream declaration — and SHALL NOT be taken from the external shelf's mirrored license state, which is not authoritative. When the upstream offers more than one license, the most permissive observed license SHALL govern. A candidate whose license is AGPL-family, non-commercial, proprietary, absent, or otherwise excluded by the curation policy SHALL be rejected before any content is stored as an official asset, and the rejection SHALL name the license axis and record the exact upstream license text observed (or explicitly note that no license was declared).

A proprietary or all-rights-reserved upstream license SHALL be classified as its own rejection axis rather than as an absent declaration: the upstream has declared terms, and what it declared is that redistribution is not granted. A text that states both a permissive license and a blanket reservation of rights SHALL continue to be admitted on the permissive license, so that boilerplate reservation language inside otherwise permissive licenses does not change the outcome.

#### Scenario: permissive license is admitted

- **WHEN** an operator starts adopting an upstream skill whose declared license is MIT
- **THEN** the candidate passes the license gate and may proceed to review

#### Scenario: license is read from upstream, not from shelf metadata

- **WHEN** the external shelf reports the candidate's license state as unknown or absent, but the upstream package carries an MIT LICENSE
- **THEN** the license gate admits the candidate on the upstream license, and the shelf's mirror state does not decide the outcome

#### Scenario: dual license resolves to the permissive one

- **WHEN** the upstream package declares both MIT and a non-commercial license
- **THEN** the gate admits the candidate on the permissive license and records both observed licenses

#### Scenario: AGPL candidate is rejected with the axis named

- **WHEN** an operator attempts to adopt a candidate whose declared license is AGPL-3.0
- **THEN** the adoption is rejected, the license axis is named, and no official asset row is created

#### Scenario: undeclared license is rejected, not guessed

- **WHEN** a candidate's upstream declares no license
- **THEN** the adoption is rejected with an explicit not-declared license note, and no license value is invented

#### Scenario: a proprietary license is rejected on its own axis

- **WHEN** a candidate's upstream LICENSE states that the material is proprietary or that all rights are reserved, and forbids redistribution or derivative works
- **THEN** the adoption is rejected with the proprietary axis named, and the rejection records that a license WAS declared rather than reporting it as absent

#### Scenario: permissive text carrying a reservation of rights is still admitted

- **WHEN** an upstream LICENSE grants a permissive license and also contains boilerplate reservation language such as "all rights reserved"
- **THEN** the gate admits the candidate on the permissive license, and the reservation wording does not turn an admission into a rejection

### Requirement: Adoption snapshots the skill content at a pinned revision and never references the shelf

An adopted official Agent SHALL embed a self-contained snapshot of the skill (body plus auxiliary files) fixed at a named upstream revision (commit sha). The official asset SHALL NOT reference the external shelf entry or re-fetch upstream at runtime; the shelf is a discovery mirror that may be removed or return 404, so an adopted asset SHALL remain complete and usable when the upstream is gone. The snapshot record SHALL carry the upstream revision it was fixed at.

#### Scenario: adopted asset survives upstream deletion

- **WHEN** an adopted Agent's upstream repository is later deleted or returns 404
- **THEN** the official Agent still installs and runs, materializing its snapshotted skill content and auxiliary files

#### Scenario: snapshot records its revision

- **WHEN** an operator inspects an adopted Agent's provenance
- **THEN** the upstream commit revision the content was fixed at is shown alongside the upstream source

### Requirement: Adopted agents carry a distinguishable official-adopted provenance

An adopted official Agent SHALL carry an adopted-provenance record distinct from both FindData-original official entries and unreviewed ecosystem entries, recording at minimum: the upstream source URL, the upstream name, the license as observed, and the pinned revision. Official status SHALL continue to derive from the deployment-side author roster and SHALL NOT be self-declared by the manifest; adopted provenance is a separate source axis, so an entry displays as official-adopted only when both the roster grants official status and the manifest carries the adopted-provenance record. Catalog listings and detail views SHALL render this adopted provenance, and it SHALL remain visually and semantically distinguishable from official-original and from not-reviewed ecosystem material. The pack type badge derivation SHALL remain unchanged by adoption.

#### Scenario: adopted entry is distinguishable from official-original and ecosystem

- **WHEN** a listing shows an adopted Agent beside a FindData-original Agent and an ecosystem-shelf entry
- **THEN** each renders a provenance mark naming which of the three kinds it is

#### Scenario: adopted provenance does not grant official status by itself

- **WHEN** a pack carries an adopted-provenance record but its author is not on the deployment-side official roster
- **THEN** the pack does not display as an official-adopted entry, and no manifest field can make it do so

#### Scenario: adoption leaves the type badge unchanged

- **WHEN** a toolkit- or assistant-shaped pack is adopted
- **THEN** its derived type badge is whatever its structure dictates, unaffected by the adopted-provenance record

#### Scenario: adopted entry exposes its upstream attribution

- **WHEN** a user opens an adopted Agent's detail view
- **THEN** the upstream source URL, upstream name, license, and pinned revision are visible

### Requirement: Adopted agents default to a narrowed tool face

An Agent produced by adoption SHALL default to a narrowed tool face (no shell, file, browser, or sub-agent reach) unless a reviewer has explicitly widened it with a recorded justification. The captured external skill text is untrusted third-party content that reaches the model prompt; a handless default bounds the blast radius of any embedded instruction until a human decides otherwise.

#### Scenario: adopted agent ships handless by default

- **WHEN** an operator forges an Agent from an adopted skill without widening the tool face
- **THEN** the resulting Agent declares a narrowed (chat) tool face and no shell/file/browser/sub-agent reach

#### Scenario: widening requires recorded justification

- **WHEN** an operator widens an adopted Agent's tool face beyond the narrowed default
- **THEN** the widening is recorded with a reviewing operator and a justification, and is visible on the Agent's review record

### Requirement: Adoption is an authenticated operator operation and never a public submission surface

The adoption path SHALL be reachable only by an authenticated operator. There SHALL be no anonymous or end-user-facing endpoint that adopts external material into the official catalog. An adoption action SHALL be attributable to the operator who performed it and the reviewer who approved it.

#### Scenario: unauthenticated adoption is refused

- **WHEN** a request to adopt external material arrives without an authenticated operator identity
- **THEN** the request is rejected and no official asset is created

#### Scenario: adoption is attributable

- **WHEN** an adopted Agent is examined
- **THEN** the adopting operator and the approving reviewer are both recorded

### Requirement: Adopted agents remain updatable on upstream change without silent drift

When the upstream of an adopted Agent changes, updating the official asset SHALL go through a reviewable step that shows the diff from the pinned snapshot and produces a new version; the platform SHALL NOT silently re-fetch and replace adopted content. Existing subscribers SHALL remain on their pinned version until they follow the new version explicitly.

#### Scenario: upstream change surfaces as a reviewable diff

- **WHEN** an adopted Agent's upstream provides a newer revision
- **THEN** the platform surfaces the change as a diff against the pinned snapshot for operator review rather than adopting it automatically

#### Scenario: subscribers do not auto-drift

- **WHEN** an operator publishes a new version of an adopted Agent from an upstream change
- **THEN** existing subscribers stay on their previously pinned version until they explicitly follow the new one

### Requirement: Adoption tolerates upstream frontmatter that sanitizes to nothing

Adoption SHALL produce a valid official asset for any upstream whose frontmatter, after the runtime-hostile and row-owned keys are removed, carries nothing at all — including the common case where the upstream frontmatter declares only a name and a description. The absence of residual frontmatter SHALL NOT abort adoption and SHALL NOT be represented as an empty or null frontmatter value in the produced asset.

#### Scenario: minimal frontmatter adopts cleanly

- **WHEN** an operator adopts an upstream skill whose frontmatter contains only name and description
- **THEN** adoption succeeds, the produced asset validates, and it simply carries no frontmatter key

#### Scenario: a failing adoption leaves no partial asset

- **WHEN** adoption aborts for any reason (license, pinnability, tool face, validation)
- **THEN** no official asset is written, so a half-built manifest cannot leak into the catalog
