# intent-onboarding Specification

## Purpose

意图驱动的首配：欢迎页问卷采集业务角色与待办，按平台策展的首配方案（recipe）一键装配——订阅功能集、设默认专家、角色联动布局。只加不减（ADR-0027：recipe 与 pack 分立）。

## Requirements

### Requirement: Welcome-embedded role questionnaire

For a user whose intent profile is empty and not marked skipped, the chat welcome state SHALL present an onboarding panel above the suggested prompts: business-role cards (1 to 3 selectable, offering only roles whose recipes are ready), an optional free-text note ("想用它办什么"), and a skip control. Selecting roles and submitting SHALL record the intent profile and assign the user's primary role (first selection) and secondary roles (further selections); skipping SHALL mark the profile skipped without recording roles. The panel SHALL NOT block chat: the composer remains usable while the panel is visible, and the panel SHALL NOT reappear after submit or skip (re-entry only via the Settings general section).

#### Scenario: first entry shows the questionnaire

- **WHEN** a user with an empty, unskipped intent profile opens the chat welcome state
- **THEN** the onboarding panel renders above the suggested prompts with recipe-ready role cards, the optional note field, and a skip control
- **AND** the composer is usable

#### Scenario: questionnaire lists only recipe-ready roles

- **WHEN** the panel renders on a deployment where only `legal`, `stock`, and `economic` have ready recipes
- **THEN** exactly those three role cards appear; `financial`, `screenplay`, `paper` do not

#### Scenario: skipping does not guess

- **WHEN** the user skips the questionnaire
- **THEN** the profile is marked skipped with no roles recorded
- **AND** the panel does not reappear on later welcome states
- **AND** the user's roles resolve per `role-system` defaults (unchanged)

### Requirement: Intent profile storage and deployment preset

The intent profile (selected roles, optional note, skipped mark, timestamps) SHALL persist per user in the user's own cell store, following the login identity across devices. A deployment SHALL be able to preset a default profile via environment (roles and note); a stored user answer SHALL win over the preset, and the preset SHALL win over empty. A skipped-or-answered user SHALL never be auto-reprompted.

#### Scenario: deployment preset applies to newcomers

- **WHEN** the deployment presets default roles `[legal]` and a new user with an empty profile loads the welcome state
- **THEN** the questionnaire is preselected/skipped per the preset semantics (the user is not asked what the customer already answered for), and the user's roles resolve with primary `legal`

#### Scenario: re-answer wins over preset

- **WHEN** the user re-opens the questionnaire and submits `stock`
- **THEN** the stored answer wins and the primary role becomes `stock`

### Requirement: Curated recipe mapping

The platform SHALL maintain, as versioned static data, one recipe per business role declaring: the first-install pack list, the default expert reference, the welcome-prompt source, and the layout preset key. Recipes are platform-curated and invisible to users; roles without a ready recipe SHALL NOT appear in the questionnaire (per `role-system` they remain assignable by admins). v1 ships ready recipes for `legal`, `stock`, `economic`.

#### Scenario: recipe drives the provisioning plan

- **WHEN** a user with primary role `legal` confirms provisioning
- **THEN** the plan is derived from the `legal` recipe's pack list, default expert, and layout preset key

### Requirement: One-click confirmation list

After the questionnaire submits, the user SHALL see a confirmation list ("为你准备了…") enumerating only items installable under the user's effective admission set; unavailable items SHALL be silently omitted with a single closing note that some content is currently unavailable. Provisioning SHALL never fail due to missing items: on marketplace-off deployments the list SHALL degrade to layout and default-expert only. One activation SHALL execute the whole list.

#### Scenario: unavailable pack omitted without blocking

- **WHEN** the recipe lists a pack the user cannot see under admission rules
- **THEN** the confirmation list omits it, the closing note states some content is unavailable, and activation succeeds for the remaining items

#### Scenario: marketplace-off degradation

- **WHEN** the deployment does not report the pack marketplace
- **THEN** the confirmation list shows layout and default expert only, and activation succeeds

### Requirement: Provisioning is add-only and idempotent

Activation SHALL subscribe the recipe's packs via the existing installation path (admission-checked), set the recipe's default expert as the user's initial selected expert, and rely on the assigned roles for layout (per `layout-configuration`). Activation SHALL NEVER uninstall or modify resources the user already has, and SHALL be idempotent: re-activation with unchanged answers installs nothing twice. Self-service onboarding SHALL NEVER grant the admin flag.

#### Scenario: existing packs untouched

- **WHEN** the user already installed one of the recipe's packs manually before activating
- **THEN** activation skips it and the user's other installed resources are unchanged

#### Scenario: re-activation is idempotent

- **WHEN** the user re-opens the questionnaire, re-submits the same roles, and activates again
- **THEN** no duplicate subscription or duplicate expert change occurs beyond re-asserting the same state

#### Scenario: default expert follows the primary role

- **WHEN** activation completes for primary role `legal`
- **THEN** the chat's initially selected expert is the `legal` recipe's default expert, and the welcome prompt cards follow it (per `chat-welcome-state`)

### Requirement: Change of mind

The Settings general section SHALL offer a "重新选择角色" entry that re-opens the questionnaire (pre-filled with the stored profile). Re-answering SHALL update the profile and roles and re-run provisioning add-only; changing the primary role SHALL re-resolve the layout on the next config read (per `layout-configuration`).

#### Scenario: switching primary role switches layout and expert

- **WHEN** a user re-answers with primary `stock` (was `legal`) and activates
- **THEN** the primary role becomes `stock`, the default expert becomes the `stock` recipe's expert, and the resolved layout follows the `stock` recipe's preset on the next config read
- **AND** the previously installed legal packs remain installed
