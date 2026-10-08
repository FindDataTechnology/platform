# project-identity Specification

## Purpose
Defines the product's name ("Platform" for display, "platform" for machine-facing identifiers and the npm package) and the identity surfaces - npm package name, browser title/heading, startup log, MCP client name, and HTTP User-Agent - that SHALL present a single, consistent product name. Synced from change rename-to-platform.

## Requirements

### Requirement: Single product name across identity surfaces
The product SHALL be named "Platform" for all user-facing display and "platform" for the npm package name. The `name` field in `package.json` (and the matching `name` fields in `package-lock.json`) SHALL be `platform`.

#### Scenario: browser title and heading show the product name
- **WHEN** a user opens the web UI
- **THEN** the browser tab title and the page heading SHALL read "Platform"

#### Scenario: npm package name
- **WHEN** the package metadata is inspected
- **THEN** the `name` field in `package.json` and `package-lock.json` SHALL be `platform`

### Requirement: Machine-facing client identifiers use the product name
The MCP client info `name` reported to MCP servers and the HTTP `User-Agent` sent by the knowledge URL fetcher SHALL identify the product as `platform`.

#### Scenario: MCP client identifies as platform
- **WHEN** the agent connects to an MCP server
- **THEN** the client info `name` reported in the MCP handshake SHALL be `platform`

#### Scenario: knowledge fetch User-Agent
- **WHEN** the knowledge module fetches a URL for ingestion
- **THEN** the request's `User-Agent` SHALL be `platform-knowledge/1.0`

### Requirement: Startup log uses the product name
The server startup log line SHALL identify the running product as "Platform".

#### Scenario: server starts
- **WHEN** the server starts and logs its bind address
- **THEN** the log line SHALL read `Platform running at http://<HOST>:<PORT>`
