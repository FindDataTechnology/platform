## 1. Package metadata

- [x] 1.1 In `package.json`, change `"name"` from `pi-web-chat` to `platform`
- [x] 1.2 In `package.json`, update `"description"` from `Web chat interface for pi-agent` to a Platform description (e.g. `Platform - browser-based AI assistant built on the pi-coding-agent SDK`)
- [x] 1.3 In `package-lock.json`, change both `name` fields (the root object and the top-level project entry) from `pi-web-chat` to `platform`; touch no dependency entries

## 2. User-facing identity

- [x] 2.1 In `public/index.html`, change the browser `<title>` from `pi-web-chat` to `Platform`
- [x] 2.2 In `public/index.html`, change the page `<h1>` heading from `pi-web-chat` to `Platform`
- [x] 2.3 In `server.js`, change the startup log from `` pi-web-chat running at http://${HOST}:${PORT} `` to `` Platform running at http://${HOST}:${PORT} ``

## 3. Machine-facing client identifiers

- [x] 3.1 In `mcp-bridge.js`, change `CLIENT_INFO.name` from `pi-web-chat` to `platform` (leave `version` as-is)
- [x] 3.2 In `knowledge.js`, change the URL-fetch `User-Agent` from `pi-web-chat-knowledge/1.0` to `platform-knowledge/1.0`

## 4. Documentation and spec references

- [x] 4.1 In `mcp.example.json`, update the comment that says `pi-web-chat registers this automatically...` to refer to `platform`
- [x] 4.2 In `CLAUDE.md`, update the project header (the line beginning `` `pi-web-chat` - a browser-based chat interface...``) so the product is named "Platform"
- [x] 4.3 Run `/opsx:sync rename-to-platform` to merge the `open-connector-ui` delta into `openspec/specs/open-connector-ui/spec.md`, changing `pi-web-chat's proxy` to `Platform's proxy` (or defer to `/opsx:archive`, which syncs first)

## 5. Verification

- [x] 5.1 Grep the repo for `pi-web-chat` (case-insensitive) and confirm zero hits in source, configs, and `openspec/specs/`; remaining hits are acceptable only inside `openspec/changes/archive/` and historical change folders. (If task 4.3 is deferred, the single `openspec/specs/open-connector-ui/spec.md` hit is expected and resolves at sync.)
- [x] 5.2 Run `npm install` (expect no changes) and `npm ls` to confirm the lockfile is consistent after the hand-edits
- [x] 5.3 Run `npm start` and confirm the browser tab title reads "Platform" and the startup log reads `Platform running at http://...`
