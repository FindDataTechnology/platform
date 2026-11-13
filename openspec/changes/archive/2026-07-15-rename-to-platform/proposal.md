## Why

The project is currently named "pi-web-chat" - a label from its origin as a general-purpose pi-agent chat prototype. The stated long-term direction is an "openclaw-like" platform assistant for a special industry, not a chat demo. The old name appears in user-facing surfaces (browser title, page heading, startup log) and in machine-facing identifiers (npm package name, MCP client info, HTTP User-Agent), so the product presents an inconsistent, prototype-era identity across the surfaces users and external systems actually see. Renaming to "Platform" aligns every identity surface with the product's actual direction.

## What Changes

- Rename the npm package from `pi-web-chat` to `platform` in `package.json` and the matching `name` fields in `package-lock.json`. **BREAKING** for any consumer that depends on the package name; the package is not published, so impact is limited to this repo.
- Update the user-facing product name to "Platform": the browser `<title>` and page `<h1>` in `public/index.html`, and the startup log line in `server.js`.
- Update machine-facing client identifiers to "platform": the MCP client `CLIENT_INFO.name` in `mcp-bridge.js` and the knowledge-fetch `User-Agent` string in `knowledge.js`.
- Update the project `description` in `package.json` from "Web chat interface for pi-agent" to one that reflects the Platform product.
- Update incidental documentation/comment references to the old name: the `mcp.example.json` comment, the `CLAUDE.md` project header, and the proper-noun reference in `openspec/specs/open-connector-ui/spec.md`.

## Capabilities

### New Capabilities
- `project-identity`: Establishes the product's name ("Platform") and the set of identity surfaces (npm package name, browser title/heading, startup log, MCP client name, HTTP User-Agent) that SHALL present a single, consistent product name.

### Modified Capabilities
- `open-connector-ui`: Updates the proper-noun reference "pi-web-chat's proxy" to the new product name so the credential-handling requirement references the platform by its current name. Behavior of the requirement is unchanged; only the named actor changes.

## Impact

- Affected files: `package.json`, `package-lock.json`, `public/index.html`, `server.js`, `mcp-bridge.js`, `knowledge.js`, `mcp.example.json`, `CLAUDE.md`, `openspec/specs/open-connector-ui/spec.md`.
- No runtime behavior, APIs, dependencies, or protocols change - this is a rename of identity strings only. The WebSocket message protocol, REST routes, MCP tool namespacing (`mcp__<server>__<tool>`), and provider/model registration are untouched.
- No new dependencies.
- **BREAKING**: the npm package `name` changes from `pi-web-chat` to `platform`. Since the package is not published and has no external consumers, the practical effect is local only; `npm install` and `npm start` continue to work unchanged.
