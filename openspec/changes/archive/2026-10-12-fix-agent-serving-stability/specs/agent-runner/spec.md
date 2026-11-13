## ADDED Requirements

### Requirement: Materialized runtime homes stay owned by the serving identity

Every (re)materialization of a deployed role's private runtime home — pack update, upgrade respawn, or first touch — SHALL leave the home tree wholly owned by the identity the child runtime runs as, so the child can read its skills, presets, and credentials without permission errors. The runner's default deployment shape (the repository's compose) SHALL run the runner and its children as the image's non-root user, matching the serving identity by construction. When a materialization encounters a home whose existing tree is owned by a different identity: a privileged (root) runner SHALL recursively repair ownership to the configured serving identity and log the repair; an unprivileged runner SHALL fail composition with an explicit error naming the offending path and the remediation, never silently producing a mixed-ownership tree that bricks the child later.

#### Scenario: Pack update preserves child-readable ownership

- **WHEN** a pack update re-materializes a deployed role's home (skills, presets, settings, credentials all rewritten)
- **THEN** every rewritten path is owned by the serving identity and the child's next turn reads its skill files without permission errors

#### Scenario: A foreign-owned home is repaired when privileged

- **WHEN** the runner runs as root and materializes a home whose existing root is owned by another identity (a leftover from a differently-privileged generation)
- **THEN** ownership is recursively repaired to the configured serving identity before the child spawns, and the repair is logged

#### Scenario: A foreign-owned home blocks composition loudly when unprivileged

- **WHEN** an unprivileged runner materializes a home it does not own and cannot repair
- **THEN** composition fails with an explicit error naming the offending path and the remediation, and no half-materialized child serves

### Requirement: A failed cold start leaves no orphan and escalates to a respawn

A child spawn that fails — including an initialize handshake that exhausts its retries — SHALL terminate the already-spawned runtime process before the failure surfaces: no orphaned runtime may outlive the failed spawn or count against the host memory budget. The runner SHALL leave no half-built child entry (a later message re-spawns, never reuses the corpse). A failed cold start SHALL self-heal beyond the in-process retry: the runner retries the whole spawn with a fresh runtime process and backoff, up to a bounded number of respawn attempts; when the bound is exhausted the role surfaces a structured cold-start error distinct from transient turn errors, and the next message still attempts a fresh spawn — recovery never requires a container restart.

#### Scenario: No orphaned runtime after a failed initialize

- **WHEN** a child's initialize exhausts its retries and the spawn fails
- **THEN** the spawned runtime process is terminated, no orphaned process remains, and the host memory budget stops counting it

#### Scenario: A transient registration race self-heals without restart

- **WHEN** a child's initialize loses the adapter-registration race beyond the in-process retry window
- **THEN** the runner respawns the child fresh with backoff and the role serves its next message without a container restart

#### Scenario: Permanent cold-start failure is distinguishable and non-wedging

- **WHEN** respawn attempts are exhausted (e.g. the provider store is missing on this runner)
- **THEN** the role surfaces a structured cold-start error naming the failure, and the next message still attempts a fresh spawn — the runner never wedges until restart
