# dsh-plugin-supply Specification

## Purpose

The dsh-layer plugin supply surface: operator-whitelisted dsh plugin bundles ship with
the deployment (image and desktop alike), every profile exposes a read-only inventory
of those bundles with their live state, and a user can enable or disable a whitelisted
bundle with the change persisted to the profile's own patch layer — without editing
YAML, without a runtime package manager, and without ever installing or running
third-party code at runtime in this version.

## ADDED Requirements

### Requirement: Deployment supplies whitelisted bundles at build time

The deployment SHALL declare its supplied dsh plugin bundles in one operator-owned
place (the profile template's manifest bundle list plus the dsh install matrix), so
that every bundle is installed at image-build / desktop-predist time and never at
runtime. A whitelisted bundle SHALL resolve through the same module-resolution anchor
as the profile's own plugins (the profile directory's module chain, backed by the
deployment's linked module tree). The platform SHALL NOT download, install, or build
any plugin package while a profile is running.

#### Scenario: bundle visible after provisioning

- **WHEN** the operator adds a bundle package to the deployment matrix and declares it in the profile template's bundle list
- **THEN** every newly materialized profile SHALL compose that bundle's patch layer at boot
- **AND** no package-manager process SHALL run during profile boot or runtime

#### Scenario: no runtime install paths

- **WHEN** any client or agent requests installation of a package at runtime
- **THEN** the platform SHALL expose no such route
- **AND** the agent-facing plugin-manager tool SHALL remain disabled

### Requirement: Read-only bundle inventory projection

The server SHALL expose a read-only inventory of the profile's bundle composition:
for each whitelisted bundle, at minimum its identifier, display description,
effective enabled state, and — when the underlying loader has it — its live phase
and any error metadata. The inventory SHALL be a point-in-time snapshot and SHALL
reflect composition changes after the next read.

#### Scenario: client reads the inventory

- **WHEN** a client requests the bundle inventory
- **THEN** the server SHALL answer one row per declared bundle with id, description, enabled state, and available phase/error metadata
- **AND** a bundle whose composition carries an error SHALL surface that error on its row rather than being omitted

#### Scenario: inventory reflects a toggle after re-application

- **WHEN** a bundle has been disabled and the change has been applied
- **THEN** a subsequent inventory read SHALL report that bundle as disabled

### Requirement: Enable/disable persists to the profile patch layer

The server SHALL accept an enable/disable directive for a whitelisted bundle row and
persist it as a `disabled` override in the profile's own patch layer, matching the
upstream plugin-manager's write semantics (last matching override wins, one appended
when none matches). The directive SHALL NOT touch the user's other patch content and
SHALL NOT modify the deployment's read-only module tree.

#### Scenario: disable survives a profile restart

- **WHEN** a user disables a whitelisted bundle and the dsh child later restarts
- **THEN** the recomposed profile SHALL keep that bundle disabled

### Requirement: Apply semantics follow the model-switch family

Applying a toggle SHALL either recompose the live profile through upstream HMR when
that watcher is active, or restart the dsh child through the established bridge
restart path with sessions resumed by id — the same family of apply semantics as a
model switch. A toggle requested while the agent is streaming SHALL be rejected with
a reason the client can render, and a rejected toggle SHALL leave the previously
reported state intact.

#### Scenario: toggle rejected while streaming

- **WHEN** a client requests a toggle while the shared runtime is streaming
- **THEN** the server SHALL refuse the directive with an explicit busy reason
- **AND** the inventory SHALL keep reporting the previous enabled state

#### Scenario: toggle applies and sessions resume

- **WHEN** a client toggles a bundle while the runtime is idle and the apply path requires a child restart
- **THEN** the bridge SHALL restart the dsh child
- **AND** existing sessions SHALL be resumable after the restart

### Requirement: Per-profile isolation across topologies

Toggle state SHALL live in the profile's own patch layer, so each profile keeps its
own enablement: in the hosted-cell topology each cell's per-user `DSH_HOME` yields
per-user enablement with no cross-user leakage, and on desktop it is per-installation.
One user's toggle SHALL NOT affect another user's cell, and SHALL NOT modify any
shared deployment asset.

#### Scenario: two cells diverge

- **WHEN** user A disables a bundle in their cell and user B keeps it enabled
- **THEN** user B's cell SHALL compose the bundle unchanged
- **AND** the shared module tree SHALL show no mutation

### Requirement: Supply failures are observable, never opaque

If a whitelisted bundle fails to resolve, import, or activate, the failure SHALL
appear in the inventory row's error metadata and in server logs, and SHALL NOT abort
boot of the profile's remaining composition. A bundle that cannot load SHALL NOT be
reported as enabled.

#### Scenario: broken bundle surfaces

- **WHEN** a whitelisted bundle's activation fails
- **THEN** the inventory SHALL list the bundle with its error metadata
- **AND** the rest of the profile SHALL boot normally
