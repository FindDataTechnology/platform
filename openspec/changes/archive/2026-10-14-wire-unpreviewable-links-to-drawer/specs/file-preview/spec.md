## MODIFIED Requirements

### Requirement: File references open the preview

A file reference in assistant output and a completed tool call that produced a file SHALL each offer to open that file in the drawer, without requiring the user to know a URL or leave the chat. A markdown link in assistant text SHALL open the drawer whenever its target names a file the platform recognizes as a produced file, whether or not the client can render that type; a link naming an unrecognized target, an external URL, or a non-file target SHALL keep its ordinary navigation behavior. For a type the client cannot render, the drawer SHALL present the download action, and SHALL report the file as no longer available rather than offer a download that cannot succeed when the file no longer exists.

#### Scenario: open a produced file from the tool block

- **WHEN** a tool call that wrote a file has completed
- **THEN** the tool block offers an action that opens that file in the drawer

#### Scenario: open a linked file from the assistant text

- **WHEN** assistant text links to a file served by the file route
- **THEN** activating the link opens the drawer instead of navigating away

#### Scenario: a link to an unrenderable produced file opens the drawer

- **WHEN** assistant text links to a produced file whose type has no renderer (for example an archive or a spreadsheet)
- **THEN** activating the link opens the drawer
- **AND** the drawer presents the download action rather than an error or a navigation

#### Scenario: a link to a produced file that no longer exists

- **WHEN** assistant text links to a produced file whose type has no renderer, and that file is no longer present in the workspace
- **THEN** the drawer reports that the file is no longer available instead of offering a download that cannot succeed

#### Scenario: ordinary links keep their behavior

- **WHEN** assistant text links to an external URL or a target that names no produced file
- **THEN** the link keeps its ordinary navigation behavior and does not open the drawer
