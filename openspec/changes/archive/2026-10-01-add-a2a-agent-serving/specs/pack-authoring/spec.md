## MODIFIED Requirements

### Requirement: Agents are persona entries

Each draft agent entry SHALL carry a display name, persona text, and optional tags and icon. An agent entry MAY carry a resource declaration naming, per role, a subset of the draft's own skill entries and MCP references; each dimension (skills, MCP) is optional, and an absent dimension means the role uses the whole pack's set for that dimension. The editor SHALL offer per-role resource pickers listing only the draft's own skill entries and MCP references, and SHALL surface a persona cost readout (approximate tokens per turn) alongside the persona text while editing. The editor SHALL NOT accept endpoint, model, or credential fields for agent entries — pack agents run as local personas on the platform's currently selected model.

An agent entry MAY additionally carry a serving contract (`serving`): a declaration that the role is deployable as an Agent Service over the A2A protocol (openspec: a2a-agent-serving). The contract SHALL contain a protocol identifier and an optional manual card declaration; absent card fields SHALL be derived at deploy time from the role's name/description/tags. The contract's card capability declarations live under the contract's own namespace and are distinct from the pack's skill files — same word, different meaning — and validation SHALL reject contract fields that name endpoints, models, or credentials. When no contract is present, every pre-existing rule of this requirement applies verbatim.

#### Scenario: Persona-only agent entry

- **WHEN** the author adds an agent entry with a display name and persona text and saves the draft
- **THEN** the entry persists with exactly those fields and no endpoint or model field exists in the editor

#### Scenario: Per-role picker offers only the draft's own entries

- **WHEN** the author opens a role's resource picker
- **THEN** it lists exactly the draft's skill entries and MCP references, and no free-form skill or server entry exists

#### Scenario: Declaration referencing a foreign name is caught before publish

- **WHEN** a role's declaration names a skill or MCP reference that is not in the draft's own lists and the author attempts to publish
- **THEN** the editor blocks the publish naming the offending role and entry

#### Scenario: Persona cost is visible while editing

- **WHEN** the author edits a role's persona text
- **THEN** the editor shows the current length and an approximate per-turn token cost for it

#### Scenario: Contract-free entries are unchanged

- **WHEN** a draft agent entry carries no serving contract
- **THEN** the entry validates and behaves exactly as before this change

#### Scenario: Minimal contract validates

- **WHEN** the author adds a serving contract consisting of only the protocol identifier and saves
- **THEN** the draft validates and publish succeeds, with card display fields to be derived at deploy time

#### Scenario: Contract cannot smuggle runtime configuration

- **WHEN** a serving contract contains a model, endpoint, or credential field
- **THEN** validation rejects the draft naming the forbidden field

#### Scenario: Card capabilities are namespace-isolated from skill files

- **WHEN** a serving contract declares card capabilities and the pack also ships skill files
- **THEN** the two coexist without collision — the capability declarations never reference or consume the skill files' contents
