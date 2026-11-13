## ADDED Requirements

### Requirement: Non-admin users see a read-only model roster
The Models settings section SHALL present non-admin users a read-only view of the models currently available to them — the providers' model rosters with serving status where known — and SHALL NOT render provider management controls (add, edit, delete, test, sync) for those users. Users with the admin role, and any user of an open-access deployment where admin gating is disabled, SHALL continue to see the full provider management surface unchanged. The read-only view SHALL carry no secrets: provider base URLs and API-key presence indicators SHALL follow the same masking rules as the management view.

#### Scenario: non-admin gets the roster without controls
- **WHEN** a signed-in non-admin user opens Settings → Models
- **THEN** the section SHALL list the available models with their provider and serving status where known
- **AND** no add/edit/delete/test/sync control SHALL render

#### Scenario: admin keeps the full management surface
- **WHEN** an admin user opens Settings → Models on the same deployment
- **THEN** the section SHALL render the full provider management surface exactly as before
