## Why

Users want to interact with pi-agent through a web browser instead of a terminal. A web chat interface makes pi accessible from any device, enables sharing sessions, and provides a familiar chat-like experience for coding assistance.

## What Changes

- Add a Node.js/Express backend server that wraps the pi SDK (`@earendil-works/pi-coding-agent`) to handle chat sessions
- Add a WebSocket layer for real-time streaming of agent responses, tool calls, and thinking output
- Add a browser-based chat UI with support for streaming text, tool execution visibility, thinking blocks, and multi-turn conversations
- Add a simple static file server for serving the frontend

## Capabilities

### New Capabilities
- `web-chat-server`: Backend server that creates pi agent sessions, handles user prompts, and streams events via WebSocket
- `web-chat-ui`: Browser-based chat interface with streaming text, tool call display, thinking blocks, and message history

### Modified Capabilities
<!-- No existing capabilities to modify -->

## Impact

- Dependencies: `express`, `ws`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`
- New files: `server.js`, `public/index.html`, `public/style.css`, `public/app.js`
- No existing code affected (greenfield project)