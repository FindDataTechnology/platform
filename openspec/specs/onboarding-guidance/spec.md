# onboarding-guidance Specification

## Purpose

In-product guidance for non-technical users: a three-step first-run tour over the chat welcome surface, a restructured help center (quick start / scenario guides / commands & shortcuts), and per-pack usage guides surfaced in the marketplace detail and the help center. Scenario guides live in a client content module keyed by pack id; packs without guide content render unchanged.

## Requirements

### Requirement: Help center is organized into three tabs

The help dialog SHALL render three tabs, in order: **Quick start（快速上手）**, **Scenario guides（场景教程）**, **Commands & shortcuts（命令与快捷键）**. Quick start SHALL carry the three-step walkthrough (matching the tour's steps as static content) and the tour replay affordance. Scenario guides SHALL list every pack that has guide content in the client content module, each entry opening that pack's guide; packs without guide content SHALL NOT appear. Commands & shortcuts SHALL carry the existing commands, skills, shortcuts, and concepts content unchanged. Tab labels SHALL resolve from the i18n bundle.

#### Scenario: tabs render and default to quick start

- **WHEN** the user opens the help center
- **THEN** the three tabs SHALL be visible with Quick start active

#### Scenario: scenario guides list only packs with content

- **WHEN** the Scenario guides tab renders
- **THEN** it SHALL list exactly the packs present in the client guide content module

### Requirement: Pack guides surface in the marketplace detail

The client SHALL carry a content module mapping pack ids to usage guides (three steps: what to prepare, what to say, what you get). The marketplace detail view SHALL render a usage-guide card for a pack when the module contains an entry for that pack's id, and SHALL render no guide card when it does not. Guide bodies SHALL present the pack's own language content as-is (zh content for the launch packs); the card's chrome labels SHALL resolve from the i18n bundle. The guide card SHALL be purely informational — it adds no subscribe, install, or navigation behavior.

#### Scenario: guide card renders for a covered pack

- **WHEN** the user opens the detail view of a pack whose id has guide content
- **THEN** the detail view SHALL show the usage-guide card with the pack's three-step guide

#### Scenario: no card for uncovered packs

- **WHEN** the user opens the detail view of a pack without guide content
- **THEN** the detail view SHALL render exactly as before, with no guide card

### Requirement: 桌面首启的本地舰队上线步

Electron 桌面壳内（以 preload bridge 存在为准）且本机无任何舰队时，首个成果引导这步之后 SHALL 追加一步「跑起第一支舰队」，把「装官方入门样例 → 用模板向导实例化 → 跑一轮 → 产出进 boards」串珠成一条可执行路径。该步 SHALL 可跳过、可从帮助中心重开，SHALL NOT 阻塞底层界面（沿用引导的交互契约：卡片不挡操作、Escape 关闭）。该步的完成标记 SHALL 独立于首启阶段，不影响 `first-run-onboarding` 的阶段推进。纯浏览器（无 preload bridge）SHALL NOT 出现该步——本机集群概念只对桌面进程成立。每一步的失败 SHALL 逐项降级呈现（市场不可达时不阻断离线 bundle 路径；两者皆不可用时给出明确引导而非卡死），SHALL NOT 阻塞应用启动。样例安装 SHALL 仍是一次显式确认，不静默物化任何 pack。

#### Scenario: 桌面空舰队首启出现该步

- **WHEN** 桌面壳内、本机部署与舰队均为空
- **THEN** 首个成果引导之后追加「跑起第一支舰队」，提供开始与跳过

#### Scenario: 浏览器不出现该步

- **WHEN** 纯浏览器访客走首个成果引导
- **THEN** 不出现本地舰队步

#### Scenario: 离线也能走通

- **WHEN** 桌面断网且安装包含预置入门 bundle
- **THEN** 该步经预置 bundle 完成安装与实例化，段末可见 boards 产出或待确认启动提示

#### Scenario: 样例安装仍是一次显式确认

- **WHEN** 用户在该步内推进到安装动作
- **THEN** 安装经一次明确的确认（沿用既有安装 consent/确认口径），不静默物化任何 pack

### Requirement: First-run guidance produces a first real result

When a user's first-run stage is `provisioned` (per `first-run-onboarding`), the UI SHALL present a single guided step that leads the user to do one concrete thing with a real outcome — install the preferred official starter team (the `preferred` entry of the official starter sequence) and land on that team's first result surface (its agents become selectable, or its board opens) — rather than a multi-step tour that only points at navigation locations. The step SHALL name the concrete action and where its result will appear, SHALL offer a skip affordance and a finish affordance, SHALL not block interaction with the underlying surface beyond the step card, and SHALL dismiss on Escape. Finishing or skipping the step SHALL advance the first-run stage to `done` on the server (no browser-local marker). When the starter material cannot be reached (market unreachable and no bundled fallback), the step SHALL present an honest unavailable state and still allow dismissal — it MUST NOT trap the user at `provisioned`.

This capability no longer defines a three-step navigation walkthrough; first-run progress lives in `first-run-onboarding` and the guidance is its `provisioned`-stage surface.

#### Scenario: provisioned user sees the single guidance step

- **WHEN** a user reaches stage `provisioned` and the welcome state renders
- **THEN** a single first-result guidance step SHALL appear, naming the starter team to install and where the result appears
- **AND** no questionnaire or configuration confirmation is visible at the same time

#### Scenario: completing advances the stage

- **WHEN** the user finishes the guidance step
- **THEN** the first-run stage becomes `done`
- **AND** reloading SHALL NOT re-present the guidance

#### Scenario: the guidance yields a first result surface

- **WHEN** the user completes the install the guidance leads to
- **THEN** the preferred team's agents SHALL become selectable, or its board SHALL open
- **AND** the step SHALL name where the result appears

#### Scenario: skipping advances the stage

- **WHEN** the user dismisses the guidance step via skip or Escape
- **THEN** the first-run stage becomes `done` and the surface stays fully interactive

#### Scenario: unreachable starter material is honest, not trapping

- **WHEN** the starter team's market content is unreachable and no bundled fallback exists
- **THEN** the step names the content as currently unavailable and offers guidance
- **AND** dismissing it still advances the stage to `done`

### Requirement: The guidance is re-openable from the help center

The help center's quick-start tab SHALL offer a replay affordance for the first-result guidance. Activating it SHALL present the guidance again regardless of the current stage; finishing or skipping the replayed guidance SHALL return the user to their current stage without regressing it (a user already at `done` stays `done`).

#### Scenario: replay from help

- **WHEN** the user activates the replay affordance in the help center quick-start tab
- **THEN** the help center SHALL close (or move behind) and the first-result guidance SHALL be presented again
- **AND** finishing or skipping it SHALL leave the server stage unchanged
