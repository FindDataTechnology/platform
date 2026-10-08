# first-run-bootstrap Specification

## Purpose
Defines the one-time initialization the Electron main process performs against a fresh `userData/` directory before the supervisor starts: seeding and merging the settings file, doing so idempotently and atomically, and never blocking app launch when a step fails.

## Requirements

### Requirement: Idempotent first-run initialization
The Electron main process SHALL run a first-run bootstrap step exactly once per fresh `userData/` directory, before the supervisor starts. The bootstrap SHALL be idempotent: on any subsequent launch it SHALL detect existing user files and MUST NOT overwrite them.

#### Scenario: Fresh install, first launch
- **WHEN** the app launches and `userData/settings.json` does not exist
- **THEN** the bootstrap writes a default `settings.json` atomically (temp file + rename) containing the default Volces provider settings
- **AND** the supervisor sees the seeded values via `resolveEnv()`

#### Scenario: Second launch with existing settings
- **WHEN** the app launches and `userData/settings.json` already exists
- **THEN** the bootstrap does NOT overwrite it
- **AND** completes without error

### Requirement: Settings file is merged, not replaced
When `userData/settings.json` exists but is missing keys the bootstrap knows how to seed, the bootstrap SHALL merge the missing defaults into the existing document and write the result atomically. Existing user-set values SHALL always win over seeded defaults.

#### Scenario: Missing key is filled in
- **WHEN** `settings.json` exists but lacks a key the bootstrap seeds
- **THEN** the bootstrap adds that key with its default value
- **AND** writes the merged document atomically (temp file + rename)

#### Scenario: User values are preserved on merge
- **WHEN** `settings.json` already sets a key the bootstrap would seed
- **THEN** the bootstrap leaves the user's value unchanged

### Requirement: Bootstrap failure never blocks app launch
If any bootstrap step fails (disk full, permission denied, corrupt existing file), the bootstrap SHALL log the failure, leave `userData/` in a recoverable state, and allow the supervisor to proceed.

#### Scenario: Corrupt settings.json
- **WHEN** `userData/settings.json` exists but cannot be parsed as JSON
- **THEN** the bootstrap logs an error and leaves the file untouched
- **AND** the supervisor still starts the backend with the inherited environment
- **AND** the app window still opens

#### Scenario: Settings file cannot be written
- **WHEN** writing `userData/settings.json` fails (disk full or permission denied)
- **THEN** the bootstrap logs the failure and does not throw
- **AND** the supervisor proceeds to start the backend
