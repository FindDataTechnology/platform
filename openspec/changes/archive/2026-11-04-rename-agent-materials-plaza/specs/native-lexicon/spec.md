## MODIFIED Requirements

### Requirement: The AI-native lexicon v4 renames all four settled user-facing terms

The 2026-10-30 lexicon ruling (superseding the 2026-10-28 v3 decision) renames every settled user-facing
term at the display layer, with underlying i18n keys, API fields, event names, and spec directory names
containing `fleet`/`cluster`/`pack` remaining byte-identical.

The 2026-11-02 v5 ruling (superseding v4's brand bullet only) renames the store and the product brand to
the Materials Plaza wording: the plaza surfaces the platform's materials — the genus word 素材 / "Material"
denotes any item a human or an AI can understand, obtain, and run from the plaza; the species terms
(功能集, 生态技能, MCP 服务, AI 分身, 官方数据锚) are unchanged, and the unit word 智能体 / "Agent" is unchanged:

- Standing, template-instantiated runtime organization: 「集群」/ "Cluster" → **「智能体团队」/ "Agent Team"**
  (navigation, cockpit branding, trace badges, overview tabs, management-surface copy, pack-provisioning
  wizard copy, onboarding tour copy, seed/template shelf copy).
- Session-bound ad-hoc group: 「阵列」/ "Array" → **「小组」/ "Group"** (agents page sections, composer
  binding strip, chat header bound/expiring notices, terminate notice, task rows, fleet member kind label).
- Installable distribution unit: 「能力包」/ "Pack" → **「智能体」/ "Agent"** (market tab, settings section,
  drafts/editor/publish surfaces, guide cards, facet shell tabs and docs, board tab).
- Store: 「能力市场」/ "Pack Market" → 「智能体市场」/ "Agent Market" (v4) → **「智能体素材广场」/
  "Agent Materials Plaza"** (v5) (glossary, facet footer entries, app-center tagline, market gallery copy,
  onboarding and publish mentions).
- Product brand: 「壹座·Packs」 → **「壹座·智能体素材广场」/ "Yizuo Agent Materials Plaza"** wherever the
  brand string renders from this repository. v4's interim ruling 「壹座·智能体基础设施」 never rendered
  (zero render points at v5 time), so no legacy string migration is owed. The registry landing page's brand
  string lives in the registry repo and stays a recorded follow-up under the same v5 wording.

Skill zip upload artifacts keep their separate「技能包」label — they are file artifacts, not market units.
The dsh plugin bundle copy (「插件包」/ "plugin bundle") is a different unit and is NOT renamed.
「素材广场」SHALL NOT be written as 插件市场 / 应用商店 / 资源广场 on any user-facing surface.
A surface that denotes the **desktop runner machine set** (the desktop-only `fleet` nav item's console) or a
**deployment record** SHALL NOT be renamed to「智能体团队」: those name machines and deployments, not agent
teams. Each occurrence MUST be classified by meaning before its string is changed.

#### Scenario: Navigation label renamed without key change

- **WHEN** a user views the main navigation in zh-CN or en
- **THEN** the entry formerly labeled 集群 / Clusters reads 智能体团队 / Agent Teams, while the i18n key serving it (`nav.fleets`) is unchanged

#### Scenario: API fields keep fleet naming

- **WHEN** a client calls fleet-related API endpoints or reads fleet fields in responses
- **THEN** field names and endpoint paths are unchanged from before this lexicon rollout

#### Scenario: Ad-hoc group reads 小组

- **WHEN** a user opens the agents page sections and the composer binding strip
- **THEN** the ad-hoc group reads 小组 / Group (我的小组, 载入小组), and the i18n keys (`agentsPage.myClusters`, `composer.strip.clusterLoad`) are unchanged

#### Scenario: Install unit and store read 智能体 / 智能体市场

- **WHEN** a user opens the market tab, the settings section, and the facet shell
- **THEN** the unit reads 智能体 / Agent, the store reads 智能体素材广场 / Agent Materials Plaza (v5 terminal wording — the scenario header keeps its v4 name; 智能体市场 no longer appears on user-facing surfaces), and no 能力包 / 能力市场 / Pack-market wording remains user-visible

#### Scenario: Brand string reads 素材广场

- **WHEN** the product brand string renders from this repository (the plaza site title, footer entries, AI-surface full-entity mentions)
- **THEN** it reads 壹座·智能体素材广场 / Yizuo Agent Materials Plaza, and neither 壹座·Packs nor 壹座·智能体基础设施 appears on any user-facing surface

#### Scenario: Skill zip artifacts and dsh plugin bundles keep their labels

- **WHEN** a user uploads a skill zip or reads the dsh plugins section
- **THEN** the copy still reads 技能包 (skill package) and 插件包 / plugin bundle — neither became 智能体

#### Scenario: Desktop machine set is not renamed to agent teams

- **WHEN** a user opens the desktop app's local runner console and its onboarding tour step
- **THEN** its machine/deployment wording keeps the 机群 / runner-cluster meaning and is not replaced by「智能体团队」

#### Scenario: Five locales consistent

- **WHEN** the locale gate runs after this change
- **THEN** all five locales carry the renamed values with key parity intact and no remaining user-visible 集群 / 阵列 / 能力包 / 能力市场 string in its old meaning, and the store reads 智能体素材广场 / Agent Materials Plaza (localized equivalents in es/fr/ja) everywhere the v4 store name appeared
