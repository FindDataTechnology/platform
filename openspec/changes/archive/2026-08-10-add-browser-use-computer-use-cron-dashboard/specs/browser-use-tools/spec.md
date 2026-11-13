# browser-use-tools Specification

## Purpose
Defines browser automation capabilities that enable the agent to interact with web pages through Playwright-based MCP tools, including navigation, screenshots, form filling, and element extraction.

## ADDED Requirements

### Requirement: Browser tools are available as MCP-wrapped tools
The server SHALL expose Playwright browser automation tools via the MCP bridge, prefixed with `mcp__playwright__`, when the Playwright MCP server is configured in `mcp.json`. If Playwright is not configured or fails to connect, the server SHALL start normally without browser tools.

#### Scenario: Browser tools loaded when configured
- **WHEN** `mcp.json` contains a valid Playwright MCP server configuration
- **THEN** the server SHALL connect to the Playwright MCP server
- **AND** browser tools SHALL appear in the agent's available tools

#### Scenario: Browser tools skipped when not configured
- **WHEN** `mcp.json` does not contain a Playwright server configuration
- **THEN** the server SHALL start normally
- **AND** a warning SHALL be logged that browser tools are not available

### Requirement: Browser tools support core navigation actions
The browser tools SHALL support core web navigation actions including go to URL, go back, go forward, and refresh.

#### Scenario: Navigate to URL
- **WHEN** the agent calls `mcp__playwright__goto` with a valid URL
- **THEN** the browser SHALL navigate to the specified URL
- **AND** the tool SHALL return page metadata (title, URL, status code)

#### Scenario: Navigation fails gracefully
- **WHEN** the agent calls `mcp__playwright__goto` with an unreachable URL
- **THEN** the tool SHALL return an error result
- **AND** the browser instance SHALL remain available for subsequent commands

### Requirement: Browser tools support screenshot capture
The browser tools SHALL support capturing full-page and viewport screenshots, returned as base64-encoded PNG data.

#### Scenario: Capture viewport screenshot
- **WHEN** the agent calls `mcp__playwright__screenshot`
- **THEN** the tool SHALL return a base64-encoded PNG of the current viewport

#### Scenario: Capture full-page screenshot
- **WHEN** the agent calls `mcp__playwright__screenshot` with `fullPage: true`
- **THEN** the tool SHALL return a base64-encoded PNG of the full page

### Requirement: Browser tools support element interaction
The browser tools SHALL support clicking elements, filling form fields, and extracting element text using CSS selectors.

#### Scenario: Click element by selector
- **WHEN** the agent calls `mcp__playwright__click` with a valid CSS selector
- **THEN** the browser SHALL click the first matching element
- **AND** the tool SHALL return success status

#### Scenario: Fill form field
- **WHEN** the agent calls `mcp__playwright__fill` with selector and value
- **THEN** the browser SHALL fill the matching input field with the value
- **AND** the tool SHALL return success status

### Requirement: Browser tools support page content extraction
The browser tools SHALL support extracting page text content, inner HTML, and lists of elements matching selectors.

#### Scenario: Extract page text
- **WHEN** the agent calls `mcp__playwright__innerText` with selector
- **THEN** the tool SHALL return the text content of matching elements

#### Scenario: Extract all links
- **WHEN** the agent calls `mcp__playwright__evaluate` with a script to collect links
- **THEN** the tool SHALL return the evaluated result containing link URLs and text

### Requirement: Browser instances are automatically cleaned up
The browser SHALL automatically close after 5 minutes of inactivity or when the server shuts down to prevent resource leaks.

#### Scenario: Auto-close idle browser
- **WHEN** no browser tool has been called for 5 minutes
- **THEN** the browser instance SHALL be closed automatically
- **AND** a new instance SHALL be created on the next tool call

#### Scenario: Browser cleanup on server shutdown
- **WHEN** the server receives a shutdown signal
- **THEN** any active browser instance SHALL be closed gracefully

### Requirement: Browser tool calls render in chat UI
Browser tool calls SHALL render as collapsible blocks in the chat UI, with screenshots displayed inline when returned.

#### Scenario: Browser tool execution displayed
- **WHEN** the server sends `tool_start` for a `mcp__playwright__*` tool
- **THEN** the UI SHALL render a collapsible block with the browser tool name
- **AND** the block SHALL show the tool arguments in the body

#### Scenario: Screenshot displayed inline
- **WHEN** a screenshot tool returns base64 image data
- **THEN** the UI SHALL render the image inline in the tool block body
