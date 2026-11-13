## ADDED Requirements

### Requirement: Every deployer is resolved to their real sub2api account by email

The platform SHALL resolve each deploying platform identity to their real sub2api account by matching the identity's email against the sub2api user directory. The platform SHALL NOT create sub2api accounts and SHALL NOT create, hold, or transmit sub2api passwords. The mapping SHALL persist platform-side as identity + account id only. When no account matches, the deploy SHALL be refused with a structured payment-required response carrying the panel URL and SSO guidance, and the copy SHALL distinguish "no account yet — SSO creates it" from "pre-existing account — SSO prompts once for the panel password".

#### Scenario: An existing account is resolved and the mapping persists

- **WHEN** a deployer whose sub2api account already exists (pre-dating the platform) triggers a deploy
- **THEN** the account is found by email, the platform-side mapping is persisted without any credential material, and the deploy proceeds to the balance gate

#### Scenario: No account yields structured login guidance

- **WHEN** a deployer has no sub2api account and triggers a deploy
- **THEN** the deploy is refused with a 402 carrying a machine-readable no-account code and the panel URL, and the balance gate is not evaluated

#### Scenario: The deploy surface reflects account state

- **WHEN** a deployer opens the pack deploy surface
- **THEN** it shows whether their sub2api account is resolved, their balance when known, and a connect-panel action when no account exists

## REMOVED Requirements

### Requirement: Every deployer maps to one sub2api account

**Reason**: Platform-created accounts with platform-held passwords were a workaround for sub2api's lack of admin-side key minting. With the panel's OIDC login live in production, the deployer's own account is directly reachable by its owner; password custody is unnecessary, and for pre-existing same-email accounts (all legacy gateway users) it never worked at all — the live 2026-10-02 finding (`keyRef: null`).
**Migration**: Platform-created accounts from the interim flow are cleaned up per the ops runbook (password handed to the account's owner, or account deleted with balance transferred) so their owners can bind SSO past the panel's choice screen; the platform-side mapping table drops password semantics and is wiped of stored passwords.

### Requirement: Deployment mints one metered key per agent

**Reason**: sub2api exposes no admin-side key creation (verified across the upstream v0.2.x series); keys can only be minted under the user's own panel session, and minting via platform-held passwords contradicts zero custody.
**Migration**: Existing bound deployments keep serving; their bindings are honored by the keep-on-redeploy semantics and re-validated for liveness, at which point deployers rebind with their own keys. Descriptor and runner-side contracts are unchanged — only the key's origin moves to the deployer.

## ADDED Requirements

### Requirement: Deployment binds a deployer-provided metered key per agent

The deploy action SHALL accept, per serving agent, one sub2api API key minted by the deployer in their own panel session and delivered in the deploy request. Before binding, the platform SHALL validate each key's shape, liveness (an auth-only probe that exercises the billing gate), ownership (the key's holder matches the resolved account), and that the agent id belongs to the pack's current serving agents; the same key value SHALL NOT be bound to more than one agent. A serving agent without a bound or provided key SHALL refuse the deploy with a machine-readable key-required code and paste guidance — no fallback to shared platform quota; packs with no serving agents are exempt. Bound keys SHALL be stored under opaque platform-side references. Redeployment omitting keys SHALL keep existing bindings, each re-validated for liveness; explicit null SHALL unbind only non-serving agents; bindings for agents that stop serving SHALL be dropped on redeploy. The deployment descriptor SHALL carry only the opaque key reference, never the key value; the registry entry and every marketplace surface SHALL remain secret-free.

#### Scenario: A deploy binds a deployer-pasted key

- **WHEN** a pack with a serving agent is deployed with a valid key for that agent — shape, liveness, ownership, and agent whitelist all pass
- **THEN** the key is stored under a fresh opaque platform reference, the descriptor carries the reference, and the deploy proceeds

#### Scenario: The key value never rides public surfaces

- **WHEN** the registry entry, descriptor, or marketplace payloads are inspected
- **THEN** no key secret appears anywhere — only the reference

#### Scenario: A serving deploy without a key is refused

- **WHEN** a pack with a serving agent is deployed with neither a pasted key nor an existing binding for that agent
- **THEN** the deploy is refused with a key-required code and paste guidance, and no shared platform quota is substituted

#### Scenario: An invalid key is refused at deploy time

- **WHEN** a pasted key is malformed, dead, owned by a different account, aimed at an unknown or non-serving agent, or a duplicate of another agent's key
- **THEN** the deploy is refused with a key-invalid code and the failing reason

#### Scenario: Redeploy keeps existing bindings and revalidates them

- **WHEN** a pack with bound keys is redeployed without any keys in the request
- **THEN** the existing bindings ride into the new descriptor, each kept key is re-probed for liveness, and a dead kept key refuses the deploy with paste-replacement guidance

#### Scenario: Unbinding follows serving status

- **WHEN** a redeploy explicitly nulls a key binding
- **THEN** nulling a serving agent's binding is refused (a serving key can only be replaced), while a stale binding for an agent that no longer serves is dropped

#### Scenario: Bindings are visible, values are not

- **WHEN** the deployer views a pack's deploy surface after deploying
- **THEN** each serving agent shows whether a key is bound, and no key value is ever displayed or returned
