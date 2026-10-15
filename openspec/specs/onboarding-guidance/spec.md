# onboarding-guidance Specification

## Purpose

In-product guidance for non-technical users: a three-step first-run tour over the chat welcome surface, a restructured help center (quick start / scenario guides / commands & shortcuts), and per-pack usage guides surfaced in the marketplace detail and the help center. Scenario guides live in a client content module keyed by pack id; packs without guide content render unchanged.

## Requirements

### Requirement: First-run tour walks the three work-surface steps

When the chat welcome state renders for a browser that has not completed the onboarding tour, the UI SHALL present a guided tour of exactly three steps, in order: ① pick an expert (anchored to the agent picker), ② state the request (anchored to the composer), ③ see the results (anchored to the Outputs navigation entry). Each step SHALL carry a localized title and body explaining what to do next. The tour SHALL offer a skip affordance and a next/finish affordance on every step, SHALL not block interaction with the underlying surface beyond the step card, and SHALL dismiss on Escape. Completing or skipping the tour SHALL persist a done marker in that browser (local storage) so it does not re-appear on the next visit.

#### Scenario: first visit shows the tour

- **WHEN** a browser with no persisted tour-done marker renders the chat welcome state
- **THEN** the three-step tour SHALL be presented starting at step ① (pick an expert)

#### Scenario: skip persists

- **WHEN** the user activates the skip affordance at any step
- **THEN** the tour SHALL dismiss immediately
- **AND** reloading the page SHALL NOT re-present the tour

#### Scenario: finishing the tour dismisses it

- **WHEN** the user advances through all three steps and activates the finish affordance
- **THEN** the tour SHALL dismiss and the done marker SHALL be persisted

#### Scenario: Escape dismisses without blocking the surface

- **WHEN** the user presses Escape while the tour is open
- **THEN** the tour SHALL dismiss and the welcome surface SHALL remain fully interactive

### Requirement: The tour is re-openable from the help center

The help center's quick-start tab SHALL offer a replay affordance. Activating it SHALL clear the persisted done marker and present the tour again from step ①.

#### Scenario: replay from help

- **WHEN** the user activates the replay affordance in the help center quick-start tab
- **THEN** the help center SHALL close (or move behind) and the tour SHALL start at step ①
- **AND** the done marker SHALL be set again when the replayed tour is finished or skipped

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
