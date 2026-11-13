## MODIFIED Requirements

### Requirement: Pack composition model

A vertical pack SHALL be defined as a named composition of four parts: exactly one entry skill, one or more MCP servers, exactly one conversational agent entry, and one visibility role. The pack definition SHALL be documented in `docs/vertical-packs.md` and is the single source a demo operator follows. Two packs remain at the sample face:

- **法律-合同**: entry `legal-contract-workflow`; MCP `law-bench`; agent 合同审查官; role `legal`
- **法律-案件**: entry `legal-case-workflow`; MCP `fd-legal-search-mcp` (skill-driven until it lands); agent 案件分析师; role `legal`

The two data-domain sample packs (**数据-股票**, **数据-中国经济**) SHALL be retired from the sample face: their domain content is carried by the 柏讯 suite line (single source of truth for data-domain packs — user ruling 2026-10-25). Retirement SHALL unlist the packs and fold any skill the 柏讯 suites lack into the corresponding suite as a new version; published versions SHALL NOT be deleted and existing subscribers SHALL NOT be broken. The sample face SHALL NOT gain new data-domain packs.

#### Scenario: Pack parts are individually installable

- **WHEN** a user with the pack's role browses the Store
- **THEN** every pack part (entry skill, MCP servers, agent in the Agents page) is visible to that user and installable/selectable with existing mechanisms — a pack adds curation, not new install machinery

#### Scenario: Wrong-role user sees none of the pack

- **WHEN** a user without the pack's role browses the Store and Agents pages
- **THEN** the pack's gated entries are invisible to that user — group gating follows the registry visibility metadata carried on each entry (`visibility`/`allowed_groups`; carried metadata wins, per `registry-bridge.js`), with the hand-mapped `registry-groups.json` serving only as a compatibility fallback for entries that carry no such metadata

#### Scenario: Data sample packs retire without breaking subscribers

- **WHEN** 数据-股票 and 数据-中国经济 are unlisted per this change
- **THEN** they disappear from the public listing, their published versions remain fetchable by existing subscribers, and the 柏讯 suites carry the equivalent (or richer) data-domain workflows
