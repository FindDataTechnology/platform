## Purpose

Defines the platform's user-facing AI-native vocabulary: the standing organization customers build and run is a **集群 (Cluster)**, the session-bound ad-hoc group is an **阵列 (Array)**, the installable distribution unit is a **能力包 (Pack)** and its store is the **能力市场** — with hard rules that code keys, API fields, and spec directory names never translate, and historical documents stay frozen.

## ADDED Requirements

### Requirement: Standing runtime organizations are named 集群 (Cluster) to users

All user-facing surfaces that today render the standing, template-instantiated runtime organization as「舰队」/ "Fleet" SHALL instead render「集群」(zh) / "Cluster" (en): navigation, cockpit branding (集群驾驶舱 / Cluster Cockpit), trace badges, overview tabs, and seed/template shelf copy. Underlying i18n keys, API fields, event names, and spec directory names containing `fleet` SHALL remain byte-identical.

#### Scenario: Navigation label renamed without key change

- **WHEN** a user views the main navigation in zh-CN or en
- **THEN** the entry formerly labeled 舰队 / Fleets reads 集群 / Clusters, while the i18n key serving it is unchanged

#### Scenario: API fields keep fleet naming

- **WHEN** a client calls fleet-related API endpoints or reads fleet fields in responses
- **THEN** field names and endpoint paths are unchanged from before this lexicon rollout

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
