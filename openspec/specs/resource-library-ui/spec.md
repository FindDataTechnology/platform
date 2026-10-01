# resource-library-ui Specification

## Purpose

The client surfaces where users discover, inspect, and manage their resources: a browsing page in each client, save affordances inside the conversation, and live reflection of library changes.

## Requirements

### Requirement: Web resources page

The web client SHALL provide a resources page at `/resources`, reached from the sidebar's Resources tab, listing the cell's resources most-recent-first with a type filter (all / charts / files) and a title search. Chart entries SHALL render as live charts through the client's existing chart component, not as static previews or code. File entries SHALL show the file name, type, and size, and SHALL open in the existing preview drawer, with the drawer's download path available for stored bytes. Every entry SHALL offer rename and delete (delete behind a confirmation), and a jump-to-source affordance that opens the originating session when it still exists and is absent or disabled otherwise. An empty library SHALL render an explanatory empty state, not a blank panel. Labels SHALL resolve from the internationalization bundle. A bound chart entry SHALL additionally show a source line naming the server, tool, and the as-of moment of its latest data, a refresh action, and a stale badge with the failure reason when its binding is marked stale; an unbound chart SHALL NOT show a source line or refresh action. The chart view SHALL offer a data-period filter over the stored series (recent windows such as last 6 months / last year / all). These bound-chart affordances SHALL be presented without changing the chart renderer.

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

### Requirement: Saving a file from the web chat

The web chat SHALL expose a save-to-resources action for files it already recognizes as workspace files — from the preview drawer at minimum — without requiring the user to leave the conversation. On success the user SHALL receive confirmation; when the library already holds the same content, the action SHALL report that instead of creating a duplicate. A failed save SHALL surface the reason (for example: too large, or the file no longer exists).

#### Scenario: save from the preview drawer

- **WHEN** the user opens a workspace file in the preview drawer and activates save-to-resources
- **THEN** the file is stored and a confirmation appears
- **AND** the resource is immediately visible on the resources page

#### Scenario: already in the library

- **WHEN** the user saves a file whose content is already stored
- **THEN** no duplicate is created and the user is told it is already in the library

### Requirement: Miniprogram resources page

The mini program SHALL provide a standalone resources page, entered from the history surface's resources group. It SHALL list the cell's resources (charts and files) and, for charts, re-render them through the client's existing canvas chart renderer. For stored files it SHALL offer the mini program's native preview for types the platform supports (`openDocument` for office and PDF documents, the image viewer for images) and a forward-to-chat action for sharing a file onwards; a type the platform cannot preview SHALL offer forward instead of a broken or empty preview. Rename, delete (with confirmation), and jump-to-source SHALL be available, with the same absent-when-gone rule as the web page. A bound chart entry SHALL show the same source line and offer the same refresh action and data-period filter as the web page; a stale binding SHALL show the stale badge. Against a cell older than this capability the bound-chart affordances SHALL hide themselves (the chart still renders, no error is surfaced) — the version-skew degradation the library already follows for its whole surface.

#### Scenario: a chart resource renders in the mini program

- **WHEN** the user opens a chart resource
- **THEN** it renders as a canvas chart, or degrades to its code block without surfacing an error

#### Scenario: a stored document previews natively

- **WHEN** the user taps a stored document resource (office document or PDF)
- **THEN** the mini program downloads it and opens it in the native document viewer

#### Scenario: an unpreviewable type offers forwarding

- **WHEN** the user taps a stored file whose type the mini program cannot preview
- **THEN** the client offers forwarding the file to a WeChat chat instead of attempting a preview

#### Scenario: jump back to the source conversation

- **WHEN** the user activates jump-to-source on a resource whose session still exists
- **THEN** the client returns to the chat with that session active

#### Scenario: a bound chart refreshes from the mini program

- **WHEN** the user taps refresh on a bound chart and the cell supports the capability
- **THEN** the chart redraws with the new data and the source line's as-of moment advances

#### Scenario: an older cell degrades silently

- **WHEN** the mini program's cell does not yet support bound charts
- **THEN** charts render as before with no source line, no refresh action, and no error

### Requirement: Miniprogram in-chat file chip

In a completed assistant message, a markdown link whose target resolves to a file inside the agent workspace SHALL render as a tappable file chip instead of the existing copy-to-clipboard link behavior. Tapping it SHALL offer preview and save-to-resources. Once saved, the chip SHALL reflect the saved state so a second save is not attempted. Links that are not workspace files — external URLs and non-file targets — SHALL keep the existing clipboard behavior unchanged.

#### Scenario: a file link renders as a chip

- **WHEN** a completed assistant message contains a link to a generated workspace file
- **THEN** it renders as a file chip, not as a plain clipboard-copying link

#### Scenario: preview and save from the chip

- **WHEN** the user taps a file chip
- **THEN** an action sheet offers preview and save-to-resources
- **AND** after saving, the chip shows the saved state

#### Scenario: ordinary links are unchanged

- **WHEN** a completed assistant message contains an external URL
- **THEN** tapping it keeps the existing clipboard-copy behavior

### Requirement: Library changes appear live

Both clients SHALL reflect library changes without a manual reload: when a resource is captured, saved, renamed, or deleted (including from the other client), an open resources list SHALL update, and count indicators on navigation surfaces (the mini program history group) SHALL stay current while that surface is on screen.

#### Scenario: a chart captured mid-conversation appears

- **WHEN** a chart is captured while the user has the resources page open
- **THEN** the chart appears without the user reloading

#### Scenario: the group count follows the library

- **WHEN** the mini program history surface is open and a resource is added or removed
- **THEN** the resources group's count reflects the change

### Requirement: The observation timeline is visible on the web

The web resources page SHALL expose, for each bound chart, its observation timeline: the list of refreshes with moment, trigger, outcome, and change counts, filterable by observation time, where each entry with changes offers the chart view as of that refresh. Viewing an as-of state SHALL be clearly distinguished from viewing the current chart, and returning to the current view SHALL be a single action. The timeline SHALL state, in a human-readable way, what each refresh did — appended, revised, resourced, unchanged counts and anomalies — using the internationalization bundle.

#### Scenario: the timeline lists what refreshes did

- **WHEN** the user opens a bound chart's timeline
- **THEN** each refresh appears with its moment, trigger, outcome, and per-classification counts in human-readable form

#### Scenario: viewing and leaving an as-of state

- **WHEN** the user opens the as-of view of a refresh and then returns to the current view
- **THEN** the as-of state is visually distinguished while active, and the current chart is restored with one action
