# native-lexicon Specification

## Purpose
Defines the platform's user-facing AI-native vocabulary: the standing organization customers build and run is a **集群 (Cluster)**, the session-bound ad-hoc group is an **阵列 (Array)**, the installable distribution unit is a **能力包 (Pack)** and its store is the **能力市场** — with hard rules that code keys, API fields, and spec directory names never translate, and historical documents stay frozen.

## Requirements

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

### Requirement: Session-bound ad-hoc groups are named 阵列 (Array) to users

The ephemeral, session-bound, auto-dissolving group assembled from installed packs' agents SHALL be labeled「阵列」(zh) / "Array" (en) on creation, listing, detail, dissolve, and composer binding surfaces. It SHALL NOT be labeled「集群」on any user-facing surface once this lexicon ships. Code keys (e.g. `clusters.*`) and API paths for this resource remain unchanged.

#### Scenario: Composer binding copy uses 阵列

- **WHEN** a user binds an ad-hoc group to the current session from the composer
- **THEN** the visible copy reads 载入阵列 / Load Array (not 集群/Cluster)

#### Scenario: Agent page section renamed

- **WHEN** a user opens the agents page
- **THEN** the section previously labeled 我的集群 reads 我的阵列, and empty-state copy references 阵列

### Requirement: Distribution unit and store are named 能力包 / 能力市场

The installable distribution unit SHALL be named「能力包」(zh) / "Pack" (en) and its store「能力市场」on all user-facing surfaces, replacing the mixed usage of 功能集 / AI 能力包 / 我的包. Skill zip upload artifacts keep the「技能包」label — they are file artifacts, not market units.

#### Scenario: Market entry copy unified

- **WHEN** a user views the store tagline, glossary, and pack-management tab in zh-CN
- **THEN** store surfaces read 能力市场 and unit surfaces read 能力包, with no 功能集 wording remaining user-visible

### Requirement: Official fleet template seeds adopt AI-native display names

The five official template seeds SHALL carry these display names on their next mint/publish: 公司式舰队→**AI 公司**, 内容工厂舰队→**内容流水线**, 情报站舰队→**晨报情报站**, 投研晨会舰队→**投研晨会**, 客服护航舰队→**客服班组**. Seed file names, packIds, and placeholder contracts SHALL remain unchanged. Existing published entries `CRM 客服套件`, `分身工坊`, `寻数分身` SHALL NOT be renamed.

#### Scenario: Re-minted seed carries new display name

- **WHEN** any of the five seeds is minted and published after this change ships
- **THEN** its market entry displays the new AI-native name while its packId stays stable, so existing installs and subscriptions are unaffected

### Requirement: Out-of-scope vocabulary and frozen history

This lexicon SHALL NOT touch: the zhiyu chatroom vocabulary v3 (空间/值守/呼叫/接管), the「AI 分身」facade wording, or the settled operator vocabulary (定时运行/产出×交付/流转/结构视图). Historical ledgers, archived specs, and published-then documents SHALL NOT be retro-edited.

#### Scenario: Archived document keeps old wording

- **WHEN** anyone reads an archived spec or a dated ledger entry that references 舰队
- **THEN** the historical text is unchanged — only live user-facing surfaces and forward-going documents use the new lexicon

### Requirement: Vendor naming covenant

The market SHALL impose no display-name suffix rules on pack authors: names are free-form; the pack's type SHALL be expressed exclusively by the auto-derived badge (openspec: pack-marketplace). Publishing SHALL NOT reject a name for lacking or bearing any particular suffix.

#### Scenario: Free-form vendor name accepted

- **WHEN** a vendor publishes a pack whose display name carries none of the historical suffix conventions (套件/工坊/分身/舰队)
- **THEN** publishing succeeds and the entry's type is conveyed by the derived badge, not by the name

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

### Requirement: Owner-view terminal term is 经营

The agent-teams hub owner view's user-facing term SHALL be「经营」(zh-CN; en "Operations"), replacing the jargon「经营坞」/ "Owner board" on live surfaces. The rename SHALL touch only i18n values — the key `agentTeams.views.owner`, routes, the `?view=owner` query value, and every code identifier stay unchanged. Archived specs, ledgers, and published-then documents SHALL NOT be retro-edited, following the frozen-history requirement already in this capability.

#### Scenario: tab reads 经营

- **WHEN** a user opens the agent-teams hub in zh-CN
- **THEN** the third view tab reads「经营」, and the URL keeps `?view=owner`

#### Scenario: deep links and bookmarks keep working

- **WHEN** a pre-rename bookmark `/fleets?view=owner` is opened
- **THEN** the view renders with the new label, no redirect or rewrite needed
