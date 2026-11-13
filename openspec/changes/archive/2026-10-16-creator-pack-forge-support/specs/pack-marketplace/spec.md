# pack-marketplace 变更 Delta

## ADDED Requirements

### Requirement: Manifests can be validated without publishing

The facet service SHALL expose a manifest validation endpoint that accepts the same request body as publishing a pack and returns the verdict publishing would return, without performing the publish. Validation SHALL be available to any authenticated caller regardless of creator-group membership; lack of publish eligibility SHALL be reported as a caller finding, not as a rejection. A validation call SHALL NOT mint a pack id or version, SHALL NOT persist any record, and SHALL NOT consume any publish-rate budget.

#### Scenario: Non-creator validates a sound manifest

- **WHEN** an authenticated caller outside the creators group submits a manifest that passes every publish gate
- **THEN** the endpoint returns success with `valid: true`, no manifest errors, and a caller finding stating that the caller cannot publish yet

#### Scenario: Invalid manifest gets publish-identical errors

- **WHEN** a submitted manifest fails structural limits, the files gate, or the tool-declaration gate
- **THEN** the endpoint reports `valid: false` with error wording identical to the corresponding publish rejection

#### Scenario: Registry unreachable during tool verification

- **WHEN** the manifest declares tool names and the registry index cannot be reached to verify them
- **THEN** the endpoint reports `valid: false` with the same fail-closed message publishing would return, and no verdict of validity is implied

#### Scenario: Continuation to an existing pack is checked read-only

- **WHEN** the request carries a pack id for a new version and the caller is not the pack's author, or the pack does not exist
- **THEN** the endpoint reports the same outcome publishing would report, without creating or modifying any version

#### Scenario: Validation is side-effect free

- **WHEN** the same manifest is validated repeatedly
- **THEN** no pack record or version is created and the author's publish budget is unchanged

#### Scenario: Anonymous callers are rejected

- **WHEN** an unauthenticated request hits the validation endpoint
- **THEN** it is rejected with the same authentication failure as the other pack write endpoints
