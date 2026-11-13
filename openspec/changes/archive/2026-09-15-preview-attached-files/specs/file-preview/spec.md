# file-preview Specification

## ADDED Requirements

### Requirement: An attached file opens the preview from its composer chip

A composer attachment chip in the attached state SHALL open its stored original in the preview drawer, using the same drawer and file route as the tool-block and link entry points. This entry point SHALL reference the file through the preview route against the `uploads` root; it SHALL NOT require the file to be in the agent workspace, and it SHALL NOT alter the message being composed.

#### Scenario: open an attachment from the chip
- **WHEN** the user activates an attached file's chip
- **THEN** the drawer opens showing that file's original
- **AND** the composed message and its `@doc:<id>` references are unchanged

#### Scenario: chip entry uses the uploads root
- **WHEN** the drawer resolves an attachment's file
- **THEN** it requests the file against the `uploads` root
- **AND** the agent workspace is not required to contain the file
