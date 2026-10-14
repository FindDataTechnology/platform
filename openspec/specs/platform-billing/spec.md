# platform-billing Specification

## Purpose

The billing domain of the public agent platform (ADR-0011): deployer accounts on the sub2api gateway (prepaid balance), one metered API key per deployed agent, a secret-free distribution channel to the runner, and the balance gate that makes prepaid quota the admission rule.

## Requirements

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

### Requirement: External turns settle against the caller's key at the boundary

Facade-admitted external turns SHALL be charged to the caller's own sub2api key by duration — rounded up to whole minutes at the platform-configured rate — settled as an idempotent admin balance deduction on turn completion. The serving agent's actual model consumption SHALL continue on the deployer's bound key; the settlement amount is a function of duration and rate, independent of token usage. Until sub2api gains a native usage-recording endpoint, the facade ledger is the authoritative usage record for external turns; calls on the internal registry path (web chat, delegation) remain deployer-paid and produce no caller settlement — the dual-track model of ADR-0014.

#### Scenario: An external turn charges the caller by duration

- **WHEN** a facade-admitted turn of 90 seconds completes at a configured per-minute rate
- **THEN** the caller's balance is deducted for 2 minute-units at that rate, while the deployer-side key flow for the agent is unchanged

#### Scenario: Internal calls stay deployer-paid

- **WHEN** the same agent serves an internal registry-path call (web chat or delegation)
- **THEN** no caller settlement occurs and no caller ledger entry is written

#### Scenario: One turn, one deduction

- **WHEN** the settlement attempt is retried after a transient sub2api failure
- **THEN** the balance deduction lands exactly once, guarded by an idempotency key

#### Scenario: The ops board shows both dimensions

- **WHEN** an operator opens the billing board
- **THEN** external usage is viewable by caller and by agent alongside the existing deployer-side view

### Requirement: Ecosystem MCP consumption is metered with a monthly free grant

Calls through the registry gateway on a caller key to data and ecosystem servers SHALL be metered on the wire line as the single ledger — the facet and marketplace surfaces only relay, never record their own usage rows. Each caller key SHALL carry a monthly free grant of gateway calls (default 5,000 per calendar month, operator-configurable), resetting monthly. Beyond the grant, the preflight gate SHALL refuse admission with a quota error before any upstream touch, on the same fail-closed semantics as the existing preflight (billing disconnection refuses closed, never open). Metered consumption SHALL land in the sub2api account ledger so the grant, the overage refusal, and the account balance reconcile as one story; a ledger hard-stop SHALL bound runaway consumption when the ledger path is degraded.

#### Scenario: Free grant admits without charge

- **WHEN** a caller key's monthly call count is below the free grant
- **THEN** calls are admitted and the metered count is visible to the key's owner

#### Scenario: Grant exhaustion blocks upstream

- **WHEN** a caller key exhausts its monthly grant and another call arrives
- **THEN** the preflight gate refuses with a quota error and the upstream server is not touched

#### Scenario: One ledger, no parallel books

- **WHEN** metered ecosystem usage is inspected from any surface (ops board, key owner's usage view)
- **THEN** the numbers come from the wire-line ledger; no second usage tally exists at facet or marketplace

#### Scenario: Ledger degradation fails closed with a hard stop

- **WHEN** the ledger path is unavailable or degraded while calls keep arriving
- **THEN** the hard-stop bound refuses admission rather than letting unmetered calls through, and the refusal is visible to the operator
