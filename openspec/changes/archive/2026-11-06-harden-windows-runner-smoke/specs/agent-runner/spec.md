# Spec delta: agent-runner (paas)

## ADDED Requirements

### Requirement: Runner RSS sampling is platform-safe

The child manager's RSS sampler SHALL return null (caller falls back to the
fixed planning cost) on platforms where neither `/proc` nor a working `ps`
exists — concretely `process.platform === "win32"` short-circuits before any
subprocess is invoked. The sampler MUST NOT emit per-poll subprocess errors
on unsupported platforms.

#### Scenario: Windows runner polls without spawning ps

WHEN the manager samples child RSS on a win32 host
THEN no `ps` subprocess is attempted and no per-poll error text is emitted

#### Scenario: Linux sampling unchanged

WHEN the manager samples RSS on linux or darwin
THEN the existing /proc-then-ps behavior is preserved byte-for-byte

### Requirement: Profile scaffold carries a package identity

The dsh profile scaffold shipped in `dsh-profile-template/package.json`
SHALL declare non-empty `name` AND `version`, because the plugin-package
inventory extension (`identityFromManifest`) rejects manifests missing
either when a freshly materialized profile directory is scanned as an
anchor. A scaffold lacking `version` breaks the first LLM turn on any
platform whose profile dir is scanned directly (Windows desktop).

#### Scenario: Fresh desktop materialization completes its first turn

WHEN an agent home is materialized on a machine with no deployment tree and the served agent answers its first turn
THEN the plugin-package inventory extension resolves every active package without an identity error
