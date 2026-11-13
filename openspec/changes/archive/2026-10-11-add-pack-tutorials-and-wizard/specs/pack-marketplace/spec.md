## ADDED Requirements

### Requirement: The detail view renders the pack's guide with a manifest-first chain

The detail view's usage-guide card SHALL resolve its content in order: the pack's own `manifest.guide` when present, else the client guide content module for that pack id, else no card. The card's chrome labels SHALL resolve from the i18n bundle while step text renders as the creator's own-language content. When the client content module holds example prompts for the pack, the card SHALL additionally list up to four example questions (read-only text) beneath the steps; packs without example content show steps only. Neither the guide card nor the examples add any subscribe, install, or navigation action.

#### Scenario: manifest guide wins over client content

- **WHEN** a pack's manifest carries a guide and the client module also has content for its id
- **THEN** the detail view renders the manifest's three steps

#### Scenario: client module still covers launch packs

- **WHEN** a pack without a manifest guide has client-module content
- **THEN** the detail view renders the client module's steps as before

#### Scenario: example questions render when available

- **WHEN** the rendered pack has example prompts in the client content module
- **THEN** up to four example questions appear beneath the guide steps as read-only text

### Requirement: Subscribing ends with a next-steps wizard

The subscribe success report panel SHALL append a next-steps footer: a line naming the follow-up (open the conversation and pick this pack's expert), a button that navigates to the chat view, and a dismiss affordance equivalent to the report's existing close. The report's per-part statuses, masking, and close behavior (openspec: pack-installation) are unchanged.

#### Scenario: the report offers the next step

- **WHEN** a subscription succeeds and the report panel renders
- **THEN** the panel shows the next-steps footer with an open-chat button
- **AND** activating the button navigates to the chat view and dismisses the report
