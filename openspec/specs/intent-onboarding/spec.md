# intent-onboarding Specification

## Purpose

意图驱动的首配：欢迎页问卷采集业务角色与待办，按平台策展的首配方案（recipe）一键装配——订阅功能集、设默认专家、角色联动布局。只加不减（ADR-0027：recipe 与 pack 分立）。

## Requirements

### Requirement: Welcome-embedded role questionnaire

For a user whose first-run stage is `new` (per `first-run-onboarding`) and whose deployment has at least one recipe-ready role, the chat welcome state SHALL present the onboarding panel as that stage's single foreground surface, above the suggested prompts: business-role cards (1 to 3 selectable, offering only roles whose recipes are ready), an optional free-text note ("想用它办什么"), and a skip control. Selecting roles and submitting SHALL record the intent profile, assign the user's primary role (first selection) and secondary roles (further selections), and advance the stage to `role_answered` (showing the configuration confirmation). Activating the configuration SHALL advance the stage to `provisioned`. Skipping SHALL mark the profile skipped without recording roles and advance the stage to `provisioned`. The panel SHALL NOT block chat: the composer remains usable while the panel is visible, and the panel SHALL NOT reappear once the stage has advanced to `provisioned` or `done` (re-entry only via the Settings general section, which returns the stage to `new`). While the stage is `role_answered` (answers recorded, activation not yet run) the confirmation list is not persisted, so a reload SHALL re-open the panel at the questionnaire pre-filled from the stored answer — the user finishes by re-submitting and activating, never by silently losing the pending activation. When the deployment has no recipe-ready role, no panel SHALL render and the stage SHALL advance as if skipped.

#### Scenario: first entry shows the questionnaire

- **WHEN** a user at stage `new` on a deployment with ready roles opens the chat welcome state
- **THEN** the onboarding panel renders above the suggested prompts with recipe-ready role cards, the optional note field, and a skip control
- **AND** the composer is usable
- **AND** no other foreground onboarding surface (configuration confirmation or first-result guidance) is visible

#### Scenario: reload while awaiting activation re-opens the pre-filled questionnaire

- **WHEN** a user at stage `role_answered` reloads the page
- **THEN** the panel re-opens with the stored roles preselected and the stored note filled
- **AND** re-submitting shows the confirmation list again, so the pending activation is never silently dropped

#### Scenario: questionnaire lists only recipe-ready roles

- **WHEN** the panel renders on a deployment where only `legal`, `stock`, and `economic` have ready recipes
- **THEN** exactly those three role cards appear; `financial`, `screenplay`, `paper` do not

#### Scenario: submitting advances to the confirmation

- **WHEN** the user selects a role and submits
- **THEN** the stage becomes `role_answered` and the configuration confirmation list is the visible surface
- **AND** activating it advances the stage to `provisioned`

#### Scenario: skipping does not guess

- **WHEN** the user skips the questionnaire
- **THEN** the profile is marked skipped with no roles recorded
- **AND** the stage advances to `provisioned` (the first-result guidance may appear once, dismissible)
- **AND** the panel does not reappear on later welcome states
- **AND** the user's roles resolve per `role-system` defaults (unchanged)

### Requirement: Intent profile storage and deployment preset

The intent profile (selected roles, optional note, skipped mark, timestamps, and the first-run stage) SHALL persist per user in the user's own cell store, following the login identity across devices. The stage field SHALL be the single source of truth for which first-run surface the client renders (per `first-run-onboarding`). A legacy "dismissed the old tour" marker MAY suppress onboarding surfaces entirely, but it SHALL only ever yield the suppressed/`done` outcome and MUST NOT be used to infer any other stage. A deployment SHALL be able to preset a default profile via environment (roles and note); a stored user answer SHALL win over the preset, and the preset SHALL win over empty. A skipped-or-answered user SHALL never be auto-reprompted.

#### Scenario: deployment preset applies to newcomers

