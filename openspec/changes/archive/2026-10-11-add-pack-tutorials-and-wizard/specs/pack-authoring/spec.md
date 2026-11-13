## ADDED Requirements

### Requirement: Manifests may carry a three-step usage guide

A pack manifest MAY include a `guide` object of the shape `{ steps: [{ title, body }, { title, body }, { title, body }] }` — exactly three steps, each with a non-empty `title` of at most 60 characters and a non-empty `body` of at most 500 characters. The publish validator SHALL reject a manifest whose guide violates this shape (missing steps, wrong count, over-length strings, non-string values) with a readable error, and SHALL accept manifests without a `guide` exactly as before. The guide is content the creator authors in the pack's own language; the platform performs no translation. The creator editor SHALL offer a three-step guide editing section that persists into the draft manifest and is carried through publish unchanged.

#### Scenario: a manifest with a valid guide publishes

- **WHEN** a creator publishes a manifest whose guide has three well-formed steps
- **THEN** the pack publishes and the stored manifest carries the guide unchanged

#### Scenario: a malformed guide is rejected at publish

- **WHEN** a creator publishes a manifest whose guide has two steps, or a step body over 500 characters
- **THEN** publish is rejected with an error naming the guide problem
- **AND** no version is frozen

#### Scenario: packs without a guide are unaffected

- **WHEN** a manifest without a `guide` field is published
- **THEN** validation passes exactly as before this capability
