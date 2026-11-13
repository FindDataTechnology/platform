# native-lexicon delta

## ADDED Requirements

### Requirement: Official seed display names follow lexicon v4

The in-repo official seeds and official assistant manifests SHALL carry v4-lexicon display names on
their next mint/publish, with packIds, agent ids, and placeholder contracts unchanged:
「集群架构师（官方种子）」→ **「团队架构师（官方种子）」** (the architect composes agent teams, not
clusters), and 「萬星舰队助手」→ **「万星机群助手」** (the Wanxing assistant operates the machine/runner
fleet — 机群 semantics, consistent with the desktop-only nav item). The persona self-references inside
those assets SHALL use the same names. The en secondary track already carries the matching English
names (Team Architect / Wanxing Ops Assistant) and SHALL NOT change.

#### Scenario: Architect seed renamed

- **WHEN** the architect seed is next minted and published
- **THEN** its market entry displays 团队架构师（官方种子） while its packId and agent id stay stable

#### Scenario: Wanxing assistant renamed to machine semantics

- **WHEN** the Wanxing assistant manifest is next published
- **THEN** its display name reads 万星机群助手, and no 舰队 wording remains in its user-visible name

#### Scenario: Seed tests pin the new names

- **WHEN** the fleet-template unit tests run after the rename
- **THEN** they pass with the new display names and unchanged structural contracts