- **WHEN** the deployment presets default roles `[legal]` and a new user with an empty profile loads the welcome state
- **THEN** the questionnaire is preselected/skipped per the preset semantics (the user is not asked what the customer already answered for), and the user's roles resolve with primary `legal`

#### Scenario: re-answer wins over preset

- **WHEN** the user re-opens the questionnaire and submits `stock`
- **THEN** the stored answer wins and the primary role becomes `stock`

#### Scenario: client reads stage, not local markers

- **WHEN** the client renders the welcome state
- **THEN** it selects the onboarding surface solely from the server-reported stage
- **AND** a stale or absent local tour marker SHALL NOT change which stage renders (a "dismissed" marker may only hide the surfaces entirely, yielding `done`)

### Requirement: Curated recipe mapping

The platform SHALL maintain, as versioned static data, one recipe per business role declaring: the first-install pack list, the default expert reference, the welcome-prompt source, and the layout preset key, plus the role's **landing** — the surface a user of that role starts on (per `layout-configuration`'s landing resolution, which owns the precedence against the deployment default). Recipes are platform-curated and invisible to users; roles without a ready recipe SHALL NOT appear in the questionnaire (per `role-system` they remain assignable by admins). v1 ships ready recipes for `legal`, `stock`, `economic`.

A recipe's pack references SHALL resolve against the deployment's market by the pack's authored display name. Because the marketplace display names change while recipes are static data, reference resolution SHALL tolerate a rename instead of silently failing: a reference that does not match any listing's display name exactly SHALL be retried against the listing's name with whitespace and the `·` separator normalized, and the resolution result SHALL name the listing it matched. A reference that still resolves to nothing SHALL be reported as unavailable (never as an empty success), and the recipe catalog's own test SHALL enumerate every ready role's references and fail naming any reference that matches no listing in the reference market snapshot.

A recipe's default expert SHALL name an expert this deployment can actually select: either a catalog agent in the deployment's merged catalog, or the built-in local agent. When the named expert is not present in the current deployment, provisioning SHALL select the built-in local agent instead and SHALL report the substitution with the missing expert's id — MUST NOT report "selected" for an expert that was never selected. The recipe catalog's own test SHALL assert that each ready recipe's expert reference resolves on at least one deployment shape (cloud catalog or bundled local), and SHALL fail naming the recipe otherwise.

A recipe's landing SHALL be expressed in the same shape a layout preset's landing accepts (a nav registry slug path or `/boards/<served line>`), and SHALL be validated as such by the recipe catalog's own test rather than at runtime: a recipe is static authored data, so a malformed landing is a code defect, not a user input. A recipe MAY omit its landing; the role then inherits the deployment default landing and finally `/chat`. Setting a role's landing SHALL NOT require that role to carry a layout preset, and the two SHALL NOT be inferred from one another.

The recipe's welcome-prompt source field is presently authored but never consumed by any surface: the client's per-pack prompt content module has retired to an empty shell, and no caller reads the plan's `prompts` value. This field SHALL be treated as reserved and SHALL NOT be relied upon to change what a user sees; a later change that revives role-driven welcome prompts SHALL own it.

#### Scenario: recipe drives the provisioning plan

- **WHEN** a user with primary role `legal` confirms provisioning
- **THEN** the plan is derived from the `legal` recipe's pack list, default expert, and layout preset key

#### Scenario: a renamed pack reference still resolves

- **WHEN** a recipe references a display name whose listing has been renamed (whitespace or `·` differs)
- **THEN** the plan shows that listing as installable (or already installed) rather than unavailable
- **AND** the plan names the listing it matched

#### Scenario: an unresolvable reference is reported, not swallowed

- **WHEN** a recipe reference matches no listing in the deployment's market
- **THEN** the plan marks it unavailable and the confirmation list's closing note says some content is currently unavailable
- **AND** the recipe catalog test fails naming that reference against the reference snapshot

#### Scenario: missing expert substitutes honestly

