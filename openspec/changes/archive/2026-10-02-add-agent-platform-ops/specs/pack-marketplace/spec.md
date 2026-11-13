# pack-marketplace Delta

## MODIFIED Requirements

### Requirement: Browse, search, and inspect

Every authenticated user SHALL be able to list published packs (name, description, tags, author identity, latest version, last publish time), search them by name or tag, and open a detail view — excluding private packs the requester does not own (openspec: pack-visibility; admins see all). The detail view SHALL return the full manifest of the latest version, including the complete body of every skill, so a subscriber can inspect exactly what will be installed before subscribing.

#### Scenario: Search by tag

- **WHEN** a user searches the marketplace for the tag `法律`
- **THEN** the listing contains exactly the published packs tagged `法律` visible to that user

#### Scenario: Skill bodies are inspectable before subscribe

- **WHEN** a user opens the detail view of a pack
- **THEN** every skill's full content, every MCP reference with its required group if any, and every agent entry are visible before any install happens
