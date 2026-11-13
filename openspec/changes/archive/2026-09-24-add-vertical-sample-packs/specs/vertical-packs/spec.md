# vertical-packs Specification (delta)

## ADDED Requirements

### Requirement: Pack composition model

A vertical pack SHALL be defined as a named composition of four parts: exactly one entry skill, one or more MCP servers, exactly one conversational agent entry, and one visibility role. The pack definition SHALL be documented in `docs/vertical-packs.md` and is the single source a demo operator follows. Four packs exist at v1:

- **法律-合同**: entry `legal-contract-workflow`; MCP `law-bench`; agent 合同审查官; role `legal`
- **法律-案件**: entry `legal-case-workflow`; MCP `fd-legal-search-mcp` (skill-driven until it lands); agent 案件分析师; role `legal`
- **数据-股票**: entry `stock-research-workflow`; MCP `fd-open-data-mcp` + `fd-cn-report`; agent 行业分析师; role `analysts`
- **数据-中国经济**: entry `china-macro-brief-workflow`; MCP `fd-open-data-mcp` + `fd-cn-report`; agent 行业分析师; role `analysts`

#### Scenario: Pack parts are individually installable

- **WHEN** a user with the pack's role browses the Store
- **THEN** every pack part (entry skill, MCP servers, agent in the Agents page) is visible to that user and installable/selectable with existing mechanisms — a pack adds curation, not new install machinery

#### Scenario: Wrong-role user sees none of the pack

- **WHEN** a user without the pack's role browses the Store and Agents pages
- **THEN** the pack's gated entries (per `registry-groups.json`) are invisible to that user

### Requirement: Entry skill is the pack's single install surface

Each entry skill SHALL be a registry skill whose SKILL.md encodes: the pack's workflow stages in order, which existing skills to invoke at each stage (referenced by exact skill name), which MCP tool groups to call (referenced by server name and tool intent), the output deliverable format, and domain honesty constraints (no fabricated citations/case numbers/tickers; low-confidence legal conclusions MUST be flagged). Installing the entry skill plus the pack's MCP servers SHALL be sufficient for the full workflow — the entry skill MUST NOT require installing any other skill to function (other skills are invoked by name when present, skipped with a note when absent).

#### Scenario: Entry skill references sibling skills by name

- **WHEN** the pack workflow reaches a stage owned by an existing skill (e.g. `preliminary-legal-analysis`) and that skill is installed
- **THEN** the entry skill directs the agent to apply that skill's method for the stage

#### Scenario: Missing sibling skill degrades, not fails

- **WHEN** the same stage runs but the sibling skill is NOT installed
- **THEN** the entry skill's inline method summary covers the stage and the output notes which recommended skill was absent

#### Scenario: MCP guidance is tool-intent based

- **WHEN** the entry skill instructs data retrieval
- **THEN** instructions reference the server and the tool intent (e.g. "law-bench 的条款 RAG 检索") rather than exact tool identifiers, so gateway-side tool renames do not break the pack

### Requirement: Legal search MCP for the case pack

`fd-legal-search-mcp` SHALL be registered in the registry and SHALL expose at minimum: statute search (query → statute articles with citation-precise identifiers), case search (query → matching adjudicated cases with court, case number, and outcome), and detail fetch by identifier. Results SHALL carry provenance (source name + identifier) sufficient for the entry skill's no-fabrication constraint. The server SHALL be scoped to the `legal` group. Until registered, the case pack's demo playbook SHALL present the pack as methodology-driven and MUST NOT imply live case retrieval.

#### Scenario: Statute search returns citable articles

- **WHEN** the case-pack workflow queries "劳动合同解除 经济补偿"
- **THEN** the server returns statute articles identifiable by law name + article number

#### Scenario: Case search returns real identifiers only

- **WHEN** the workflow queries for similar cases
- **THEN** every returned case carries a court name and case number that exist in the corpus; absence of matches returns an explicit empty result, never an invented case

### Requirement: Conversational agent per pack

Each pack's agent entry SHALL be a catalog `agent-remote` `chat` entry backed by the OpenAI-compatible endpoint `token.finddatatech.cloud/v1` (model `deepseek-v4-pro`), with credentials supplied exclusively via an environment-variable reference (`apiKeyEnv`); the API key MUST NOT appear inline in any catalog document. Selecting the pack agent SHALL route prompts to that endpoint. The registry's `chatlaw`/`fingpt` link cards remain in the catalog as ecosystem showcase entries alongside the chat agents.

#### Scenario: Chat agent without inline secrets

- **WHEN** the pack agent entry is served by `GET /api/catalog`
- **THEN** the entry carries `baseUrl`, `model`, and an `apiKeyEnv` name, and no secret material

#### Scenario: Persona comes from the entry skill, not the agent entry

- **WHEN** a user chats with a pack agent with the pack's entry skill installed
- **THEN** the entry skill's workflow and constraints govern the conversation; the agent entry contributes the model endpoint and display identity only

### Requirement: Demo playbook

`docs/vertical-packs.md` SHALL document, per pack: composition table, operator setup (Logto group assignment, scope grants, token provisioning for V0 manual-paste until registry-sso-credentials lands), a canned demo input, and the expected deliverable shape. The playbook SHALL include the registry-side provisioning runbook (groups, scopes, `registry-groups.json`, agent registration) so a new operator can reproduce the demo without this change's history.

#### Scenario: New operator reproduces the demo

- **WHEN** an operator follows `docs/vertical-packs.md` top to bottom on a fresh fd-prod account with the right role
- **THEN** all four packs' entry skills install, their MCP servers connect with a provisioned token, and each canned demo input produces its expected deliverable shape
