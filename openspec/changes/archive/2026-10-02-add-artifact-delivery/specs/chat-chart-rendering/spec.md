# chat-chart-rendering Delta

## ADDED Requirements

### Requirement: Chart blocks display library entry status
The chat chart block SHALL display a persistent library-entry badge when the echarts fence it renders corresponds to a chart resource captured from the same message. The badge SHALL be clickable and navigate to the resources page. When no corresponding captured resource exists, the block SHALL display no badge. Badge state SHALL be derived from library data at render time and SHALL render identically for live sessions and historical sessions reopened later.

#### Scenario: captured chart shows the badge
- **WHEN** an assistant message's echarts fence has been captured into the resource library and the message is rendered
- **THEN** the chart block displays a persistent library-entry badge
- **AND** activating the badge navigates to the resources page

#### Scenario: uncaptured chart shows no badge
- **WHEN** an assistant message's echarts fence has no corresponding library resource (for example capture predates the feature or the fence failed to parse)
- **THEN** the chart block displays no badge and no empty placeholder

#### Scenario: historical session renders the badge
- **WHEN** a past session is reopened and one of its messages' charts is in the library
- **THEN** the chart block renders with the library-entry badge, derived from existing library data

#### Scenario: badge appears without a page reload
- **WHEN** a chart is captured while the user is viewing the conversation
- **THEN** the chart block acquires the badge through the live library-change notification, without requiring a manual reload
