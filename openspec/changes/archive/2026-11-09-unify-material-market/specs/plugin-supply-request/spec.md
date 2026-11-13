## Purpose

A closed-loop request channel that keeps the plugin catalogue curated without making it a dead end: the 插件 tab of the 素材市场 surface shows every plugin the operator has reviewed, a catalogued plugin not baked into this deployment can be asked for with one 申请供应 action, and that ask becomes a de-duplicated row visible to the same supply pipeline that builds the image / desktop predist. Supply stays build-time only — a request never fetches, installs, or runs code — so users gain a way to say "I want this" while the operator keeps the only key that puts a plugin on a deployment.

## ADDED Requirements

### Requirement: 目录内未供应项可被申请供应

A signed-in user SHALL be able to request supply for a plugin that is catalogued but not supplied by the current deployment (`未供应`), from that plugin's row in the 插件 tab. A request record SHALL carry at minimum: the plugin id, the catalogue version the entry was read at, the requester's identity, the requested-at timestamp, and a state of exactly one of `requested` / `queued` / `supplied` / `declined`. `requested` and `declined` are user-visible states; `queued` is recorded by the operator's supply pipeline when the item is accepted into a batch; `supplied` is derived, never written by hand.

#### Scenario: first request for an unsupplied plugin

- **WHEN** a user activates 申请供应 on a `未供应` plugin row
- **THEN** the system SHALL record one request with the plugin id, catalogue version, requester identity, requested-at time, and state `requested`
- **AND** the row SHALL keep showing `未供应`, because the request changes nothing about supply or runtime state
- **AND** the requester SHALL see that their request was recorded

### Requirement: 申请幂等并按插件按部署去重

Requests SHALL be idempotent and de-duplicated per plugin per deployment: asking again for the same plugin in the same deployment SHALL NOT create a second row and SHALL NOT rewrite the first row's requester or requested-at. A request for a plugin the current deployment already supplies SHALL be refused with a clear answer and SHALL create no row at all — the item is not requestable while it is already supplied.

#### Scenario: duplicate request does not create a second row

- **WHEN** the same user, or another user, asks for the same unsupplied plugin again in the same deployment
- **THEN** the system SHALL keep exactly one request row for that plugin in that deployment
- **AND** the original requester and requested-at SHALL be unchanged

#### Scenario: request refused for an already-supplied plugin

- **WHEN** a user requests supply for a plugin that this deployment already supplies
- **THEN** the system SHALL refuse the request, explain that the plugin is already supplied, and create no request row
- **AND** the row SHALL keep reporting `可启用` or `已启用` rather than a request state

### Requirement: 申请不安装也不改变运行时状态

A request SHALL NOT install, download, fetch, resolve, or build anything, and SHALL NOT change the plugin's runtime state, the profile's enabled set, or any patch layer. Its only effect SHALL be to make the item visible to the operator's supply pipeline — the same pipeline that bakes the image / desktop predist. No route SHALL exist by which a user request causes plugin code to be fetched or executed on a running profile, in keeping with the build-time supply invariant of `dsh-plugin-supply`.

#### Scenario: a request never causes code to be fetched

- **WHEN** a user submits 申请供应 for an unsupplied plugin while their profile is running
- **THEN** no package-manager process, download, or install SHALL be triggered
- **AND** the plugin SHALL NOT become loadable, enabled, or present in the profile's module tree
- **AND** the only observable effect SHALL be the request record appearing in the operator's supply pipeline view

### Requirement: 供应后申请状态由供应态派生

When a later deployment supplies a plugin that has an open request, reading that request SHALL report `supplied`, derived from the deployment's supply state and never from a manual edit of the request row. The 插件 tab SHALL then report the plugin as `可启用` (or `已启用` if the profile enables it), and the requester SHALL see that their ask landed.

#### Scenario: request resolves to supplied after a deployment supplies it

- **WHEN** a deployment that includes the requested plugin becomes the deployment serving the profile
- **THEN** reading the request SHALL report `supplied` without anyone editing the request row
- **AND** the 插件 tab SHALL report the plugin as `可启用` or `已启用` with its toggle available
- **AND** the request SHALL NOT be able to report `supplied` while the serving deployment does not supply the plugin

### Requirement: 拒绝申请须给出理由

An operator SHALL be able to decline a request. A declined request SHALL carry a reason, and that reason SHALL be surfaced to the requester in the plugin's row or the request's own view. Declining SHALL NOT itself remove the plugin from the catalogue: the plugin stays listed as `未供应` unless the operator removes it from the catalogue. A declined request SHALL remain idempotent — re-asking SHALL reuse the declined row rather than creating a new one, unless the operator re-opens it.

#### Scenario: declined request shows its reason

- **WHEN** an operator declines a request and records a reason
- **THEN** the request state SHALL read `declined` and the requester SHALL see the reason
- **AND** the plugin SHALL remain in the catalogue as `未供应`, still offering 申请供应
