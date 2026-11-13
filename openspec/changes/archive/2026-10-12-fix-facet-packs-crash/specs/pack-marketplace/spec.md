## MODIFIED Requirements

### Requirement: Subscribing ends with a next-steps wizard

The subscribe success report panel SHALL append a next-steps footer: a line naming the follow-up (open the conversation and pick this pack's expert), a button that navigates to the chat view, and a dismiss affordance equivalent to the report's existing close. The report's per-part statuses, masking, and close behavior (openspec: pack-installation) are unchanged. On the facet shell — where no conversation view exists — the next-steps footer SHALL not render, and the report panel itself SHALL be unchanged.

#### Scenario: the report offers the next step

- **WHEN** a subscription succeeds and the report panel renders on 壹座
- **THEN** the panel shows the next-steps footer with an open-chat button
- **AND** activating the button navigates to the chat view and dismisses the report

#### Scenario: the facet report ends without the wizard footer

- **WHEN** a subscription is recorded on the facet shell and the report panel renders
- **THEN** the report panel shows its per-part statuses and close affordance
- **AND** no next-steps footer or open-chat button renders
