## MODIFIED Requirements

### Requirement: Deploy action composes registry-native assets

The platform SHALL offer a deploy action (「部署为服务」) on published pack versions whose agents carry a serving contract, gated to pack creators and admins for public packs and to the pack's owner for private packs (openspec: pack-visibility), idempotent per (pack version, agent id), and admitted only when the deployer's billing balance passes the platform-billing gate. The action SHALL: publish each of the pack's skills as a registry skill entry under a pack-scoped path with restricted visibility; register one registry agent entry per serving-contract agent with `supported_protocol: "a2a"`, the runner's backend URL as the proxy backend, and a `metadata` deployment descriptor limited to small fields (persona, MCP references, skill paths, serving contract, effective work rhythm, effective turn budget, effective model, billing key reference); compose the AgentCard from the serving contract's manual card fields, defaulting to values derived from the agent's name/description/tags when absent; and mint the per-agent billing key per platform-billing. The deployer's rhythm and budget overrides, and any deploy-time model choice, SHALL be recorded as the deployment's initial service config (openspec: agent-service-config) — rewritable afterwards on the serving config surface — not as one-shot request parameters; the descriptor records the resulting effective values. A deploy-time model choice SHALL pass the same write-time lane validation as any later config write. The action SHALL NOT embed the full manifest, skill bodies, or any key secret in the agent entry.

A deploy request MAY carry an `agents` array naming a non-empty subset of the pack's serving-contract agent ids; the deploy then registers, configures, and records ONLY the named agents. An omitted `agents` key deploys every serving-contract agent exactly as before. Unknown, duplicate, or non-serving ids in the array SHALL be refused with a reason naming the id. When a subset is deployed, the billing-key admission rule (every deployed serving agent ends up bound) SHALL apply only to the selected agents: unselected serving agents keep their existing key and secret bindings untouched — not revalidated, not required, not dropped — because their live registry entries are not being replaced. A pasted billing key or an explicit secret-unbind aimed at a serving agent outside the selection SHALL be refused with a reason naming the agent, never silently ignored.

#### Scenario: Deploying a serving-contract role

- **WHEN** a creator triggers deploy on a pack version whose agent carries a serving contract
- **THEN** the registry gains one a2a agent entry and one skill entry per pack skill, and a second trigger for the same (version, agent) changes nothing

#### Scenario: Deploy is refused without the contract

- **WHEN** a creator triggers deploy on a pack whose agents carry no serving contract
- **THEN** the action is refused with a reason naming the missing contract

#### Scenario: Card defaults are derived

- **WHEN** the serving contract omits manual card fields
- **THEN** the registered AgentCard's display fields are derived from the agent's name, description, and tags

#### Scenario: Skills are gated on the registry

- **WHEN** the deploy action publishes pack skills as registry skill entries
- **THEN** those entries are not publicly listed to marketplace browsers outside the intended visibility

#### Scenario: The deployer rhythm override lands in the descriptor

- **WHEN** a deploy request carries a rhythm override differing from the manifest default, or carries none
- **THEN** the descriptor records the override as the effective rhythm in the first case and the manifest default in the second, and the override persists as the deployment's initial service config

#### Scenario: The deployer budget override lands in the descriptor

- **WHEN** a deploy request carries a per-agent budget override, or the contract declares `budget.turnMinutes`, or neither
- **THEN** the descriptor records the override in the first case, the declared ceiling in the second, and no budget field in the third (the runner's deployment default applying instead), and any override persists as the deployment's initial service config

#### Scenario: The descriptor carries a key reference, never the key

- **WHEN** a deploy mints the per-agent billing key
- **THEN** the descriptor records the key's reference only, and no secret value reaches the registry

#### Scenario: A deploy-time model rides the same lane validation

- **WHEN** a deploy request carries a model choice that is not authorized on the deployer key's sub2api lanes, or violates the serving contract's model whitelist
- **THEN** the deploy is refused with the write-time lane validation error, and no agent entry is registered

#### Scenario: An agent subset deploys only the named agents

- **WHEN** a deploy request carries `agents: ["alpha"]` on a pack whose serving agents are alpha and beta
- **THEN** only alpha's registry entry is composed (or upserted) and recorded, beta's live entry and stored bindings are untouched, and the response's `deployed` lists alpha only

#### Scenario: A bad selection is refused naming the id

- **WHEN** a deploy request carries `agents` containing an id that is not a serving agent of the pack, a duplicate, or an empty array
- **THEN** the deploy is refused with a 400 naming the offending entry, and nothing is deployed

#### Scenario: Keys for unselected agents are refused, not ignored

- **WHEN** a subset deploy pastes a billing key for a serving agent outside the selection, or aims a secret null-unbind at one
- **THEN** the deploy is refused with a reason naming the agent and the selection, so an unselected agent's live entry never drifts from its stored bindings

#### Scenario: Billing admission scopes to the selection

- **WHEN** a subset deploy provides billing keys for every selected agent and the billing plane is linked
- **THEN** the deploy is admitted even though an unselected serving agent has no stored key binding, and that unselected agent's absence of a binding changes nothing for this deploy