- **WHEN** the deployment's merged catalog does not contain the recipe's named expert
- **THEN** provisioning selects the built-in local agent and its result carries the missing expert's id and the substitution
- **AND** MUST NOT report the named expert as selected

#### Scenario: each ready recipe declares a landing

- **WHEN** the recipe catalog's own test enumerates every ready role
- **THEN** each recipe's landing, when present, parses as a nav registry slug path or `/boards/<served line>`, and the test fails naming the recipe otherwise

#### Scenario: a role without a recipe landing falls through

- **WHEN** a user's primary role has a ready recipe that declares no landing and the deployment default declares none
- **THEN** the role contributes no landing and the user lands on `/chat`

#### Scenario: the welcome-prompt source changes nothing

- **WHEN** a recipe declares a welcome-prompt source value
- **THEN** no user-visible surface changes as a result, and the value is not treated as a contract by any caller

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

Activation's expert step SHALL report one of three outcomes and MUST NOT collapse them: `selected` (the named expert was selected), `substituted` (a different expert was selected, carrying the requested id and the selected id), `failed` (carrying the reason). An installation item's outcome SHALL likewise distinguish `installed`, `already-installed`, `unavailable`, and `failed`; an item that was not installed MUST NOT be reported as installed.

#### Scenario: existing packs untouched

- **WHEN** the user already installed one of the recipe's packs manually before activating
- **THEN** activation skips it and the user's other installed resources are unchanged

#### Scenario: re-activation is idempotent

- **WHEN** the user re-opens the questionnaire, re-submits the same roles, and activates again
- **THEN** no duplicate subscription or duplicate expert change occurs beyond re-asserting the same state

#### Scenario: default expert follows the primary role

- **WHEN** activation completes for primary role `legal`
- **THEN** the chat's initially selected expert is the `legal` recipe's default expert, and the welcome prompt cards follow it (per `chat-welcome-state`)

#### Scenario: expert step reports substitution, not success

- **WHEN** activation runs on a deployment whose catalog lacks the recipe's expert
- **THEN** the expert result reports `substituted` with the requested and selected ids
- **AND** the confirmation list states which expert was actually selected

### Requirement: Change of mind

The Settings general section SHALL offer a "重新选择角色" entry that re-opens the questionnaire (pre-filled with the stored profile). Re-answering SHALL update the profile and roles and re-run provisioning add-only; changing the primary role SHALL re-resolve the layout on the next config read (per `layout-configuration`).

#### Scenario: switching primary role switches layout and expert

- **WHEN** a user re-answers with primary `stock` (was `legal`) and activates
- **THEN** the primary role becomes `stock`, the default expert becomes the `stock` recipe's expert, and the resolved layout follows the `stock` recipe's preset on the next config read
- **AND** the previously installed legal packs remain installed

### Requirement: 问卷接受「我要一支团队」这条非角色路径

问卷 SHALL 在业务角色卡之外提供一条独立的「我要一支团队」入口。它是**意图**而非业务角色：
选择它 MUST NOT 写入任何业务角色指派（`roles` 保持原值），MUST NOT 改变布局层，也 MUST NOT
被记录为 skipped。记录后问卷 SHALL 把用户交给建队门卡的分叉（per `team-building-first-run`），
本能力 MUST NOT 自己实现建队写路径。

#### Scenario: 选团队不写角色

- **WHEN** 未答用户选择「我要一支团队」并确认
- **THEN** 意图档案记录「建队意图」且 `roles` 仍为空
- **AND** 用户的布局层与角色指派保持未指派状态（`standard` 回落不变）
- **AND** 问卷不再出现，建队门卡的三选一承接后续

#### Scenario: 角色路径与团队路径互不覆盖

- **WHEN** 用户先选业务角色 `legal`、之后重新打开问卷改选「我要一支团队」
- **THEN** 业务角色与布局按既有语义保持不变（add-only：不清空已指派角色）
- **AND** 既有的 `legal` 食谱装出的包不被卸载
