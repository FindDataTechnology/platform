# platform-billing Delta

## Purpose

The billing domain of the public agent platform (ADR-0011): deployer accounts on the sub2api gateway (prepaid balance), one metered API key per deployed agent, a secret-free distribution channel to the runner, and the balance gate that makes prepaid quota the admission rule.

## ADDED Requirements

### Requirement: Every deployer maps to one sub2api account

The platform SHALL map each deploying platform identity to exactly one sub2api user (deterministic username derivation from the platform identity), creating it via the admin API with platform-held service credentials on first deploy and reusing it thereafter. The mapping SHALL persist platform-side. The admin API key SHALL live in the platform's secret store, never in code or manifests.

#### Scenario: First deploy ensures the account

- **WHEN** an identity deploys for the first time and no sub2api mapping exists
- **THEN** the platform creates the sub2api user, persists the mapping, and the deployment proceeds

#### Scenario: Later deploys reuse the account

- **WHEN** the same identity deploys again
- **THEN** the same sub2api account is used and no duplicate is created

### Requirement: Deployment mints one metered key per agent

Each deploy action SHALL mint, via the admin API on the deployer's behalf, one sub2api API key per serving agent — carrying a USD quota and the 5h/1d/7d spending windows — and store it in the platform's deployment records. The deployment descriptor SHALL carry only an opaque key REFERENCE, never the key value; the registry entry and every marketplace surface SHALL remain secret-free.

#### Scenario: A deploy mints a metered key

- **WHEN** a pack version with a serving-contract agent is deployed
- **THEN** one key is minted under the deployer's sub2api account with quota and spending windows, and the descriptor references it by id

#### Scenario: The key value never rides public surfaces

- **WHEN** the registry entry, descriptor, or marketplace payloads are inspected
- **THEN** no key secret appears anywhere — only the reference

### Requirement: The runner fetches agent keys over an authenticated channel

The platform SHALL serve the per-agent key value to the runner through a gateway route authenticated by the runner's service credential, keyed by the descriptor's key reference; the runner SHALL inject the fetched key into that agent's child as its LLM credential (replacing the runner-level shared quota for deployed agents). A revoked or exhausted key SHALL fail that agent's turns with the gateway's quota error, never a fallback to another key.

#### Scenario: The child runs on its own key

- **WHEN** a deployed agent's child composes
- **THEN** its LLM calls carry the agent's own sub2api key, and its consumption lands on the deployer's metering

#### Scenario: No silent key fallback

- **WHEN** an agent's key is exhausted or revoked and a turn is attempted
- **THEN** the turn fails with the quota error surfaced to the caller, and no other credential is substituted

### Requirement: Deployment is balance-gated with visible balance

The deploy action SHALL be admitted only when the deployer's sub2api balance exceeds a configured threshold (read via the admin API). The platform SHALL surface the deployer's balance read-only in the deploy surface with a low-balance warning banner linking to the recharge path. Day-one recharge is operator-managed (redeem codes or manual balance adjustment) — the built-in payment gateway remains unconfigured until operations decide otherwise.

#### Scenario: Zero balance blocks deploy

- **WHEN** a deployer whose balance is at or below the threshold triggers a deploy
- **THEN** the action is refused with the balance reason and a recharge hint

#### Scenario: Balance and warning are visible

- **WHEN** the deployer opens the pack deploy surface
- **THEN** their current balance is shown, with a warning banner under the threshold
