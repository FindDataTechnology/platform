## MODIFIED Requirements

### Requirement: Collapsed header summarizes activity in plain language
The collapsed group header SHALL NOT display tool names, file paths, or other machine identifiers. While the turn is streaming it SHALL show live progress as a step count; after the turn ends it SHALL show a final summary of thinking duration (when measurable client-side) and executed step count. Every placeholder in the rendered summary SHALL be filled with its value in the active locale — no interpolation placeholder SHALL be displayed to the user.

#### Scenario: Live header during streaming
- **WHEN** the third tool call is running in a streaming turn
- **THEN** the collapsed header SHALL indicate that step 3 is in progress

#### Scenario: Final header after completion
- **WHEN** a turn that had 2 seconds of thinking and 5 non-text steps completes
- **THEN** the collapsed header SHALL state the thinking duration and the step count, with every placeholder filled, and without any tool name

#### Scenario: Expanded group hides the summary duplication
- **WHEN** the user expands a group
- **THEN** the header SHALL remain as the group's title bar and inner blocks SHALL render below it
