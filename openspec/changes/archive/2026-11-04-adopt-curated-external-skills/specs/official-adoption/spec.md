## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Adoption tolerates upstream frontmatter that sanitizes to nothing

Adoption SHALL produce a valid official asset for any upstream whose frontmatter, after the runtime-hostile and row-owned keys are removed, carries nothing at all — including the common case where the upstream frontmatter declares only a name and a description. The absence of residual frontmatter SHALL NOT abort adoption and SHALL NOT be represented as an empty or null frontmatter value in the produced asset.

#### Scenario: minimal frontmatter adopts cleanly

- **WHEN** an operator adopts an upstream skill whose frontmatter contains only name and description
- **THEN** adoption succeeds, the produced asset validates, and it simply carries no frontmatter key

#### Scenario: a failing adoption leaves no partial asset

- **WHEN** adoption aborts for any reason (license, pinnability, tool face, validation)
- **THEN** no official asset is written, so a half-built manifest cannot leak into the catalog
