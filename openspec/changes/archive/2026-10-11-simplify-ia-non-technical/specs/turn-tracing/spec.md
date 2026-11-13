## MODIFIED Requirements

### Requirement: The UI renders a per-turn trace viewer
The list of captured turns SHALL render as the Settings 诊断 (`diagnostics`) section at `/settings/diagnostics`, and the legacy `/trace` route SHALL redirect there. The per-turn viewer SHALL remain a top-level route: `/trace/:turnId` renders the turn's ordered event timeline with expandable raw payloads and derived sections (LLM calls including retries, tool calls with durations, aggregated delta counts). Per-turn deep links from the chat surface (opening a specific turn's trace) SHALL continue to land directly on `/trace/:turnId` unchanged.

#### Scenario: inspecting a slow turn
- **WHEN** the user opens a turn in `/trace/:turnId`
- **THEN** the timeline SHALL show each LLM request with any retries and each tool call with its duration, in order

#### Scenario: trace list lives in Settings
- **WHEN** the user opens Settings and selects the 诊断 (diagnostics) section
- **THEN** the captured-turn list SHALL render inside the Settings modal with its existing filters and columns
- **AND** navigating to `/trace` SHALL redirect to `/settings/diagnostics`

#### Scenario: chat deep link bypasses the list
- **WHEN** the user activates a turn's trace link in the chat surface
- **THEN** the app SHALL navigate directly to `/trace/:turnId` as a top-level page, without passing through the Settings modal
