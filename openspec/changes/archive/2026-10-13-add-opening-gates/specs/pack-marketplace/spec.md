# pack-marketplace 变更（add-opening-gates）

## MODIFIED Requirements

### Requirement: Publishing is identity-gated

Publishing SHALL be allowed only for authenticated users whose platform groups include the configured creator group (default `creators`), unless the deployment's access mode is `open`. The access mode SHALL be read from `PACK_ACCESS_MODE` with `closed` as the default; in `closed` mode the creator-group gate applies exactly as before (byte-identical refusals), and in `open` mode any authenticated user MAY publish — the creator group remains required for nothing on this path. Every other user SHALL receive a rejection. The gateway SHALL stamp the publishing user's identity and the publish time onto the stored version; the manifest itself SHALL NOT carry author-controlled identity claims. Both arrival surfaces — the cell-assembled flow on 壹座 and the publish-from-manifest flow on the facet surface — SHALL pass through the same gate and the same manifest validation.

#### Scenario: Creator publishes

- **WHEN** a user whose groups include `creators` submits a valid pack manifest to the publish endpoint
- **THEN** the pack is stored and the response returns its identifier and version

#### Scenario: Non-creator is rejected

- **WHEN** a user without the creator group submits a manifest to the publish endpoint in `closed` mode
- **THEN** the gateway rejects the request with an authorization error and stores nothing

#### Scenario: Manifest publish and cell-assembled publish share the gate

- **WHEN** the same creator publishes the same manifest shape via the facet console and via the 壹座 cell-assembled flow
- **THEN** both pass the identical identity gate and manifest validation, and both store versions stamped with the same author identity

#### Scenario: Open access mode admits any authenticated user

- **WHEN** `PACK_ACCESS_MODE=open` and a user without the creator group submits a valid manifest
- **THEN** the pack is stored under that user's identity — the same rate limiter, manifest validation, and tool gate apply unchanged

#### Scenario: Closed remains the default

- **WHEN** `PACK_ACCESS_MODE` is unset (or any value other than `open`) and a non-creator publishes
- **THEN** the refusal is byte-identical to the pre-change contract
