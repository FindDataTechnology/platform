## MODIFIED Requirements

### Requirement: Clean-checkout build is self-sufficient
The release pipeline SHALL build a working desktop installer from a fresh checkout with no pre-existing `resources/` directory and no hand-placed binaries. Every bundled resource selected by the resolved bundle manifest (`openconnector`, `python`, `litellm`, `node`, `postgres`) SHALL be produced by a build script invoked during `predist` and asserted present by `verify-bundle.js`; resources for components deselected in the manifest SHALL be skipped by `predist` and SHALL NOT be required by `verify-bundle.js`. `resources/node` SHALL always be built regardless of component selection.

#### Scenario: Fresh checkout builds the macOS installer
- **WHEN** a clean checkout is built on a macOS arm64 runner with the default (all-components) manifest
- **THEN** `predist` produces `resources/openconnector`, `resources/python`, `resources/litellm`, and `resources/node`
- **AND** `verify-bundle.js` passes asserting all four present
- **AND** `npm run dist` produces a `.dmg`

#### Scenario: Fresh checkout builds a lean installer
- **WHEN** a clean checkout is built with a manifest selecting only `openconnector`
- **THEN** `predist` produces `resources/node` and `resources/openconnector` and skips `resources/python`, `resources/litellm`, and `resources/postgres`
- **AND** `verify-bundle.js` passes asserting the selected set
- **AND** `npm run dist` produces a `.dmg` containing no python/litellm/postgres payload

#### Scenario: Bundled Node is reproducibly built
- **WHEN** `resources/node/` is absent
- **THEN** `scripts/build-node.js` downloads the standalone Node for the host platform
- **AND** `verify-bundle.js` fails the build if the platform-correct Node binary is missing

### Requirement: Build caching for cost and reproducibility
The release pipeline SHALL cache the Python pip cache, the `resources/` directory (keyed by OS and `platformBundles`), and the electron-builder cache, so that repeated builds do not re-download python-build-standalone or re-install `litellm[proxy]`. The `resources/` cache key SHALL additionally hash `platform.bundle.json` and the resolved component selection (`PLATFORM_BUNDLE_COMPONENTS`), so a component-selection change never restores a stale cache built for a different component set.

#### Scenario: Cached resources are reused
- **WHEN** a second build runs on the same OS with unchanged `platformBundles` and unchanged component selection
- **THEN** `predist` skips rebuilding already-present `resources/`
- **AND** the pip cache is reused for the litellm install

#### Scenario: Component selection change invalidates the cache
- **WHEN** a build runs with a component selection different from the cached build
- **THEN** the resources cache key differs and the cache is not restored
- **AND** `predist` builds exactly the newly selected component set

## ADDED Requirements

### Requirement: Dispatch-time component selection
The release workflow SHALL expose a `workflow_dispatch` input for component selection (comma-separated component names, or `all` / `none`), passed to the build as `PLATFORM_BUNDLE_COMPONENTS`. When the input is empty, the build SHALL use the manifest's `components` selections unchanged. Tag-triggered builds SHALL use the manifest unchanged.

#### Scenario: Manual dispatch builds a lean installer
- **WHEN** the workflow is dispatched with component input `openconnector`
- **THEN** all matrix jobs build installers containing only the node + openconnector payloads
- **AND** the artifacts are distinguishable from full-bundle artifacts

#### Scenario: Empty input defers to the manifest
- **WHEN** the workflow is dispatched with an empty component input
- **THEN** the build resolves components from `platform.bundle.json`
