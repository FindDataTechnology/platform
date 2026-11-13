## Purpose

The client surfaces where users discover, inspect, and manage their resources: a browsing page in each client, save affordances inside the conversation, and live reflection of library changes.

## ADDED Requirements

### Requirement: Web resources page

The web client SHALL provide a resources page at `/resources`, reached from the sidebar's Resources tab, listing the cell's resources most-recent-first with a type filter (all / charts / files) and a title search. Chart entries SHALL render as live charts through the client's existing chart component, not as static previews or code. File entries SHALL show the file name, type, and size, and SHALL open in the existing preview drawer, with the drawer's download path available for stored bytes. Every entry SHALL offer rename and delete (delete behind a confirmation), and a jump-to-source affordance that opens the originating session when it still exists and is absent or disabled otherwise. An empty library SHALL render an explanatory empty state, not a blank panel. Labels SHALL resolve from the internationalization bundle.

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

The mini program SHALL provide a standalone resources page, entered from the history surface's resources group. It SHALL list the cell's resources (charts and files) and, for charts, re-render them through the client's existing canvas chart renderer. For stored files it SHALL offer the mini program's native preview for types the platform supports (`openDocument` for office and PDF documents, the image viewer for images) and a forward-to-chat action for sharing a file onwards; a type the platform cannot preview SHALL offer forward instead of a broken or empty preview. Rename, delete (with confirmation), and jump-to-source SHALL be available, with the same absent-when-gone rule as the web page.

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