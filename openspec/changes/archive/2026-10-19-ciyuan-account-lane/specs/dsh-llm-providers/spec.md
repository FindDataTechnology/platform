# dsh-llm-providers Delta

## ADDED Requirements

### Requirement: A bound ciyuan account overrides the deployment seed per hosted cell

In hosted deployments where each cell serves exactly one identity, the credential store writer SHALL, when that identity has a bound ciyuan account key, write it as the value of the ciyuan provider's env ref (`LLM_PROVIDER_KEY_FINDDATA`) instead of the deployment seed from `llm-providers.json`. The override SHALL ride the same hot-reloaded store, so it reaches the **next LLM request** without a dsh restart; removing the binding (disconnect or stale) SHALL restore the seed value on the next store write. In single-process deployments serving several identities from one store, the writer SHALL NOT apply any per-identity override.

#### Scenario: bound key wins over the seed in a cell

- **WHEN** the cell's identity binds a ciyuan account and the credential store is rewritten
- **THEN** `.credentials.yaml` carries the user's key under `LLM_PROVIDER_KEY_FINDDATA`
- **AND** the next LLM request uses it with no dsh restart

#### Scenario: unbinding restores the seed

- **WHEN** the identity disconnects (or the key is marked stale) and the store is rewritten
- **THEN** `LLM_PROVIDER_KEY_FINDDATA` equals the `llm-providers.json` seed again

#### Scenario: shared single-process store is never overridden

- **WHEN** the server runs single-process for several identities
- **THEN** no identity's ciyuan key is written into the shared credential store
