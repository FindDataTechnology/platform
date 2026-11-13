## MODIFIED Requirements

<!-- 本 delta 只向既有能力新增需求，不改任何既有需求文本；故 MODIFIED 段为空，
     新需求放 ADDED 段（对既有能力用 ADDED = 该能力的需求集扩充）。 -->

## ADDED Requirements

### Requirement: Guide content is single-sourced in the manifest

Guide copy that any surface renders for a pack SHALL come from the pack manifest's `guide` field, delivered with the pack's versioned data. The web client SHALL NOT carry guide copy keyed by pack id. When the manifest carries no guide, surfaces SHALL render no guide block; they SHALL NOT substitute client-side copy. Publishing a new manifest version SHALL be the only way guide copy changes, and the updated copy SHALL reach every consuming surface without a client release.

#### Scenario: Guide renders from the document

- **WHEN** a pack's manifest declares a three-step guide and a user opens its market detail
- **THEN** the guide block renders those three steps from the manifest data

#### Scenario: No client-side guide copy

- **WHEN** the web client bundle is inspected for guide copy
- **THEN** no guide text is keyed by pack id in client code; guides arrive only with pack data

#### Scenario: Missing guide renders nothing

- **WHEN** a pack's manifest declares no guide
- **THEN** consuming surfaces render no guide block and add no fallback copy

#### Scenario: Copy update rides a version

- **WHEN** an author publishes a new version with edited guide copy
- **THEN** every consuming surface shows the new copy after the version is live, with no client deployment
