# a2a-agent-serving Specification

## ADDED Requirements

### Requirement: Example prompts ride the AgentCard

The manual card fields SHALL include `examples`: at most three sample prompts (each a non-empty string of at most 200 characters) that discovery surfaces offer as one-click starters. Manifest validation SHALL accept the field only in that shape (absent keeps the card without it; malformed fails naming the entry), and the composed AgentCard SHALL pass declared examples through verbatim.

#### Scenario: Example prompts ride the card verbatim

- **WHEN** a serving contract declares `card.examples` with two sample prompts and the agent deploys
- **THEN** the registered card carries exactly those two strings

#### Scenario: A malformed declaration fails validation

- **WHEN** `card.examples` declares four entries, an empty string, or a 201-character string
- **THEN** manifest validation fails naming the serving entry, and nothing registers

#### Scenario: Absent examples keep the card shape unchanged

- **WHEN** a contract without `card.examples` deploys
- **THEN** the composed card simply lacks the field, byte-identical to the pre-change shape
