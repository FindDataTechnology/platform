## ADDED Requirements

### Requirement: Packaged tree covers every referenced runtime directory

The packaging file list SHALL include every runtime directory the bundled application references — through supervisor descriptor spawn paths and the server's module graph (server, lib, services, gateway, agent-runner, dsh profile template, …). `verify-bundle.js` SHALL assert before packing that each runtime directory referenced by a supervisor descriptor exists in the tree being packaged; a missing referenced directory SHALL fail the build at the assertion with the missing path named, rather than surfacing as `ERR_MODULE_NOT_FOUND` on an installed app.

#### Scenario: descriptor referencing an unpackaged directory fails the build

- **WHEN** a supervisor descriptor spawns a script under a directory that is absent from the packaging file list
- **THEN** `verify-bundle.js` fails the build before packing, naming the missing directory

#### Scenario: the fleet runner ships with the installer

- **WHEN** the desktop fleet runner descriptor (spawning `agent-runner/index.js`) is present
- **THEN** the packaged tree contains the agent-runner runtime directory and a packaged app can spawn the seat runner

#### Scenario: a future runtime directory cannot silently go unpackaged

- **WHEN** a later change adds a runtime directory referenced by descriptors or the server module graph without adding it to the file list
- **THEN** the packaging build fails in CI, not on user machines after install
