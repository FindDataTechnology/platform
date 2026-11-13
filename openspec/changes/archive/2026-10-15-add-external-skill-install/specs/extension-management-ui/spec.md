## ADDED Requirements

### Requirement: External skill install flow presents a consent panel before installing

The external-source shelf's entry detail SHALL offer an install action that first opens a consent panel rather than installing directly. The panel SHALL present, before confirmation: what will be installed (skill body excerpt), the package's file inventory with executable-content files (scripts etc.) visually marked, the license state/text as mirrored from upstream, and the upstream origin address. The panel SHALL require an explicit confirmation control before the install action becomes available, and after completion it SHALL report the outcome — success (naming the installed skill) or an explicit failure reason. The "not reviewed by this platform" provenance mark SHALL remain visible on the detail and in the consent panel; the shelf itself SHALL remain browse-only in the sense that no install happens without this per-entry, per-action confirmation.

#### Scenario: install opens the consent panel first

- **WHEN** the user clicks install on an external entry's detail
- **THEN** a consent panel opens showing the body excerpt, file inventory, script marking, license state, and upstream address — nothing is installed until the user confirms

#### Scenario: script-bearing skill requires explicit acknowledgement

- **WHEN** the preview lists executable-content files
- **THEN** the panel presents the script warning and requires the user's explicit acknowledgement before the confirm action is enabled

#### Scenario: successful install reports the outcome

- **WHEN** the user confirms and the server installs the skill
- **THEN** the panel (or the surface that replaces it) reports success and names the installed skill, and the installed skill appears in the installed-skills listing

#### Scenario: failed install reports the reason

- **WHEN** the install request fails (upstream gone, name conflict, package limits)
- **THEN** the panel reports the failure reason returned by the server and does not present the skill as installed

#### Scenario: not-reviewed mark persists through the flow

- **WHEN** the user views an entry's detail or its consent panel
- **THEN** the "not reviewed by this platform" mark remains visible alongside the license state
