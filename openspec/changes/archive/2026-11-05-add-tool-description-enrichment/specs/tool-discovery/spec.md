## ADDED Requirements

### Requirement: Discovery index reflects enriched descriptions consistently

When tool-description enrichment is active (per `tool-description-enrichment`), the effective-tool search index SHALL expose the same enriched description text the model face receives for that tool (append or replace applied identically). Tool names, server names, leaf names, and parameter-schema summaries in the index SHALL remain exactly as before — enrichment MUST NOT alter the searchable identity of any tool. When enrichment is absent, disabled, or the tool carries no canonical brief, the index SHALL expose the upstream description unchanged.

#### Scenario: Index matches the model face

- **WHEN** an enriched tool is both visible to the model and searched via effective-tool discovery
- **THEN** the description returned by search equals the description on the model face

#### Scenario: Search identity is untouched

- **WHEN** enrichment is enabled for a tool with a canonical brief
- **THEN** searching for the tool's exact callable name SHALL resolve it identically to before enrichment, with the same server and leaf attribution

#### Scenario: Unenriched tools are byte-identical

- **WHEN** a tool carries no canonical brief or enrichment is disabled
- **THEN** the index description equals the upstream description exactly
