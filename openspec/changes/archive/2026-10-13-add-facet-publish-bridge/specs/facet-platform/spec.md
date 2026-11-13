## REMOVED Requirements

### Requirement: One identity provider, two arrival channels

**Reason:** The publish bridge (F3.2) adds a third arrival channel — a paired device's app token — so the "two channels" shape no longer holds; reshaped below with the same scenarios plus the new channel.

## ADDED Requirements

### Requirement: One identity provider, three arrival channels

The facet service SHALL authenticate direct visitors via OIDC authorization-code flow against the same identity tenant 壹座 uses — same users, same organizations, same creator groups — issuing its own session cookie scoped to the facet domain; SHALL accept proxy-forwarded verified identity from 壹座 as the second channel; and SHALL accept a paired device's verified app token (the device-pairing surface mounted on the facet service) as the third. A user SHALL be one identity across all channels: publishing, subscriptions, and deployment ownership are recorded under one key regardless of arrival surface.

#### Scenario: Same user publishes from either surface

- **WHEN** a creator publishes a pack on the facet domain and later subscribes to another pack through 壹座's embedded surface (or vice versa)
- **THEN** both actions are recorded against the same identity, and creator gating applies identically on both surfaces

#### Scenario: Silent sign-in on the facet domain

- **WHEN** an already-authenticated 壹座 user initiates login on the facet domain
- **THEN** the OIDC flow completes via the shared tenant without a credential prompt

#### Scenario: A paired device token publishes on the facet domain

- **WHEN** a CLI publishes through the facet domain with an app token whose account identity is in a creator group
- **THEN** the publish is recorded under that account identity and passes exactly the same creator gating, manifest validation, and rate limiting as a web-session publish
