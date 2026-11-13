# tool-use-rendering Specification Delta

## ADDED Requirements

### Requirement: Browser tool screenshots render inline
Browser tool calls returning base64 image data SHALL render the image inline in the tool block body.

#### Scenario: Screenshot displayed in tool block
- **WHEN** a `tool_end` event arrives for `mcp__playwright__screenshot` containing base64 image data
- **THEN** the UI SHALL render an `<img>` element with the image data
- **AND** the image SHALL be constrained to the tool block width
