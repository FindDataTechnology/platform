## MODIFIED Requirements

### Requirement: Web resources page

The web client SHALL provide a resources page at `/resources`, reached from the sidebar's Resources tab, listing the cell's resources most-recent-first with a type filter (all / charts / files) and a title search. Chart entries SHALL render as live charts through the client's existing chart component, not as static previews or code. File entries SHALL show the file name, type, and size, and SHALL open in the existing preview drawer, with the drawer's download path available for stored bytes. Every entry SHALL offer rename and delete (delete behind a confirmation), and a jump-to-source affordance that opens the originating session when it still exists and is absent or disabled otherwise. An empty library SHALL render an explanatory empty state, not a blank panel. Labels SHALL resolve from the internationalization bundle. A bound chart entry SHALL additionally show a source line naming the server, tool, and the as-of moment of its latest data, a refresh action, and a stale badge with the failure reason when its binding is marked stale; an unbound chart SHALL NOT show a source line or refresh action. The chart view SHALL offer a data-period filter over the stored series (recent windows such as last 6 months / last year / all). These bound-chart affordances SHALL be presented without changing the chart renderer.

File entries SHALL additionally offer selection for batch export: a checkbox per file entry, a select-all-files affordance, and an export action that packages the selected files' stored bytes client-side into a single zip download (`outputs-<date>.zip`). Chart entries SHALL NOT participate in the selection (their checkboxes are absent), and the export action SHALL be absent while no file is selected. Batch export SHALL reuse each file's existing stored-bytes serving path — no new server route — and SHALL NOT alter the per-entry download, preview, rename, delete, or jump affordances.

#### Scenario: the page renders both types

- **WHEN** the user opens the resources page with captured charts and saved files present
- **THEN** charts render as live charts and files render as file entries in one list
- **AND** the type filter narrows the list to a single type

#### Scenario: a file resource previews from its stored copy

- **WHEN** the user opens a stored file resource
- **THEN** the preview shows the stored bytes, regardless of the state of the original workspace file

#### Scenario: jump back to the source conversation

- **WHEN** the user activates the jump-to-source affordance of a resource whose session still exists
- **THEN** the client opens that session
- **WHEN** the session no longer exists
- **THEN** the affordance is absent or disabled and the entry remains usable otherwise

#### Scenario: empty state

- **WHEN** the library has no resources
- **THEN** the page explains what will appear here and offers no dead actions

#### Scenario: a bound chart shows its source line

- **WHEN** the user views a chart bound to an MCP data call
- **THEN** a source line names the server, the tool, and how old the shown data is
- **AND** an unbound chart in the same list shows no source line and no refresh action

#### Scenario: a stale chart says so

- **WHEN** a bound chart's binding is marked stale after a failed refresh
- **THEN** the entry shows a stale badge with the failure reason
- **AND** the chart still renders its last good data with its source line reporting the data's age

#### Scenario: batch export packages selected files

- **WHEN** the user selects two or more file entries and activates the export action
- **THEN** a single zip download SHALL be produced containing each selected file's stored bytes under its displayed name
- **AND** chart entries SHALL be absent from the archive regardless of any filter state

#### Scenario: export affordance tracks selection

- **WHEN** no file entry is selected
- **THEN** the export action SHALL be absent
- **AND** selecting and then deselecting every file SHALL hide it again
