## MODIFIED Requirements

### Requirement: Assistant messages render with degraded-but-defined markdown

While a turn is streaming, assistant text SHALL render as plain text (no
markdown parsing of partial content). After the turn completes, the final
assistant message SHALL render as markdown (headings, lists, links, tables,
inline code, fenced code blocks). Fenced code blocks SHALL render as monospace
blocks without syntax highlighting. Markdown links SHALL be tappable: a link
whose target resolves to a file inside the agent workspace SHALL render as a
file chip offering preview and save-to-resources (see `resource-library-ui`);
all other links SHALL keep the existing copy-to-clipboard affordance and SHALL
NOT be presented as files. Malformed markdown SHALL never crash the message
list.

#### Scenario: streaming shows plain text, completion renders markdown

- **WHEN** an assistant turn streams `# Hea` then `ding\n\n- item` and completes
- **THEN** during streaming the raw text is shown as-is, and after `done` the message renders a heading and a bullet list

#### Scenario: an echarts fence renders as a chart or degrades

- **WHEN** a completed assistant message contains a fenced `echarts` block
- **THEN** the client renders it as an interactive canvas chart, or when chart rendering fails, shows the block as an ordinary code block without surfacing an error

#### Scenario: a workspace file link renders as a chip

- **WHEN** a completed assistant message contains a markdown link to a generated workspace file
- **THEN** the link renders as a file chip with preview and save-to-resources actions

#### Scenario: an external URL keeps the clipboard behavior

- **WHEN** a completed assistant message contains a markdown link to an external URL
- **THEN** tapping it keeps the existing copy-to-clipboard affordance

### Requirement: History secondary surfaces live in collapsed groups

The history page SHALL organize secondary surfaces below the session list as
collapsed-by-default groups: the user's active shares (count on the header;
expanding lists tokens with a revoke action), the resources entry (count on the
header; opening navigates to the resources page), the scheduled-task entry
(count on the header; the unread indication for unseen task output lives on this
group's header and clears by the existing seen-marking rules), and the
server/advanced settings. The session list itself SHALL remain the primary
surface above the groups. No secondary section SHALL render expanded without
a user tap.

#### Scenario: groups render collapsed with counts

- **WHEN** the history list page is shown
- **THEN** the session list renders first, followed by collapsed group headers for shares, resources, scheduled tasks, and server settings, each carrying its count where one exists

#### Scenario: unseen task output marks the group

- **WHEN** a scheduled task produced unseen output
- **THEN** the scheduled-task group header shows the unread indication until the session is viewed by the existing rules

#### Scenario: the resources group opens the resources page

- **WHEN** the user taps the resources group
- **THEN** the client navigates to the resources page