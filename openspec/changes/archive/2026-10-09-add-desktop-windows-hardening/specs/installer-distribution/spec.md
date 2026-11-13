## ADDED Requirements

### Requirement: Assisted installer is explicitly configured
The Windows installer MUST be produced as an assisted (wizard) installer, with the NSIS options declared at the configuration top level rather than nested under a platform key.

#### Scenario: NSIS options live at the top level
- **WHEN** the packaging configuration is loaded
- **THEN** the NSIS block is a top-level configuration key
- **AND** the packager reads it (a block nested under the Windows platform key is silently ignored)

#### Scenario: Installer exposes directory choice, progress and completion
- **WHEN** the user runs the Windows installer
- **THEN** the installer presents a wizard with an installation-directory choice
- **AND** shows progress during unpacking
- **AND** shows a completion page
- **AND** allows canceling the installation

#### Scenario: Per-user install by default
- **WHEN** installing on Windows without a signed binary
- **THEN** the install targets the per-user location
- **AND** does not require elevation

### Requirement: Packaging closure covers runtime-only packages
The packaged app MUST contain every package the runtime resolves, including packages that the package manager installed as peers but that no manifest declares as a dependency.

#### Scenario: Peer-only runtime packages ship in the installer
- **WHEN** the agent runtime loads components that are declared only as peer dependencies
- **THEN** those components are present in the packaged app
- **AND** the runtime boots without a module-not-found failure

#### Scenario: Dynamically loaded runtime tree ships intact
- **GIVEN** the agent runtime resolves a large component tree from its own nested directory
- **WHEN** the app is packaged
- **THEN** that nested tree is copied into the package by an explicit resource declaration
- **AND** the packaged tree matches the development tree package-for-package

#### Scenario: Install resolves conflicting peer generations
- **WHEN** declared packages carry mutually incompatible peer ranges across two generations
- **THEN** installation proceeds with peer resolution relaxed
- **AND** the lockfile remains the source of truth for the resolved tree

### Requirement: Profile module links are maintained by the app
The app MUST ensure the agent profile can resolve its bare-specifier plugins on a machine that has no out-of-band provisioning.

#### Scenario: Bridge plugin dependencies are linked into the profile
- **WHEN** the app prepares the agent home
- **THEN** the packages the profile bridge plugins import are linked into the profile's module directory
- **AND** links point at the app's own copies

#### Scenario: Links do not shadow the runtime's own resolution
- **WHEN** linking packages for the profile
- **THEN** only the packages the bridges import are linked
- **AND** the runtime's own plugin names continue resolving from the runtime's own tree
- **AND** no link replaces a path the agent runtime itself manages

#### Scenario: Stale non-link entries are cleared before linking
- **GIVEN** a previous install left a real directory where the runtime expects a managed link
- **WHEN** the app prepares the agent home
- **THEN** the stale entry is removed and replaced by a link
- **AND** the runtime's boot does not abort with an ownership error

### Requirement: Readiness reflects the agent runtime
The readiness endpoint MUST report healthy only when the agent runtime actually initialized.

#### Scenario: A degraded agent keeps readiness unhealthy
- **WHEN** agent initialization fails but the server degrades instead of exiting
- **THEN** the readiness endpoint remains non-200
- **AND** the response exposes the initialization error
- **AND** readiness later follows runtime events as the runtime recovers or dies

#### Scenario: A healthy agent reports ready
- **WHEN** agent initialization succeeds
- **THEN** the readiness endpoint returns 200
