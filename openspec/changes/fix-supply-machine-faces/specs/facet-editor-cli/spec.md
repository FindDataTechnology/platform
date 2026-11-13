## ADDED Requirements

### Requirement: The CLI can browse the catalog without a known pack id

The CLI SHALL provide a discovery path that does not require the user to know a pack id in advance: `facet list` SHALL print the marketplace's listed packs (id, name, version, line/category), and `facet search <query>` SHALL print the packs matching that query by the market's own search semantics. Both SHALL accept `--base` (self-hosted marketplace), `--species` (at minimum `pack`), `--line` (a line word such as `lex` or `wire`), `--limit`, and `--json`, and SHALL read the same listing API the install path uses — no second catalog, no local cache that can disagree with the market.

Both SHALL fail honestly when the marketplace is unreachable or the query matches nothing: an unreachable market reports the base it tried and the reason, and an empty result prints an explicit "no match" rather than an empty table. Neither SHALL print anything to a pipe that a subsequent `install` cannot consume: the printed id SHALL be exactly the reference `facet install` accepts.

#### Scenario: A user lists the market without knowing ids

- **WHEN** a user runs `facet list` against a reachable marketplace
- **THEN** the output names each listed pack with an id that `facet install` accepts verbatim

#### Scenario: Search narrows by query and line

- **WHEN** a user runs `facet search 合同 --line lex`
- **THEN** only packs matching the query and belonging to the lex line are printed

#### Scenario: A self-hosted market is browsable

- **WHEN** a user runs `facet list --base https://facet.example.internal`
- **THEN** the listing is fetched from that base and the output reports it

#### Scenario: An empty result is explicit

- **WHEN** a query matches no pack
- **THEN** the CLI prints an explicit no-match message and exits without an empty table

#### Scenario: Unreachable market names the reason

- **WHEN** the marketplace does not respond
- **THEN** the CLI reports the base it tried and the failure reason, and prints no partial catalog
