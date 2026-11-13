## ADDED Requirements

### Requirement: Bridge restart accepts a new working directory

The dsh bridge's `restart()` SHALL accept an optional `cwd` alongside the
existing `provider` and `model` overrides. When supplied, the bridge SHALL use
it as the working directory for both the spawned child process and the
`initialize` handshake, and SHALL retain it for subsequent restarts until
overridden again. When omitted, the bridge SHALL reuse the current working
directory.

#### Scenario: restart with a new cwd

- **WHEN** `restart({ cwd: "/Users/me/proj" })` is called
- **THEN** the bridge SHALL terminate the existing dsh child
- **AND** SHALL spawn a replacement whose process cwd and `initialize` params
  both carry `/Users/me/proj`

#### Scenario: restart without cwd preserves the current one

- **WHEN** `restart({ model: "deepseek-v4-flash" })` is called after a previous
  restart set the cwd to `/Users/me/proj`
- **THEN** the replacement child SHALL be spawned with cwd `/Users/me/proj`

#### Scenario: cwd persists across an unexpected-exit restart

- **WHEN** the dsh child exits unexpectedly after the cwd was changed
- **THEN** the automatic backoff restart SHALL spawn the replacement with the
  most recently set cwd, not the original startup directory
